/*
This file is part of web3.js.

web3.js is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

web3.js is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with web3.js.  If not, see <http://www.gnu.org/licenses/>.
*/
// eslint-disable-next-line max-classes-per-file
import { Web3Context } from 'web3-core';
import Web3Eth, { registeredSubscriptions } from 'web3-eth';
import Contract from 'web3-eth-contract';
import { ENS, registryAddresses } from 'web3-eth-ens';
import Iban from 'web3-eth-iban';
import Personal from 'web3-eth-personal';
import Net from 'web3-net';
import * as utils from 'web3-utils';
import { isNullish } from 'web3-utils';
import {
	Address,
	ContractAbi,
	ContractInitOptions,
	EthExecutionAPI,
	SupportedProviders,
} from 'web3-types';
import { InvalidMethodParamsError } from 'web3-errors';
import abi from './abi.js';
import { initAccountsForContext } from './accounts.js';
import { Web3EthInterface } from './types.js';
import { Web3PkgInfo } from './version.js';

const REPLICATED_QUERY_LENGTH = 4;
type QueryFunction<T extends unknown[], R> = (...args: T) => R;

function isQueryMethod(methodName: string): boolean {
	return methodName.includes('get');
}

function stringifyData<T>(data: T): string {
	return JSON.stringify(data, (_, value) => {
		if (typeof value === 'bigint') {
			return value.toString(); // Convert BigInt to string
		}
		return value as unknown; // Return other values unchanged
	});
}

export class Web3 extends Web3Context<EthExecutionAPI> {
	public static version = Web3PkgInfo.version;
	public static utils = utils;
	public static modules = {
		Web3Eth,
		Iban,
		Net,
		ENS,
		Personal,
	};

	public utils: typeof utils;

	public eth: Web3EthInterface;

	public constructor(provider?: SupportedProviders<EthExecutionAPI> | string) {
		super({ provider, registeredSubscriptions });

		if (isNullish(provider) || (typeof provider === 'string' && provider.trim() === '')) {
			console.warn(
				'NOTE: web3.js is running without provider. You need to pass a provider in order to interact with the network!',
			);
		}

		const accounts = initAccountsForContext(this);

		// Init protected properties
		this._wallet = accounts.wallet;
		this._accountProvider = accounts;

		this.utils = utils;

		// Have to use local alias to initiate contract context
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;

		class ContractBuilder<Abi extends ContractAbi> extends Contract<Abi> {
			public constructor(jsonInterface: Abi);
			public constructor(jsonInterface: Abi, address: Address);
			public constructor(jsonInterface: Abi, options: ContractInitOptions);
			public constructor(jsonInterface: Abi, address: Address, options: ContractInitOptions);
			public constructor(
				jsonInterface: Abi,
				addressOrOptions?: Address | ContractInitOptions,
				options?: ContractInitOptions,
			) {
				if (typeof addressOrOptions === 'object' && typeof options === 'object') {
					throw new InvalidMethodParamsError(
						'Should not provide options at both 2nd and 3rd parameters',
					);
				}
				if (isNullish(addressOrOptions)) {
					super(jsonInterface, options, self.getContextObject());
				} else if (typeof addressOrOptions === 'object') {
					super(jsonInterface, addressOrOptions, self.getContextObject());
				} else if (typeof addressOrOptions === 'string') {
					super(jsonInterface, addressOrOptions, options ?? {}, self.getContextObject());
				} else {
					throw new InvalidMethodParamsError();
				}

				super.subscribeToContextEvents(self);
			}
		}

		// Intercept all .eth queries
		const eth = new Proxy<Web3Eth>(self.use(Web3Eth), {
			get(target: Web3Eth, prop: string) {
				// get actual method or property being called
				const originalMethod = target[prop as keyof Web3Eth];
				// check if it's a function, a query method and not getBlockNumber
				if (
					isQueryMethod(prop) &&
					typeof originalMethod === 'function' &&
					prop !== 'getBlockNumber'
				) {
					return async (...args: unknown[]): Promise<unknown> => {
						let funcArgs: unknown[] = args;
						if (!args.length) {
							// get latest block number and add to arguments
							const latestBlockNumber: bigint = await target.getBlockNumber();
							funcArgs = [latestBlockNumber];
						}
						// call query 4times
						const replicatedQueries = Array.from(
							{ length: REPLICATED_QUERY_LENGTH },
							async () =>
								(originalMethod as QueryFunction<unknown[], unknown>).apply(
									target,
									funcArgs,
								) as Promise<unknown>,
						);
						const promises = await Promise.all(replicatedQueries);

						// check if all the results of the queries are the same
						const areAllEqual: boolean = promises.every(
							(val, _, arr) => stringifyData(val) === stringifyData(arr[0]),
						);
						if (areAllEqual) return promises[0];
						// throw error if the queries are not the same
						throw new Error('query nodes do not match');
					};
				}

				return originalMethod;
			},
		});

		// Eth Module
		this.eth = Object.assign(eth, {
			// ENS module
			ens: self.use(ENS, registryAddresses.main), // registry address defaults to main network

			// Iban helpers
			Iban,

			net: self.use(Net),
			personal: self.use(Personal),

			// Contract helper and module
			Contract: ContractBuilder,

			// ABI Helpers
			abi,

			// Accounts helper
			accounts,
		});
	}
}
export default Web3;

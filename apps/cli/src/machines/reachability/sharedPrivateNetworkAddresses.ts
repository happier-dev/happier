import { isIP } from 'node:net';
import { accessProviderRefsEqualV1, type MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';

/** P21's shared ready-network selection, reused by service and SSH consumers. */
export function readSharedPrivateNetworkAddresses(input: Readonly<{
    observer: readonly MachinePrivateNetworkObservationV1[];
    target: readonly MachinePrivateNetworkObservationV1[];
    networkIdentity?: string;
}>): readonly Readonly<{ address: string; family: number }>[] {
    return input.target.flatMap(network => {
        if (network.state !== 'ready' || network.networkIdentity === null
            || input.networkIdentity !== undefined && network.networkIdentity !== input.networkIdentity
            || !input.observer.some(observer => observer.state === 'ready' && observer.networkIdentity === network.networkIdentity
                && accessProviderRefsEqualV1(observer.provider, network.provider))) return [];
        return network.addresses.flatMap(address => {
            const family = isIP(address);
            return !family || address === '::1' || address.startsWith('127.') || address === '0.0.0.0' || address === '::'
                ? [] : [{ address, family }];
        });
    });
}

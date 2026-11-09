import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import type { MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { MachineFirewallTransitionIntentV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { NativeComposeRuntimeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contributionIdentity';

const unavailable = (): never => {
    throw Object.assign(new Error('private_scope_unenforceable'), { code: 'private_scope_unenforceable' });
};

/** Match saved export intent to effective Compose ports and observed Networks. */
export function privateServicePublicationBindings(input: Readonly<{
    environmentId: string;
    exports: NonNullable<NonNullable<DeploymentEnvironmentContentV1['ownServer']>['serviceExports']>;
    services: NativeComposeRuntimeReview['services'];
    privateNetworks: readonly MachinePrivateNetworkObservationV1[];
}>): NonNullable<MachineFirewallTransitionIntentV1['privateWorkloadBindings']> {
    const bindings: NonNullable<MachineFirewallTransitionIntentV1['privateWorkloadBindings']>['bindings'] = [];
    for (const exported of input.exports) {
        if (exported.exposure !== 'privateNetwork') continue;
        const service = input.services.find(value => value.name === exported.service);
        const publishedPorts = (service?.ports ?? []).filter(port =>
            port.protocol === 'tcp' && Number(port.target) === exported.containerPort);
        // An additional wildcard or public bind would expose the same exported
        // service outside the reviewed private Network.
        if (publishedPorts.length !== 1) return unavailable();
        const matched = input.privateNetworks.flatMap(network => {
            if (network.state !== 'ready' || !exported.privateNetwork || network.networkIdentity !== exported.privateNetwork
                || !network.interfaceName || !network.sourceRanges.length) return [];
            return publishedPorts.flatMap(port => {
                if (!port.bindAddress || !network.addresses.includes(port.bindAddress)) return [];
                const hostPort = Number(port.published);
                if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65_535) return [];
                return [{ exposure: { requirementId: exported.key, exposure: 'privateNetwork' as const,
                    providerId: 'kind' in network.provider ? network.provider.id : buildQualifiedPluginContributionKey(network.provider),
                    networkIdentity: network.networkIdentity, hostAddress: port.bindAddress, hostPort,
                    containerPort: exported.containerPort, protocol: 'tcp' as const },
                    interfaceName: network.interfaceName, sourceRanges: network.sourceRanges }];
            });
        });
        // Connect consumes one concrete address per declared export. Ambiguous
        // effective publications cannot supply that reference.
        if (matched.length !== 1) return unavailable();
        bindings.push(matched[0]!);
    }
    return { environmentId: input.environmentId, bindings };
}

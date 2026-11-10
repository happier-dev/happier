import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import type { MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { MachineFirewallTransitionIntentV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { NativeComposeRuntimeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contributionIdentity';
import { isLiteralLoopbackHostname } from '@happier-dev/protocol';
import { DeploymentServiceExportV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';

const unavailable = (): never => {
    throw Object.assign(new Error('private_scope_unenforceable'), { code: 'private_scope_unenforceable' });
};

type ServicePublications = Pick<Parameters<typeof privateServicePublicationBindings>[0], 'exports' | 'services'>;

function readServicePublication(input: ServicePublications, exported: ServicePublications['exports'][number], loopback = false) {
    const service = input.services.find(value => value.name === exported.service);
    const ports = (service?.ports ?? []).filter(port =>
        port.protocol === 'tcp' && Number(port.target) === exported.containerPort);
    const dual = exported.exposure === 'privateNetwork' && exported.transport?.kind === 'iroh';
    const selected = dual ? ports.filter(port => Boolean(port.bindAddress && isLiteralLoopbackHostname(port.bindAddress)) === loopback) : ports;
    if (ports.length !== (dual ? 2 : 1) || selected.length !== 1) return unavailable();
    const port = selected[0]!;
    const hostPort = Number(port.published);
    return { port, hostPort };
}

/** Iroh reaches an actual loopback publication and never installs a network permit. */
export function assertIrohServicePublications(input: ServicePublications
    & Pick<NativeComposeRuntimeReview, 'risks'>): void {
    for (const exported of input.exports) {
        if (exported.transport?.kind !== 'iroh') continue;
        if (input.risks.some(risk => risk.kind === 'host_network' && risk.service === exported.service)) return unavailable();
        const { port, hostPort } = readServicePublication(input, exported, true);
        // Omitted or zero asks Docker for an ephemeral port; inspection supplies
        // the positive assigned port before any connection can resolve.
        if (port.published !== null && port.published !== 0 && port.published !== '0'
            && !DeploymentServiceExportV1Schema.shape.containerPort.safeParse(hostPort).success) return unavailable();
        if (!port.bindAddress || !isLiteralLoopbackHostname(port.bindAddress)) return unavailable();
    }
}

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
        // An additional wildcard or public bind would expose the same exported
        // service outside the reviewed private Network.
        const { port, hostPort } = readServicePublication(input, exported);
        if (!DeploymentServiceExportV1Schema.shape.containerPort.safeParse(hostPort).success) return unavailable();
        const matched = input.privateNetworks.flatMap(network => {
            if (network.state !== 'ready' || !exported.privateNetwork || network.networkIdentity !== exported.privateNetwork
                || !network.interfaceName || !network.sourceRanges.length) return [];
            if (!port.bindAddress || !network.addresses.includes(port.bindAddress)) return [];
            return [{ exposure: { requirementId: exported.key, exposure: 'privateNetwork' as const,
                providerId: 'kind' in network.provider ? network.provider.id : buildQualifiedPluginContributionKey(network.provider),
                networkIdentity: network.networkIdentity, hostAddress: port.bindAddress, hostPort,
                containerPort: exported.containerPort, protocol: 'tcp' as const },
                interfaceName: network.interfaceName, sourceRanges: network.sourceRanges }];
        });
        // Connect consumes one concrete address per declared export. Ambiguous
        // effective publications cannot supply that reference.
        if (matched.length !== 1) return unavailable();
        bindings.push(matched[0]!);
    }
    return { environmentId: input.environmentId, bindings };
}

import type { ActionExecutorContext, DeploymentDomainChildRpcV1 } from '@happier-dev/protocol';
import type { HostReviewedChildInvocationV1 } from '@happier-dev/protocol/actions/executor/types';
import type { DeploymentDomainHeaderV1, DeploymentDomainTopologyV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentDomainTunnelOwnershipV1, DeploymentDomainTunnelDispositionV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { parseMachineSecretGrantSubjectKey, type DeploymentDomainContentV1 } from '@happier-dev/deployment-protocol';
import { readCloudflareNamedControllerSelection } from '@happier-dev/cli-common/relayAccess';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { StoredCredentials } from '@/persistence';
import { readEnvironmentDomainSecretLaunchAdmissionForHost,
    bindMachineConnectorSecretsForHost } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';
import type { createOwnServerDomainContentWriter } from './ownServerDomainActions';
import { projectActionFailureCauseV1, type ActionExecuteFailure, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

const refuse = (code: string, details?: Readonly<{ requiredFact: string }>): never => {
    throw Object.assign(new Error(code), { code, ...(details ? { details } : {}) });
};
/** Keep the remote result's diagnosis when Domain execution has not reached Caddy. */
function refuseCloudflare(code: string, phase: 'preparation' | 'retirement', options: Readonly<{
    providerCode?: string; child?: ActionExecuteFailure; providerOutput?: string;
    failureCause?: ActionFailureCauseV1; tunnelId?: string;
}> = {}): never {
    const { child, providerOutput, failureCause, tunnelId, providerCode = code } = options;
    const failure: ActionExecuteFailure = { ok: false, errorCode: code, error: code,
        details: { requiredFact: 'cloudflarePreparation', ...(providerOutput ? { providerOutput } : {}),
            ...(tunnelId ? { tunnelId } : {}) },
        failureCause: child?.failureCause ?? failureCause ?? projectActionFailureCauseV1(Object.assign(new Error(providerCode), { code: providerCode }), `deployment.domain.cloudflare_${phase}`),
        ...(typeof child?.effectAttempted === 'boolean' ? { effectAttempted: child.effectAttempted } : {}) };
    throw Object.assign(new Error(code, { cause: failure }), { code });
}
type Connector = NonNullable<NonNullable<DeploymentDomainContentV1['cloudflarePreparation']>['connectors']>[number];
type Grant = Pick<Connector, 'machineId' | 'installationId' | 'grantRef'>;
type Prepared = { kind: 'prepared' | 'unknown' | 'refused'; code?: string; providerOutput?: string; tunnelId?: string;
    tunnelOwnership?: DeploymentDomainTunnelOwnershipV1;
    failureCause?: ActionFailureCauseV1; grants?: readonly Grant[]; dnsOwnership?: readonly Readonly<{ hostname: string; recordId: string }>[] };

/** One Account operation prepares a shared tunnel; each real target receives its own sealed grant. */
export async function prepareCloudflareDomainForHost(input: Readonly<{
    domain: DeploymentDomainHeaderV1; content: DeploymentDomainContentV1;
    topology: DeploymentDomainTopologyV1; context: ActionExecutorContext;
    host: Readonly<{ serverId: string; machineId: string; credentials: StoredCredentials; installedCredentials?: StoredCredentials;
        serverHttpBaseUrl: string;
        persistPreparedContent: ReturnType<typeof createOwnServerDomainContentWriter> }>;
}>): Promise<Readonly<{ domain: DeploymentDomainHeaderV1; content: DeploymentDomainContentV1 }>> {
    const { host, domain, content, topology, context } = input;
    const selected = readCloudflareNamedControllerSelection(content.ingress);
    if (!selected) return { domain, content };
    const origin = topology.tunnelOrigin;
    const identity = readInstallationIdentityIfExistsSync();
    const child = context.hostReviewedChild;
    if (!origin) return refuse('required_fact_unavailable', { requiredFact: 'cloudflare_tunnel_origin' });
    if (!identity) return refuse('required_fact_unavailable', { requiredFact: 'installation_identity' });
    if (!child) return refuse('required_fact_unavailable', { requiredFact: 'reviewed_cloudflare_child' });
    const purpose = selected.selection.credentialRefs.find(item => item.purpose === 'tunnel.manage');
    if (purpose?.credentialRef.kind !== 'connectedAccount') return refuse('connected_account_required');
    const admissions: Awaited<ReturnType<typeof readEnvironmentDomainSecretLaunchAdmissionForHost>>[] = [];
    const acknowledged: Grant[] = [];
    const previous = content.cloudflarePreparation;
    const desired = [{ hostname: content.hostname, ...(content.target.path ? { path: content.target.path } : {}),
        service: origin.service }];
    try {
        for (const member of origin.members) {
            const capture = domain.placements?.find(item => item.desired && item.placement.machineId === member.machineId
                && item.placement.installationId === member.installationId && item.placement.nativeServer === member.nativeServer);
            if (!capture) return refuse('target_mismatch');
            const admitted = await readEnvironmentDomainSecretLaunchAdmissionForHost({ credentials: host.installedCredentials ?? host.credentials,
                serverId: host.serverId, serverHttpBaseUrl: host.serverHttpBaseUrl, machineId: host.machineId,
                installationId: identity.installationId, environmentId: domain.environmentId, targetLinkId: capture.placement.targetLinkId,
                context, signal: context.signal ?? new AbortController().signal, materialization: { kind: 'domain', domainId: domain.id,
                    expectedDomainRevision: domain.revision, actionOperationId: capture.placement.actionOperationId, capture } });
            admissions.push(admitted);
        }
        const service = bindMachineConnectorSecretsForHost({ credentials: host.installedCredentials ?? host.credentials,
            serverId: host.serverId, serverHttpBaseUrl: host.serverHttpBaseUrl, context, domain,
            signal: context.signal ?? new AbortController().signal,
            domainAdmissions: admissions.flatMap(item => item.domainAdmission ? [item.domainAdmission] : []),
            assertCurrent: async () => { context.signal?.throwIfAborted(); }, onGrant: grant => acknowledged.push(grant) });
        const result = await child.invoke({ action: { pluginId: purpose.credentialRef.account.service.pluginId, localId: 'cloudflare-named/configure' }, role: 'configure',
            input: { credentialRef: purpose.credentialRef.account, accountId: selected.controller.accountId, zoneId: selected.controller.zoneId,
                tunnel: previous ? { kind: 'adopt', tunnelId: previous.tunnelId, name: selected.controller.tunnel.name } : selected.controller.tunnel,
                owned: previous?.owned ?? selected.controller.owned, desired, dnsOwnership: previous?.dnsOwnership ?? selected.controller.dnsOwnership },
            invocationServices: { machineConnectorSecrets: service } });
        // The contributed runtime validates this result with the declared closed Action schema.
        const prepared = result.ok ? result.result as Prepared : undefined;
        const knownSubject = acknowledged[0] && parseMachineSecretGrantSubjectKey(acknowledged[0].grantRef);
        const tunnelId = prepared?.tunnelId ?? (knownSubject?.kind === 'connectorToken' ? knownSubject.connectorId : undefined);
        let updated = domain;
        let preparedContent = content;
        if (tunnelId) {
            // Re-preparation adopts this ID; preserve witnessed creation and
            // keep older records without provenance unknown.
            const tunnelOwnership = previous ? previous.tunnelOwnership : prepared?.tunnelOwnership;
            const connectors = acknowledged.map(grant => {
                const member = origin.members.find(item => item.machineId === grant.machineId && item.installationId === grant.installationId);
                if (!member) return refuse('target_mismatch');
                return { ...grant, ...selected.controller.connector, networkName: member.networkName };
            });
            const capture = domain.placements?.find(item => item.desired);
            if (!capture) return refuse('target_mismatch');
            try {
                preparedContent = { ...content,
                    cloudflarePreparation: { tunnelId, owned: desired.map(({ service, ...route }) => ({ ...route, expectedService: service })),
                        ...(tunnelOwnership ? { tunnelOwnership } : {}),
                        dnsOwnership: [...(prepared?.dnsOwnership ?? previous?.dnsOwnership ?? selected.controller.dnsOwnership)],
                        connectors: [...(previous?.connectors ?? []).filter(old => !connectors.some(current =>
                            old.machineId === current.machineId && old.installationId === current.installationId)), ...connectors] } };
                updated = await host.persistPreparedContent({ domain, capture, context, content: preparedContent });
            } catch (error) {
                const failureCause = projectActionFailureCauseV1(error, 'deployment.domain.cloudflare_preparation');
                return refuseCloudflare(failureCause.errorCode ?? 'outcome_unknown', 'preparation', { failureCause, tunnelId });
            }
        }
        if (!result.ok) return refuseCloudflare(result.errorCode, 'preparation', { child: result, tunnelId });
        if (prepared?.kind !== 'prepared') return refuseCloudflare(prepared?.kind === 'unknown' ? 'outcome_unknown'
            : prepared?.code ?? 'provider_unavailable', 'preparation', { providerCode: prepared?.code ?? 'provider_unavailable',
            providerOutput: prepared?.providerOutput, failureCause: prepared?.failureCause, tunnelId });
        return { domain: updated, content: preparedContent };
    } finally { await Promise.all(admissions.map(item => item.release?.())); }
}

/** Retire this Domain's reviewed resources using Home's captured last-consumer decision. */
export async function disableCloudflareDomainForHost(content: DeploymentDomainContentV1,
    context: ActionExecutorContext, retireTunnel = false): Promise<DeploymentDomainTunnelDispositionV1 | undefined> {
    const selected = readCloudflareNamedControllerSelection(content.ingress);
    if (!selected) return;
    const prepared = content.cloudflarePreparation;
    const purpose = selected.selection.credentialRefs.find(item => item.purpose === 'tunnel.manage');
    if (!context.hostReviewedChild) return refuse('required_fact_unavailable', { requiredFact: 'reviewed_cloudflare_child' });
    if (purpose?.credentialRef.kind !== 'connectedAccount') return refuse('connected_account_required');
    const pluginId = purpose.credentialRef.account.service.pluginId;
    const recovered = context.hostReviewedChild.preparedChildren?.find(child => child.role === 'disable'
        && typeof child.action !== 'string' && child.action.pluginId === pluginId
        && child.action.localId === 'cloudflare-named/disable');
    const request: HostReviewedChildInvocationV1 | undefined = prepared ? {
        action: { pluginId, localId: 'cloudflare-named/disable' }, role: 'disable',
        input: { credentialRef: purpose.credentialRef.account, accountId: selected.controller.accountId,
            zoneId: selected.controller.zoneId, tunnelId: prepared.tunnelId,
            ...(prepared.tunnelOwnership ? { tunnelOwnership: prepared.tunnelOwnership } : {}), retireTunnel,
            owned: prepared.owned, dnsOwnership: prepared.dnsOwnership },
    } : recovered;
    if (!request) return refuse('required_fact_unavailable', { requiredFact: 'reviewed_cloudflare_child' });
    const result = await context.hostReviewedChild.invoke(request);
    if (!result.ok) return refuseCloudflare(result.errorCode, 'retirement', { child: result });
    // The contributed runtime validates the declared closed Action result.
    const disabled = result.result as { kind: 'verified' | 'unknown' | 'refused'; code?: string; providerOutput?: string;
        tunnel?: DeploymentDomainTunnelDispositionV1 };
    if (disabled.kind !== 'verified') return refuseCloudflare(disabled.kind === 'unknown' ? 'outcome_unknown'
        : disabled.code ?? 'provider_unavailable', 'retirement', { providerCode: disabled.code ?? 'provider_unavailable', providerOutput: disabled.providerOutput });
    return disabled.tunnel;
}

/** Native children consume only their own saved value-free operand. */
export function cloudflareDomainConnectorForTarget(content: DeploymentDomainContentV1,
    target: Readonly<{ machineId: string; installationId: string }>): DeploymentDomainChildRpcV1['cloudflareConnector'] {
    const prepared = content.cloudflarePreparation;
    const connector = prepared?.connectors?.find(item => item.machineId === target.machineId && item.installationId === target.installationId);
    return prepared && connector ? { tunnelId: prepared.tunnelId, grantRef: connector.grantRef,
        connector: { imageRef: connector.imageRef, version: connector.version }, networkName: connector.networkName } : undefined;
}

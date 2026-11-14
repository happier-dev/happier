import { refuseDeploymentArtifactRead } from '@/deployments/deploymentFailure';
import type { ActionExecutorContext, DeploymentDomainChildRpcV1 } from '@happier-dev/protocol';
import type { HostReviewedChildInvocationV1 } from '@happier-dev/protocol/actions/executor/types';
import type { DeploymentDomainHeaderV1, DeploymentDomainTopologyV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentDomainArtifactV1, parseMachineSecretGrantSubjectKey,
    type DeploymentDomainContentV1, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
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
function refuseCloudflare(code: string, phase: 'preparation' | 'retirement', providerCode = code,
    child?: ActionExecuteFailure, providerOutput?: string, failureCause?: ActionFailureCauseV1): never {
    const failure: ActionExecuteFailure = { ok: false, errorCode: code, error: code,
        details: { requiredFact: 'cloudflarePreparation', ...(providerOutput ? { providerOutput } : {}),
            remedy: 'Inspect the selected Cloudflare tunnel and its owned hostname routes, resolve the reported provider error, then review the Domain operation again.' },
        failureCause: child?.failureCause ?? failureCause ?? projectActionFailureCauseV1({ code: providerCode }, `deployment.domain.cloudflare_${phase}`),
        ...(typeof child?.effectAttempted === 'boolean' ? { effectAttempted: child.effectAttempted } : {}) };
    throw Object.assign(new Error(code, { cause: failure }), { code });
}
type Connector = NonNullable<NonNullable<DeploymentDomainContentV1['cloudflarePreparation']>['connectors']>[number];
type Grant = Pick<Connector, 'machineId' | 'installationId' | 'grantRef'>;
type Prepared = { kind: 'prepared' | 'unknown' | 'refused'; code?: string; providerOutput?: string; tunnelId?: string;
    failureCause?: ActionFailureCauseV1; grants?: readonly Grant[]; dnsOwnership?: readonly Readonly<{ hostname: string; recordId: string }>[] };

/** One Account operation prepares a shared tunnel; each real target receives its own sealed grant. */
export async function prepareCloudflareDomainForHost(input: Readonly<{
    domain: DeploymentDomainHeaderV1; topology: DeploymentDomainTopologyV1; context: ActionExecutorContext;
    host: Readonly<{ serverId: string; machineId: string; credentials: StoredCredentials; installedCredentials?: StoredCredentials;
        serverHttpBaseUrl: string; open(id: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null>;
        persistPreparedContent: ReturnType<typeof createOwnServerDomainContentWriter> }>;
}>): Promise<DeploymentDomainHeaderV1> {
    const { host, domain, topology, context } = input;
    const opened = readDeploymentDomainArtifactV1(domain, await host.open(domain.contentArtifactId, context));
    if (!opened.ok) return refuseDeploymentArtifactRead(opened);
    const selected = readCloudflareNamedControllerSelection(opened.content.ingress);
    if (!selected) return domain;
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
    const previous = opened.content.cloudflarePreparation;
    const desired = [{ hostname: opened.content.hostname, ...(opened.content.target.path ? { path: opened.content.target.path } : {}),
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
        if (tunnelId) {
            const connectors = acknowledged.map(grant => {
                const member = origin.members.find(item => item.machineId === grant.machineId && item.installationId === grant.installationId);
                if (!member) return refuse('target_mismatch');
                return { ...grant, ...selected.controller.connector, networkName: member.networkName };
            });
            const capture = domain.placements?.find(item => item.desired);
            if (!capture) return refuse('target_mismatch');
            updated = await host.persistPreparedContent({ domain, capture, context, content: { ...opened.content,
                cloudflarePreparation: { tunnelId, owned: desired.map(({ service, ...route }) => ({ ...route, expectedService: service })),
                    dnsOwnership: [...(prepared?.dnsOwnership ?? previous?.dnsOwnership ?? selected.controller.dnsOwnership)],
                    connectors: [...(previous?.connectors ?? []).filter(old => !connectors.some(current =>
                        old.machineId === current.machineId && old.installationId === current.installationId)), ...connectors] } } });
        }
        if (!result.ok) return refuseCloudflare(result.errorCode, 'preparation', result.errorCode, result);
        if (prepared?.kind !== 'prepared') return refuseCloudflare(prepared?.kind === 'unknown' ? 'outcome_unknown'
            : prepared?.code ?? 'provider_unavailable', 'preparation', prepared?.code ?? 'provider_unavailable', undefined,
            prepared?.providerOutput, prepared?.failureCause);
        return updated;
    } finally { await Promise.all(admissions.map(item => item.release?.())); }
}

/** Remove only this Domain's reviewed remote routes; shared native retirement is captured by Home. */
export async function disableCloudflareDomainForHost(content: DeploymentDomainContentV1,
    context: ActionExecutorContext): Promise<void> {
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
            owned: prepared.owned, dnsOwnership: prepared.dnsOwnership },
    } : recovered;
    if (!request) return refuse('required_fact_unavailable', { requiredFact: 'reviewed_cloudflare_child' });
    const result = await context.hostReviewedChild.invoke(request);
    if (!result.ok) return refuseCloudflare(result.errorCode, 'retirement', result.errorCode, result);
    // The contributed runtime validates the declared closed Action result.
    const disabled = result.result as { kind: 'verified' | 'unknown' | 'refused'; code?: string; providerOutput?: string };
    if (disabled.kind !== 'verified') return refuseCloudflare(disabled.kind === 'unknown' ? 'outcome_unknown'
        : disabled.code ?? 'provider_unavailable', 'retirement', disabled.code ?? 'provider_unavailable', undefined, disabled.providerOutput);
}

/** Native children consume only their own saved value-free operand. */
export function cloudflareDomainConnectorForTarget(content: DeploymentDomainContentV1,
    target: Readonly<{ machineId: string; installationId: string }>): DeploymentDomainChildRpcV1['cloudflareConnector'] {
    const prepared = content.cloudflarePreparation;
    const connector = prepared?.connectors?.find(item => item.machineId === target.machineId && item.installationId === target.installationId);
    return prepared && connector ? { tunnelId: prepared.tunnelId, grantRef: connector.grantRef,
        connector: { imageRef: connector.imageRef, version: connector.version }, networkName: connector.networkName } : undefined;
}

import type { AgentConnectedAccountNativeAuthCodecV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountServiceKey, ConnectedServiceBindingsV2, QualifiedConnectedAccountPurposeBindingV1 } from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { AgentSessionAuthRefreshPayloadV1Schema } from '@happier-dev/protocol/runtime/authRefresh';
import { ConnectedServiceCredentialRevisionV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';

import type { ConnectedServiceDaemonAuthBridgeRegistration } from './daemonAuthBridgeTypes';
import type { ConnectedAccountPurposeAuthorizationScope, ConnectedAccountPurposeBindingOwner } from './purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ConnectedServiceRefreshCoordinator } from './refresh/ConnectedServiceRefreshCoordinator';
import { ConnectedServiceRuntimeAuthRefreshSelectionSchema } from './runtimeAuthRefreshAuthorization';
import { parseDaemonAuthBridgeRefreshSettlement } from './sessionRuntimeAuthRefresh';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { AgentSessionRunnerBindingV1 } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { connectedAccountSessionPurposeBindingSubjectId } from './purposeBindings/ConnectedAccountPurposeBindingOwner';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './requestAuth/prepareConnectedAccountRequestAuthForSpawn';

export type NativeAuthRuntimeRefreshScope = Readonly<{
    subjectId: string;
    fileMaterializationPurposes: readonly ConnectedAccountPurposeAuthorizationScope[];
    bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
    codec: NonNullable<AgentConnectedAccountNativeAuthCodecV1['runtimeAuthRefresh']>;
    isCurrent(): boolean;
}>;

export type NativeAuthRuntimeRefreshAgentAuthority = Readonly<{
    retainedAgent: AgentSessionRunnerBindingV1;
    isCurrent(): boolean;
}>;

/** Captures the existing exact Session purpose scope from one already acquired registry. */
export function captureSessionNativeAuthRuntimeRefreshScope(input: Readonly<{
    sessionId: string;
    agentId: CatalogAgentId;
    bindings: ConnectedServiceBindingsV2;
    registry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'contributes' | 'readPluginSourceCustody'>;
    codec: NativeAuthRuntimeRefreshScope['codec'];
    retainedAgentAuthority: NativeAuthRuntimeRefreshAgentAuthority;
    isCurrent(): boolean;
}>): NativeAuthRuntimeRefreshScope | null {
    const retained = input.retainedAgentAuthority.retainedAgent;
    const contribution = input.registry.contributes.agentDefinitionsById.get(input.agentId);
    const identity = contribution?.identity;
    const sourceCustody = identity && input.registry.readPluginSourceCustody?.(identity.pluginId);
    const isCurrent = () => input.isCurrent() && input.retainedAgentAuthority.isCurrent();
    if (!isCurrent() || retained.agentId !== input.agentId || !identity || !sourceCustody
        || identity.pluginId !== retained.pluginId || identity.localId !== retained.localAgentId
        || !pluginSourceCustodyV1Equal(sourceCustody, retained.sourceCustody)) return null;
    const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
        agentId: input.agentId, bindings: input.bindings, contributions: input.registry.contributes,
    });
    if (!snapshot?.fileMaterializationPurposes?.length) return null;
    return Object.freeze({ subjectId: connectedAccountSessionPurposeBindingSubjectId(input.sessionId),
        codec: input.codec, bindings: snapshot.bindings,
        fileMaterializationPurposes: snapshot.fileMaterializationPurposes, isCurrent });
}

/** One descriptor-to-declared-purpose projection for both admission proof and materialization. */
export function resolveNativeAuthRuntimeRefreshBinding(
    scope: NativeAuthRuntimeRefreshScope,
    serviceId: ConnectedAccountServiceKey,
): Readonly<{ authorization: ConnectedAccountPurposeAuthorizationScope;
    binding: QualifiedConnectedAccountPurposeBindingV1 }> | null {
    const authorization = scope.fileMaterializationPurposes.find((candidate) =>
        candidate.purpose.purpose === scope.codec.purpose
        && candidate.serviceRefs.some((service) => buildQualifiedPluginContributionKey(service) === serviceId));
    const binding = authorization ? scope.bindings.find((candidate) =>
        qualifiedPurposeKey(candidate.purpose) === qualifiedPurposeKey(authorization.purpose)) : null;
    return authorization && binding ? { authorization, binding } : null;
}

/** The existing qualified credential owner refreshes; the same purpose owner discloses native files. */
export function createNativeAuthRuntimeRefreshBridge(input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    scope: NativeAuthRuntimeRefreshScope;
    purposeBindingOwner: Pick<ConnectedAccountPurposeBindingOwner, 'resolveCurrentRequestAuthBinding' | 'materialize'>;
    refreshCoordinator: Pick<ConnectedServiceRefreshCoordinator, 'refreshQualifiedConnectedAccountCredentialForRuntimeAuth'>;
    signal: AbortSignal;
}>): ConnectedServiceDaemonAuthBridgeRegistration {
    const unavailable = () => ({ status: 'unavailable' as const, reason: 'runtime_auth_binding_not_current' });
    const admitted = resolveNativeAuthRuntimeRefreshBinding(input.scope, input.serviceId);
    const scope = admitted?.authorization;
    const binding = admitted?.binding;
    return Object.freeze({ serviceId: input.serviceId,
        async refresh(request) {
        try {
        const selection = ConnectedServiceRuntimeAuthRefreshSelectionSchema.safeParse(request.selection);
        const revision = ConnectedServiceCredentialRevisionV1Schema.safeParse(request.expectedCredentialRevision);
        if (!scope || !binding || !selection.success || selection.data.serviceId !== input.serviceId
            || !revision.success || !request.refreshAttemptId || !input.scope.isCurrent()) return unavailable();
        const readCurrent = async () => await input.purposeBindingOwner.resolveCurrentRequestAuthBinding({
            subjectId: input.scope.subjectId, binding, signal: input.signal,
        });
        const before = await readCurrent();
        const selectedAccountId = selection.data.kind === 'profile' ? selection.data.profileId : selection.data.activeProfileId;
        const selectionIsCurrent = (current: Awaited<ReturnType<typeof readCurrent>>) => Boolean(current
            && current.account.accountId === selectedAccountId
            && buildQualifiedPluginContributionKey(current.account.service) === input.serviceId
            && (selection.data.kind === 'profile' ? !current.group
                : current.group?.groupId === selection.data.groupId && current.group.generation === selection.data.generation));
        if (!selectionIsCurrent(before) || !before || !input.scope.isCurrent()) return unavailable();
        const refreshed = await input.refreshCoordinator.refreshQualifiedConnectedAccountCredentialForRuntimeAuth({
            account: before.account, expectedCredentialRevision: revision.data, refreshAttemptId: request.refreshAttemptId,
        });
        if (refreshed.status !== 'refreshed' || !input.scope.isCurrent()) return unavailable();
        const after = await readCurrent();
        if (!after || !selectionIsCurrent(after) || !sameQualifiedConnectedAccountRef(before.account, after.account)
            || after.credentialRevision !== refreshed.credentialRevision || !input.scope.isCurrent()) return unavailable();
        let materializedRevision: string | null = null;
        const materialization = await input.purposeBindingOwner.materialize({
            ...scope, exactPurposeBindingSubjectId: input.scope.subjectId, expectedAccount: after.account,
            request: input.scope.codec.materialization, signal: input.signal,
            credentialRevisionBasis: { expectedCredentialRevision: after.credentialRevision,
                captureCredentialRevision(value) { materializedRevision = value; } },
        });
        const settled = await readCurrent();
        if (materialization.kind !== 'files' || materializedRevision !== refreshed.credentialRevision
            || !settled || !selectionIsCurrent(settled) || settled.credentialRevision !== refreshed.credentialRevision
            || !input.scope.isCurrent()) return unavailable();
        const result = AgentSessionAuthRefreshPayloadV1Schema.parse(input.scope.codec.decode({
            files: materialization.files, credentialRevision: refreshed.credentialRevision,
            ...(request.planType === undefined ? {} : { planType: typeof request.planType === 'string' ? request.planType : null }),
        }));
        return input.scope.isCurrent() ? parseDaemonAuthBridgeRefreshSettlement({ status: 'refreshed', result }, request.refreshAttemptId) : unavailable();
        } catch {
            return input.scope.isCurrent() ? { status: 'failed' as const, reason: 'runtime_auth_refresh_failed' } : unavailable();
        }
    } });
}

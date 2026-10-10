import type { Session } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ResolvedSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
import { getProfileCatalogSnapshot } from '@/sync/store/settings/profileCatalogSnapshot';
import { createSessionInputFailureError } from '@/components/sessions/pending/pendingMessageVisualState';
import { createUiExecutionRunActionDeps } from '@/sync/ops/actions/executionRunActionDeps';
import { t } from '@/text';

import { ensureExecutionRunHostSessionActive } from './ensureExecutionRunHostSessionActive';

type ResumeContext = Parameters<typeof ensureExecutionRunHostSessionActive>[0];

function assertConfiguredAcpTargetsCurrent(
    scope: ServerAccountScopeLifetime['scope'],
    targets: readonly (PersistedBackendTargetRefV2 | null | undefined)[],
): void {
    const configuredTargets = targets.filter((target) => target?.kind === 'backend' && target.configuredBackendId);
    if (configuredTargets.length === 0) return;
    const snapshot = getAcpCatalogSnapshot(scope);
    const refuse = () => { throw Object.assign(new Error(t('common.unavailable')), { code: 'acp_catalog_unavailable' }); };
    if (!snapshot || snapshot.stale || snapshot.catalog.status !== 'ready') return refuse();
    const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: [], acpCatalogSnapshot: snapshot.catalog });
    if (configuredTargets.some((target) => !entries.some((entry) => target && backendTargetKeysMatch(target, entry.backendTarget)))) refuse();
}

export function isExecutionRunSessionProfileReady(session: Session | null, catalog: ProfileCatalogSnapshotV1 | null | undefined): boolean {
    const profileId = session?.metadata?.profileId;
    return typeof profileId !== 'string' || profileId.trim().length === 0
        || (catalog?.status === 'ready' && catalog.source === 'destination');
}

/** The existing launcher admission, shared by its hook and no-invoke host selection. */
export async function admitExecutionRunLaunchTarget(input: Readonly<{
    sessionId: string | null;
    cwd?: string;
    serverId: string | null;
    session: Session | null;
    exactSettings: Settings | null;
    settings: Settings;
    accountLifetime: ServerAccountScopeLifetime | null;
    machineId: string | null;
    machineTarget?: ResumeContext['machineTarget'];
    machineReachable: boolean;
    resumeCapabilityOptions: ResumeContext['resumeCapabilityOptions'];
    defaultBackend: ResolvedSessionActionDefaultBackend | null;
    runBackendTargets?: readonly PersistedBackendTargetRefV2[];
    requirements: Readonly<{ secretReferenceOverlay: boolean; teamCredentialModel: boolean; roleBinding?: boolean }>;
    readinessOperationId: string;
}>) {
    const { session, exactSettings, accountLifetime, machineId, serverId, sessionId, requirements } = input;
    const detached = sessionId === null;
    if ((!detached && !session) || !exactSettings || !accountLifetime?.isCurrent()
        || (detached && (!machineId || !input.cwd || !input.machineReachable))) throw new Error(t('common.unavailable'));
    const targets = [input.defaultBackend?.backendTarget, ...(input.runBackendTargets ?? [])];
    assertConfiguredAcpTargetsCurrent(accountLifetime.scope, targets);
    if (!isExecutionRunSessionProfileReady(session, getProfileCatalogSnapshot(accountLifetime.scope)?.catalog)) {
        throw new Error(t('common.unavailable'));
    }
    let admittedMachineId: string | undefined;
    const runScopedAgentBindings = requirements.teamCredentialModel || requirements.roleBinding === true;
    if (detached || requirements.secretReferenceOverlay || runScopedAgentBindings) {
        const capability = await createUiExecutionRunActionDeps().executionRunCheckProtocolV2?.(sessionId, {
            detachedScope: detached, startAndWait: false, exactInputResults: false,
            runScopedAgentBindings, secretReferenceOverlay: requirements.secretReferenceOverlay,
        }, { ...(serverId ? { serverId } : {}), ...(machineId ? { targetMachineId: machineId } : {}) });
        if (!capability) throw createSessionInputFailureError('execution_run_target_changed');
        if (capability.ok === false) {
            if (requirements.secretReferenceOverlay && capability.errorCode === 'execution_run_protocol_unsupported') {
                throw createSessionInputFailureError('execution_run_secret_reference_overlay_update_required');
            }
            throw new Error(capability.error);
        }
        if (capability.exactMachineId !== machineId) throw createSessionInputFailureError('execution_run_target_changed');
        admittedMachineId = capability.exactMachineId;
    }
    if (detached) {
        if (!accountLifetime.isCurrent()) throw new Error(t('common.unavailable'));
        assertConfiguredAcpTargetsCurrent(accountLifetime.scope, targets);
        return;
    }
    if (!session || !sessionId) throw new Error(t('common.unavailable'));
    const active = await ensureExecutionRunHostSessionActive({ sessionId, session,
        machineReachable: input.machineReachable, resumeCapabilityOptions: input.resumeCapabilityOptions,
        sessionActionDefaultBackend: input.defaultBackend, agentId: input.defaultBackend?.defaultAgentId ?? null,
        settings: input.settings, serverId, accountLifetime,
        ...(input.machineTarget ? { machineTarget: input.machineTarget } : {}),
        readinessOperationId: input.readinessOperationId,
        ...(admittedMachineId ? { expectedMachineId: admittedMachineId } : {}) });
    if (!active.ok) throw new Error(active.reason === 'machine_offline'
        ? t('session.machineOfflineCannotResume') : active.error ?? t('session.resumeFailed'));
    if (!accountLifetime.isCurrent()) throw new Error(t('common.unavailable'));
    assertConfiguredAcpTargetsCurrent(accountLifetime.scope, targets);
    if (!isExecutionRunSessionProfileReady(session, getProfileCatalogSnapshot(accountLifetime.scope)?.catalog)) {
        throw new Error(t('common.unavailable'));
    }
}

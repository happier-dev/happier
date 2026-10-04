import type { Session } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ResolvedSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { createSessionInputFailureError } from '@/components/sessions/pending/pendingMessageVisualState';
import { createUiExecutionRunActionDeps } from '@/sync/ops/actions/executionRunActionDeps';
import { t } from '@/text';

import { ensureExecutionRunHostSessionActive } from './ensureExecutionRunHostSessionActive';

type ResumeContext = Parameters<typeof ensureExecutionRunHostSessionActive>[0];

/** The existing launcher admission, shared by its hook and no-invoke host selection. */
export async function admitExecutionRunLaunchTarget(input: Readonly<{
    sessionId: string;
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
    requirements: Readonly<{ secretReferenceOverlay: boolean; teamCredentialModel: boolean; roleBinding?: boolean }>;
    readinessOperationId: string;
}>) {
    const { session, exactSettings, accountLifetime, machineId, serverId, sessionId, requirements } = input;
    if (!session || !exactSettings || !accountLifetime?.isCurrent()) throw new Error(t('common.unavailable'));
    let admittedMachineId: string | undefined;
    const runScopedAgentBindings = requirements.teamCredentialModel || requirements.roleBinding === true;
    if (requirements.secretReferenceOverlay || runScopedAgentBindings) {
        const capability = await createUiExecutionRunActionDeps().executionRunCheckProtocolV2?.(sessionId, {
            detachedScope: false, startAndWait: false, exactInputResults: false,
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
}

import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { buildResumeSessionExtrasFromUiState } from '@/agents/catalog/catalog';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { getPermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import {
    resolveSessionActionDefaultTarget,
    type ResolvedSessionActionDefaultBackend,
} from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import type { Settings } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resumeSession } from '@/sync/ops/sessions';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type EnsureExecutionRunHostSessionActiveResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: 'machine_offline' | 'not_resumable' | 'resume_failed'; error?: string }>;

/**
 * One resume-before-Run-start owner shared by the bounded launcher and the
 * empty Agent-conversation launcher. It reuses ordinary Session resume and
 * introduces no Run-specific wake path.
 */
export async function ensureExecutionRunHostSessionActive(input: Readonly<{
    sessionId: string;
    session: Session;
    machineReachable: boolean;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    sessionActionDefaultBackend: ResolvedSessionActionDefaultBackend | null;
    agentId: string | null;
    settings: Settings;
    serverId?: string | null;
    accountLifetime?: ServerAccountScopeLifetime;
    machineTarget?: Readonly<{ machineId: string; basePath: string }>;
    /** Stable identity of the user operation that will start/admit this Run. */
    readinessOperationId?: string;
    /** Exact Machine proven by Run capability admission before an inactive resume. */
    expectedMachineId?: string;
}>): Promise<EnsureExecutionRunHostSessionActiveResult> {
    if (input.session.active !== false) return { ok: true };
    if (!input.machineReachable) return { ok: false, reason: 'machine_offline' };
    if (input.expectedMachineId) {
        const currentTarget = readMachineControlTargetForSession(input.serverId
            ? { serverId: input.serverId, sessionId: input.sessionId }
            : input.sessionId);
        if (currentTarget?.machineId !== input.expectedMachineId) {
            return {
                ok: false,
                reason: 'resume_failed',
                error: 'execution_run_target_changed',
            };
        }
    }

    const permissionOverride = getPermissionModeOverrideForSpawn(input.session);
    const target = resolveSessionActionDefaultTarget(input.sessionActionDefaultBackend);
    const modelOverride = input.sessionActionDefaultBackend && target
        ? getModelOverrideForSpawn(input.session, buildBackendTargetKeyV2(target))
        : null;
    const base = buildResumeSessionBaseOptionsFromSession({
        sessionId: input.sessionId,
        session: input.session,
        resumeCapabilityOptions: input.resumeCapabilityOptions,
        ...(input.machineTarget ? { resumeTargetOverride: { machineId: input.machineTarget.machineId, directory: input.machineTarget.basePath } } : {}),
        permissionOverride,
        modelOverride,
    });
    if (!base || !input.agentId) return { ok: false, reason: 'not_resumable' };

    const result = await resumeSession({
        ...base,
        ...(input.accountLifetime ? { accountLifetime: input.accountLifetime } : {}),
        ...(input.serverId ? { serverId: input.serverId } : {}),
        ...buildResumeSessionExtrasFromUiState({
            agentId: input.agentId,
            settings: input.settings,
            session: input.session,
        }),
        ...(input.readinessOperationId
            ? {
                spawnNonce: `execution-run-host-${input.readinessOperationId}`,
                waitForReady: true,
            }
            : {}),
    });
    return result.type === 'error'
        ? { ok: false, reason: 'resume_failed', error: result.errorMessage }
        : { ok: true };
}

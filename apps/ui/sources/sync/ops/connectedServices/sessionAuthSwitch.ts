import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { prepareAccountSettingsForDaemonSpawnIfNeeded } from '@/sync/ops/accountSettingsDaemonSpawnPreparation';
import type {
    ConnectedServiceBindingsV1,
    ConnectedServiceId,
    ConnectedServiceUxDiagnosticV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

export const SESSION_CONNECTED_SERVICE_AUTH_SWITCH_MACHINE_RPC_METHOD =
    RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH;

// The daemon switch owner can legitimately spend one 60s turn-boundary wait plus
// one 60s bounded application window. Keep the outer machine acknowledgement
// above the daemon HTTP budget so a healthy completion cannot be reported as a
// UI failure first.
const SESSION_CONNECTED_SERVICE_AUTH_SWITCH_MACHINE_RPC_TIMEOUT_MS = 210_000;

export type SessionConnectedServiceAuthSwitchStatus =
    | 'hot_applied'
    | 'metadata_updated'
    | 'restart_requested'
    | 'unchanged';

export type SessionConnectedServiceAuthSwitchErrorCode =
    | 'session_not_found'
    | 'agent_mismatch'
    | 'unsupported_service'
    | 'profile_missing'
    | 'profile_disconnected'
    | 'group_missing'
    | 'group_generation_conflict'
    | 'not_group_selection'
    | 'connected_service_required'
    | 'profile_action_required'
    | 'provider_state_sharing_required'
    | 'provider_state_sharing_unavailable'
    | 'provider_session_state_unavailable_for_resume'
    | 'metadata_update_failed'
    | 'restart_failed'
    | 'hot_apply_failed'
    | 'bindings_rollback_failed'
    | 'post_switch_recovery_failed'
    | 'provider_account_adoption_mismatch'
    | 'post_switch_verification_failed'
    | 'hot_apply_succeeded_but_recovery_failed'
    | 'partial_applied_pending_reconciliation';

export type SessionConnectedServiceAuthSwitchServiceResult =
    Readonly<{
        status: 'applied' | 'failed' | 'not_attempted';
        errorCode?: string;
    }>;

export type SessionConnectedServiceAuthSwitchDiagnostics =
    Readonly<{
        failurePhase?: 'session_lookup' | 'agent_validation' | 'normalization' | 'continuity' | 'metadata' | 'restart' | 'hot_apply' | 'rollback' | 'recover' | 'post_switch_recovery' | 'post_switch_verification' | 'reconciliation';
        partialState?: 'runtime_auth_partially_applied';
        application?: Readonly<{
            status: 'hot_apply_failed' | 'restart_failed' | 'recover_failed' | 'hot_apply_succeeded_but_recovery_failed' | 'partial_applied_pending_reconciliation';
            phase: 'hot_apply' | 'restart' | 'recover';
            actor?: string;
            reason?: string;
        }>;
        actionRequired?: Readonly<
            | { kind: 'retry' }
            | { kind: 'reconnect_profile'; serviceId?: string; profileId?: string }
            | { kind: 'open_connected_services_settings' }
        >;
        accountSettingsFreshness?: Readonly<{
            requestedVersion: number | null;
            status: 'succeeded' | 'failed';
            error?: string;
        }>;
        serviceResultsByServiceId?: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>>;
        uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
    }>;

export type SessionConnectedServiceAuthSwitchResult =
    | Readonly<{
        ok: true;
        action: SessionConnectedServiceAuthSwitchStatus;
        normalizedBindings?: ConnectedServiceBindingsV1;
        continuityByServiceId?: Readonly<Record<string, string>>;
        warnings?: readonly string[];
      }>
    | Readonly<{
        ok: false;
        error?: string;
        errorCode: SessionConnectedServiceAuthSwitchErrorCode;
        serviceId?: string;
        continuityByServiceId?: Readonly<Record<string, string>>;
        diagnostics?: SessionConnectedServiceAuthSwitchDiagnostics;
      }>;

export async function setSessionConnectedServiceAuthBinding(params: Readonly<{
    sessionId: string;
    agentId: string;
    machineId: string;
    serverId?: string | null;
    bindings: ConnectedServiceBindingsV1;
    rematerializeServiceId?: ConnectedServiceId;
    expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
    accountSettingsVersionHint?: number;
}>): Promise<SessionConnectedServiceAuthSwitchResult> {
    const accountSettingsPreparation = await prepareAccountSettingsForDaemonSpawnIfNeeded(params.accountSettingsVersionHint);
    const accountSettingsVersionHint = typeof params.accountSettingsVersionHint === 'number'
        ? params.accountSettingsVersionHint
        : accountSettingsPreparation.accountSettingsVersionHint;
    const response = await machineRpcWithServerScope<SessionConnectedServiceAuthSwitchResult, {
        sessionId: string;
        agentId: string;
        bindings: ConnectedServiceBindingsV1;
        rematerializeServiceId?: ConnectedServiceId;
        expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
        accountSettingsVersionHint?: number;
    }>({
        machineId: params.machineId,
        serverId: params.serverId ?? null,
        method: SESSION_CONNECTED_SERVICE_AUTH_SWITCH_MACHINE_RPC_METHOD,
        timeoutMs: SESSION_CONNECTED_SERVICE_AUTH_SWITCH_MACHINE_RPC_TIMEOUT_MS,
        // This is a non-idempotent session mutation. Once emitted, the scoped
        // transport must surface uncertainty instead of retrying it on another route.
        onIssued: () => {},
        payload: {
            sessionId: params.sessionId,
            agentId: params.agentId,
            bindings: params.bindings,
            ...(params.rematerializeServiceId ? { rematerializeServiceId: params.rematerializeServiceId } : {}),
            ...(params.expectedGroupGenerationByServiceId
                ? { expectedGroupGenerationByServiceId: params.expectedGroupGenerationByServiceId }
                : {}),
            ...(typeof accountSettingsVersionHint === 'number' ? { accountSettingsVersionHint } : {}),
        },
    });

    return response;
}

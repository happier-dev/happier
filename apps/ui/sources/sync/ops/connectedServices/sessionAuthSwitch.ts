import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { prepareAccountSettingsForDaemonSpawnIfNeeded } from '@/sync/ops/accountSettingsDaemonSpawnPreparation';
import type {
    ConnectedServiceBindingsV2,
    ConnectedAccountServiceKey} from '@happier-dev/protocol/connect/connected-service-bindings';
import type {
    ConnectedServiceUxDiagnosticV1,
} from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionTeamCredentialBindingIntentListV1 } from '@happier-dev/protocol/teams';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';

export const SESSION_CONNECTED_SERVICE_AUTH_SWITCH_MACHINE_RPC_METHOD =
    RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH;

export type SessionConnectedServiceAuthSwitchStatus =
    | 'hot_applied'
    | 'metadata_updated'
    | 'restart_requested'
    | 'unchanged';

export type SessionConnectedServiceAuthSwitchErrorCode =
    | 'session_not_found'
    | 'agent_mismatch'
    | 'unsupported_service'
    | 'continuity_unsupported'
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
        normalizedBindings?: ConnectedServiceBindingsV2;
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

/** The composer consumes the settled domain result after Action approval. */
export function readSessionConnectedServiceAuthSwitchActionResult(result: ActionExecuteResult): SessionConnectedServiceAuthSwitchResult {
    if (!result.ok && result.details && typeof result.details === 'object'
        && 'ok' in result.details && result.details.ok === false) {
        return result.details as Extract<SessionConnectedServiceAuthSwitchResult, { ok: false }>;
    }
    requireActionSuccess(result);
    return result.result as SessionConnectedServiceAuthSwitchResult;
}

export async function setSessionConnectedServiceAuthBinding(params: Readonly<{
    sessionId: string;
    agentId: string;
    machineId: string;
    serverId?: string | null;
    bindings: ConnectedServiceBindingsV2;
    rematerializeServiceId?: ConnectedAccountServiceKey;
    expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
    previousTeamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
    teamVisibilityGrantConsent?: Readonly<{ teamId: string }>;
    accountSettingsVersionHint?: number;
}>): Promise<SessionConnectedServiceAuthSwitchResult> {
    const accountSettingsPreparation = await prepareAccountSettingsForDaemonSpawnIfNeeded(params.accountSettingsVersionHint);
    const accountSettingsVersionHint = typeof params.accountSettingsVersionHint === 'number'
        ? params.accountSettingsVersionHint
        : accountSettingsPreparation.accountSettingsVersionHint;
    const response = await machineRpcWithServerScope<SessionConnectedServiceAuthSwitchResult, {
        sessionId: string;
        agentId: string;
        bindings: ConnectedServiceBindingsV2;
        rematerializeServiceId?: ConnectedAccountServiceKey;
        expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
        teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
        previousTeamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
        teamVisibilityGrantConsent?: Readonly<{ teamId: string }>;
        accountSettingsVersionHint?: number;
    }>({
        machineId: params.machineId,
        serverId: params.serverId ?? null,
        method: SESSION_CONNECTED_SERVICE_AUTH_SWITCH_MACHINE_RPC_METHOD,
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
            ...(params.teamCredentialBindings ? { teamCredentialBindings: params.teamCredentialBindings } : {}),
            ...(params.previousTeamCredentialBindings
                ? { previousTeamCredentialBindings: params.previousTeamCredentialBindings }
                : {}),
            ...(params.teamVisibilityGrantConsent ? { teamVisibilityGrantConsent: params.teamVisibilityGrantConsent } : {}),
            ...(typeof accountSettingsVersionHint === 'number' ? { accountSettingsVersionHint } : {}),
        },
    });

    return response;
}

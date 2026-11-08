import { normalizeSpawnSessionErrorDetail, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { readConnectedServiceUxDiagnosticFromError } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { writePersistedBackendTargetRefV2, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { presentSessionStartupFailureCause, presentSessionStartupFailureRecovery } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { resolveSessionSpawnNewConnectedAccountFailure, resolveSessionSpawnNewResultFailureMessage } from '@/sync/ops/actions/sessionSpawnFailurePresentation';
import { t } from '@/text';

export type ResumeFailurePresentation = Readonly<
    | { kind: 'alert'; message: string; errorCode?: string; reasonCode?: string; recovery?: 'connected_accounts' | 'machine_runtime_reload' }
    | { kind: 'directory_missing'; errorCode: typeof SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING }
    | { kind: 'agent_setup'; errorCode: typeof SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT }
    | { kind: 'plugin_disabled'; message: string; errorCode: 'plugin_disabled'; pluginId: string | null }
>;

export function resolveResumeFailurePresentation(result: Readonly<{
    errorCode?: string | null;
    errorMessage?: string | null;
    details?: unknown;
    errorDetail?: unknown;
}>, fallbackMessage: string, agentTarget?: PersistedBackendTargetRefV2 | null): ResumeFailurePresentation {
    const errorCode = typeof result.errorCode === 'string' ? result.errorCode.trim() : '';
    const detail = normalizeSpawnSessionErrorDetail(result.errorDetail ?? (result.details && typeof result.details === 'object'
        ? Reflect.get(result.details, 'errorDetail') : undefined));
    const cause = detail?.kind === 'connected_service_ux_diagnostic' ? detail.uxDiagnostic.code
        : detail?.kind === 'launch_error' ? detail.code : undefined;
    const startupRecovery = presentSessionStartupFailureRecovery([cause, errorCode]);
    if (startupRecovery) return { kind: 'alert', message: startupRecovery.message,
        errorCode: cause || errorCode, recovery: startupRecovery.recovery };
    if (cause === SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT || errorCode === SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT) {
        return { kind: 'agent_setup', errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT };
    }
    if (errorCode === 'plugin_disabled') {
        const target = agentTarget?.kind === 'backend' ? writePersistedBackendTargetRefV2(agentTarget) : agentTarget;
        return { kind: 'plugin_disabled', errorCode, pluginId: target?.kind === 'agent' ? target.identity.pluginId : null,
            message: presentSessionStartupFailureCause(errorCode) ?? fallbackMessage };
    }
    if (errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING) {
        return { kind: 'directory_missing', errorCode };
    }
    if (detail?.kind === 'provider_error') {
        return { kind: 'alert', errorCode: detail.providerError.code,
            message: resolveSessionSpawnNewResultFailureMessage({ type: 'error', code: 'spawn_failed',
                retryable: detail.providerError.retryable, providerError: detail.providerError }) };
    }
    if (detail?.kind === 'launch_error') {
        const pool = resolveSessionSpawnNewConnectedAccountFailure({ type: 'error', code: 'spawn_failed',
            retryable: false, launchError: detail });
        if (pool) return { kind: 'alert', errorCode: errorCode || detail.code, reasonCode: detail.code,
            recovery: 'connected_accounts', message: pool.message };
    }
    const diagnostic = readConnectedServiceUxDiagnosticFromError({ errorDetail: detail });
    if (diagnostic) return { kind: 'alert', errorCode: diagnostic.code,
        message: resolveSessionSpawnNewResultFailureMessage({ type: 'error', code: 'spawn_failed', retryable: diagnostic.retryable,
            launchError: { kind: 'launch_error', code: diagnostic.code, uxDiagnostic: diagnostic, message: fallbackMessage } }) };
    const causeMessage = presentSessionStartupFailureCause(cause);
    if (cause && causeMessage) return { kind: 'alert', errorCode: cause,
        message: t('errors.errorWithCode', { message: causeMessage, code: cause }) };
    if (errorCode === SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED) {
        return { kind: 'alert', message: fallbackMessage, errorCode };
    }
    const message = typeof result.errorMessage === 'string' ? result.errorMessage.trim() : '';
    return { kind: 'alert', message: message || fallbackMessage, ...(errorCode ? { errorCode } : {}) };
}

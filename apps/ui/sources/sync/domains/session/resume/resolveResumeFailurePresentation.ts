import { normalizeSpawnSessionErrorDetail, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { writePersistedBackendTargetRefV2, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { presentSessionStartupFailureCause } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { t } from '@/text';

export type ResumeFailurePresentation = Readonly<
    | { kind: 'alert'; message: string; errorCode?: string }
    | { kind: 'directory_missing' }
    | { kind: 'plugin_disabled'; message: string; errorCode: 'plugin_disabled'; pluginId: string | null }
>;

export function resolveResumeFailurePresentation(result: Readonly<{
    errorCode?: string | null;
    errorMessage?: string | null;
    details?: unknown;
}>, fallbackMessage: string, agentTarget?: PersistedBackendTargetRefV2 | null): ResumeFailurePresentation {
    const errorCode = typeof result.errorCode === 'string' ? result.errorCode.trim() : '';
    const detail = result.details && typeof result.details === 'object'
        ? normalizeSpawnSessionErrorDetail(Reflect.get(result.details, 'errorDetail')) : undefined;
    const cause = detail?.kind === 'connected_service_ux_diagnostic' ? detail.uxDiagnostic.code
        : detail?.kind === 'launch_error' ? detail.code : undefined;
    if (errorCode === 'plugin_disabled') {
        const target = agentTarget?.kind === 'backend' ? writePersistedBackendTargetRefV2(agentTarget) : agentTarget;
        return { kind: 'plugin_disabled', errorCode, pluginId: target?.kind === 'agent' ? target.identity.pluginId : null,
            message: presentSessionStartupFailureCause(errorCode) ?? fallbackMessage };
    }
    if (errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING) {
        return { kind: 'directory_missing' };
    }
    const causeMessage = presentSessionStartupFailureCause(cause);
    if (cause && causeMessage) return { kind: 'alert', errorCode: cause,
        message: t('errors.errorWithCode', { message: causeMessage, code: cause }) };
    if (errorCode === SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED) {
        return { kind: 'alert', message: fallbackMessage, errorCode };
    }
    const message = typeof result.errorMessage === 'string' ? result.errorMessage.trim() : '';
    return { kind: 'alert', message: message || fallbackMessage, ...(errorCode ? { errorCode } : {}) };
}

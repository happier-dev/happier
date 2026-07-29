import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export const SESSION_DRAFT_VALUES_STORAGE_BASE_KEY = 'session-draft-values-v1';
export const AGENT_INPUT_LOCAL_UI_STATE_STORAGE_BASE_KEY = 'agent-input-local-ui-state-v1';
export const SESSION_VIEWPORT_STORAGE_BASE_KEY = 'session-viewport-v1';
export const SESSION_VIEWPORT_RECORD_STORAGE_BASE_KEY = 'session-viewport-record-v2';

export function scopedSessionLocalStateKey(baseKey: string, scope?: ServerAccountScope | null): string {
    if (!scope) return baseKey;
    return `${baseKey}:scope:v2:${serverAccountScopeKeySuffix(scope)}`;
}

export function sessionDraftValuesStorageKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey(SESSION_DRAFT_VALUES_STORAGE_BASE_KEY, scope);
}

export function agentInputLocalUiStateStorageKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey(AGENT_INPUT_LOCAL_UI_STATE_STORAGE_BASE_KEY, scope);
}

export function sessionViewportStorageKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey(SESSION_VIEWPORT_STORAGE_BASE_KEY, scope);
}

export function sessionViewportRecordStoragePrefix(scope?: ServerAccountScope | null): string {
    return `${scopedSessionLocalStateKey(SESSION_VIEWPORT_RECORD_STORAGE_BASE_KEY, scope)}:`;
}

export function sessionViewportRecordStorageKey(
    sessionId: string,
    scope?: ServerAccountScope | null,
): string {
    return `${sessionViewportRecordStoragePrefix(scope)}${encodeURIComponent(sessionId)}`;
}

import {
    AccountApiTokensCreateActionOutputV1Schema,
    AccountApiTokensListActionOutputV1Schema,
    AccountApiTokensRevokeActionOutputV1Schema,
    AccountApiTokensRevokeAllActionOutputV1Schema,
    AccountSessionsSignOutEverywhereActionOutputV1Schema,
    type AccountApiTokenSummaryV1,
    type ActionExecuteResult,
} from '@happier-dev/protocol';

import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

export type ApiTokenExpiryPreset = '30d' | '90d' | '1y' | 'none';

export type ApiTokenSettingsErrorCode =
    | 'account_unavailable'
    | 'auth_unavailable'
    | 'invalid_request'
    | 'invalid_response'
    | 'label_required'
    | 'network_error'
    | 'not_revoked'
    | 'present_user_required'
    | 'unavailable';

export type ApiTokenSettingsExecute = ReturnType<typeof createFrontDoorActionExecute>;

export type ApiTokenSettingsState = Readonly<{
    phase: 'idle' | 'loading' | 'ready' | 'error';
    tokens: readonly AccountApiTokenSummaryV1[];
    isRefreshing: boolean;
    listError: ApiTokenSettingsErrorCode | null;
    createDraft: Readonly<{ label: string; expiryPreset: ApiTokenExpiryPreset }>;
    createPending: boolean;
    createError: ApiTokenSettingsErrorCode | null;
    reveal: Readonly<{
        token: string;
        apiToken: AccountApiTokenSummaryV1;
        acknowledged: boolean;
    }> | null;
    operation: 'revoke' | 'revokeAll' | 'signOutEverywhere' | null;
    operationTokenId: string | null;
    operationError: ApiTokenSettingsErrorCode | null;
    operationNotice: 'revoked' | 'revokedAll' | 'signedOutEverywhere' | null;
}>;

export type ApiTokenSettingsControllerDependencies = Readonly<{
    execute: ApiTokenSettingsExecute;
    captureActiveAccountScopeLifetime(): ActiveServerAccountScopeLifetime | null;
    now(): number;
}>;

export type ApiTokenSettingsController = Readonly<{
    getState(): ApiTokenSettingsState;
    subscribe(listener: () => void): () => void;
    refresh(): Promise<void>;
    setCreateDraft(draft: ApiTokenSettingsState['createDraft']): void;
    resetCreateDraft(): void;
    createToken(): Promise<void>;
    acknowledgeReveal(): void;
    clearReveal(): void;
    requestRevealDismiss(
        confirm: () => Promise<boolean>,
        reason: 'shared' | 'action',
    ): Promise<boolean>;
    revokeToken(tokenId: string): Promise<boolean>;
    revokeAllTokens(): Promise<number | null>;
    signOutEverywhere(): Promise<boolean>;
    clearOperationFeedback(): void;
    retire(): void;
}>;

const DEFAULT_DRAFT = Object.freeze({ label: '', expiryPreset: '90d' as const });

const INITIAL_STATE: ApiTokenSettingsState = Object.freeze({
    phase: 'idle',
    tokens: [],
    isRefreshing: false,
    listError: null,
    createDraft: DEFAULT_DRAFT,
    createPending: false,
    createError: null,
    reveal: null,
    operation: null,
    operationTokenId: null,
    operationError: null,
    operationNotice: null,
});

const defaultDependencies: ApiTokenSettingsControllerDependencies = Object.freeze({
    execute: createFrontDoorActionExecute(),
    captureActiveAccountScopeLifetime: captureActiveServerAccountScopeLifetime,
    now: () => Date.now(),
});

function normalizeActionErrorCode(errorCode: unknown): ApiTokenSettingsErrorCode {
    const code = typeof errorCode === 'string' ? errorCode.trim() : '';
    switch (code) {
        case 'account_unavailable':
        case 'auth_unavailable':
        case 'invalid_request':
        case 'invalid_response':
        case 'label_required':
        case 'network_error':
        case 'not_revoked':
        case 'present_user_required':
        case 'unavailable':
            return code;
        default:
            return 'unavailable';
    }
}

function resolveActionError(result: ActionExecuteResult): ApiTokenSettingsErrorCode {
    if (result.ok) return 'invalid_response';
    return normalizeActionErrorCode(result.errorCode);
}

function resolveExpiresAt(preset: ApiTokenExpiryPreset, now: number): string | null {
    if (preset === 'none') return null;
    const durationDays = preset === '30d' ? 30 : preset === '90d' ? 90 : 365;
    return new Date(now + durationDays * 24 * 60 * 60 * 1000).toISOString();
}

export function createApiTokenSettingsController(
    dependencies: ApiTokenSettingsControllerDependencies = defaultDependencies,
): ApiTokenSettingsController {
    let state = INITIAL_STATE;
    let retired = false;
    let activeRequest: AbortController | null = null;
    let activeLifetime: ActiveServerAccountScopeLifetime | null = null;
    let retirement: Readonly<{ dispose(): void }> | null = null;
    const listeners = new Set<() => void>();

    const publish = (next: ApiTokenSettingsState): void => {
        if (retired) return;
        state = Object.freeze(next);
        for (const listener of [...listeners]) listener();
    };

    const dropScopeState = (): void => {
        activeRequest?.abort();
        activeRequest = null;
        retirement?.dispose();
        retirement = null;
        activeLifetime = null;
        if (!retired) publish(INITIAL_STATE);
    };

    const captureLifetime = (): ActiveServerAccountScopeLifetime | null => {
        const lifetime = dependencies.captureActiveAccountScopeLifetime();
        if (!lifetime?.isCurrent()) {
            dropScopeState();
            return null;
        }
        if (activeLifetime !== lifetime) {
            retirement?.dispose();
            activeLifetime = lifetime;
            retirement = lifetime.onRetire(dropScopeState);
        }
        return lifetime;
    };

    const run = async <T>(params: Readonly<{
        actionId: 'account.apiTokens.list'
            | 'account.apiTokens.create'
            | 'account.apiTokens.revoke'
            | 'account.apiTokens.revokeAll'
            | 'account.sessions.signOutEverywhere';
        input: unknown;
        parse(result: ActionExecuteResult): T | null;
    }>): Promise<Readonly<{ value: T | null; error: ApiTokenSettingsErrorCode | 'scope_retired' | null }>> => {
        if (retired) return { value: null, error: 'scope_retired' };
        const lifetime = captureLifetime();
        if (!lifetime) return { value: null, error: 'account_unavailable' };
        const controller = new AbortController();
        activeRequest = controller;
        try {
            const result = await dependencies.execute(params.actionId, params.input, {
                surface: 'ui',
                actionCaller: { kind: 'host' },
                signal: controller.signal,
            });
            if (retired || activeRequest !== controller || !lifetime.isCurrent()) {
                return { value: null, error: 'scope_retired' };
            }
            const value = params.parse(result);
            return value === null
                ? { value: null, error: resolveActionError(result) }
                : { value, error: null };
        } catch (error) {
            if (controller.signal.aborted || !lifetime.isCurrent()) {
                return { value: null, error: 'scope_retired' };
            }
            return {
                value: null,
                error: normalizeActionErrorCode(error instanceof Error ? error.message : null),
            };
        } finally {
            if (activeRequest === controller) activeRequest = null;
        }
    };

    const parseWith = <T>(schema: Readonly<{ safeParse(value: unknown): { success: boolean; data?: T } }>) => (
        result: ActionExecuteResult,
    ): T | null => {
        if (!result.ok) return null;
        const parsed = schema.safeParse(result.result);
        return parsed.success ? parsed.data ?? null : null;
    };

    return Object.freeze({
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async refresh() {
            if (retired || activeRequest) return;
            const hadContent = state.phase === 'ready';
            publish({
                ...state,
                phase: hadContent ? 'ready' : 'loading',
                isRefreshing: hadContent,
                listError: null,
            });
            const result = await run({
                actionId: 'account.apiTokens.list',
                input: {},
                parse: parseWith(AccountApiTokensListActionOutputV1Schema),
            });
            if (result.error === 'scope_retired' || retired) return;
            if (!result.value) {
                publish({
                    ...state,
                    phase: hadContent ? 'ready' : 'error',
                    isRefreshing: false,
                    listError: result.error,
                });
                return;
            }
            publish({
                ...state,
                phase: 'ready',
                tokens: result.value.tokens,
                isRefreshing: false,
                listError: null,
            });
        },
        setCreateDraft(draft) {
            publish({ ...state, createDraft: { ...draft }, createError: null });
        },
        resetCreateDraft() {
            publish({ ...state, createDraft: DEFAULT_DRAFT, createError: null });
        },
        async createToken() {
            if (retired || activeRequest) return;
            const label = state.createDraft.label.trim();
            if (!label) {
                publish({ ...state, createError: 'label_required' });
                return;
            }
            publish({ ...state, createPending: true, createError: null });
            const result = await run({
                actionId: 'account.apiTokens.create',
                input: {
                    label,
                    expiresAt: resolveExpiresAt(state.createDraft.expiryPreset, dependencies.now()),
                },
                parse: parseWith(AccountApiTokensCreateActionOutputV1Schema),
            });
            if (result.error === 'scope_retired' || retired) return;
            if (!result.value) {
                publish({ ...state, createPending: false, createError: result.error });
                return;
            }
            publish({
                ...state,
                phase: 'ready',
                tokens: [result.value.apiToken, ...state.tokens.filter((token) => token.tokenId !== result.value?.apiToken.tokenId)],
                createPending: false,
                createError: null,
                reveal: {
                    token: result.value.token,
                    apiToken: result.value.apiToken,
                    acknowledged: false,
                },
            });
        },
        acknowledgeReveal() {
            if (!state.reveal) return;
            publish({ ...state, reveal: { ...state.reveal, acknowledged: true } });
        },
        clearReveal() {
            if (!state.reveal && state.createDraft === DEFAULT_DRAFT && state.createError === null) return;
            publish({ ...state, reveal: null, createDraft: DEFAULT_DRAFT, createError: null });
        },
        async requestRevealDismiss(confirm) {
            if (state.createPending) return false;
            if (!state.reveal) return true;
            if (!state.reveal.acknowledged && !(await confirm())) return false;
            publish({ ...state, reveal: null, createDraft: DEFAULT_DRAFT, createError: null });
            return true;
        },
        async revokeToken(tokenId) {
            if (retired || activeRequest) return false;
            publish({ ...state, operation: 'revoke', operationTokenId: tokenId, operationError: null, operationNotice: null });
            const result = await run({
                actionId: 'account.apiTokens.revoke',
                input: { tokenId },
                parse: parseWith(AccountApiTokensRevokeActionOutputV1Schema),
            });
            if (result.error === 'scope_retired' || retired) return false;
            if (!result.value?.revoked) {
                publish({ ...state, operation: null, operationTokenId: null, operationError: result.error ?? 'not_revoked' });
                return false;
            }
            publish({
                ...state,
                tokens: state.tokens.filter((token) => token.tokenId !== tokenId),
                operation: null,
                operationTokenId: null,
                operationError: null,
                operationNotice: 'revoked',
            });
            return true;
        },
        async revokeAllTokens() {
            if (retired || activeRequest) return null;
            publish({ ...state, operation: 'revokeAll', operationTokenId: null, operationError: null, operationNotice: null });
            const result = await run({
                actionId: 'account.apiTokens.revokeAll',
                input: {},
                parse: parseWith(AccountApiTokensRevokeAllActionOutputV1Schema),
            });
            if (result.error === 'scope_retired' || retired) return null;
            if (!result.value) {
                publish({ ...state, operation: null, operationError: result.error });
                return null;
            }
            publish({
                ...state,
                tokens: [],
                operation: null,
                operationError: null,
                operationNotice: 'revokedAll',
            });
            return result.value.revokedCount;
        },
        async signOutEverywhere() {
            if (retired || activeRequest) return false;
            publish({ ...state, operation: 'signOutEverywhere', operationTokenId: null, operationError: null, operationNotice: null });
            const result = await run({
                actionId: 'account.sessions.signOutEverywhere',
                input: {},
                parse: parseWith(AccountSessionsSignOutEverywhereActionOutputV1Schema),
            });
            if (result.error === 'scope_retired' || retired) return false;
            if (!result.value) {
                publish({ ...state, operation: null, operationError: result.error });
                return false;
            }
            publish({ ...state, operation: null, operationError: null, operationNotice: 'signedOutEverywhere' });
            return true;
        },
        clearOperationFeedback() {
            publish({ ...state, operationError: null, operationNotice: null });
        },
        retire() {
            if (retired) return;
            activeRequest?.abort();
            activeRequest = null;
            retirement?.dispose();
            retirement = null;
            activeLifetime = null;
            state = INITIAL_STATE;
            retired = true;
            listeners.clear();
        },
    });
}

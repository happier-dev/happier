import type { AccountApiTokenSummaryV1 } from '@happier-dev/protocol';

import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import type { TranslationKeyNoParams } from '@/text';

export type ApiTokenListPresentation = 'skeleton' | 'list' | 'listWithRetry' | 'empty' | 'emptyWithRetry' | 'error';

export function resolveApiTokenListPresentation(state: Readonly<{
    phase: 'idle' | 'loading' | 'ready' | 'error';
    tokens: readonly unknown[];
    isRefreshing: boolean;
    listError?: string | null;
}>): ApiTokenListPresentation {
    if ((state.phase === 'idle' || state.phase === 'loading') && state.tokens.length === 0) return 'skeleton';
    if (state.tokens.length > 0) return state.listError ? 'listWithRetry' : 'list';
    if (state.phase === 'error') return 'error';
    return state.listError ? 'emptyWithRetry' : 'empty';
}

export type ApiTokenRowPresentation = Readonly<{
    token: AccountApiTokenSummaryV1;
    displayPrefix: string;
    status: 'active' | 'expiring' | 'expired';
    statusVariant: StatusPillVariant;
}>;

export function buildApiTokenRowPresentation(params: Readonly<{
    token: AccountApiTokenSummaryV1;
    nowMs: number;
}>): ApiTokenRowPresentation {
    const expiresAtMs = params.token.expiresAt ? Date.parse(params.token.expiresAt) : null;
    const expired = expiresAtMs !== null && expiresAtMs <= params.nowMs;
    const expiring = !expired
        && expiresAtMs !== null
        && expiresAtMs - params.nowMs <= 7 * 24 * 60 * 60 * 1000;
    return {
        token: params.token,
        displayPrefix: `${params.token.displayPrefix}…`,
        status: expired ? 'expired' : expiring ? 'expiring' : 'active',
        statusVariant: expired ? 'neutral' : expiring ? 'warning' : 'success',
    };
}

export function resolveApiTokenOperationErrorMessageKey(error: string | null): TranslationKeyNoParams {
    if (error === 'label_required') return 'settingsApiTokens.errors.labelRequired';
    if (error === 'present_user_required') return 'settingsApiTokens.errors.presentUserRequired';
    if (error === 'auth_unavailable' || error === 'offline' || error === 'network_error') {
        return 'settingsApiTokens.errors.offline';
    }
    if (error === 'account_mismatch') return 'settingsApiTokens.errors.accountMismatch';
    return 'settingsApiTokens.errors.unavailable';
}

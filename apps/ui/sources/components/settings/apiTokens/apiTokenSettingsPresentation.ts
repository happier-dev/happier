import { isApiTokenGrantRestrictedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { AccountApiTokenSummaryV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import type { ActionIdFamilyV1 } from '@happier-dev/protocol/actions/actionIds';
import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';

import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import { t, type TranslationKeyNoParams } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import type { ApiTokenSettingsErrorCode } from './apiTokenSettingsController';

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

/** A token shows an "expiring" pill for its last seven days (plan 01 §6.1). */
export const API_TOKEN_EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How soon an expiring token expires ("Expires in 5d"), and the instant that wording next changes. */
export type ApiTokenExpiresIn = Readonly<{ unit: 'days' | 'hours' | 'minutes'; count: number; changesAtMs: number }>;

/** `null` unless the token is in its last seven days and not yet expired. */
export function readApiTokenExpiresIn(expiresAt: string | null, nowMs: number): ApiTokenExpiresIn | null {
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAtMs)) return null;
    const remainingMs = expiresAtMs - nowMs;
    if (remainingMs <= 0 || remainingMs > API_TOKEN_EXPIRING_WINDOW_MS) return null;
    const [unit, unitMs] = remainingMs >= DAY_MS ? ['days', DAY_MS] as const
        : remainingMs >= HOUR_MS ? ['hours', HOUR_MS] as const
            : ['minutes', MINUTE_MS] as const;
    const count = Math.floor(remainingMs / unitMs);
    // Under a minute still reads "1m"; the next change is the expiry itself.
    return count === 0
        ? { unit, count: 1, changesAtMs: expiresAtMs }
        // At the exact threshold the old count still holds. The first millisecond after it is the
        // change; returning the threshold itself would let the clock discard it as already past.
        : { unit, count, changesAtMs: expiresAtMs - count * unitMs + 1 };
}

/** The pill a token row shows: only for an expiry that needs attention. One wording for tokens and embeds. */
export function resolveApiTokenStatusLabel(presentation: Pick<ApiTokenRowPresentation, 'status' | 'expiresIn'>): string | null {
    if (presentation.status === 'expired') return t('settingsApiTokens.status.expired');
    const expiresIn = presentation.expiresIn;
    if (presentation.status !== 'expiring' || !expiresIn) return null;
    if (expiresIn.unit === 'days') return t('settingsApiTokens.status.expiresInDays', { count: expiresIn.count });
    if (expiresIn.unit === 'hours') return t('settingsApiTokens.status.expiresInHours', { count: expiresIn.count });
    return t('settingsApiTokens.status.expiresInMinutes', { count: expiresIn.count });
}

export type ApiTokenRowPresentation = Readonly<{
    token: AccountApiTokenSummaryV1;
    displayPrefix: string;
    status: 'active' | 'expiring' | 'expired';
    /** Set while `expiring`. */
    expiresIn: ApiTokenExpiresIn | null;
    /** An embed owns this token: its row opens Settings → Embeds, the one place it is managed. */
    embedBacked: boolean;
    statusVariant: StatusPillVariant;
    encryptionAccess: 'enabled' | 'bearerOnly';
    unattendedTeamAccess: 'authorized' | 'notAuthorized';
}>;

export function buildApiTokenRowPresentation(params: Readonly<{
    token: ApiTokenRowPresentation['token'];
    nowMs: number;
}>): ApiTokenRowPresentation {
    const expiresAtMs = params.token.expiresAt ? Date.parse(params.token.expiresAt) : null;
    const expired = expiresAtMs !== null && expiresAtMs <= params.nowMs;
    const expiresIn = readApiTokenExpiresIn(params.token.expiresAt, params.nowMs);
    const expiring = expiresIn !== null;
    return {
        token: params.token,
        displayPrefix: `${params.token.displayPrefix}…`,
        status: expired ? 'expired' : expiring ? 'expiring' : 'active',
        expiresIn,
        embedBacked: params.token.embedConfig !== null,
        statusVariant: expired ? 'neutral' : expiring ? 'warning' : 'success',
        encryptionAccess: params.token.hasEncryptionAccess ? 'enabled' : 'bearerOnly',
        unattendedTeamAccess: params.token.hasUnattendedTeamAccess ? 'authorized' : 'notAuthorized',
    };
}

export function resolveApiTokenOperationErrorMessageKey(error: ApiTokenSettingsErrorCode | null): TranslationKeyNoParams {
    if (error === 'unsupported') return 'settingsApiTokens.encryption.unsupported';
    if (error === 'api_token_encryption_not_ready') return 'settingsApiTokens.encryption.notReady';
    if (error === 'api_token_encryption_stale') return 'settingsApiTokens.encryption.stale';
    if (error === 'api_token_id_conflict') return 'settingsApiTokens.encryption.idConflict';
    if (error === 'credential_authentication_evidence_limit') return 'settingsApiTokens.unattended.evidenceLimit';
    if (error === 'credential_authentication_evidence_unavailable') return 'settingsApiTokens.unattended.evidenceUnavailable';
    if (error === 'outcome_unknown') return 'settingsApiTokens.encryption.outcomeUnknown';
    if (error === 'label_required') return 'settingsApiTokens.errors.labelRequired';
    if (error === 'account_changed') return 'settingsApiTokens.errors.accountChanged';
    if (error === 'present_user_required') return 'settingsApiTokens.errors.presentUserRequired';
    if (error === 'grant_incomplete') return 'settingsApiTokens.errors.grantIncomplete';
    if (error === 'network_error') {
        return 'settingsApiTokens.errors.offline';
    }
    return 'settingsApiTokens.errors.unavailable';
}

export type ApiTokenAccessSummaryPart =
    | Readonly<{ kind: 'full' }>
    | Readonly<{ kind: 'allActions' }>
    | Readonly<{ kind: 'actions'; names: readonly string[]; more: number }>
    | Readonly<{ kind: 'targets'; sessions: number; machines: number }>
    | Readonly<{ kind: 'approve' }>
    | Readonly<{ kind: 'models'; name: string | null; count: number }>
    | Readonly<{ kind: 'websites'; host: string | null; count: number }>
    | Readonly<{ kind: 'content' }>
    | Readonly<{ kind: 'expiry'; state: 'never' | 'active' | 'expired'; at: string | null }>;

export type ApiTokenAccessSummaryNames = Readonly<{
    familyName: (family: ActionIdFamilyV1) => string | null;
    actionName: (actionId: string) => string | null;
    modelName: (ref: ProviderBoundModelRef) => string | null;
}>;

/**
 * A token's access as one line, always in the order scope → targets → approve → models → websites →
 * content → expiry (plan 01 §6.1). Quiet defaults (every session, any model, no websites, API access
 * only) say nothing; an unrestricted token is "Full access". The rail, the list and the editor's
 * review line all read this one owner.
 */
export function buildApiTokenAccessSummaryParts(params: Readonly<{
    token: Pick<AccountApiTokenSummaryV1, 'grant' | 'expiresAt' | 'hasEncryptionAccess'>;
    nowMs: number;
    names: ApiTokenAccessSummaryNames;
}>): readonly ApiTokenAccessSummaryPart[] {
    const { grant } = params.token;
    const parts: ApiTokenAccessSummaryPart[] = [];
    if (grant.actions !== null) {
        const names = [
            ...grant.actions.families.map((family) => params.names.familyName(family) ?? family),
            ...grant.actions.ids.map((id) => params.names.actionName(id) ?? id),
        ];
        parts.push({ kind: 'actions', names: names.slice(0, 2), more: Math.max(0, names.length - 2) });
    } else if (isApiTokenGrantRestrictedV1(grant) || grant.approve || grant.origins.length > 0) {
        parts.push({ kind: 'allActions' });
    } else {
        parts.push({ kind: 'full' });
    }
    if (grant.targets !== null) parts.push({ kind: 'targets', sessions: grant.targets.sessions.length, machines: grant.targets.machines.length });
    if (grant.approve) parts.push({ kind: 'approve' });
    if (grant.models !== null) {
        parts.push({
            kind: 'models',
            name: grant.models.length === 1 ? params.names.modelName(grant.models[0]!) : null,
            count: grant.models.length,
        });
    }
    if (grant.origins.length > 0) {
        parts.push({ kind: 'websites', host: grant.origins.length === 1 ? originHost(grant.origins[0]!) : null, count: grant.origins.length });
    }
    if (params.token.hasEncryptionAccess) parts.push({ kind: 'content' });
    const expiresAtMs = params.token.expiresAt ? Date.parse(params.token.expiresAt) : null;
    parts.push(expiresAtMs === null
        ? { kind: 'expiry', state: 'never', at: null }
        : { kind: 'expiry', state: expiresAtMs <= params.nowMs ? 'expired' : 'active', at: params.token.expiresAt });
    return parts;
}

function originHost(origin: string): string {
    try {
        return new URL(origin).host;
    } catch {
        return origin;
    }
}

function formatSummaryDate(at: string): string {
    return formatWithCachedDateTimeFormatter(new Date(at), undefined, { day: 'numeric', month: 'short' });
}

export function formatApiTokenAccessSummaryPart(part: ApiTokenAccessSummaryPart): string {
    switch (part.kind) {
        case 'full': return t('settingsApiTokens.summary.full');
        case 'allActions': return t('settingsApiTokens.summary.allActions');
        case 'actions': return part.more > 0
            ? t('settingsApiTokens.summary.namesAndMore', { names: part.names.join(', '), count: part.more })
            : part.names.join(', ');
        case 'targets': return [
            part.sessions > 0 ? t('settingsApiTokens.summary.sessions', { count: part.sessions }) : null,
            part.machines > 0 ? t('settingsApiTokens.summary.computers', { count: part.machines }) : null,
        ].filter((value): value is string => value !== null).join(' · ');
        case 'approve': return t('settingsApiTokens.summary.approve');
        case 'models': return part.name ?? t('settingsApiTokens.summary.models', { count: part.count });
        case 'websites': return part.host ?? t('settingsApiTokens.summary.websites', { count: part.count });
        case 'content': return t('settingsApiTokens.summary.content');
        case 'expiry': return part.state === 'never' || part.at === null
            ? t('settingsApiTokens.summary.noExpiry')
            : part.state === 'expired'
                ? t('settingsApiTokens.summary.expired', { date: formatSummaryDate(part.at) })
                : t('settingsApiTokens.summary.expires', { date: formatSummaryDate(part.at) });
    }
}

export function formatApiTokenAccessSummary(parts: readonly ApiTokenAccessSummaryPart[]): string {
    return parts.map(formatApiTokenAccessSummaryPart).filter((text) => text.length > 0).join(' · ');
}

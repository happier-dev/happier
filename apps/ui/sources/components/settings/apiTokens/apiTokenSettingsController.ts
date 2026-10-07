import { AccountApiTokensCreateActionOutputV1Schema, AccountApiTokensListActionOutputV1Schema, formatAccountApiTokenCredentialV1, AccountApiTokensRevokeActionOutputV1Schema, AccountApiTokensRevokeAllActionOutputV1Schema, AccountApiTokensUpdateActionOutputV1Schema, parseAccountApiTokenBearerV1, type AccountApiTokenSummaryV1, type AccountApiTokensUpdateActionInputV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { AccountSessionsSignOutEverywhereActionOutputV1Schema } from '@happier-dev/protocol/auth/accountSessions';
import { ApiTokenGrantV1Schema, type ApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { EmbedConfigV1 } from '@happier-dev/protocol/embed';

import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { encodeBase64 } from '@/encryption/base64';
import { randomUUID } from '@/platform/randomUUID';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { captureServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { fetchAccountEncryptionCurrentness, AccountEncryptionCurrentnessReadinessError } from '@/sync/api/account/apiAccountEncryptionMode';
import { prepareApiTokenEncryptionAccess } from '@/sync/ops/account/prepareApiTokenEncryptionAccess';
import { HappyError } from '@/utils/errors/errors';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

export type ApiTokenExpiryPreset = '30d' | '90d' | '1y' | 'none';

export type ApiTokenSettingsErrorCode =
    | 'account_unavailable'
    | 'account_changed'
    | 'auth_unavailable'
    | 'invalid_request'
    | 'invalid_response'
    | 'label_required'
    | 'network_error'
    | 'not_revoked'
    | 'present_user_required'
    | 'approvals_not_supported'
    | 'approval_rejected'
    | 'approval_canceled'
    | 'action_disabled'
    | 'account-disabled'
    | 'account_disabled'
    | 'unsupported'
    | 'api_token_encryption_not_ready'
    | 'api_token_encryption_stale'
    | 'api_token_id_conflict'
    | 'credential_authentication_evidence_limit'
    | 'credential_authentication_evidence_unavailable'
    | 'outcome_unknown'
    | 'grant_incomplete'
    | 'unavailable';

export type ApiTokenSettingsExecute = ReturnType<typeof createFrontDoorActionExecute>;

export type ApiTokenSettingsDestructiveTarget = ActiveServerAccountScopeLifetime;

/**
 * Whether this Account can hold an encrypted token from this device right now:
 * - `unchecked`, `checking`: not known yet;
 * - `plain`: a plain Account; tokens are keyless;
 * - `ready`: an encrypted Account whose keys are usable here;
 * - `unavailable`, `stale`: an encrypted Account whose keys are missing, or out of date, on this
 *   device (restoring the secret key repairs both);
 * - `unreadable`: the check itself failed (retry).
 */
export type ApiTokenEncryptionAvailability = 'unchecked' | 'checking' | 'plain' | 'ready' | 'unavailable' | 'stale' | 'unreadable';

export type ApiTokenSettingsState = Readonly<{
    phase: 'idle' | 'loading' | 'ready' | 'error';
    tokens: readonly AccountApiTokenSummaryV1[];
    encryptionAvailability: ApiTokenEncryptionAvailability;
    recoveryTokenId: string | null;
    isRefreshing: boolean;
    listError: ApiTokenSettingsErrorCode | null;
    createDraft: Readonly<{
        label: string;
        expiryPreset: ApiTokenExpiryPreset;
        encryptionAccess?: boolean;
        authorizeUnattendedTeamAccess?: boolean;
        /** Absent or `full`: the token gets the full grant (no `grant` is sent). */
        access?: 'full' | 'limited';
        /** The limited grant being chosen; sent only when `access` is `limited`. */
        grant?: ApiTokenGrantV1;
        /** Settings → Embeds: the token is an embed's parent (plan 04 §4.2); sent with its limited grant. */
        embedConfig?: EmbedConfigV1;
    }>;
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
    /** An existing token's access being edited (`account.apiTokens.update`). */
    accessEdit: Readonly<{
        tokenId: string;
        grant: ApiTokenGrantV1;
        pending: boolean;
        error: ApiTokenSettingsErrorCode | null;
        /** Saving a changed grant revokes this token's children (plan 01 INV-A3). */
        signsOutEmbeddedCredentials: boolean;
    }> | null;
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
    refreshEncryptionAvailability(): Promise<void>;
    setCreateDraft(draft: ApiTokenSettingsState['createDraft']): void;
    resetCreateDraft(): void;
    createToken(): Promise<void>;
    /** Adopts a human approval's show-once result for its captured Home, without another mint. */
    adoptCreatedToken(input: Readonly<{
        result: unknown;
        tokenId: string;
        target: ActiveServerAccountScopeLifetime;
    }>): boolean;
    acknowledgeReveal(): void;
    clearReveal(): void;
    requestRevealDismiss(
        confirm: () => Promise<boolean>,
        reason: 'shared' | 'action',
    ): Promise<boolean>;
    /**
     * The Account and Home a destructive confirmation is about, captured when it opens. Passing it to
     * `revokeToken`, `revokeAllTokens` or `signOutEverywhere` makes them refuse (`account_changed`)
     * rather than act on whichever Account is active by the time the person confirms.
     */
    captureDestructiveTarget(): ApiTokenSettingsDestructiveTarget | null;
    revokeToken(tokenId: string, target?: ApiTokenSettingsDestructiveTarget): Promise<boolean>;
    revokeAllTokens(target?: ApiTokenSettingsDestructiveTarget): Promise<number | null>;
    signOutEverywhere(target?: ApiTokenSettingsDestructiveTarget): Promise<boolean>;
    /** Starts editing a listed token's access from its current grant; false when it is not listed. */
    beginAccessEdit(tokenId: string): boolean;
    setAccessEditGrant(grant: ApiTokenGrantV1): void;
    /** Saves the edited grant; true once the Home stored it. */
    saveAccessEdit(): Promise<boolean>;
    /**
     * Stores exactly this change (label, grant and/or embed configuration) and adopts the returned
     * row; `null` on success, else the error. A grant change revokes the token's children (01).
     */
    updateToken(input: AccountApiTokensUpdateActionInputV1): Promise<ApiTokenSettingsErrorCode | null>;
    cancelAccessEdit(): void;
    clearOperationFeedback(): void;
    retire(): void;
}>;

const DEFAULT_DRAFT = Object.freeze({ label: '', expiryPreset: '90d' as const });

const INITIAL_STATE: ApiTokenSettingsState = Object.freeze({
    phase: 'idle',
    tokens: [],
    encryptionAvailability: 'unchecked',
    recoveryTokenId: null,
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
    accessEdit: null,
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
        case 'approvals_not_supported':
        case 'approval_rejected':
        case 'approval_canceled':
        case 'action_disabled':
        case 'account-disabled':
        case 'account_disabled':
        case 'unsupported':
        case 'api_token_encryption_not_ready':
        case 'api_token_encryption_stale':
        case 'api_token_id_conflict':
        case 'credential_authentication_evidence_limit':
        case 'credential_authentication_evidence_unavailable':
        case 'outcome_unknown':
        case 'grant_incomplete':
        case 'unavailable':
            return code;
        case 'unsupported_action':
            return 'unsupported';
        case 'invalid_parameters':
            return 'invalid_request';
        default:
            return 'unavailable';
    }
}

function resolveActionError(result: ActionExecuteResult): ApiTokenSettingsErrorCode {
    if (result.ok) return 'invalid_response';
    return normalizeActionErrorCode(result.errorCode);
}

/** Canonical expiry projection shared by one-time API credential creators. */
export function resolveApiTokenExpiryInstant(preset: ApiTokenExpiryPreset, now: number): string | null {
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
    // The optional encryption-availability read is not a mutation and must not
    // occupy the mutation slot: holding `activeRequest` made ordinary token
    // creation return silently while it was in flight.
    let availabilityRequest: AbortController | null = null;
    let activeLifetime: ActiveServerAccountScopeLifetime | null = null;
    let retirement: Readonly<{ dispose(): void }> | null = null;
    const listeners = new Set<() => void>();
    let creation: { cancelled: boolean; dismissed: boolean; tokenId: string; encrypted: boolean } | null = null;

    const publish = (next: ApiTokenSettingsState): void => {
        if (retired) return;
        state = Object.freeze(next);
        for (const listener of [...listeners]) listener();
    };

    const dropScopeState = (): void => {
        if (creation) creation.cancelled = true;
        creation = null;
        activeRequest?.abort();
        activeRequest = null;
        availabilityRequest?.abort();
        availabilityRequest = null;
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
            | 'account.apiTokens.update'
            | 'account.sessions.signOutEverywhere';
        input: unknown;
        parse(result: ActionExecuteResult): T | null;
        target?: ApiTokenSettingsDestructiveTarget;
    }>): Promise<Readonly<{ value: T | null; error: ApiTokenSettingsErrorCode | 'scope_retired' | null }>> => {
        if (retired) return { value: null, error: 'scope_retired' };
        const lifetime = captureLifetime();
        // A confirmed destructive action runs only for the Account and Home it was confirmed for.
        if (params.target && (lifetime !== params.target || !params.target.isCurrent())) {
            return { value: null, error: 'account_changed' };
        }
        if (!lifetime) return { value: null, error: 'account_unavailable' };
        const controller = new AbortController();
        activeRequest = controller;
        try {
            const result = await dependencies.execute(params.actionId, params.input, {
                surface: 'ui',
                authority: 'present_user',
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


    /** The one `account.apiTokens.update` path: every edit stores exactly its change and adopts the row. */
    const executeUpdate = async (input: AccountApiTokensUpdateActionInputV1): Promise<ApiTokenSettingsErrorCode | 'scope_retired' | null> => {
        if (retired) return 'scope_retired';
        const result = await run({
            actionId: 'account.apiTokens.update',
            input,
            parse: parseWith(AccountApiTokensUpdateActionOutputV1Schema),
        });
        if (result.error === 'scope_retired' || retired) return 'scope_retired';
        if (!result.value) return result.error ?? 'invalid_response';
        const updated = result.value.apiToken;
        publish({ ...state, tokens: state.tokens.map((row) => (row.tokenId === updated.tokenId ? updated : row)) });
        return null;
    };
    const parseWith = <T>(schema: Readonly<{ safeParse(value: unknown): { success: boolean; data?: T } }>) => (
        result: ActionExecuteResult,
    ): T | null => {
        if (!result.ok) return null;
        const parsed = schema.safeParse(result.result);
        return parsed.success ? parsed.data ?? null : null;
    };

    const readCreatedToken = (result: unknown, tokenId: string) => {
        const parsed = AccountApiTokensCreateActionOutputV1Schema.safeParse(result);
        return parsed.success && parsed.data.apiToken.tokenId === tokenId
            && parseAccountApiTokenBearerV1(parsed.data.token)?.tokenId === tokenId
            ? parsed.data : null;
    };
    const revealCreatedToken = (value: NonNullable<ReturnType<typeof readCreatedToken>>, token = value.token): void => {
        publish({ ...state, phase: 'ready',
            tokens: [value.apiToken, ...state.tokens.filter(row => row.tokenId !== value.apiToken.tokenId)],
            createPending: false, createError: null,
            reveal: { token, apiToken: value.apiToken, acknowledged: false },
        });
    };

    const readEncryptionContext = async (lifetime: ActiveServerAccountScopeLifetime, signal: AbortSignal) => {
        const authority = await captureServerRequestAuthorityForServerAccountScope({
            scope: lifetime.scope,
            activeRequest: async () => { throw new Error('account_unavailable'); },
        });
        try {
            if (!lifetime.isCurrent() || signal.aborted) throw new Error('account_unavailable');
            const credentials = authority.context.credentials;
            const serverIdentityId = getServerProfileById(lifetime.scope.serverId)?.serverIdentityId;
            if (!credentials || !serverIdentityId) throw new Error('api_token_encryption_not_ready');
            const currentness = await fetchAccountEncryptionCurrentness(credentials, { request: authority.request, signal });
            if (!lifetime.isCurrent() || signal.aborted) throw new Error('account_unavailable');
            return { credentials, currentness, serverIdentityId, accountId: lifetime.scope.accountId };
        } finally {
            await authority.release();
        }
    };

    const dismissCreation = (): void => {
        if (!creation) return;
        creation.dismissed = true;
        // Keep the request identity until the shared transport settles: an
        // issued abort is outcome-unknown, while a pre-issue abort is not.
        activeRequest?.abort();
        publish({ ...state, createPending: false, createError: null });
    };

    const publishEncryptionAvailability = (availability: ApiTokenEncryptionAvailability): void => {
        const available = availability === 'ready';
        publish({
            ...state,
            encryptionAvailability: availability,
            createDraft: !available && state.createDraft.encryptionAccess === true
                ? { ...state.createDraft, encryptionAccess: false }
                : state.createDraft,
        });
    };

    const controller: ApiTokenSettingsController = {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async refresh() {
            if (retired || activeRequest || creation) return;
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
                recoveryTokenId: state.recoveryTokenId
                    && result.value.tokens.some((token) => token.tokenId === state.recoveryTokenId)
                    ? state.recoveryTokenId
                    : null,
                isRefreshing: false,
                listError: null,
            });
        },
        async refreshEncryptionAvailability() {
            if (retired || creation) return;
            const lifetime = captureLifetime();
            if (!lifetime) return;
            // Availability is a live Home/Account/content-key fact. Do not keep
            // offering a previously verified capability while it is rechecked.
            if (state.encryptionAvailability !== 'checking') publish({ ...state, encryptionAvailability: 'checking' });
            const pending = new AbortController();
            availabilityRequest?.abort();
            availabilityRequest = pending;
            try {
                const context = await readEncryptionContext(lifetime, pending.signal);
                if (lifetime.isCurrent() && !pending.signal.aborted) {
                    const { currentness, credentials } = context;
                    publishEncryptionAvailability(currentness.mode !== 'e2ee'
                        ? 'plain'
                        : currentness.recipientEnvelopeReadiness?.status === 'available'
                            && ('secret' in credentials || 'encryption' in credentials)
                            ? 'ready'
                            : 'unavailable');
                }
            } catch (error) {
                // Optional encrypted creation stays hidden; ordinary creation remains usable.
                if (lifetime.isCurrent() && !pending.signal.aborted) {
                    publishEncryptionAvailability(error instanceof AccountEncryptionCurrentnessReadinessError
                        || (error instanceof Error && error.message === 'api_token_encryption_not_ready')
                        ? 'unavailable'
                        : 'unreadable');
                }
            } finally {
                if (availabilityRequest === pending) availabilityRequest = null;
            }
        },
        setCreateDraft(draft) {
            publish({ ...state, createDraft: { ...draft }, createError: null });
        },
        resetCreateDraft() {
            publish({ ...state, createDraft: DEFAULT_DRAFT, createError: null });
        },
        async createToken() {
            if (retired || activeRequest || creation || state.recoveryTokenId) return;
            const draft = state.createDraft;
            const label = draft.label.trim();
            if (!label) { publish({ ...state, createError: 'label_required' }); return; }
            // A limited token sends exactly the grant chosen, and only one the protocol accepts.
            const grant = draft.access === 'limited' ? draft.grant ?? null : null;
            if (draft.access === 'limited' && (!grant || !ApiTokenGrantV1Schema.safeParse(grant).success)) {
                publish({ ...state, createError: 'grant_incomplete' });
                return;
            }
            const lifetime = captureLifetime();
            if (!lifetime) { publish({ ...state, createError: 'account_unavailable' }); return; }
            // The selector is captured before every attempt, ordinary or
            // encrypted, so a lost response can be reconciled against the same
            // Account's list without adopting a server-returned row.
            const attempt = {
                cancelled: false,
                dismissed: false,
                tokenId: randomUUID(),
                encrypted: draft.encryptionAccess === true,
            };
            creation = attempt;
            // A mutation is admitted: the optional availability read no longer
            // has a consumer and must not publish over the attempt.
            availabilityRequest?.abort();
            availabilityRequest = null;
            publish({ ...state, createPending: true, createError: null });
            let prepared: Awaited<ReturnType<typeof prepareApiTokenEncryptionAccess>> | null = null;
            let binding: { serverIdentityId: string; accountId: string } | null = null;
            try {
                if (attempt.encrypted) {
                    const pending = new AbortController();
                    activeRequest = pending;
                    const context = await readEncryptionContext(lifetime, pending.signal);
                    prepared = await prepareApiTokenEncryptionAccess({ ...context, tokenId: attempt.tokenId });
                    binding = { serverIdentityId: context.serverIdentityId, accountId: context.accountId };
                    if (activeRequest === pending) activeRequest = null;
                }
                if (attempt.cancelled || attempt.dismissed || retired || !lifetime.isCurrent()) return;
                const result = await run({
                    actionId: 'account.apiTokens.create',
                    input: { tokenId: attempt.tokenId, label,
                        expiresAt: resolveApiTokenExpiryInstant(draft.expiryPreset, dependencies.now()),
                        ...(draft.authorizeUnattendedTeamAccess === true
                            ? { authorizeUnattendedTeamAccess: true }
                            : {}),
                        ...(prepared ? { encryption: { access: prepared.encryptionAccess } } : {}),
                        ...(grant ? { grant } : {}),
                        ...(grant && draft.embedConfig ? { embedConfig: draft.embedConfig } : {}) },
                    parse: parseWith(AccountApiTokensCreateActionOutputV1Schema),
                });
                if (attempt.cancelled || result.error === 'scope_retired' || retired || !lifetime.isCurrent()) return;
                if (attempt.dismissed && result.value) {
                    publish({
                        ...state,
                        createPending: false,
                        createError: 'outcome_unknown',
                        recoveryTokenId: attempt.tokenId,
                        reveal: null,
                    });
                    return;
                }
                if (!result.value) {
                    publish({ ...state, createPending: false,
                        createError: result.error,
                        recoveryTokenId: result.error === 'outcome_unknown' ? attempt.tokenId : null });
                    return;
                }
                // The response schema only proves the bearer and summary agree
                // with each other; disclosure additionally requires both to be
                // this attempt's selector.
                const created = readCreatedToken(result.value, attempt.tokenId);
                if (!created) {
                    publish({ ...state, createPending: false, createError: 'invalid_response', recoveryTokenId: attempt.tokenId });
                    return;
                }
                const token = prepared && binding ? formatAccountApiTokenCredentialV1({
                    bearer: created.token, wrappingSecret: encodeBase64(prepared.wrappingSecret, 'base64url'),
                    ...binding, contentPublicKey: prepared.encryptionAccess.contentPublicKey,
                }) : created.token;
                revealCreatedToken(created, token);
            } catch (error) {
                if (attempt.cancelled || retired || !lifetime.isCurrent()) return;
                if (attempt.dismissed) {
                    publish({ ...state, createPending: false, createError: null, recoveryTokenId: null, reveal: null });
                    return;
                }
                const code = error instanceof AccountEncryptionCurrentnessReadinessError ? 'api_token_encryption_not_ready'
                    : error instanceof HappyError && (error.status === 404 || error.status === 405) ? 'unsupported'
                    : normalizeActionErrorCode(error instanceof Error ? error.message : null);
                publish({ ...state, createPending: false,
                    createError: code,
                    // A refused encrypted attempt says why this device cannot hold the key, until rechecked.
                    ...(code === 'api_token_encryption_stale' ? { encryptionAvailability: 'stale' as const }
                        : code === 'api_token_encryption_not_ready' ? { encryptionAvailability: 'unavailable' as const } : {}),
                    recoveryTokenId: null });
            } finally {
                prepared?.wrappingSecret.fill(0);
                if (creation === attempt) { creation = null; activeRequest = null; }
                if (!retired && lifetime.isCurrent() && state.recoveryTokenId) await controller.refresh();
            }
        },
        adoptCreatedToken({ result, tokenId, target }) {
            if (retired || activeRequest || creation || state.reveal || !target.isCurrent()) return false;
            // The caller captured this exact lifetime before deciding. Never
            // adopt into a different active Account after that decision settles.
            if (captureLifetime() !== target || !target.isCurrent()) return false;
            const created = readCreatedToken(result, tokenId);
            if (!created) return false;
            // Approval results contain the raw bearer only. A requester-owned
            // encryption wrapping secret is not reconstructed on the deciding device.
            revealCreatedToken(created);
            return true;
        },
        acknowledgeReveal() {
            if (!state.reveal) return;
            publish({ ...state, reveal: { ...state.reveal, acknowledged: true } });
        },
        clearReveal() {
            dismissCreation();
            if (!state.reveal && state.createDraft === DEFAULT_DRAFT && state.createError === null) return;
            publish({ ...state, reveal: null, createDraft: DEFAULT_DRAFT, createError: null });
        },
        async requestRevealDismiss(confirm) {
            if (state.createPending) { dismissCreation(); return true; }
            if (!state.reveal) return true;
            if (!state.reveal.acknowledged && !(await confirm())) return false;
            publish({ ...state, reveal: null, createDraft: DEFAULT_DRAFT, createError: null });
            return true;
        },
        captureDestructiveTarget() {
            return retired ? null : captureLifetime();
        },
        async revokeToken(tokenId, target) {
            if (retired || activeRequest) return false;
            publish({ ...state, operation: 'revoke', operationTokenId: tokenId, operationError: null, operationNotice: null });
            const result = await run({
                actionId: 'account.apiTokens.revoke',
                input: { tokenId },
                target,
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
                recoveryTokenId: state.recoveryTokenId === tokenId ? null : state.recoveryTokenId,
            });
            return true;
        },
        async revokeAllTokens(target) {
            if (retired || activeRequest) return null;
            publish({ ...state, operation: 'revokeAll', operationTokenId: null, operationError: null, operationNotice: null });
            const result = await run({
                actionId: 'account.apiTokens.revokeAll',
                input: {},
                target,
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
                recoveryTokenId: null,
            });
            return result.value.revokedCount;
        },
        async signOutEverywhere(target) {
            if (retired || activeRequest) return false;
            publish({ ...state, operation: 'signOutEverywhere', operationTokenId: null, operationError: null, operationNotice: null });
            const result = await run({
                actionId: 'account.sessions.signOutEverywhere',
                input: {},
                target,
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
        beginAccessEdit(tokenId) {
            if (retired) return false;
            const token = state.tokens.find((row) => row.tokenId === tokenId);
            if (!token) return false;
            publish({
                ...state,
                accessEdit: {
                    tokenId,
                    grant: token.grant,
                    pending: false,
                    error: null,
                    signsOutEmbeddedCredentials: token.activeChildCount > 0,
                },
            });
            return true;
        },
        setAccessEditGrant(grant) {
            if (!state.accessEdit || state.accessEdit.pending) return;
            publish({ ...state, accessEdit: { ...state.accessEdit, grant, error: null } });
        },
        async saveAccessEdit() {
            const edit = state.accessEdit;
            if (retired || !edit || edit.pending || activeRequest) return false;
            if (!ApiTokenGrantV1Schema.safeParse(edit.grant).success) {
                publish({ ...state, accessEdit: { ...edit, error: 'grant_incomplete' } });
                return false;
            }
            publish({ ...state, accessEdit: { ...edit, pending: true, error: null } });
            const result = await executeUpdate({ tokenId: edit.tokenId, grant: edit.grant });
            if (result === 'scope_retired') return false;
            const current = state.accessEdit;
            if (result !== null) {
                if (current?.tokenId === edit.tokenId) {
                    publish({ ...state, accessEdit: { ...current, pending: false, error: result } });
                }
                return false;
            }
            publish({ ...state, accessEdit: current?.tokenId === edit.tokenId ? null : current });
            return true;
        },
        async updateToken(input) {
            const result = await executeUpdate(input);
            return result === 'scope_retired' ? 'account_changed' : result;
        },
        cancelAccessEdit() {
            if (!state.accessEdit) return;
            publish({ ...state, accessEdit: null });
        },
        clearOperationFeedback() {
            publish({ ...state, operationError: null, operationNotice: null });
        },
        retire() {
            if (retired) return;
            if (creation) creation.cancelled = true;
            creation = null;
            activeRequest?.abort();
            activeRequest = null;
            availabilityRequest?.abort();
            availabilityRequest = null;
            retirement?.dispose();
            retirement = null;
            activeLifetime = null;
            state = INITIAL_STATE;
            retired = true;
            listeners.clear();
        },
    };
    return Object.freeze(controller);
}

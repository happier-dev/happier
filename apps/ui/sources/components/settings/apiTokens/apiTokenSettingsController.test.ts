import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

// Randomness is a genuine system boundary; the request-owned selector below is
// the exact value the controller must send, bind and reconcile against.
const uuid = vi.hoisted(() => ({ next: '11111111-1111-4111-8111-111111111111' }));
vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => uuid.next }));

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import {
    createApiTokenSettingsController,
    type ApiTokenSettingsControllerDependencies,
    type ApiTokenSettingsExecute,
} from './apiTokenSettingsController';

const NOW = Date.parse('2026-08-22T12:00:00.000Z');

const TOKEN_A = {
    tokenId: '11111111-1111-4111-8111-111111111111',
    label: 'CI on build-server',
    displayPrefix: 'hap_v1_11111111',
    createdAt: '2026-08-20T12:00:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
    hasEncryptionAccess: false,
    hasUnattendedTeamAccess: false,
    grant: API_TOKEN_FULL_GRANT_V1,
    parentTokenId: null,
    activeChildCount: 0,
    embedConfig: null,
} as const;

const TOKEN_B = {
    tokenId: '22222222-2222-4222-8222-222222222222',
    label: 'Release automation',
    displayPrefix: 'hap_v1_22222222',
    createdAt: '2026-08-21T12:00:00.000Z',
    lastUsedAt: '2026-08-22T11:00:00.000Z',
    expiresAt: '2026-08-29T12:00:00.000Z',
    hasEncryptionAccess: true,
    hasUnattendedTeamAccess: false,
    grant: API_TOKEN_FULL_GRANT_V1,
    parentTokenId: null,
    activeChildCount: 0,
    embedConfig: null,
} as const;

type TestLifetime = ActiveServerAccountScopeLifetime & Readonly<{ retire(): void }>;

function createLifetime(accountId = 'account-a'): TestLifetime {
    let current = true;
    const callbacks = new Set<() => void>();
    return {
        scope: { serverId: 'server-a', accountId },
        isCurrent: () => current,
        onRetire(callback) {
            if (!current) {
                callback();
                return { dispose() {} };
            }
            callbacks.add(callback);
            return { dispose: () => callbacks.delete(callback) };
        },
        retire() {
            current = false;
            for (const callback of [...callbacks]) callback();
            callbacks.clear();
        },
    };
}

function ok(result: unknown): ActionExecuteResult {
    return { ok: true, result };
}

function createHarness(results: readonly (ActionExecuteResult | Promise<ActionExecuteResult>)[]) {
    const queue = [...results];
    const lifetime = createLifetime();
    const execute = vi.fn<ApiTokenSettingsExecute>(async () => await (queue.shift() ?? ok({ tokens: [] })));
    const dependencies: ApiTokenSettingsControllerDependencies = {
        execute,
        captureActiveAccountScopeLifetime: () => lifetime,
        now: () => NOW,
    };
    const controller = createApiTokenSettingsController(dependencies);
    return { controller, execute, lifetime };
}

describe('createApiTokenSettingsController', () => {
    beforeEach(() => { uuid.next = TOKEN_A.tokenId; });

    it('adopts an approved creation into the existing show-once lifecycle without minting again', async () => {
        const harness = createHarness([]);
        const token = `hap_v1_${TOKEN_A.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
        expect(harness.controller.adoptCreatedToken({ result: { token, apiToken: TOKEN_A },
            tokenId: TOKEN_A.tokenId, target: harness.lifetime })).toBe(true);
        expect(harness.controller.getState()).toMatchObject({
            phase: 'ready', tokens: [TOKEN_A], reveal: { token, apiToken: TOKEN_A, acknowledged: false },
        });
        expect(harness.execute).not.toHaveBeenCalled();
        await expect(harness.controller.requestRevealDismiss(async () => false, 'shared')).resolves.toBe(false);
        harness.controller.acknowledgeReveal();
        await expect(harness.controller.requestRevealDismiss(async () => false, 'action')).resolves.toBe(true);
        expect(harness.controller.getState().reveal).toBeNull();
        expect(harness.controller.adoptCreatedToken({ result: { token, apiToken: TOKEN_A },
            tokenId: TOKEN_A.tokenId, target: harness.lifetime })).toBe(true);
        harness.lifetime.retire();
        expect(harness.controller.getState().reveal).toBeNull();
    });

    it('refuses an invalid or stale approved creation instead of falling back to the current Account', () => {
        const oldLifetime = createLifetime();
        let currentLifetime = oldLifetime;
        const execute = vi.fn<ApiTokenSettingsExecute>(async () => ok({ tokens: [] }));
        const controller = createApiTokenSettingsController({ execute,
            captureActiveAccountScopeLifetime: () => currentLifetime, now: () => NOW });
        const token = `hap_v1_${TOKEN_A.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
        for (const result of [{ token, apiToken: TOKEN_A, unexpected: true }, { token, apiToken: TOKEN_B }]) {
            expect(controller.adoptCreatedToken({ result, tokenId: TOKEN_A.tokenId, target: oldLifetime })).toBe(false);
            expect(controller.getState().reveal).toBeNull();
        }
        expect(controller.adoptCreatedToken({ result: { token, apiToken: TOKEN_A },
            tokenId: TOKEN_B.tokenId, target: oldLifetime })).toBe(false);
        oldLifetime.retire();
        currentLifetime = createLifetime('account-b');
        expect(controller.adoptCreatedToken({ result: { token, apiToken: TOKEN_A },
            tokenId: TOKEN_A.tokenId, target: oldLifetime })).toBe(false);
        expect(controller.getState().reveal).toBeNull();
        expect(execute).not.toHaveBeenCalled();
    });

    it('loads summaries through the UI Action front door and preserves them during refresh', async () => {
        let finishRefresh!: (value: ActionExecuteResult) => void;
        const deferred = new Promise<ActionExecuteResult>((resolve) => { finishRefresh = resolve; });
        const harness = createHarness([ok({ tokens: [TOKEN_A] }), deferred]);

        await harness.controller.refresh();
        expect(harness.controller.getState()).toMatchObject({
            phase: 'ready',
            tokens: [TOKEN_A],
            isRefreshing: false,
        });

        const pending = harness.controller.refresh();
        expect(harness.controller.getState()).toMatchObject({
            phase: 'ready',
            tokens: [TOKEN_A],
            isRefreshing: true,
        });
        finishRefresh(ok({ tokens: [TOKEN_A, TOKEN_B] }));
        await pending;

        expect(harness.controller.getState()).toMatchObject({ tokens: [TOKEN_A, TOKEN_B], isRefreshing: false });
        expect(harness.execute).toHaveBeenNthCalledWith(
            1,
            'account.apiTokens.list',
            {},
            expect.objectContaining({ surface: 'ui', actionCaller: { kind: 'host' }, signal: expect.any(AbortSignal) }),
        );
    });

    it('keeps last-known content available when a background refresh fails', async () => {
        const harness = createHarness([
            ok({ tokens: [TOKEN_A] }),
            { ok: false, errorCode: 'auth_unavailable', error: 'auth_unavailable' },
        ]);

        await harness.controller.refresh();
        await harness.controller.refresh();

        expect(harness.controller.getState()).toMatchObject({
            phase: 'ready',
            tokens: [TOKEN_A],
            isRefreshing: false,
            listError: 'auth_unavailable',
        });
    });

    it('reopens a collection with the last-known rows of the same Account and keeps them when that refresh fails', async () => {
        const lifetime = createLifetime();
        const failure: ActionExecuteResult = { ok: false, errorCode: 'network_error', error: 'network_error' };
        const first = createApiTokenSettingsController({
            execute: vi.fn<ApiTokenSettingsExecute>(async () => ok({ tokens: [TOKEN_A, TOKEN_B] })),
            captureActiveAccountScopeLifetime: () => lifetime,
            now: () => NOW,
        });
        await first.refresh();
        first.retire();

        const reopened = createApiTokenSettingsController({
            execute: vi.fn<ApiTokenSettingsExecute>(async () => failure),
            captureActiveAccountScopeLifetime: () => lifetime,
            now: () => NOW,
        });
        await reopened.refresh();
        expect(reopened.getState()).toMatchObject({
            phase: 'ready', tokens: [TOKEN_A, TOKEN_B], isRefreshing: false, listError: 'network_error',
        });

        // Another Account never inherits those rows.
        const otherAccount = createApiTokenSettingsController({
            execute: vi.fn<ApiTokenSettingsExecute>(async () => failure),
            captureActiveAccountScopeLifetime: () => createLifetime('account-b'),
            now: () => NOW,
        });
        await otherAccount.refresh();
        expect(otherAccount.getState()).toMatchObject({ phase: 'error', tokens: [], listError: 'network_error' });
    });

    it('normalizes unsupported executor failures instead of inventing UI states', async () => {
        const harness = createHarness([
            { ok: false, errorCode: 'account_mismatch', error: 'account_mismatch' },
        ]);

        await harness.controller.refresh();

        expect(harness.controller.getState()).toMatchObject({
            phase: 'error',
            listError: 'unavailable',
        });
    });

    it('preserves the canonical invalid-request failure for presentation', async () => {
        const harness = createHarness([
            { ok: false, errorCode: 'invalid_request', error: 'invalid_request' },
        ]);

        await harness.controller.refresh();

        expect(harness.controller.getState()).toMatchObject({
            phase: 'error',
            listError: 'invalid_request',
        });
    });

    it('preserves the active operation projection when another request is attempted while it is busy', async () => {
        let finishRevoke!: (value: ActionExecuteResult) => void;
        const pendingRevoke = new Promise<ActionExecuteResult>((resolve) => { finishRevoke = resolve; });
        const harness = createHarness([pendingRevoke]);
        harness.controller.setCreateDraft({ label: 'Second token', expiryPreset: '90d' });

        const revoke = harness.controller.revokeToken(TOKEN_A.tokenId);
        const activeState = harness.controller.getState();
        expect(activeState).toMatchObject({
            createDraft: { label: 'Second token', expiryPreset: '90d' },
            operation: 'revoke',
            operationTokenId: TOKEN_A.tokenId,
            operationError: null,
            operationNotice: null,
        });

        await harness.controller.refresh();
        await expect(harness.controller.createToken()).resolves.toBeUndefined();
        await expect(harness.controller.revokeToken(TOKEN_B.tokenId)).resolves.toBe(false);
        await expect(harness.controller.revokeAllTokens()).resolves.toBeNull();
        await expect(harness.controller.signOutEverywhere()).resolves.toBe(false);

        expect(harness.controller.getState()).toEqual(activeState);
        expect(harness.execute).toHaveBeenCalledOnce();

        finishRevoke(ok({ revoked: true }));
        await expect(revoke).resolves.toBe(true);
        expect(harness.controller.getState()).toMatchObject({
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: 'revoked',
        });
    });

    it('sends the request-owned selector for an ordinary create and keeps it while the row is still listed', async () => {
        const harness = createHarness([
            { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' },
            ok({ tokens: [TOKEN_A] }),
        ]);
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d' });

        await harness.controller.createToken();

        expect(harness.execute).toHaveBeenNthCalledWith(
            1,
            'account.apiTokens.create',
            { tokenId: TOKEN_A.tokenId, label: TOKEN_A.label, expiresAt: '2026-11-20T12:00:00.000Z' },
            expect.objectContaining({ surface: 'ui' }),
        );
        expect(harness.controller.getState()).toMatchObject({
            createError: 'outcome_unknown',
            recoveryTokenId: TOKEN_A.tokenId,
            tokens: [TOKEN_A],
            reveal: null,
        });
    });

    it('discloses nothing when an ordinary create returns a selector this attempt did not request', async () => {
        const harness = createHarness([
            ok({
                token: `hap_v1_${TOKEN_B.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
                apiToken: TOKEN_B,
            }),
            ok({ tokens: [TOKEN_A] }),
        ]);
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d' });

        await harness.controller.createToken();

        expect(harness.controller.getState()).toMatchObject({
            createError: 'invalid_response',
            recoveryTokenId: TOKEN_A.tokenId,
            tokens: [TOKEN_A],
            reveal: null,
        });
        // The returned row is never adopted, retried or revoked on this attempt.
        expect(harness.execute.mock.calls.map(([id]) => id)).toEqual([
            'account.apiTokens.create',
            'account.apiTokens.list',
        ]);
    });

    it('reconciles a lost create against the authoritative list before permitting a replacement', async () => {
        const harness = createHarness([
            { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' },
            ok({ tokens: [TOKEN_A] }),
            ok({ tokens: [] }),
            ok({
                token: `hap_v1_${TOKEN_B.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
                apiToken: TOKEN_B,
            }),
        ]);
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d' });

        await harness.controller.createToken();
        expect(harness.controller.getState().recoveryTokenId).toBe(TOKEN_A.tokenId);

        // No replacement may be minted while the request-owned row may still exist.
        await harness.controller.createToken();
        expect(harness.execute).toHaveBeenCalledTimes(2);

        // Another client revoked that exact row; the authoritative list proves absence.
        await harness.controller.refresh();
        expect(harness.controller.getState()).toMatchObject({ recoveryTokenId: null, tokens: [] });

        uuid.next = TOKEN_B.tokenId;
        await harness.controller.createToken();
        expect(harness.execute).toHaveBeenLastCalledWith(
            'account.apiTokens.create',
            expect.objectContaining({ tokenId: TOKEN_B.tokenId }),
            expect.objectContaining({ surface: 'ui' }),
        );
        expect(harness.controller.getState()).toMatchObject({
            reveal: { apiToken: TOKEN_B, acknowledged: false },
            recoveryTokenId: null,
            createError: null,
        });
    });

    it('retains the create draft after a typed failure and reveals a successful secret only in controller memory', async () => {
        const harness = createHarness([
            { ok: false, errorCode: 'present_user_required', error: 'present_user_required' },
            ok({
                token: `hap_v1_${TOKEN_A.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
                apiToken: TOKEN_A,
            }),
        ]);
        harness.controller.setCreateDraft({
            label: TOKEN_A.label,
            expiryPreset: '90d',
            authorizeUnattendedTeamAccess: true,
        });

        await harness.controller.createToken();
        expect(harness.controller.getState()).toMatchObject({
            createDraft: { label: TOKEN_A.label, expiryPreset: '90d', authorizeUnattendedTeamAccess: true },
            createError: 'present_user_required',
            reveal: null,
        });

        await harness.controller.createToken();
        expect(harness.controller.getState()).toMatchObject({
            createError: null,
            reveal: {
                token: `hap_v1_${TOKEN_A.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
                apiToken: TOKEN_A,
                acknowledged: false,
            },
        });
        expect(harness.execute).toHaveBeenLastCalledWith(
            'account.apiTokens.create',
            {
                tokenId: TOKEN_A.tokenId,
                label: TOKEN_A.label,
                expiresAt: '2026-11-20T12:00:00.000Z',
                authorizeUnattendedTeamAccess: true,
            },
            expect.objectContaining({ surface: 'ui', actionCaller: { kind: 'host' } }),
        );
    });

    it.each([
        'unsupported_action',
        'approvals_not_supported',
        'approval_rejected',
        'approval_canceled',
        'action_disabled',
        'account-disabled',
        'invalid_request',
        'invalid_parameters',
        'api_token_encryption_not_ready',
        'api_token_encryption_stale',
        'credential_authentication_evidence_limit',
        'api_token_id_conflict',
    ])('keeps known pre-effect failure %s typed with no recovery row', async (errorCode) => {
        const harness = createHarness([{ ok: false, errorCode, error: errorCode }]);
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d' });

        await harness.controller.createToken();

        expect(harness.controller.getState()).toMatchObject({
            createError: errorCode === 'unsupported_action' ? 'unsupported'
                : errorCode === 'invalid_parameters' ? 'invalid_request'
                    : errorCode,
            recoveryTokenId: null,
            reveal: null,
        });
    });

    it('does not infer outcome_unknown from a generic create transport failure', async () => {
        const harness = createHarness([
            { ok: false, errorCode: 'network_error', error: 'network_error' },
        ]);
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d' });
        await harness.controller.createToken();
        expect(harness.controller.getState()).toMatchObject({ createError: 'network_error', recoveryTokenId: null });
    });

    it('keeps list state intact when revoke or revoke-all loses an issued response', async () => {
        const harness = createHarness([
            ok({ tokens: [TOKEN_A, TOKEN_B] }),
            { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' },
            { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' },
        ]);
        await harness.controller.refresh();

        await expect(harness.controller.revokeToken(TOKEN_A.tokenId)).resolves.toBe(false);
        expect(harness.controller.getState()).toMatchObject({
            tokens: [TOKEN_A, TOKEN_B],
            operation: null,
            operationTokenId: null,
            operationError: 'outcome_unknown',
            recoveryTokenId: null,
        });

        harness.controller.clearOperationFeedback();
        await expect(harness.controller.revokeAllTokens()).resolves.toBeNull();
        expect(harness.controller.getState()).toMatchObject({
            tokens: [TOKEN_A, TOKEN_B],
            operation: null,
            operationError: 'outcome_unknown',
            recoveryTokenId: null,
        });
    });

    it('suppresses a late create secret after dismissal and retains its exact recovery selector', async () => {
        let finishCreate!: (value: ActionExecuteResult) => void;
        const pendingCreate = new Promise<ActionExecuteResult>((resolve) => { finishCreate = resolve; });
        const harness = createHarness([pendingCreate, ok({ tokens: [TOKEN_A] })]);
        const confirmDismiss = vi.fn(async () => true);
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d' });

        const create = harness.controller.createToken();
        expect(harness.controller.getState()).toMatchObject({ createPending: true, reveal: null });

        await expect(harness.controller.requestRevealDismiss(confirmDismiss, 'shared')).resolves.toBe(true);
        expect(confirmDismiss).not.toHaveBeenCalled();
        expect(harness.controller.getState()).toMatchObject({ createPending: false, reveal: null });

        finishCreate(ok({
            token: `hap_v1_${TOKEN_A.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
            apiToken: TOKEN_A,
        }));
        await create;

        expect(harness.controller.getState()).toMatchObject({
            createPending: false,
            createError: 'outcome_unknown',
            recoveryTokenId: TOKEN_A.tokenId,
            tokens: [TOKEN_A],
            reveal: null,
        });
        expect(harness.execute.mock.calls.map(([actionId]) => actionId)).toEqual([
            'account.apiTokens.create',
            'account.apiTokens.list',
        ]);
    });

    it('warns once for every unacknowledged dismissal path, never traps, and clears the secret on permitted exit', async () => {
        const createResult = ok({
            token: `hap_v1_${TOKEN_A.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
            apiToken: TOKEN_A,
        });
        const harness = createHarness([createResult, createResult]);
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: 'none' });
        await harness.controller.createToken();
        const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

        await expect(harness.controller.requestRevealDismiss(confirm, 'shared')).resolves.toBe(false);
        expect(harness.controller.getState().reveal?.token).toContain('hap_v1_');
        await expect(harness.controller.requestRevealDismiss(confirm, 'action')).resolves.toBe(true);
        expect(harness.controller.getState().reveal).toBeNull();
        expect(confirm).toHaveBeenCalledTimes(2);

        await harness.controller.createToken();
        harness.controller.acknowledgeReveal();
        await expect(harness.controller.requestRevealDismiss(confirm, 'shared')).resolves.toBe(true);
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(harness.controller.getState().reveal).toBeNull();
    });

    it('clears a cancelled create draft even when no secret has been revealed', () => {
        const harness = createHarness([]);
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '30d' });

        harness.controller.clearReveal();

        expect(harness.controller.getState()).toMatchObject({
            createDraft: { label: '', expiryPreset: '90d' },
            createError: null,
            reveal: null,
        });
    });

    it('keeps a token visible after revoke fails and removes it only after confirmed success', async () => {
        const harness = createHarness([
            ok({ tokens: [TOKEN_A] }),
            ok({ revoked: false }),
            ok({ revoked: true }),
        ]);
        await harness.controller.refresh();

        await expect(harness.controller.revokeToken(TOKEN_A.tokenId)).resolves.toBe(false);
        expect(harness.controller.getState()).toMatchObject({
            tokens: [TOKEN_A],
            operation: null,
            operationError: 'not_revoked',
        });

        await expect(harness.controller.revokeToken(TOKEN_A.tokenId)).resolves.toBe(true);
        expect(harness.controller.getState()).toMatchObject({
            tokens: [],
            operationError: null,
            operationNotice: 'revoked',
        });
    });

    it('revokes one token, revokes all tokens, and signs out sessions with separate Action semantics', async () => {
        const harness = createHarness([
            ok({ tokens: [TOKEN_A, TOKEN_B] }),
            ok({ revoked: true }),
            ok({ revokedCount: 1 }),
            ok({ status: 'signed_out' }),
        ]);
        await harness.controller.refresh();
        await harness.controller.revokeToken(TOKEN_A.tokenId);
        expect(harness.controller.getState().tokens).toEqual([TOKEN_B]);
        await harness.controller.revokeAllTokens();
        expect(harness.controller.getState().tokens).toEqual([]);
        await harness.controller.signOutEverywhere();

        expect(harness.execute.mock.calls.map(([id]) => id)).toEqual([
            'account.apiTokens.list',
            'account.apiTokens.revoke',
            'account.apiTokens.revokeAll',
            'account.sessions.signOutEverywhere',
        ]);
    });

    it('never applies a destructive confirmation opened for one Account to the Account active at confirm', async () => {
        let active = createLifetime('account-a');
        const execute = vi.fn<ApiTokenSettingsExecute>(async () => ok({ revoked: true, revokedCount: 1, status: 'signed_out' }));
        const controller = createApiTokenSettingsController({ execute, captureActiveAccountScopeLifetime: () => active, now: () => NOW });

        const target = controller.captureDestructiveTarget();
        expect(target?.scope.accountId).toBe('account-a');
        // The person switches Account while the confirmation is open.
        active.retire();
        active = createLifetime('account-b');

        await expect(controller.revokeToken(TOKEN_A.tokenId, target!)).resolves.toBe(false);
        await expect(controller.revokeAllTokens(target!)).resolves.toBeNull();
        await expect(controller.signOutEverywhere(target!)).resolves.toBe(false);
        expect(execute).not.toHaveBeenCalled();
        expect(controller.getState().operationError).toBe('account_changed');
    });

    it('drops content, draft, secret, and stale results when the Account/server scope retires', async () => {
        let finish!: (value: ActionExecuteResult) => void;
        const deferred = new Promise<ActionExecuteResult>((resolve) => { finish = resolve; });
        const harness = createHarness([deferred]);
        harness.controller.setCreateDraft({ label: 'Account A token', expiryPreset: '30d' });

        const pending = harness.controller.refresh();
        harness.lifetime.retire();
        finish(ok({ tokens: [TOKEN_A] }));
        await pending;

        expect(harness.controller.getState()).toMatchObject({
            phase: 'idle',
            tokens: [],
            createDraft: { label: '', expiryPreset: '90d' },
            reveal: null,
        });
    });
    describe('scoped grants', () => {
        const LIMITED_GRANT = {
            ...API_TOKEN_FULL_GRANT_V1,
            actions: { families: ['messaging' as const, 'session_transcripts' as const], ids: ['session.user_action.answer'] },
            targets: { sessions: ['session-1'], machines: [] },
            approve: true,
            origins: ['http://localhost:5173'],
            models: [{ agentTargetKey: 'claude', providerConnectionId: null, modelId: 'claude-sonnet-4-5' }],
        };

        it('creates a limited token with the exact grant it was given, models included', async () => {
            const harness = createHarness([ok({
                token: `hap_v1_${TOKEN_A.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
                apiToken: { ...TOKEN_A, grant: LIMITED_GRANT },
            })]);
            harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '30d', access: 'limited', grant: LIMITED_GRANT });

            await harness.controller.createToken();

            expect(harness.execute).toHaveBeenNthCalledWith(
                1,
                'account.apiTokens.create',
                { tokenId: TOKEN_A.tokenId, label: TOKEN_A.label, expiresAt: '2026-09-21T12:00:00.000Z', grant: LIMITED_GRANT },
                expect.objectContaining({ surface: 'ui' }),
            );
            expect(harness.controller.getState().reveal?.apiToken.grant).toEqual(LIMITED_GRANT);
        });

        it('sends no grant for full access even when a limited draft was prepared earlier', async () => {
            const harness = createHarness([ok({
                token: `hap_v1_${TOKEN_A.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
                apiToken: TOKEN_A,
            })]);
            harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d', access: 'full', grant: LIMITED_GRANT });

            await harness.controller.createToken();

            expect(harness.execute.mock.calls[0]?.[1]).not.toHaveProperty('grant');
        });

        it('refuses to send a limited grant that the protocol schema rejects', async () => {
            const harness = createHarness([]);
            harness.controller.setCreateDraft({
                label: TOKEN_A.label,
                expiryPreset: '90d',
                access: 'limited',
                grant: { ...LIMITED_GRANT, actions: { families: [], ids: [] } },
            });

            await harness.controller.createToken();

            expect(harness.execute).not.toHaveBeenCalled();
            expect(harness.controller.getState().createError).toBe('grant_incomplete');
        });

        it('saves edited access through account.apiTokens.update and adopts the returned summary', async () => {
            const updated = { ...TOKEN_A, grant: LIMITED_GRANT, activeChildCount: 0 };
            const harness = createHarness([
                ok({ tokens: [{ ...TOKEN_A, activeChildCount: 2 }, TOKEN_B] }),
                ok({ apiToken: updated }),
            ]);
            await harness.controller.refresh();

            harness.controller.beginAccessEdit(TOKEN_A.tokenId);
            expect(harness.controller.getState().accessEdit).toMatchObject({
                tokenId: TOKEN_A.tokenId,
                grant: API_TOKEN_FULL_GRANT_V1,
                signsOutEmbeddedCredentials: true,
            });
            harness.controller.setAccessEditGrant(LIMITED_GRANT);
            const saved = await harness.controller.saveAccessEdit();

            expect(saved).toBe(true);
            expect(harness.execute).toHaveBeenNthCalledWith(
                2,
                'account.apiTokens.update',
                { tokenId: TOKEN_A.tokenId, grant: LIMITED_GRANT },
                expect.objectContaining({ surface: 'ui', actionCaller: { kind: 'host' } }),
            );
            expect(harness.controller.getState()).toMatchObject({
                tokens: [updated, TOKEN_B],
                accessEdit: null,
            });
        });

        it('keeps every edited choice and the error when saving access fails', async () => {
            const harness = createHarness([
                ok({ tokens: [TOKEN_A] }),
                { ok: false, errorCode: 'network_error', error: 'network_error' },
            ]);
            await harness.controller.refresh();
            harness.controller.beginAccessEdit(TOKEN_A.tokenId);
            harness.controller.setAccessEditGrant(LIMITED_GRANT);

            expect(await harness.controller.saveAccessEdit()).toBe(false);

            expect(harness.controller.getState()).toMatchObject({
                tokens: [TOKEN_A],
                accessEdit: { tokenId: TOKEN_A.tokenId, grant: LIMITED_GRANT, pending: false, error: 'network_error' },
            });
        });
    });
});

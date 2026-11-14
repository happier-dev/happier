import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

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
import {
    apiTokenReadWireFixture,
    createApiTokenSettingsControllerHarness,
    disposeApiTokenSettingsControllerHarnesses,
    type ApiTokenSettingsControllerHarnessOptions,
} from './apiTokenSettingsControllerTestHarness';

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

async function createRealHarness(options: ApiTokenSettingsControllerHarnessOptions = {}) {
    return createApiTokenSettingsControllerHarness({ mode: 'plain', ...options });
}

describe('createApiTokenSettingsController', () => {
    afterEach(async () => {
        await disposeApiTokenSettingsControllerHarnesses();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });
    beforeEach(() => {
        uuid.next = TOKEN_A.tokenId;
    });

    it('adopts an approved creation into the existing show-once lifecycle without minting again', async () => {
        const harness = await createRealHarness();
        const token = `hap_v1_${TOKEN_A.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
        const result = { token, apiToken: apiTokenReadWireFixture(TOKEN_A) };
        await expect(harness.controller.adoptCreatedToken({ result,
            tokenId: TOKEN_A.tokenId, target: harness.lifetime })).resolves.toBe(true);
        expect(harness.controller.getState()).toMatchObject({
            phase: 'ready', tokens: [TOKEN_A], reveal: { token, apiToken: TOKEN_A, acknowledged: false },
        });
        expect(harness.requests).toEqual([]);
        await expect(harness.controller.requestRevealDismiss(async () => false, 'shared')).resolves.toBe(false);
        harness.controller.acknowledgeReveal();
        await expect(harness.controller.requestRevealDismiss(async () => false, 'action')).resolves.toBe(true);
        expect(harness.controller.getState().reveal).toBeNull();
        await expect(harness.controller.adoptCreatedToken({ result,
            tokenId: TOKEN_A.tokenId, target: harness.lifetime })).resolves.toBe(true);
        harness.controller.retire();
        expect(harness.controller.getState().reveal).toBeNull();
    });

    it('refuses an invalid or stale approved creation instead of falling back to the current Account', async () => {
        const oldLifetime = createLifetime();
        let currentLifetime = oldLifetime;
        const execute = vi.fn<ApiTokenSettingsExecute>(async () => ok({ tokens: [] }));
        const controller = createApiTokenSettingsController({ execute,
            captureActiveAccountScopeLifetime: () => currentLifetime, now: () => NOW });
        const token = `hap_v1_${TOKEN_A.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
        for (const result of [
            { token, apiToken: TOKEN_A, unexpected: true },
            { token, apiToken: TOKEN_B },
        ]) {
            await expect(controller.adoptCreatedToken({ result, tokenId: TOKEN_A.tokenId, target: oldLifetime })).resolves.toBe(false);
            expect(controller.getState().reveal).toBeNull();
        }
        await expect(controller.adoptCreatedToken({ result: { token, apiToken: TOKEN_A },
            tokenId: TOKEN_B.tokenId, target: oldLifetime })).resolves.toBe(false);
        oldLifetime.retire();
        currentLifetime = createLifetime('account-b');
        await expect(controller.adoptCreatedToken({ result: { token, apiToken: TOKEN_A },
            tokenId: TOKEN_A.tokenId, target: oldLifetime })).resolves.toBe(false);
        expect(controller.getState().reveal).toBeNull();
        expect(execute).not.toHaveBeenCalled();
    });

    it('loads summaries through the UI Action front door and preserves them during refresh', async () => {
        const harness = await createRealHarness({ rows: [apiTokenReadWireFixture(TOKEN_A), apiTokenReadWireFixture(TOKEN_B)] });

        await harness.controller.refresh();
        expect(harness.controller.getState()).toMatchObject({
            phase: 'ready',
            tokens: [TOKEN_A, TOKEN_B],
            isRefreshing: false,
        });

        await harness.controller.refresh();

        expect(harness.controller.getState()).toMatchObject({ tokens: [TOKEN_A, TOKEN_B], isRefreshing: false });
        expect(harness.requests.filter((request) => request.path.endsWith('/list'))).toHaveLength(2);
        harness.controller.retire();
    });

    it('keeps last-known content available when a background refresh fails', async () => {
        const harness = await createRealHarness({ rows: [apiTokenReadWireFixture(TOKEN_A)] });

        await harness.controller.refresh();
        harness.setListAvailable(false);
        await harness.controller.refresh();

        expect(harness.controller.getState()).toMatchObject({
            phase: 'ready',
            tokens: [expect.objectContaining({ tokenId: TOKEN_A.tokenId, label: TOKEN_A.label })],
            isRefreshing: false,
            listError: 'network_error',
        });
        harness.controller.retire();
    });

    it('reopens a collection with the last-known rows of the same Account and keeps them when that refresh fails', async () => {
        const harness = await createRealHarness({ rows: [apiTokenReadWireFixture(TOKEN_A), apiTokenReadWireFixture(TOKEN_B)] });
        await harness.controller.refresh();
        harness.controller.retire();
        harness.setListAvailable(false);
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const reopened = createApiTokenSettingsController({
            execute: createDefaultActionExecutor().execute,
            captureActiveAccountScopeLifetime: () => harness.lifetime,
            now: () => NOW,
        });
        await reopened.refresh();
        expect(reopened.getState()).toMatchObject({
            phase: 'ready', tokens: [TOKEN_A, TOKEN_B], isRefreshing: false, listError: 'network_error',
        });
        reopened.retire();
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

    it('seals the request-owned selector before an ordinary create and keeps it while the row is still listed', async () => {
        const harness = await createRealHarness({ failure: 'network' });
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d' });

        await harness.controller.createToken();

        const createRequest = harness.requests.find((request) => request.path === '/v1/auth/api-tokens/create');
        expect(createRequest?.body).toMatchObject({
            tokenId: TOKEN_A.tokenId,
            label: { content: { t: 'plain', v: TOKEN_A.label }, recipients: [] },
        });
        expect(harness.requests[0]?.path).toBe('/v1/account/private-labels/recipient-census');
        expect(harness.controller.getState()).toMatchObject({
            createError: 'outcome_unknown',
            recoveryTokenId: TOKEN_A.tokenId,
            tokens: [expect.objectContaining({ tokenId: TOKEN_A.tokenId, label: TOKEN_A.label })],
            reveal: null,
        });
        harness.controller.retire();
    });

    it('discloses nothing when an ordinary create returns a selector this attempt did not request', async () => {
        const harness = await createRealHarness({ failure: 'mismatch' });
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d' });

        await harness.controller.createToken();

        expect(harness.controller.getState()).toMatchObject({
            createError: 'invalid_response',
            recoveryTokenId: null,
            reveal: null,
        });
        // The returned row is never adopted, retried or revoked on this attempt.
        expect(harness.requests.some((request) => request.path === '/v1/auth/api-tokens/create')).toBe(true);
        expect(harness.requests.some((request) => request.path === '/v1/auth/api-tokens/list')).toBe(true);
        expect(harness.requests.some((request) => request.path === '/v1/auth/api-tokens/revoke')).toBe(false);
        harness.controller.retire();
    });

    it('reconciles a lost create against the authoritative list before permitting a replacement', async () => {
        const harness = await createRealHarness({ failure: 'network' });
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d' });

        await harness.controller.createToken();
        expect(harness.controller.getState().recoveryTokenId).toBe(TOKEN_A.tokenId);

        // No replacement may be minted while the request-owned row may still exist.
        await harness.controller.createToken();
        expect(harness.requests.filter((request) => request.path === '/v1/auth/api-tokens/create')).toHaveLength(1);

        // Another client revoked that exact row; the authoritative list proves absence.
        harness.removeRow(TOKEN_A.tokenId);
        await harness.controller.refresh();
        expect(harness.controller.getState()).toMatchObject({ recoveryTokenId: null, tokens: [] });

        uuid.next = TOKEN_B.tokenId;
        harness.setFailure(undefined);
        harness.controller.setCreateDraft({ label: TOKEN_B.label, expiryPreset: 'none' });
        await harness.controller.createToken();
        expect(harness.requests.filter((request) => request.path === '/v1/auth/api-tokens/create')).toHaveLength(2);
        expect(harness.controller.getState()).toMatchObject({
            reveal: { apiToken: expect.objectContaining({ tokenId: TOKEN_B.tokenId, label: TOKEN_B.label }), acknowledged: false },
            recoveryTokenId: null,
            createError: null,
        });
        harness.controller.retire();
    });

    it('keeps list state intact when revoke is refused', async () => {
        const harness = await createRealHarness({
            rows: [apiTokenReadWireFixture(TOKEN_A), apiTokenReadWireFixture(TOKEN_B)],
            revokeFailure: 'not-revoked',
        });
        await harness.controller.refresh();

        await expect(harness.controller.revokeToken(TOKEN_A.tokenId)).resolves.toBe(false);
        expect(harness.controller.getState()).toMatchObject({
            tokens: [TOKEN_A, TOKEN_B],
            operation: null,
            operationTokenId: null,
            operationError: 'not_revoked',
            recoveryTokenId: null,
        });

        expect(harness.requests.some((request) => request.path === '/v1/auth/api-tokens/revoke')).toBe(true);
        harness.controller.retire();
    });

    it('suppresses a late create secret after dismissal and retains its exact recovery selector', async () => {
        let finishCreate!: () => void;
        const hold = new Promise<void>((resolve) => { finishCreate = resolve; });
        const harness = await createRealHarness({ hold });
        const confirmDismiss = vi.fn(async () => true);
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d' });

        const create = harness.controller.createToken();
        expect(harness.controller.getState()).toMatchObject({ createPending: true, reveal: null });
        // The controller now seals before it reaches the Action boundary. This
        // scenario is specifically a post-issue response loss, not a cancelled
        // pre-issue seal.
        await vi.waitFor(() => expect(harness.requests.some((request) => request.path === '/v1/auth/api-tokens/create')).toBe(true));

        await expect(harness.controller.requestRevealDismiss(confirmDismiss, 'shared')).resolves.toBe(true);
        expect(confirmDismiss).not.toHaveBeenCalled();
        expect(harness.controller.getState()).toMatchObject({ createPending: false, reveal: null });

        finishCreate();
        await create;

        expect(harness.controller.getState()).toMatchObject({
            createPending: false,
            createError: 'outcome_unknown',
            recoveryTokenId: TOKEN_A.tokenId,
            tokens: [expect.objectContaining({ tokenId: TOKEN_A.tokenId, label: TOKEN_A.label })],
            reveal: null,
        });
        expect(harness.requests.some((request) => request.path === '/v1/auth/api-tokens/list')).toBe(true);
        harness.controller.retire();
    });

    it('warns once for every unacknowledged dismissal path, never traps, and clears the secret on permitted exit', async () => {
        const harness = await createRealHarness();
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: 'none' });
        await harness.controller.createToken();
        const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

        await expect(harness.controller.requestRevealDismiss(confirm, 'shared')).resolves.toBe(false);
        expect(harness.controller.getState().reveal?.token).toContain('hap_v1_');
        await expect(harness.controller.requestRevealDismiss(confirm, 'action')).resolves.toBe(true);
        expect(harness.controller.getState().reveal).toBeNull();
        expect(confirm).toHaveBeenCalledTimes(2);

        uuid.next = TOKEN_B.tokenId;
        await harness.controller.createToken();
        harness.controller.acknowledgeReveal();
        await expect(harness.controller.requestRevealDismiss(confirm, 'shared')).resolves.toBe(true);
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(harness.controller.getState().reveal).toBeNull();
        harness.controller.retire();
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
        const harness = await createRealHarness({
            rows: [apiTokenReadWireFixture(TOKEN_A)],
            revokeFailure: 'not-revoked',
        });
        await harness.controller.refresh();

        await expect(harness.controller.revokeToken(TOKEN_A.tokenId)).resolves.toBe(false);
        expect(harness.controller.getState()).toMatchObject({
            tokens: [TOKEN_A],
            operation: null,
            operationError: 'not_revoked',
        });

        harness.setRevokeFailure(undefined);
        await expect(harness.controller.revokeToken(TOKEN_A.tokenId)).resolves.toBe(true);
        expect(harness.controller.getState()).toMatchObject({
            tokens: [],
            operationError: null,
            operationNotice: 'revoked',
        });
        harness.controller.retire();
    });

    it('revokes one token and then all tokens through separate Action semantics', async () => {
        const harness = await createRealHarness({
            rows: [apiTokenReadWireFixture(TOKEN_A), apiTokenReadWireFixture(TOKEN_B)],
        });
        await harness.controller.refresh();
        await harness.controller.revokeToken(TOKEN_A.tokenId);
        expect(harness.controller.getState().tokens).toEqual([TOKEN_B]);
        await harness.controller.revokeAllTokens();
        expect(harness.controller.getState().tokens).toEqual([]);
        expect(harness.requests.map(({ path }) => path)).toEqual(expect.arrayContaining([
            '/v1/auth/api-tokens/list',
            '/v1/auth/api-tokens/revoke',
            '/v1/auth/api-tokens/revoke-all',
        ]));
        harness.controller.retire();
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
            const harness = await createRealHarness();
            harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '30d', access: 'limited', grant: LIMITED_GRANT });

            await harness.controller.createToken();

            const request = harness.requests.find((entry) => entry.path === '/v1/auth/api-tokens/create');
            expect(request?.body).toMatchObject({ tokenId: TOKEN_A.tokenId, grant: LIMITED_GRANT });
            expect(harness.controller.getState().reveal?.apiToken.grant).toEqual(LIMITED_GRANT);
            harness.controller.retire();
        });

        it('sends no grant for full access even when a limited draft was prepared earlier', async () => {
            const harness = await createRealHarness();
            harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d', access: 'full', grant: LIMITED_GRANT });

            await harness.controller.createToken();

            const request = harness.requests.find((entry) => entry.path === '/v1/auth/api-tokens/create');
            expect(request?.body).not.toHaveProperty('grant');
            harness.controller.retire();
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
            const updated = { ...TOKEN_A, grant: LIMITED_GRANT, activeChildCount: 2 };
            const harness = await createRealHarness({ rows: [apiTokenReadWireFixture({ ...TOKEN_A, activeChildCount: 2 }), apiTokenReadWireFixture(TOKEN_B)] });
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
            expect(harness.requests.find((request) => request.path === '/v1/auth/api-tokens/update')?.body).toEqual({
                tokenId: TOKEN_A.tokenId, grant: LIMITED_GRANT,
            });
            expect(harness.controller.getState()).toMatchObject({
                tokens: [updated, TOKEN_B],
                accessEdit: null,
            });
            harness.controller.retire();
        });

        it('keeps every edited choice and the error when saving access fails', async () => {
            const harness = await createRealHarness({ rows: [apiTokenReadWireFixture(TOKEN_A)], updateFailure: 'network' });
            await harness.controller.refresh();
            harness.controller.beginAccessEdit(TOKEN_A.tokenId);
            harness.controller.setAccessEditGrant(LIMITED_GRANT);

            expect(await harness.controller.saveAccessEdit()).toBe(false);

            expect(harness.controller.getState()).toMatchObject({
                tokens: [TOKEN_A],
                accessEdit: { tokenId: TOKEN_A.tokenId, grant: LIMITED_GRANT, pending: false, error: 'outcome_unknown' },
            });
            harness.controller.retire();
        });
    });
});

import { describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol';

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
    displayPrefix: 'hap_11111111',
    createdAt: '2026-08-20T12:00:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
} as const;

const TOKEN_B = {
    tokenId: '22222222-2222-4222-8222-222222222222',
    label: 'Release automation',
    displayPrefix: 'hap_22222222',
    createdAt: '2026-08-21T12:00:00.000Z',
    lastUsedAt: '2026-08-22T11:00:00.000Z',
    expiresAt: '2026-08-29T12:00:00.000Z',
} as const;

type TestLifetime = ActiveServerAccountScopeLifetime & Readonly<{ retire(): void }>;

function createLifetime(): TestLifetime {
    let current = true;
    const callbacks = new Set<() => void>();
    return {
        scope: { serverId: 'server-a', accountId: 'account-a' },
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

    it('retains the create draft after a typed failure and reveals a successful secret only in controller memory', async () => {
        const harness = createHarness([
            { ok: false, errorCode: 'present_user_required', error: 'present_user_required' },
            ok({
                token: `hap_v1_${TOKEN_A.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
                apiToken: TOKEN_A,
            }),
        ]);
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d' });

        await harness.controller.createToken();
        expect(harness.controller.getState()).toMatchObject({
            createDraft: { label: TOKEN_A.label, expiryPreset: '90d' },
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
            { label: TOKEN_A.label, expiresAt: '2026-11-20T12:00:00.000Z' },
            expect.objectContaining({ surface: 'ui', actionCaller: { kind: 'host' } }),
        );
    });

    it('keeps the create flow open while minting so a one-time secret cannot be lost', async () => {
        let finishCreate!: (value: ActionExecuteResult) => void;
        const pendingCreate = new Promise<ActionExecuteResult>((resolve) => { finishCreate = resolve; });
        const harness = createHarness([pendingCreate]);
        const confirmDismiss = vi.fn(async () => true);
        harness.controller.setCreateDraft({ label: TOKEN_A.label, expiryPreset: '90d' });

        const create = harness.controller.createToken();
        expect(harness.controller.getState()).toMatchObject({ createPending: true, reveal: null });

        await expect(harness.controller.requestRevealDismiss(confirmDismiss, 'shared')).resolves.toBe(false);
        expect(confirmDismiss).not.toHaveBeenCalled();
        expect(harness.controller.getState()).toMatchObject({ createPending: true, reveal: null });

        finishCreate(ok({
            token: `hap_v1_${TOKEN_A.tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
            apiToken: TOKEN_A,
        }));
        await create;

        expect(harness.controller.getState()).toMatchObject({
            createPending: false,
            reveal: { token: expect.stringContaining('hap_v1_') },
        });
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
});

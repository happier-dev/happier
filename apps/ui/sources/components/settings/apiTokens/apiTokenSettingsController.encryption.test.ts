import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
import {
    parseAccountApiTokenCredentialV1,
    type AccountApiTokenEncryptionAccessV1,
} from '@happier-dev/protocol/auth/accountApiTokens';
import {
    openApiTokenEncryptionAccessV1} from '@happier-dev/protocol/crypto/apiTokenEncryptionAccess';
import { decodeBase64 } from '@/encryption/base64';

import {
    createApiTokenSettingsControllerHarness,
    disposeApiTokenSettingsControllerHarnesses,
    type ApiTokenSettingsControllerHarnessOptions,
} from './apiTokenSettingsControllerTestHarness';

// The real store and Action graph need a longer cold-transform budget on shared workers.
beforeAll(async () => {
    await import('@/sync/domains/state/storageStore');
    await import('@/sync/ops/actions/defaultActionExecutor');
}, 600_000);
afterEach(async () => {
    await disposeApiTokenSettingsControllerHarnesses();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

async function harness(options: ApiTokenSettingsControllerHarnessOptions = {}) {
    const created = await createApiTokenSettingsControllerHarness(options);
    created.controller.setCreateDraft({ label: 'Integration', expiryPreset: '90d', encryptionAccess: true });
    return created;
}

describe('trusted token UI encryption lifecycle', () => {
    it('never probes encryption currentness during ordinary list refresh', async () => {
        const { controller, requests, withdrawCurrentness } = await harness();
        await controller.refresh();
        expect(requests.some((request) => request.path.endsWith('/currentness'))).toBe(false);
        withdrawCurrentness();
        await controller.refresh();
        expect(requests.some((request) => request.path.endsWith('/currentness'))).toBe(false);
        expect(controller.getState()).toMatchObject({ phase: 'ready' });
        controller.retire();
    }, 180_000);

    it('probes authoritative readiness lazily when encrypted creation is opened', async () => {
        const { controller, requests } = await harness();
        await controller.refreshEncryptionAvailability();
        expect(requests.filter((request) => request.path.endsWith('/currentness'))).toHaveLength(1);
        expect(controller.getState().encryptionAvailability).toBe('ready');
        controller.retire();
    }, 180_000);

    it('tells a plain Account (keyless creation) from an encrypted one whose material is not usable here', async () => {
        const plain = await harness({ mode: 'plain' });
        expect(plain.controller.getState().encryptionAvailability).toBe('unchecked');
        await plain.controller.refreshEncryptionAvailability();
        expect(plain.controller.getState().encryptionAvailability).toBe('plain');
        plain.controller.retire();

        const unavailable = await harness({ readiness: 'unavailable' });
        await unavailable.controller.refreshEncryptionAvailability();
        expect(unavailable.controller.getState().encryptionAvailability).toBe('unavailable');
        unavailable.controller.retire();
    }, 180_000);

    it('withdraws stale encrypted readiness without blocking ordinary creation', async () => {
        const { controller, withdrawCurrentness } = await harness();
        await controller.refreshEncryptionAvailability();
        expect(controller.getState().encryptionAvailability).toBe('ready');
        withdrawCurrentness();
        const refresh = controller.refreshEncryptionAvailability();
        expect(controller.getState().encryptionAvailability).toBe('checking');
        await refresh;
        expect(controller.getState()).toMatchObject({
            encryptionAvailability: 'unreadable',
            createDraft: { encryptionAccess: false },
        });

        await controller.createToken();
        expect(controller.getState()).toMatchObject({
            createError: null,
            recoveryTokenId: null,
            reveal: { token: expect.stringMatching(/^hap_v1_/), apiToken: { hasEncryptionAccess: false } },
        });
        controller.retire();
    }, 180_000);

    it('admits ordinary creation while the optional availability read is still in flight', async () => {
        let finish!: () => void;
        const holdCurrentness = new Promise<void>((resolve) => { finish = resolve; });
        const { controller, requests } = await harness({ holdCurrentness });
        controller.setCreateDraft({ label: 'Integration', expiryPreset: '90d', encryptionAccess: false });
        const availability = controller.refreshEncryptionAvailability();
        try {
            await vi.waitFor(() => expect(requests.some((request) => request.path.endsWith('/currentness'))).toBe(true));

            // The optional read is not a mutation: pressing Create must not return
            // silently with no pending state, no error and no notice.
            await controller.createToken();
            expect(controller.getState()).toMatchObject({
                createError: null,
                reveal: { token: expect.stringMatching(/^hap_v1_/) },
            });
        } finally {
            finish();
            await availability;
            controller.retire();
        }
    }, 180_000);

    it('cancels local preparation before dispatch without creating a token', async () => {
        let finish!: () => void;
        const holdCurrentness = new Promise<void>((resolve) => { finish = resolve; });
        const { controller, requests } = await harness({ holdCurrentness });
        const create = controller.createToken();
        await vi.waitFor(() => expect(requests.some((request) => request.path.endsWith('/currentness'))).toBe(true));
        await expect(controller.requestRevealDismiss(async () => true, 'shared')).resolves.toBe(true);
        finish();
        await create;
        expect(requests.some((request) => request.path.endsWith('/create'))).toBe(false);
        expect(controller.getState()).toMatchObject({ reveal: null, recoveryTokenId: null, createPending: false });
        controller.retire();
    }, 180_000);

    it('retains the exact selector and reconciles the committed row after dismissal during dispatch', async () => {
        let finish!: () => void;
        const hold = new Promise<void>((resolve) => { finish = resolve; });
        const { controller, requests } = await harness({ hold });
        const create = controller.createToken();
        await vi.waitFor(() => expect(requests.some((request) => request.path === '/v1/auth/api-tokens/create')).toBe(true));
        await expect(controller.requestRevealDismiss(async () => true, 'shared')).resolves.toBe(true);
        finish();
        await create;
        const createRequest = requests.find((request) => request.path === '/v1/auth/api-tokens/create');
        expect(controller.getState()).toMatchObject({
            reveal: null,
            createPending: false,
            createError: 'outcome_unknown',
            recoveryTokenId: createRequest?.body.tokenId,
            tokens: [expect.objectContaining({ tokenId: createRequest?.body.tokenId })],
        });
        expect(requests.filter((request) => request.path.endsWith('/list'))).toHaveLength(1);
        controller.retire();
    }, 180_000);

    it('suppresses all late results after the captured Account retires', async () => {
        let finish!: () => void;
        const hold = new Promise<void>((resolve) => { finish = resolve; });
        const { controller, requests } = await harness({ hold });
        const create = controller.createToken();
        await vi.waitFor(() => expect(requests.some((request) => request.path === '/v1/auth/api-tokens/create')).toBe(true));
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        retireActiveServerAccountScopeLifetime();
        finish();
        await create;
        expect(controller.getState()).toMatchObject({ reveal: null, tokens: [], recoveryTokenId: null, createPending: false });
        controller.retire();
    }, 180_000);

    it('preserves ordinary token access after unsupported encrypted creation', async () => {
        const { controller, requests } = await harness({ failure: 'unsupported' });
        await controller.createToken();
        expect(controller.getState()).toMatchObject({ createError: 'unsupported', recoveryTokenId: null, reveal: null });
        expect(requests.filter((request) => request.path.endsWith('/create'))).toHaveLength(1);
        controller.retire();
    }, 180_000);

    it.each(['conflict', 'account-disabled'] as const)('keeps known %s refusal typed and recovery-free', async (failure) => {
        const { controller } = await harness({ failure });
        await controller.createToken();
        expect(controller.getState()).toMatchObject({
            createError: failure === 'conflict' ? 'api_token_id_conflict' : 'account-disabled',
            recoveryTokenId: null,
            reveal: null,
        });
        controller.retire();
    }, 180_000);

    it('uses a fresh UUID when the user explicitly retries a pre-effect collision', async () => {
        const { controller, requests } = await harness({ failure: 'conflict' });
        await controller.createToken();
        await controller.createToken();
        const createIds = requests
            .filter((request) => request.path === '/v1/auth/api-tokens/create')
            .map((request) => request.body.tokenId);
        expect(createIds).toHaveLength(2);
        expect(createIds[0]).not.toBe(createIds[1]);
        expect(controller.getState().recoveryTokenId).toBeNull();
        controller.retire();
    }, 180_000);

    it('prepares locally, dispatches once, and reveals only a correctly bound combined credential', async () => {
        const { controller, requests, encryption } = await harness();
        await controller.createToken();
        const created = requests.find((request) => request.path === '/v1/auth/api-tokens/create');
        expect(created).toBeDefined();
        // The canonical create input carries the selector once, at the top level,
        // and the optional encryption arm is exactly `{ access }`.
        expect(typeof created!.body.tokenId).toBe('string');
        expect(Object.keys(created!.body.encryption as object)).toEqual(['access']);
        const reveal = controller.getState().reveal;
        expect(reveal?.token).toMatch(/^hapc_v1_/);
        const parsed = parseAccountApiTokenCredentialV1(reveal!.token);
        expect(parsed).not.toBeNull();
        expect(JSON.stringify(requests)).not.toContain(reveal!.token);
        expect(JSON.stringify(requests)).not.toContain(parsed!.wrappingSecret);
        expect(openApiTokenEncryptionAccessV1({
            context: { serverIdentityId: parsed!.serverIdentityId, accountId: parsed!.accountId, tokenId: String(created!.body.tokenId), contentPublicKey: parsed!.contentPublicKey },
            wrappingSecret: decodeBase64(parsed!.wrappingSecret, 'base64url'), encryptionAccess: (created!.body.encryption as { access: AccountApiTokenEncryptionAccessV1 }).access,
        })).toEqual(encryption!.getContentPrivateKey());
        controller.clearReveal();
        expect(controller.getState().reveal).toBeNull();
        controller.retire();
    }, 180_000);

    it.each(['network', 'malformed'] as const)('preserves the requested UUID only after outcome-unknown %s settlement', async (failure) => {
        const { controller, requests } = await harness({ failure });
        await controller.createToken();
        const created = requests.find((request) => request.path === '/v1/auth/api-tokens/create');
        const tokenId = created?.body.tokenId;
        expect(controller.getState()).toMatchObject({ reveal: null, createPending: false, recoveryTokenId: tokenId });
        expect(controller.getState().recoveryTokenId).toBeTruthy();
        expect(requests.filter((request) => request.path.endsWith('/create'))).toHaveLength(1);
        await controller.refresh();
        await controller.revokeToken(controller.getState().recoveryTokenId!);
        expect(requests.find((request) => request.path.endsWith('/revoke'))?.body).toEqual({ tokenId });
        expect(controller.getState().recoveryTokenId).toBeNull();
        controller.retire();
    }, 180_000);

    it('clears recovery after a mismatched response is absent from the authoritative list', async () => {
        const { controller, requests } = await harness({ failure: 'mismatch' });
        await controller.createToken();
        const created = requests.find((request) => request.path === '/v1/auth/api-tokens/create');
        const requestedTokenId = created?.body.tokenId;
        expect(requestedTokenId).toBeTruthy();
        expect(controller.getState()).toMatchObject({
            createError: 'invalid_response',
            recoveryTokenId: null,
            reveal: null,
        });
        expect(requests.filter((request) => request.path.endsWith('/create'))).toHaveLength(1);
        expect(requests.filter((request) => request.path.endsWith('/list'))).toHaveLength(1);
        expect(requests.some((request) => request.path.endsWith('/revoke'))).toBe(false);
        controller.retire();
    }, 180_000);
});

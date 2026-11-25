import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createCliActionExecutor } from './createCliActionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
    { name: 'owner', accountId: 'owner', actorAccountId: 'owner', allowed: true },
    { name: 'Manage guest', accountId: 'guest', actorAccountId: 'guest', allowed: false },
    { name: 'guest with owner attribution', accountId: 'owner', actorAccountId: 'guest', allowed: false },
    { name: 'foreign runtime Account', accountId: 'guest', allowed: false },
])('admits $name before handing installed Account Review services to a Workflow', async ({ accountId, actorAccountId, allowed }) => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const executor = createCliActionExecutor({ token, credentials: { token, encryption: null },
        sessionId: '', mode: 'plain', ctx: null, serverId: 'home',
        pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
    let current = true;
    const verifyMachineAdmissionCurrent = vi.fn(async () => current);
    const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation', runtimeAccountId: accountId,
        ...(actorAccountId ? { machineAdmission: { actorAccountId, custodianAccountId: 'owner', machineId: 'machine',
            installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent } : {}) };
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: { error: 'not_found' } });
    const direct = await executor.execute('reviews.comments.list', { reviewId: 'missing-review' }, context);
    if (allowed) {
        expect(direct, JSON.stringify(direct)).toMatchObject({ ok: false, error: 'review_comment_encryption_material_unavailable' });
        expect(get).toHaveBeenCalled();
    } else {
        expect(direct, JSON.stringify(direct)).toMatchObject({ ok: false, errorCode: 'review_comment_permission_denied' });
        expect(get).not.toHaveBeenCalled();
    }
    if (!allowed) {
        await expect(executor.prepare!('reviews.comments.list', { reviewId: 'missing-review' }, context))
            .resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'review_comment_permission_denied' } });
        expect(get).not.toHaveBeenCalled();
    }
    verifyMachineAdmissionCurrent.mockClear();
    const services = await executor.resolveReviewServices!(context);
    if (!allowed) {
        expect(services).toEqual({});
        return;
    }
    expect(services.records).toBeDefined();
    expect(services.comments).toBeTypeOf('function');
    // The port has been admitted. Later finite work consumes it without a new
    // Machine admission check after withdrawal.
    current = false;
    await expect(services.records!.read('missing-review')).resolves.toBeNull();
    await expect(services.comments!({ actionId: 'reviews.comments.list', input: { reviewId: 'missing-review' } }))
        .rejects.toThrow('review_comment_encryption_material_unavailable');
    expect(verifyMachineAdmissionCurrent).toHaveBeenCalledTimes(1);
});

it('keeps host Review services on their captured Home with refreshed Account credentials', async () => {
    const serverApiUrl = 'https://review-home.example.test';
    const serverIdentityId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const credential = (accountId: string, revision: number) => ({
        token: `header.${Buffer.from(JSON.stringify({ sub: accountId, revision,
            provenance: { v: 2, kind: 'terminal', authority: 'account_automation',
                evidence: [{ kind: 'home_method', methodId: 'key_challenge' }] },
        })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const,
    });
    const installed = credential('requester-account', 1);
    let current: ReturnType<typeof credential> | null = credential('requester-account', 1);
    const reads: Array<{ url: string; authorization: unknown }> = [];
    // HTTP is the boundary; credential selection, host context and Review ports remain real.
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(input)).toBe(`${serverApiUrl}/v1/features/authenticated`);
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${current?.token}`);
        return Response.json(FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId } } }));
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        reads.push({ url: String(url), authorization: config?.headers?.Authorization });
        expect(String(url)).toBe(`${serverApiUrl}/v1/artifacts/missing-review`);
        expect(config?.headers?.Authorization).toBe(`Bearer ${current?.token}`);
        return { status: 404, data: { error: 'not_found' } };
    });
    const executor = createCliActionExecutorFromCredentials({ credentials: installed,
        readCredentials: async () => current, serverId: 'review-home-profile', serverApiUrl,
        pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
    const resolve = executor.resolveReviewServices;
    expect(resolve).toBeTypeOf('function');
    if (!resolve) throw new Error('Review services resolver missing');
    const context = { surface: 'cli' as const, authority: 'account_automation' as const };
    for (const revision of [1, 2]) {
        current = credential('requester-account', revision);
        await runWithServerHttpBaseUrl('https://other-home.example.test', async () => {
            const services = await resolve(context);
            expect(services.records).toBeDefined();
            expect(services.comments).toBeTypeOf('function');
            await expect(services.records!.read('missing-review')).resolves.toBeNull();
            await expect(services.comments!({ actionId: 'reviews.comments.list',
                input: { reviewId: 'missing-review' } }))
                .rejects.toMatchObject({ code: 'review_comment_encryption_material_unavailable' });
        });
    }
    expect(reads).toHaveLength(4);
    current = credential('foreign-account', 1);
    await expect(resolve(context)).resolves.toEqual({});
    expect(reads).toHaveLength(4);
    current = null;
    await expect(resolve(context)).resolves.toEqual({});
    expect(reads).toHaveLength(4);
});

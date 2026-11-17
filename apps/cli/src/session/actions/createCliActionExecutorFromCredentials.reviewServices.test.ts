import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
    const installed = credential('installed-account', 1);
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
    current = null;
    await expect(resolve(context)).resolves.toEqual({});
    expect(reads).toHaveLength(4);
});

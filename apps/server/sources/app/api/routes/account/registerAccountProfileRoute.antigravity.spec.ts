import { describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol';

import { createFakeRouteApp, createReplyStub, getRouteHandler } from '../../testkit/routeHarness';

vi.mock('@/storage/db', () => ({ db: {
    account: { findUniqueOrThrow: vi.fn(async () => ({ firstName: 'Ada', lastName: null, username: null, avatar: null })) },
    serviceAccountToken: { findMany: vi.fn(async () => ['openai-codex', 'antigravity'].map((vendor) => ({
        id: vendor, vendor, profileId: 'default', metadata: null, expiresAt: null, lastUsedAt: null,
    }))) },
    connectedServiceAuthGroup: { findMany: vi.fn(async () => ['openai-codex', 'antigravity'].map((vendor) => ({
        vendor, groupId: 'work', displayName: null, activeProfileId: 'default', generation: 1,
        members: [{ profileId: 'default' }],
    }))) },
} }));
vi.mock('@/storage/blob/files', () => ({ getPublicUrl: vi.fn() }));
vi.mock('@/app/auth/providers/linkedProviders', () => ({ fetchLinkedProvidersForAccount: vi.fn(async () => []) }));
vi.mock('@/app/features/catalog/serverFeatureGate', () => ({ isServerFeatureEnabledForRequest: () => true }));

describe('account profile Antigravity reader negotiation', () => {
    it.each([undefined, 'application/json', 'application/json; happier-connected-service-antigravity=0'])(
        'preserves released readers with Accept %s', async (accept) => {
            const { registerAccountProfileRoute } = await import('./registerAccountProfileRoute');
            const app = createFakeRouteApp();
            registerAccountProfileRoute(app as any);
            const body = AccountProfileSchema.parse(await getRouteHandler(app, 'GET', '/v1/account/profile')({ userId: 'account', headers: { accept } }, createReplyStub()));
            expect(body.firstName).toBe('Ada');
            expect(body.connectedServicesV2.map((entry) => entry.serviceId)).toEqual(['openai-codex']);
            expect(body.connectedServiceCredentialRevisionsV1.map((entry) => entry.serviceId)).toEqual(['openai-codex']);
        },
    );

    it('includes AGY profiles, groups and revisions for an opted-in reader', async () => {
        const { registerAccountProfileRoute } = await import('./registerAccountProfileRoute');
        const app = createFakeRouteApp();
        registerAccountProfileRoute(app as any);
        const body = AccountProfileSchema.parse(await getRouteHandler(app, 'GET', '/v1/account/profile')({
            userId: 'account', headers: { accept: 'application/json; happier-connected-service-antigravity=1' },
        }, createReplyStub()));
        expect(body.connectedServicesV2.find((entry) => entry.serviceId === 'antigravity')).toEqual(expect.objectContaining({
            profiles: [expect.objectContaining({ profileId: 'default' })],
            groups: [expect.objectContaining({ groupId: 'work' })],
        }));
        expect(body.connectedServiceCredentialRevisionsV1).toEqual(expect.arrayContaining([expect.objectContaining({ serviceId: 'antigravity' })]));
    });
});

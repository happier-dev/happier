import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AccountProfileSchema } from '@happier-dev/protocol';

const { emitUpdate } = vi.hoisted(() => ({ emitUpdate: vi.fn() }));
vi.mock('@/app/changes/markAccountChanged', () => ({ markAccountChanged: vi.fn(async () => 42) }));
vi.mock('@/storage/inTx', () => ({ afterTx: (_tx: unknown, callback: () => void) => callback() }));
vi.mock('@/storage/blob/files', () => ({ getPublicUrl: vi.fn() }));
vi.mock('@/app/features/catalog/serverFeatureGate', () => ({ isServerFeatureEnabledForRequest: () => true }));
vi.mock('@/app/events/eventRouter', async () => {
    const { buildUpdateAccountUpdate } = await import('@/app/events/eventPayloadBuilders');
    return { buildUpdateAccountUpdate, eventRouter: { emitUpdate } };
});

// ui-web-v0.2.12 (a357c65536ba89669422977d6f7daf9aa0d17e73) has these
// closed IDs in both persisted account service rows and revision rows.
const releasedServiceId = z.enum(['claude-subscription', 'openai-codex', 'openai', 'anthropic', 'gemini', 'github']);
const releasedProfile = AccountProfileSchema.extend({
    connectedServicesV2: z.array(AccountProfileSchema.shape.connectedServicesV2.removeDefault().element.extend({ serviceId: releasedServiceId })),
    connectedServiceCredentialRevisionsV1: z.array(AccountProfileSchema.shape.connectedServiceCredentialRevisionsV1.removeDefault().element.extend({ serviceId: releasedServiceId })),
});

describe('connected-service account profile push compatibility', () => {
    it('keeps persisted released profiles readable and wakes updated UI and daemon readers', async () => {
        const { recordConnectedServiceAccountProfileChange } = await import('./connectedServicesAccountProfileChange');
        const tx = {
            serviceAccountToken: { findMany: async () => ['openai-codex', 'antigravity'].map((vendor) => ({
                id: vendor, vendor, profileId: 'default', metadata: null, expiresAt: null, lastUsedAt: null,
            })) },
            connectedServiceAuthGroup: { findMany: async () => ['openai-codex', 'antigravity'].map((vendor) => ({
                vendor, groupId: 'work', displayName: null, activeProfileId: 'default', generation: 1, members: [{ profileId: 'default' }],
            })) },
        };
        await expect(recordConnectedServiceAccountProfileChange(tx as any, { accountId: 'account' })).resolves.toBe(42);
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate.mock.calls.map(([call]) => call.recipientFilter.type)).toEqual(['user-machine-scoped-only', 'user-scoped-only']);
        for (const [call] of emitUpdate.mock.calls) {
            const { body } = call.payload;
            const persisted = JSON.parse(JSON.stringify({ id: 'account', firstName: 'Ada', ...body }));
            expect(releasedProfile.safeParse(persisted).success).toBe(true);
            expect(body.connectedServicesV2.map((entry: any) => entry.serviceId)).toEqual(['openai-codex']);
            expect(body.connectedServiceCredentialRevisionsV1.map((entry: any) => entry.serviceId)).toEqual(['openai-codex']);
            expect(body.connectedServicesProfileChanged).toBe(true);
        }
    });
});

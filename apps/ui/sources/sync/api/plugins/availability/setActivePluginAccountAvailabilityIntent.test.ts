import { describe, expect, it, vi } from 'vitest';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import {
    createActivePluginAccountAvailabilityIntentSetter,
} from './setActivePluginAccountAvailabilityIntent';

const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

describe('active Account Availability intent setter', () => {
    it('sends the existing intent CAS only through current active Account authority', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            intent: {
                pluginId: 'example.tasks',
                desiredVersion: '2.0.0',
                enabled: false,
                offlineUiHosting: 'disabled',
                writableCollections: [{
                    pluginId: 'example.tasks',
                    collectionId: 'tasks',
                    schemaVersion: 2,
                    contractDigest: 'a'.repeat(43),
                }],
                revision: 'intent-2',
            },
        }), { status: 200 }));
        const setter = createActivePluginAccountAvailabilityIntentSetter({
            captureLifetime: () => lifetime,
            getServerSnapshot: () => ({ serverId: 'server-a', generation: 4 }),
            captureRequestAuthority: async () => ({ request }),
        });

        await expect(setter.set({
            pluginId: 'example.tasks',
            desiredVersion: '2.0.0',
            enabled: false,
            offlineUiHosting: 'disabled',
            writableCollections: [{
                pluginId: 'example.tasks',
                collectionId: 'tasks',
                schemaVersion: 2,
                contractDigest: 'a'.repeat(43),
            }],
            expectedRevision: 'intent-1',
        })).resolves.toEqual({
            kind: 'updated',
            intent: expect.objectContaining({ revision: 'intent-2', desiredVersion: '2.0.0' }),
        });
        expect(request).toHaveBeenCalledWith('/v1/plugins/availability/intents/set', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
                pluginId: 'example.tasks',
                desiredVersion: '2.0.0',
                enabled: false,
                offlineUiHosting: 'disabled',
                writableCollections: [{
                    pluginId: 'example.tasks',
                    collectionId: 'tasks',
                    schemaVersion: 2,
                    contractDigest: 'a'.repeat(43),
                }],
                expectedRevision: 'intent-1',
            }),
        }));
    });

    it('preserves an intent revision conflict for the present-user selection owner', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            error: 'plugin_intent_revision_conflict',
        }), { status: 409 }));
        const setter = createActivePluginAccountAvailabilityIntentSetter({
            captureLifetime: () => lifetime,
            getServerSnapshot: () => ({ serverId: 'server-a', generation: 4 }),
            captureRequestAuthority: async () => ({ request }),
        });

        await expect(setter.set({
            pluginId: 'example.tasks',
            desiredVersion: '2.0.0',
            enabled: false,
            offlineUiHosting: 'disabled',
            writableCollections: [{
                pluginId: 'example.tasks',
                collectionId: 'tasks',
                schemaVersion: 2,
                contractDigest: 'a'.repeat(43),
            }],
            expectedRevision: 'intent-1',
        })).resolves.toEqual({ kind: 'conflict', code: 'intent_revision_conflict' });
    });

    it('preserves only the exact writable-collections preparation refusal', async () => {
        const preparationRequired = createActivePluginAccountAvailabilityIntentSetter({
            captureLifetime: () => lifetime,
            getServerSnapshot: () => ({ serverId: 'server-a', generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async () => new Response(JSON.stringify({
                    error: 'plugin_intent_writable_collections_not_ready',
                }), { status: 400 }),
            }),
        });
        const otherClientFailure = createActivePluginAccountAvailabilityIntentSetter({
            captureLifetime: () => lifetime,
            getServerSnapshot: () => ({ serverId: 'server-a', generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async () => new Response(JSON.stringify({
                    error: 'plugin_release_not_found',
                }), { status: 400 }),
            }),
        });
        const input = {
            pluginId: 'example.tasks',
            desiredVersion: '2.0.0',
            enabled: true,
            offlineUiHosting: 'disabled' as const,
            writableCollections: [{
                pluginId: 'example.tasks',
                collectionId: 'tasks',
                schemaVersion: 2,
                contractDigest: 'a'.repeat(43),
            }],
            expectedRevision: 'intent-1',
        };

        await expect(preparationRequired.set(input)).resolves.toEqual({ kind: 'preparationRequired' });
        await expect(otherClientFailure.set(input)).resolves.toEqual({ kind: 'rejected', code: 'request_rejected' });
    });
});

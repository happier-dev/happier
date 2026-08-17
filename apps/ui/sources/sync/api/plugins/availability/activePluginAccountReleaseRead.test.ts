import { describe, expect, it, vi } from 'vitest';

import { PluginAvailabilityReleaseReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import {
    createActivePluginAccountReleaseReader,
} from './activePluginAccountReleaseRead';

const facts = {
    ref: { pluginId: 'com.acme.fixture', version: '2.0.0' },
    archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
    normalizedManifest: {
        schemaVersion: 2,
        id: 'com.acme.fixture',
        version: '2.0.0',
        displayName: 'Fixture',
        engines: { happier: '^1.0.0' },
        runtime: { apiVersion: 1 },
        contributes: {},
    },
    collectionContracts: [],
    uiSlots: [],
    packageAssetArchive: {
        archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
        resources: [],
    },
} as const;

const input = { release: facts.ref } as const;
const canonicalOutput = PluginAvailabilityReleaseReadActionOutputV1Schema.parse({
    availabilityCursor: 17,
    facts,
});

function lifetime(isCurrent: () => boolean): ActiveServerAccountScopeLifetime {
    return Object.freeze({
        scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
        isCurrent,
        onRetire: () => Object.freeze({ dispose: () => {} }),
    });
}

describe('active Account immutable release reader', () => {
    it('returns exact immutable target facts and their Availability cursor through active Account authority', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            availabilityCursor: 17,
            facts,
        }), { status: 200 }));
        const reader = createActivePluginAccountReleaseReader({
            captureLifetime: () => lifetime(() => true),
            getServerSnapshot: () => ({ serverId: 'server-a', generation: 4 }),
            captureRequestAuthority: async () => ({ request }),
        });

        await expect(reader.read(input)).resolves.toEqual({
            kind: 'available',
            availabilityCursor: canonicalOutput.availabilityCursor,
            facts: canonicalOutput.facts,
        });
        expect(request).toHaveBeenCalledWith('/v1/plugins/availability/releases/read', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify(input),
        }));
    });

    it('keeps the server typed exact-coordinate 404 distinct from an unavailable transport', async () => {
        const reader = createActivePluginAccountReleaseReader({
            captureLifetime: () => lifetime(() => true),
            getServerSnapshot: () => ({ serverId: 'server-a', generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async () => new Response(JSON.stringify({
                    error: 'plugin_release_not_found',
                }), { status: 404 }),
            }),
        });

        await expect(reader.read(input)).resolves.toEqual({ kind: 'notFound' });
    });

    it('does not treat an older server route miss as target-release absence', async () => {
        const reader = createActivePluginAccountReleaseReader({
            captureLifetime: () => lifetime(() => true),
            getServerSnapshot: () => ({ serverId: 'server-a', generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async () => new Response(JSON.stringify({
                    error: 'Not Found',
                    message: 'Route POST:/v1/plugins/availability/releases/read not found',
                }), { status: 404 }),
            }),
        });

        await expect(reader.read(input)).resolves.toEqual({
            kind: 'unavailable',
            code: 'transport_unavailable',
        });
    });

    it('drops a response after the active Account scope changes', async () => {
        let current = true;
        const request = vi.fn(async () => {
            current = false;
            return new Response(JSON.stringify({ availabilityCursor: 17, facts }), { status: 200 });
        });
        const reader = createActivePluginAccountReleaseReader({
            captureLifetime: () => lifetime(() => current),
            getServerSnapshot: () => ({ serverId: 'server-a', generation: 4 }),
            captureRequestAuthority: async () => ({ request }),
        });

        await expect(reader.read(input)).resolves.toEqual({
            kind: 'unavailable',
            code: 'account_scope_changed',
        });
    });

    it('drops a response after the active server generation changes', async () => {
        let generation = 4;
        const request = vi.fn(async () => {
            generation = 5;
            return new Response(JSON.stringify({ availabilityCursor: 17, facts }), { status: 200 });
        });
        const reader = createActivePluginAccountReleaseReader({
            captureLifetime: () => lifetime(() => true),
            getServerSnapshot: () => ({ serverId: 'server-a', generation }),
            captureRequestAuthority: async () => ({ request }),
        });

        await expect(reader.read(input)).resolves.toEqual({
            kind: 'unavailable',
            code: 'server_generation_changed',
        });
    });
});

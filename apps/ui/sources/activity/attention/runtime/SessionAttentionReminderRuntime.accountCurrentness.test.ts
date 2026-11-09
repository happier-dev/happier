import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';

installTokenStorageWebPlatformMocks();

type PendingRequest = Readonly<{ token: string; url: string; resolve: (response: Response) => void }>;

// The network boundary only: the reminder inventory, credential store, snapshot
// owner and organization store below it are all the real production modules.
const network = vi.hoisted(() => ({ pending: [] as PendingRequest[] }));
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: (params: Readonly<{ token: string; url: string }>) => (
        new Promise<Response>((resolve) => {
            network.pending.push({ token: params.token, url: params.url, resolve });
        })
    ),
}));

// Keep the real runtime graph loaded; its cold imports are collection work, not request work.
await import('./SessionAttentionReminderRuntime');

function snapshotResponse(params: Readonly<{ version: number; sessionId: string; remindAt: number }>): Response {
    return Response.json(SessionOrganizationSnapshotResponseSchema.parse({
        snapshot: {
            schemaVersion: 1,
            version: params.version,
            pins: [{ sessionId: params.sessionId, sortKey: 'pin-a', pinnedAt: 10, listPinned: true, railPinned: false }],
            folders: [],
            folderAssignments: [],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
            attentionStandings: [{ sessionId: params.sessionId, standing: true, remindAt: params.remindAt, updatedAt: 1 }],
        },
    }));
}

function accountToken(sub: string): string {
    return `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
}

async function waitForPendingRequest(count: number): Promise<void> {
    for (let attempt = 0; attempt < 200 && network.pending.length < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(network.pending).toHaveLength(count);
}

describe('refreshSessionAttentionReminderInventory Account currentness', () => {
    let restoreLocalStorage: (() => void) | null = null;
    let restoreWebLocks: (() => void) | null = null;
    let scopeSequence = 0;
    const previousStorageScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    beforeEach(() => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `reminder_inventory_currentness_${scopeSequence++}`;
        restoreLocalStorage = installLocalStorageMock().restore;
        restoreWebLocks = installWebLockManagerMock().restore;
        network.pending.length = 0;
    });

    afterEach(() => {
        restoreLocalStorage?.();
        restoreWebLocks?.();
        if (previousStorageScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousStorageScope;
    });

    it('never commits Account A\'s late inventory into the Home after Account B replaced its credentials', async () => {
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { refreshSessionAttentionReminderInventory } = await import('./SessionAttentionReminderRuntime');

        const serverUrl = 'https://home-a.example.test';
        const profile = await upsertServerProfile({ serverUrl, name: 'Home A', source: 'manual' });
        const serverId = profile.id;
        await expect(TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, { token: accountToken('account-a'), secret: 'secret-a' }))
            .resolves.toBe(true);

        const accountARefresh = refreshSessionAttentionReminderInventory({ serverId, serverUrl });
        const accountAOutcome = accountARefresh.then(() => 'resolved', () => 'rejected');
        await waitForPendingRequest(1);
        expect(network.pending[0]!.token).toBe(accountToken('account-a'));

        // Account B signs in on the same (possibly offscreen) Home while A's request is in flight.
        await expect(TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, { token: accountToken('account-b'), secret: 'secret-b' }))
            .resolves.toBe(true);
        network.pending[0]!.resolve(snapshotResponse({ version: 9, sessionId: 'account-a-private', remindAt: 5_000 }));

        // A superseded inventory is not reported as loaded, so the scheduler retries it.
        await expect(accountAOutcome).resolves.toBe('rejected');
        const afterStale = getStorage().getState();
        expect(afterStale.sessionOrganizationSnapshotVersionByServerId[serverId]).toBeUndefined();
        expect(JSON.stringify(afterStale.sessionOrganizationPinsBySessionKey)).not.toContain('account-a-private');
        expect(JSON.stringify(afterStale.sessionOrganizationAttentionStandingsBySessionKey)).not.toContain('account-a-private');

        // B's own, lower-versioned inventory is not rejected by A's version.
        const accountBRefresh = refreshSessionAttentionReminderInventory({ serverId, serverUrl });
        await waitForPendingRequest(2);
        expect(network.pending[1]!.token).toBe(accountToken('account-b'));
        network.pending[1]!.resolve(snapshotResponse({ version: 1, sessionId: 'account-b-session', remindAt: 6_000 }));
        await expect(accountBRefresh).resolves.toEqual({ kind: 'loaded' });
        const afterB = getStorage().getState();
        expect(afterB.sessionOrganizationSnapshotVersionByServerId[serverId]).toBe(1);
        expect(JSON.stringify(afterB.sessionOrganizationAttentionStandingsBySessionKey)).toContain('account-b-session');
    });
});

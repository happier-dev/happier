import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appStateEmitter = vi.hoisted(async () => {
    const { createReactNativeAppStateEmitter } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeAppStateEmitter('active');
});
const getSnapshotPlain = vi.hoisted(() => vi.fn(async () => null));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { get OS() { return 'web'; } },
        AppState: (await appStateEmitter).appState,
    });
});
vi.mock('@/utils/platform/tauri', () => ({ isTauriDesktop: () => false }));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
    getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
    requestConnectedServiceQuotaSnapshotRefresh: vi.fn(async () => true),
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
    getConnectedServiceQuotaSnapshotPlain: getSnapshotPlain,
    requestConnectedServiceQuotaSnapshotRefreshV3: vi.fn(async () => true),
}));
vi.mock('@/sync/domains/connectedServices/openConnectedServiceQuotaViewSnapshot', () => ({
    openConnectedServiceQuotaViewSnapshot: vi.fn(() => null),
}));

import {
    __resetConnectedServiceQuotaSnapshotStore,
    buildQuotaSnapshotScopeKey,
    retainQuotaSnapshotPolling,
} from './connectedServiceQuotaSnapshotStore';

const ctx = {
    credentials: { token: 't', secret: 's' },
    credentialScope: 'scope',
    serverBasis: {
        serverId: 'server-a',
        generation: 3,
    },
    serviceId: 'openai-codex',
    profileId: 'work',
    resolveAccountMode: async () => 'plain' as const,
    assertOperationAllowed: async () => {},
} as const;

describe('connectedServiceQuotaSnapshotStore polling lifecycle', () => {
    const globalWithDocument = globalThis as unknown as { document?: { visibilityState?: string } };
    const originalDocument = globalWithDocument.document;

    beforeEach(async () => {
        vi.useFakeTimers();
        globalWithDocument.document = { visibilityState: 'visible' };
        (await appStateEmitter).emit('active');
        __resetConnectedServiceQuotaSnapshotStore();
        getSnapshotPlain.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
        globalWithDocument.document = originalDocument;
    });

    it('stops fetching quota snapshots while the app is backgrounded and refetches on return', async () => {
        const key = buildQuotaSnapshotScopeKey('scope', 'openai-codex', 'work');

        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(2);

        (await appStateEmitter).emit('background');
        await vi.advanceTimersByTimeAsync(30_000 * 4);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(2);

        (await appStateEmitter).emit('active');
        await vi.advanceTimersByTimeAsync(0);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(3);

        release();
    });
});

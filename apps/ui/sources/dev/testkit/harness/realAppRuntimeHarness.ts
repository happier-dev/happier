import { afterAll, afterEach, beforeEach, vi } from 'vitest';

import { installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

installDisconnectedServerSocketBoundary();
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));

let initialized = false;
let disposeSyncBridge: (() => void) | null = null;
let webLocks: ReturnType<typeof installWebLockManagerMock> | null = null;
const installDefaultHttpBoundary = async () => {
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async () => new Response('{}', { status: 404 }));
};

// Register lifetimes at module scope so callers can initialize after their
// configured platform fixtures, including from beforeAll/beforeEach.
beforeEach(async () => {
    if (!initialized) return;
    webLocks?.restore();
    webLocks = installWebLockManagerMock();
    await installDefaultHttpBoundary();
});
afterEach(() => {
    webLocks?.restore();
    webLocks = null;
});
afterAll(async () => {
    if (!initialized) return;
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    disposeSyncBridge?.();
    disposeSyncBridge = null;
    const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    resetRuntimeFetch();
    webLocks?.restore();
});

/** Real Auth/Sync initialization without importing another screen's module mocks. */
export async function initializeRealAppRuntimeForTests() {
    // A caller may have reset Vitest's module graph after retiring the previous
    // runtime. Retire its Node require cache bridge before loading the new graph.
    disposeSyncBridge?.();
    disposeSyncBridge = null;
    webLocks?.restore();
    webLocks = installWebLockManagerMock();
    await installDefaultHttpBoundary();
    const { loadSyncSingletonForTests } = await import('./syncSingletonLoader');
    const bridge = await loadSyncSingletonForTests();
    disposeSyncBridge = bridge.dispose;
    initialized = true;
    return bridge;
}

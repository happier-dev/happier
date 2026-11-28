import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installDisconnectedServerSocketBoundary();
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

const { Modal } = await import('@/modal');
const { openCatalogAction } = await import('./openCatalogAction');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
// Resolve the real lazy form modules before exercising their asynchronous admission boundary.
await Promise.all([
    import('@/components/plugins/actions/actionInputForm'),
    import('@/components/plugins/actions/presentActionInputForm'),
]);
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
beforeAll(async () => {
    webLocks = installWebLockManagerMock();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async () => new Response('{}', { status: 404 }));
    await loadSyncSingletonForTests();
});
afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    vi.clearAllMocks();
});
afterAll(async () => {
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    resetRuntimeFetch();
    webLocks?.restore();
});

it('retires the clicked form intent when its Account lifetime ends while the form modules load', async () => {
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://catalog-action-form.example.test', accountId: 'catalog-action-form-account',
        request: async input => new URL(String(input)).pathname === '/v1/account/encryption/currentness'
            ? Response.json(createPlainAccountEncryptionCurrentnessFixture())
            : new Response('{}', { status: 404 }),
    });
    const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
    const opening = openCatalogAction({ spec: getActionSpec('session.open'), context: {}, execute });
    retireActiveServerAccountScopeLifetime();
    await opening;
    const shown = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
    const form = (shown as unknown as { props: { form: import('@/components/plugins/actions/actionInputForm').ActionInputForm } }).props.form;
    form.replaceInput({ sessionId: 'session-form-target' });
    expect(await form.submit()).toMatchObject({ kind: 'stale' });
    expect(execute).not.toHaveBeenCalled();
});

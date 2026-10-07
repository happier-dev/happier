import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';
import { createScmNetworkTestHarness, scmNetworkSnapshot } from '../sourceControl/scmNetworkTestHarness';

const modalAlert = vi.hoisted(() => vi.fn());
installSessionFilesHookCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert: modalAlert } }).module;
    },
    storage: async importOriginal => importOriginal(),
});
const harness = await createScmNetworkTestHarness();
const { renderHook, standardCleanup } = await import('@/dev/testkit');
const { useFilesScmOperations } = await import('./useFilesScmOperations');
const pushRequests = () => harness.network.requests.filter(request => request.method === RPC_METHODS.SCM_REMOTE_PUSH);
const mount = () => renderHook(() => useFilesScmOperations({
    sessionId: 's1', serverId: harness.serverId, sessionPath: '/repo', scmSnapshot: scmNetworkSnapshot,
    scmWriteEnabled: true, scmCommitStrategy: 'git_staging', scmRemoteConfirmPolicy: 'never',
    scmPushRejectPolicy: 'prompt_fetch', refreshScmData: vi.fn(async () => {}), loadCommitHistory: vi.fn(async () => {}),
}));

describe('useFilesScmOperations (daemon unavailable)', () => {
    beforeEach(() => {
        harness.reset();
        modalAlert.mockClear();
        harness.network.respond(RPC_METHODS.SCM_REMOTE_PUSH, {
            success: false, errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE, error: 'RPC method not available',
        });
    });
    afterEach(() => standardCleanup());
    afterAll(() => harness.dispose());

    it('shows daemon-unavailable alert with Retry when remote operation fails with RPC method-not-available', async () => {
        const hook = await mount();
        await act(async () => { await hook.getCurrent().runRemoteOperation('push'); });
        expect(pushRequests()).toHaveLength(1);
        const [title, message, buttons] = modalAlert.mock.calls[0] ?? [];
        expect(title).toBe('errors.daemonUnavailableTitle');
        expect(String(message ?? '')).toContain('errors.daemonUnavailableBody');
        expect(Array.isArray(buttons)).toBe(true);
    });

    it('does not retry after unmount when pressing Retry', async () => {
        const hook = await mount();
        await act(async () => { await hook.getCurrent().runRemoteOperation('push'); });
        const buttons: Array<{ text: string; onPress?: () => void }> = modalAlert.mock.calls[0]?.[2] ?? [];
        const retry = buttons.find(button => button.text === 'common.retry');
        expect(retry).toBeTruthy();
        await hook.unmount();
        await act(async () => { retry?.onPress?.(); });
        expect(pushRequests()).toHaveLength(1);
    });
});

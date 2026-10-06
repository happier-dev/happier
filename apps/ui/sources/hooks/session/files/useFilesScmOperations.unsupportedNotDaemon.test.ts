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

describe('useFilesScmOperations (unsupported is not daemon unavailable)', () => {
    beforeEach(() => {
        harness.reset();
        modalAlert.mockClear();
        harness.network.respond(RPC_METHODS.SCM_REMOTE_PUSH, {
            success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'RPC method not available',
        });
    });
    afterEach(() => standardCleanup());
    afterAll(() => harness.dispose());

    it('does not show daemon-unavailable alert for FEATURE_UNSUPPORTED even if error text is method-not-available', async () => {
        const hook = await renderHook(() => useFilesScmOperations({
            sessionId: 's1', serverId: harness.serverId, sessionPath: '/repo', scmSnapshot: scmNetworkSnapshot,
            scmWriteEnabled: true, scmCommitStrategy: 'git_staging', scmRemoteConfirmPolicy: 'never',
            scmPushRejectPolicy: 'prompt_fetch', refreshScmData: vi.fn(async () => {}), loadCommitHistory: vi.fn(async () => {}),
        }));
        await act(async () => { await hook.getCurrent().runRemoteOperation('push'); });
        expect(harness.network.requests.filter(request => request.method === RPC_METHODS.SCM_REMOTE_PUSH)).toHaveLength(1);
        expect(modalAlert).toHaveBeenCalled();
        expect(modalAlert.mock.calls[0]?.[0]).toBe('common.error');
    });
});

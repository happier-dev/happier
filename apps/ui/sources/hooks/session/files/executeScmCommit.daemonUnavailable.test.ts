import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
  SCM_OPERATION_ERROR_CODES,
} from '@happier-dev/protocol';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createScmNetworkTestHarness } from '../sourceControl/scmNetworkTestHarness';

const modalAlert = vi.hoisted(() => vi.fn());
const modalConfirm = vi.hoisted(() => vi.fn(async () => true));

installSessionFilesHookCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
          spies: {
            alert: modalAlert,
            confirm: modalConfirm,
          },
        }).module;
  },
  storage: async (importOriginal) => importOriginal(),
});

const harness = await createScmNetworkTestHarness();
const commitResponses = vi.fn();
const commitRequests = () => harness.network.requests.filter(request => request.method === RPC_METHODS.SCM_COMMIT_CREATE);

beforeEach(() => {
  harness.reset();
  modalAlert.mockClear();
  modalConfirm.mockClear();
  commitResponses.mockReset();
  harness.network.setRpcResponder(async request => request.method === RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK
    ? { success: true, removed: true, lockPath: '/repo/.git/index.lock' }
    : await commitResponses());
});
afterAll(() => harness.dispose());

describe('executeScmCommit (daemon unavailable)', () => {
  it('leaves an unavailable daemon to the pane outcome line instead of raising a modal', async () => {
    commitResponses.mockResolvedValueOnce({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      error: 'RPC method not available',
    });

    const { executeScmCommit } = await import('./executeScmCommit');

    const result = await executeScmCommit({
      sessionId: 's1',
      serverId: harness.serverId,
      repoPath: '/repo',
      commitMessage: 'feat: test',
      scmCommitStrategy: 'git_staging',
      commitSelectionPaths: [],
      commitSelectionPatches: [],
      refreshScmData: vi.fn(async () => {}),
      loadCommitHistory: vi.fn(async () => {}),
      setScmOperationBusy: vi.fn(),
      setScmOperationStatus: vi.fn(),
      tracking: null,
    });

    expect(result.ok).toBe(false);
    expect(modalAlert).not.toHaveBeenCalled();
    expect(commitRequests()).toHaveLength(1);
  });

  it('omits a broader commit scope when atomic line-selection patches are present', async () => {
    commitResponses.mockResolvedValueOnce({
      success: true,
      commitSha: 'abc123',
    });

    const { executeScmCommit } = await import('./executeScmCommit');

    const result = await executeScmCommit({
      sessionId: 's1',
      serverId: harness.serverId,
      repoPath: '/repo',
      commitMessage: 'feat: test',
      scmCommitStrategy: 'atomic',
      commitSelectionPaths: ['a.txt'],
      commitSelectionPatches: [
        {
          path: 'a.txt',
          patch: [
            'diff --git a/a.txt b/a.txt',
            'index df967b9..9f0e218 100644',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+line-one',
            '',
          ].join('\n'),
        },
      ],
      refreshScmData: vi.fn(async () => {}),
      loadCommitHistory: vi.fn(async () => {}),
      setScmOperationBusy: vi.fn(),
      setScmOperationStatus: vi.fn(),
      tracking: null,
    });

    expect(result.ok).toBe(true);
    expect(commitRequests()).toHaveLength(1);
    expect(commitRequests()[0]).toMatchObject({ targetId: 'machine-1', payload: {
        message: 'feat: test',
        patches: expect.any(Array),
        cwd: '/repo',
    } });
    expect(commitRequests()[0]?.payload).not.toHaveProperty('scope');
  });

  it('offers stale Git index-lock recovery and retries commit creation once', async () => {
    commitResponses
      .mockResolvedValueOnce({
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        error: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
      })
      .mockResolvedValueOnce({
        success: true,
        commitSha: 'abc123',
      });

    const refreshScmData = vi.fn(async () => {});
    const loadCommitHistory = vi.fn(async () => {});
    const { executeScmCommit } = await import('./executeScmCommit');

    const result = await executeScmCommit({
      sessionId: 's1',
      serverId: harness.serverId,
      repoPath: '/repo',
      commitMessage: 'feat: test',
      scmCommitStrategy: 'git_staging',
      commitSelectionPaths: [],
      commitSelectionPatches: [],
      refreshScmData,
      loadCommitHistory,
      setScmOperationBusy: vi.fn(),
      setScmOperationStatus: vi.fn(),
      tracking: null,
    });

    expect(result.ok).toBe(true);
    expect(modalConfirm).toHaveBeenCalledTimes(1);
    expect(harness.network.requests.find(request => request.method === RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK)).toMatchObject({ targetId: 'machine-1', payload: {
      cwd: '/repo',
      confirmed: true,
      confirmationToken: REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
    } });
    expect(commitRequests()).toHaveLength(2);
    expect(refreshScmData).toHaveBeenCalledTimes(1);
    expect(loadCommitHistory).toHaveBeenCalledWith({ reset: true });
  });
});

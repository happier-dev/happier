import { describe, expect, test } from 'vitest';

import { createCodexAppServerRpcError } from './compatibility.js';
import {
  buildCodexAppServerLegacyPermissionParams,
  buildCodexAppServerPermissionParams,
  shouldRetryWithoutCodexAppServerPermissionProfile,
} from './permissionProfile.js';

describe('Codex app-server permission profile params', () => {
  test('builds native permission profiles from legacy thread policies', () => {
    expect(buildCodexAppServerPermissionParams({
      policy: {
        approvalPolicy: 'never',
        sandbox: 'read-only',
        sandboxPolicy: { type: 'readOnly' },
      },
      support: 'unknown',
      target: 'thread',
    })).toEqual({
      permissions: { type: 'profile', id: ':read-only' },
    });

    expect(buildCodexAppServerPermissionParams({
      policy: {
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite' },
      },
      support: 'unknown',
      target: 'thread',
    })).toEqual({
      permissions: { type: 'profile', id: ':workspace' },
    });

    expect(buildCodexAppServerPermissionParams({
      policy: {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
      support: 'unknown',
      target: 'thread',
    })).toEqual({
      permissions: { type: 'profile', id: ':danger-no-sandbox' },
    });
  });

  test('falls back to legacy thread and turn fields after permission profiles are unsupported', () => {
    const policy = {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/repo'] },
    };

    expect(buildCodexAppServerPermissionParams({
      policy,
      support: 'legacy',
      target: 'thread',
    })).toEqual(buildCodexAppServerLegacyPermissionParams({
      policy,
      target: 'thread',
    }));

    expect(buildCodexAppServerLegacyPermissionParams({
      policy,
      target: 'thread',
    })).toEqual({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    });

    expect(buildCodexAppServerLegacyPermissionParams({
      policy,
      target: 'turn',
    })).toEqual({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/repo'] },
    });
  });

  test('retries only targeted unsupported permissions errors', () => {
    const requestParams = {
      threadId: 'thread_1',
      permissions: { type: 'profile', id: ':workspace' },
    };

    expect(shouldRetryWithoutCodexAppServerPermissionProfile(
      createCodexAppServerRpcError({
        method: 'thread/resume',
        code: -32602,
        message: 'invalid params: permissions unsupported',
      }),
      requestParams,
    )).toBe(true);

    expect(shouldRetryWithoutCodexAppServerPermissionProfile(
      createCodexAppServerRpcError({
        method: 'thread/resume',
        code: -32602,
        message: 'invalid params: model unsupported',
      }),
      requestParams,
    )).toBe(false);

    expect(shouldRetryWithoutCodexAppServerPermissionProfile(
      createCodexAppServerRpcError({
        method: 'thread/resume',
        code: -32602,
        message: 'invalid params: permissions unsupported',
      }),
      { threadId: 'thread_1' },
    )).toBe(false);
  });
});

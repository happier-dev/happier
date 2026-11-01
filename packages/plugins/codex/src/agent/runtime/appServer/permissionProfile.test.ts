import { describe, expect, test } from 'vitest';

import { createCodexAppServerRpcError } from './compatibility.js';
import {
  buildCodexAppServerLegacyPermissionParams,
  buildCodexAppServerPermissionParams,
  shouldRetryWithoutCodexAppServerPermissionProfile,
} from './permissionProfile.js';

describe('Codex app-server permission profile params', () => {
  test('preserves a granular MCP-only approval policy instead of replacing it with a never-approval profile', () => {
    const approvalPolicy = { granular: { sandbox_approval: false, rules: false,
      mcp_elicitations: true, request_permissions: false, skill_approval: false } };
    for (const target of ['thread', 'turn'] as const) {
      expect(buildCodexAppServerPermissionParams({ policy: { approvalPolicy, sandbox: 'read-only' },
        support: 'supported', target })).toEqual({ approvalPolicy,
        ...(target === 'thread' ? { sandbox: 'read-only' } : { sandboxPolicy: { type: 'readOnly' } }) });
    }
  });
  test('keeps hands-off read-only on a turn when an older app-server lacks permission profiles', () => {
    expect(buildCodexAppServerPermissionParams({
      policy: { approvalPolicy: 'never', sandbox: 'read-only' }, support: 'legacy', target: 'turn',
    })).toEqual({ approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
  });

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
      permissions: ':read-only',
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
      permissions: ':workspace',
    });

    const dangerPolicy = {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
    };

    expect(buildCodexAppServerPermissionParams({
      policy: dangerPolicy,
      support: 'unknown',
      target: 'thread',
    })).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' });

    expect(buildCodexAppServerPermissionParams({
      policy: dangerPolicy,
      support: 'unknown',
      target: 'turn',
    })).toEqual({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
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
    })).toEqual({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'workspace-write' });

    expect(buildCodexAppServerPermissionParams({
      policy,
      support: 'legacy',
      target: 'turn',
    })).toEqual({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/repo'] },
    });

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

  test('preserves approval policy fields instead of profile-only params for prompting policies', () => {
    const policy = {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/repo'] },
    };

    expect(buildCodexAppServerPermissionParams({
      policy,
      support: 'unknown',
      target: 'thread',
    })).toEqual({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    });

    expect(buildCodexAppServerPermissionParams({
      policy,
      support: 'unknown',
      target: 'turn',
    })).toEqual({
      approvalPolicy: 'on-request',
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

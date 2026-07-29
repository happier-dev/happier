import { describe, expect, it } from 'vitest';
import type {
  PluginUiApprovalRequest,
  PluginUiApprovalResult,
} from '@happier-dev/plugin-sdk/runtime';

import {
  buildOpenCodePermissionApprovalRequest,
  mapOpenCodeApprovalResultToReply,
  readOpenCodeApprovalReplyMessage,
} from './permissionBridge.js';

const ASK = {
  requestId: 'permission-1',
  providerSessionId: 'provider-session-1',
  permission: 'bash',
  patterns: ['git status'],
  metadata: { command: 'git status' },
} as const;

describe('OpenCode native tool approval bridge', () => {
  it('builds only the public tool-approval intent and requests session persistence explicitly', () => {
    expect(buildOpenCodePermissionApprovalRequest(ASK)).toEqual({
      title: 'Allow OpenCode to use bash?',
      description: 'OpenCode requested permission to use bash.',
      subject: {
        kind: 'tool',
        name: 'bash',
        input: {
          providerSessionId: 'provider-session-1',
          permission: 'bash',
          patterns: ['git status'],
          metadata: { command: 'git status' },
        },
      },
      allowSessionPersistence: true,
    } satisfies PluginUiApprovalRequest);
  });

  it.each([
    [{ status: 'approved', persistence: 'once' }, 'once'],
    [{ status: 'approved', persistence: 'session' }, 'always'],
    [{ status: 'denied', rationale: 'No shell access' }, 'reject'],
    [{ status: 'cancelled' }, 'reject'],
    [{
      status: 'unavailable',
      diagnostic: { code: 'ui_unavailable', severity: 'error' },
    }, 'reject'],
  ] satisfies readonly (readonly [PluginUiApprovalResult, 'once' | 'always' | 'reject'])[])(
    'maps %o to the fail-closed OpenCode reply %s',
    (result, expected) => {
      expect(mapOpenCodeApprovalResultToReply(result)).toBe(expected);
    },
  );

  it('preserves only denial and terminal diagnostic messages for the provider reply', () => {
    expect(readOpenCodeApprovalReplyMessage({
      status: 'denied',
      rationale: 'Denied by policy',
    })).toBe('Denied by policy');
    expect(readOpenCodeApprovalReplyMessage({
      status: 'cancelled',
      diagnostic: { code: 'cancelled', severity: 'warning', message: 'User cancelled' },
    })).toBe('User cancelled');
    expect(readOpenCodeApprovalReplyMessage({
      status: 'unavailable',
      diagnostic: { code: 'offline', severity: 'error', message: 'Approval UI unavailable' },
    })).toBe('Approval UI unavailable');
  });
});

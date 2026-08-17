import { describe, expect, it } from 'vitest';
import type {
  InteractionTransientApprovalAuthorRequestV1,
  InteractionTransientApprovalResultV1,
} from '@happier-dev/plugin-sdk/interactions';

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
      kind: 'approval',
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
    } satisfies InteractionTransientApprovalAuthorRequestV1);
  });

  it.each([
    [{ requestId: 'approval-1', kind: 'approval', status: 'approved', persistence: 'once' }, 'once'],
    [{ requestId: 'approval-2', kind: 'approval', status: 'approved', persistence: 'session' }, 'always'],
    [{ requestId: 'approval-3', kind: 'approval', status: 'declined' }, 'reject'],
    [{ requestId: 'approval-4', kind: 'approval', status: 'userCancelled' }, 'reject'],
    [{ requestId: 'approval-5', kind: 'approval', status: 'unavailable' }, 'reject'],
  ] satisfies readonly (readonly [InteractionTransientApprovalResultV1, 'once' | 'always' | 'reject'])[])(
    'maps %o to the fail-closed OpenCode reply %s',
    (result, expected) => {
      expect(mapOpenCodeApprovalResultToReply(result)).toBe(expected);
    },
  );

  it('does not invent provider-facing messages absent from the strict result contract', () => {
    expect(readOpenCodeApprovalReplyMessage({
      requestId: 'approval-1',
      kind: 'approval',
      status: 'unavailable',
    })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { buildAgentRequestNotificationContent } from './agentRequestNotificationContent.js';

describe('buildAgentRequestNotificationContent', () => {
  it('builds permission-request payloads with sanitized tool details', () => {
    expect(
      buildAgentRequestNotificationContent({
        kind: 'permission',
        sessionId: 'session-1',
        requestId: 'request-1',
        toolName: 'Bash',
        toolInput: { command: 'git status --short && echo secret-token' },
      }),
    ).toEqual({
      title: 'Permission Request',
      body: 'Approval needed for: Bash\nCommand: git',
      data: {
        sessionId: 'session-1',
        requestId: 'request-1',
        tool: 'Bash',
        type: 'permission_request',
        kind: 'permission',
      },
      toolDetails: 'Command: git',
    });
  });

  it('uses explicit tool details when provided and normalizes ask-user-question labels', () => {
    expect(
      buildAgentRequestNotificationContent({
        kind: 'user_action',
        sessionId: 'session-1',
        requestId: 'request-2',
        toolName: 'ask_user_question',
        toolInput: {
          questions: [{ question: 'Which branch should I use?' }],
        },
        toolDetails: 'Custom details',
      }),
    ).toMatchObject({
      title: 'Action Required',
      body: 'Input needed for: AskUserQuestion\nCustom details',
      toolDetails: 'Custom details',
    });
  });
});

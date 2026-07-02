import { describe, expect, it } from 'vitest';

import { buildAgentRequestNotificationContent } from './agentRequestNotificationContent.js';

describe('buildAgentRequestNotificationContent', () => {
  it('builds permission-request payloads with sanitized tool details', () => {
    expect(
      buildAgentRequestNotificationContent({
        kind: 'permission',
        sessionId: 'session-1',
        sessionTitle: 'Fix prod issue',
        agentDisplayName: 'Claude',
        requestId: 'request-1',
        toolName: 'Bash',
        toolInput: { command: 'git status --short && echo secret-token' },
      }),
    ).toEqual({
      title: 'Fix prod issue',
      body: 'Claude asks permission to use Bash\nCommand: git',
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
        sessionTitle: '  Research   plan  ',
        agentDisplayName: 'Codex',
        requestId: 'request-2',
        toolName: 'ask_user_question',
        toolInput: {
          questions: [{ question: 'Which branch should I use?' }],
        },
        toolDetails: 'Custom details',
      }),
    ).toMatchObject({
      title: 'Research plan',
      body: 'Codex needs your input for AskUserQuestion\nCustom details',
      toolDetails: 'Custom details',
    });
  });

  it('uses safe fallback display text when session and agent labels are missing', () => {
    expect(
      buildAgentRequestNotificationContent({
        kind: 'permission',
        sessionId: 'session-permission-with-long-id',
        sessionTitle: '   ',
        agentDisplayName: '',
        requestId: 'request-3',
        toolName: 'Write',
        toolDetails: null,
      }),
    ).toMatchObject({
      title: 'Session session-',
      body: 'Agent asks permission to use Write',
      data: {
        sessionId: 'session-permission-with-long-id',
        requestId: 'request-3',
        tool: 'Write',
        type: 'permission_request',
        kind: 'permission',
      },
      toolDetails: null,
    });
  });
});

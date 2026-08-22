import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
  SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
} from '@happier-dev/protocol';

import { projectIncomingMachineRpcDebugPayload } from './machine/projectIncomingMachineRpcDebugPayload';

describe('projectIncomingMachineRpcDebugPayload', () => {
  it('redacts all Conversation reply-handoff envelope content before debug logging', () => {
    const payload = projectIncomingMachineRpcDebugPayload({
      method: `machine-1:${AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1}`,
      params: {
        handoff: {
          resultEnvelope: { t: 'plain', v: { text: 'private result text' } },
          replyContextEnvelope: { t: 'encrypted', c: 'private-envelope-bytes' },
        },
      },
    });

    expect(payload).toEqual({
      method: `machine-1:${AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1}`,
      params: '[redacted: automation reply-handoff content]',
    });
    expect(JSON.stringify(payload)).not.toContain('private result text');
    expect(JSON.stringify(payload)).not.toContain('private-envelope-bytes');
  });

  it('redacts plain Session server-start input before generic RPC debug logging', () => {
    const payload = projectIncomingMachineRpcDebugPayload({
      method: `machine-1:${SESSION_SERVER_START_DAEMON_RPC_METHOD_V1}`,
      params: {
        start: {
          requestEnvelope: {
            t: 'plain',
            v: { initialMessage: 'private Automation start input' },
          },
        },
      },
    });

    expect(payload).toEqual({
      method: `machine-1:${SESSION_SERVER_START_DAEMON_RPC_METHOD_V1}`,
      params: '[redacted: Session server-start content]',
    });
    expect(JSON.stringify(payload)).not.toContain('private Automation start input');
  });
});

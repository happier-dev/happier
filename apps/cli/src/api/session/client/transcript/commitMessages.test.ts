import { describe, expect, it, vi } from 'vitest';

import type { SessionClientTranscriptSendPort } from './sendMessages';
import {
  prepareCommittedAgentMessageViaPort,
  prepareCommittedUserTextMessageViaPort,
} from './commitMessages';

function createTranscriptSendPort(): SessionClientTranscriptSendPort {
  return {
    sessionId: 'session-1',
    socket: {
      connected: true,
      emit: vi.fn(),
    },
    outboundShapeLogger: {
      log: vi.fn(),
    },
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    getMetadataSnapshot: () => null,
    buildOutboundSessionMessagePayload: (content) => ({ t: 'plain', v: content }),
    commitSessionMessageBestEffort: vi.fn(),
    logSendWhileDisconnected: vi.fn(),
    markAgentQueueEchoSuppressedLocalId: vi.fn(),
    toolCallCanonicalNameByProviderAndId: new Map(),
    permissionToolCallRawInputByProviderAndId: new Map(),
    toolCallInputByProviderAndId: new Map(),
  };
}

describe('commitMessages', () => {
  it('prepares committed ACP transcript payloads through the transcript port seam', () => {
    const port = createTranscriptSendPort();

    const prepared = prepareCommittedAgentMessageViaPort(
      port,
      'codex',
      { type: 'message', message: 'hello', sidechainId: 'side-1' } as any,
      { localId: 'local-1' },
    );

    expect(prepared.normalizedBody).toEqual({
      type: 'message',
      message: 'hello',
      sidechainId: 'side-1',
    });
    expect(prepared.localId).toBe('local-1');
    expect(prepared.sidechainId).toBe('side-1');
    expect(prepared.payload).toEqual({
      t: 'plain',
      v: {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'codex',
          data: {
            type: 'message',
            message: 'hello',
            sidechainId: 'side-1',
          },
        },
        meta: {
          sentFrom: 'cli',
          source: 'cli',
        },
      },
    });
  });

  it('prepares committed user text payloads through the transcript port seam', () => {
    const port = createTranscriptSendPort();

    const prepared = prepareCommittedUserTextMessageViaPort(
      port,
      'ship it',
      { localId: 'user-1', meta: { source: 'ui' } },
    );

    expect(prepared.localId).toBe('user-1');
    expect(prepared.payload).toEqual({
      t: 'plain',
      v: {
        role: 'user',
        content: {
          type: 'text',
          text: 'ship it',
        },
        meta: {
          sentFrom: 'cli',
          source: 'ui',
        },
      },
    });
  });
});

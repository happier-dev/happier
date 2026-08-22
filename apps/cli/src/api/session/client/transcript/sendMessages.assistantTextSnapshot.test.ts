import { describe, expect, it, vi } from 'vitest';

import { createTurnAssistantTextSnapshotStore } from '../../turns/assistantTextSnapshotStore';
import type { SessionClientTranscriptSendPort } from './sendMessages';
import { sendAgentMessageEphemeralViaPort } from './sendMessages';

function createTranscriptSendPort(snapshotStore = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 })): SessionClientTranscriptSendPort {
  snapshotStore.beginTurn({ turnToken: 'turn-1', startSeqExclusive: null, startedAtMs: 100 });
  return {
    sessionId: 'session-1',
    socket: {
      connected: true,
      emit: vi.fn(),
    },
    outboundShapeLogger: { log: vi.fn() },
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    getMetadataSnapshot: () => null,
    buildOutboundSessionMessagePayload: (content) => ({ t: 'plain', v: content }),
    toolCallCanonicalNameByProviderAndId: new Map(),
    permissionToolCallRawInputByProviderAndId: new Map(),
    toolCallInputByProviderAndId: new Map(),
    turnAssistantTextSnapshotStore: snapshotStore,
  };
}

describe('session transcript assistant text snapshot observation', () => {
  it('stamps ephemeral ACP thinking segments as event rows', () => {
    const port = createTranscriptSendPort();

    sendAgentMessageEphemeralViaPort(port, 'codex', { type: 'thinking', text: 'checking' } as any, {
      localId: 'thinking-1',
      createdAt: 100,
    });

    expect(port.socket.emit).toHaveBeenCalledWith(
      'transcript-stream-segment',
      expect.objectContaining({
        message: expect.objectContaining({ messageRole: 'event' }),
      }),
    );
  });

  it('observes root assistant text sent through sendAgentMessageEphemeral', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });
    const port = createTranscriptSendPort(store);

    sendAgentMessageEphemeralViaPort(port, 'codex', { type: 'message', message: 'Live done.' }, {
      localId: 'segment-1',
      createdAt: 100,
    });

    expect(store.getCurrentTurnSnapshot({ turnToken: 'turn-1' })).toMatchObject({
      normalizedText: 'Live done.',
      source: 'ephemeral',
      localId: 'segment-1',
    });
  });

});

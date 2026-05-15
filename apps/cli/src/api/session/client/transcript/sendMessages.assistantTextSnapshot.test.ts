import { describe, expect, it, vi } from 'vitest';

import { createTurnAssistantTextSnapshotStore } from '../../turns/assistantTextSnapshotStore';
import type { SessionClientTranscriptSendPort } from './sendMessages';
import { sendAgentMessageEphemeralViaPort, sendAgentMessageViaPort } from './sendMessages';

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
    commitSessionMessageBestEffort: vi.fn(),
    logSendWhileDisconnected: vi.fn(),
    markAgentQueueEchoSuppressedLocalId: vi.fn(),
    toolCallCanonicalNameByProviderAndId: new Map(),
    permissionToolCallRawInputByProviderAndId: new Map(),
    toolCallInputByProviderAndId: new Map(),
    turnAssistantTextSnapshotStore: snapshotStore,
  };
}

describe('session transcript assistant text snapshot observation', () => {
  it('stamps durable ACP tool calls as event rows', () => {
    const port = createTranscriptSendPort();

    sendAgentMessageViaPort(port, 'codex', {
      type: 'tool-call',
      callId: 'call-1',
      name: 'Bash',
      input: { command: 'pwd' },
    } as any);

    expect(port.commitSessionMessageBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ messageRole: 'event' }),
    );
  });

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

  it('does not attribute unsequenced provider-dispatch text to the active turn', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });
    const port = createTranscriptSendPort(store);

    sendAgentMessageViaPort(port, 'codex', { type: 'message', message: 'Done.' });

    expect(store.getCurrentTurnSnapshot({ turnToken: 'turn-1' })).toBeNull();
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

  it('ignores sidechain assistant text sent through shared transcript APIs', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });
    const port = createTranscriptSendPort(store);

    sendAgentMessageViaPort(port, 'codex', {
      type: 'message',
      message: 'Nested done.',
      sidechainId: 'task-1',
    });

    expect(store.getCurrentTurnSnapshot({ turnToken: 'turn-1' })).toBeNull();
  });
});

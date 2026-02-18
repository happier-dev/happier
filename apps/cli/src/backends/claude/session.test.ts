import { describe, expect, it, vi } from 'vitest';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { Session } from './session';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { EnhancedMode } from './loop';

type MetadataMap = Record<string, unknown>;
type SessionFoundHookData = NonNullable<Parameters<Session['onSessionFound']>[1]>;

function createSessionClientStub(overrides?: Partial<SessionClientPort>): SessionClientPort {
  return {
    sessionId: 'session-test',
    rpcHandlerManager: {
      registerHandler: vi.fn(),
      invokeLocal: vi.fn(async () => ({})),
    },
    sendSessionEvent: vi.fn(),
    sendClaudeSessionMessage: vi.fn(),
    sendAgentMessage: vi.fn(),
    keepAlive: vi.fn(),
    getMetadataSnapshot: () => null,
    waitForMetadataUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    peekPendingMessageQueueV2Count: vi.fn(async () => 0),
    discardPendingMessageQueueV2All: vi.fn(async () => 0),
    discardCommittedMessageLocalIds: vi.fn(async () => 0),
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
}

function createSession(client: SessionClientPort, claudeArgs?: string[]): Session {
  return new Session({
    client,
    path: '/tmp',
    logPath: '/tmp/log',
    sessionId: null,
    claudeArgs,
    mcpServers: {},
    messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/hooks.json',
  });
}

function hookWithTranscript(transcriptPath: string): SessionFoundHookData {
  return { transcript_path: transcriptPath };
}

describe('Session', () => {
  it('defaults startedBy to terminal', () => {
    const client = createSessionClientStub();

    const session = createSession(client);

    try {
      expect((session as any).startedBy).toBe('terminal');
    } finally {
      session.cleanup();
    }
  });

  it('stores startedBy when provided', () => {
    const client = createSessionClientStub();

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      claudeArgs: [],
      mcpServers: {},
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
    });

    try {
      expect((session as any).startedBy).toBe('daemon');
    } finally {
      session.cleanup();
    }
  });

  it('adopts permissionMode from metadata without republishing it', () => {
    const metadataUpdates: MetadataMap[] = [];
    const client = createSessionClientStub({
      updateMetadata: (updater) => {
        metadataUpdates.push(updater({}));
      },
    });

    const session = createSession(client);

    try {
      session.setLastPermissionMode('plan', 111);
      expect(metadataUpdates).toEqual([{ permissionMode: 'plan', permissionModeUpdatedAt: 111 }]);
      metadataUpdates.length = 0;

      expect(session.adoptLastPermissionModeFromMetadata('acceptEdits', 222)).toBe(true);
      expect(session.lastPermissionMode).toBe('safe-yolo');
      expect(session.lastPermissionModeUpdatedAt).toBe(222);
      expect(metadataUpdates).toEqual([]);

      expect(session.adoptLastPermissionModeFromMetadata('default', 200)).toBe(false);
      expect(session.lastPermissionMode).toBe('safe-yolo');
      expect(session.lastPermissionModeUpdatedAt).toBe(222);
    } finally {
      session.cleanup();
    }
  });

  it('does not bump permissionModeUpdatedAt when permission mode does not change', () => {
    const metadataUpdates: MetadataMap[] = [];
    const client = createSessionClientStub({
      updateMetadata: (updater) => {
        metadataUpdates.push(updater({}));
      },
    });

    const session = createSession(client);

    try {
      session.setLastPermissionMode('default', 111);
      session.setLastPermissionMode('default', 222);
      session.setLastPermissionMode('plan', 333);
      session.setLastPermissionMode('plan', 444);

      expect(metadataUpdates).toEqual([{ permissionMode: 'plan', permissionModeUpdatedAt: 333 }]);
    } finally {
      session.cleanup();
    }
  });

  it('notifies sessionFound callbacks with transcriptPath when provided', () => {
    let metadata: MetadataMap = {};

    const client = createSessionClientStub({
      updateMetadata: (updater) => {
        metadata = updater(metadata);
      },
    });

    const session = createSession(client);

    try {
      const events: Array<{ sessionId: string; transcriptPath: string | null }> = [];
      session.addSessionFoundCallback((info) => events.push(info));

      session.onSessionFound('sess_1', hookWithTranscript('/tmp/sess_1.jsonl'));

      expect(metadata.claudeSessionId).toBe('sess_1');
      expect(metadata.claudeTranscriptPath).toBe('/tmp/sess_1.jsonl');
      expect(events).toEqual([{ sessionId: 'sess_1', transcriptPath: '/tmp/sess_1.jsonl' }]);
    } finally {
      session.cleanup();
    }
  });

  it('does not carry over transcriptPath when sessionId changes and hook lacks transcriptPath', () => {
    let metadata: MetadataMap = {};

    const client = createSessionClientStub({
      updateMetadata: (updater) => {
        metadata = updater(metadata);
      },
    });

    const session = createSession(client);

    try {
      const events: Array<{ sessionId: string; transcriptPath: string | null }> = [];
      session.addSessionFoundCallback((info) => events.push(info));

      session.onSessionFound('sess_1', hookWithTranscript('/tmp/sess_1.jsonl'));
      session.onSessionFound('sess_2');
      session.onSessionFound('sess_2', hookWithTranscript('/tmp/sess_2.jsonl'));

      expect(metadata.claudeSessionId).toBe('sess_2');
      expect(events).toEqual([
        { sessionId: 'sess_1', transcriptPath: '/tmp/sess_1.jsonl' },
        { sessionId: 'sess_2', transcriptPath: null },
        { sessionId: 'sess_2', transcriptPath: '/tmp/sess_2.jsonl' },
      ]);
    } finally {
      session.cleanup();
    }
  });

  it('clearSessionId clears transcriptPath as well', () => {
    const client = createSessionClientStub();

    const session = createSession(client);

    try {
      session.onSessionFound('sess_1', hookWithTranscript('/tmp/sess_1.jsonl'));
      expect(session.sessionId).toBe('sess_1');
      expect(session.transcriptPath).toBe('/tmp/sess_1.jsonl');

      session.clearSessionId();

      expect(session.sessionId).toBeNull();
      expect(session.transcriptPath).toBeNull();
    } finally {
      session.cleanup();
    }
  });

  it('consumeOneTimeFlags consumes short -c and -r flags', () => {
    const client = createSessionClientStub();

    const session = createSession(client, ['-c', '-r', 'abc-123', '--foo', 'bar']);

    try {
      session.consumeOneTimeFlags();
      expect(session.claudeArgs).toEqual(['--foo', 'bar']);
    } finally {
      session.cleanup();
    }
  });

  it('emits ACP task lifecycle events when thinking toggles', () => {
    const sendAgentMessage = vi.fn();
    const client = createSessionClientStub({ sendAgentMessage });

    const session = createSession(client);

    try {
      session.onThinkingChange(true);
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);
      const [provider1, payload1] = sendAgentMessage.mock.calls[0] ?? [];
      expect(provider1).toBe('claude');
      expect(payload1?.type).toBe('task_started');
      expect(typeof payload1?.id).toBe('string');

      session.onThinkingChange(true);
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);

      session.onThinkingChange(false);
      expect(sendAgentMessage).toHaveBeenCalledTimes(2);
      const [provider2, payload2] = sendAgentMessage.mock.calls[1] ?? [];
      expect(provider2).toBe('claude');
      expect(payload2).toEqual({ type: 'task_complete', id: payload1.id });
    } finally {
      session.cleanup();
    }
  });

  it('does not emit orphan ACP task_complete events', () => {
    const sendAgentMessage = vi.fn();
    const client = createSessionClientStub({ sendAgentMessage });

    const session = createSession(client);

    try {
      session.onThinkingChange(false);
      expect(sendAgentMessage).not.toHaveBeenCalled();
    } finally {
      session.cleanup();
    }
  });
});

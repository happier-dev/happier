import { describe, it, expect } from 'vitest';

import { importAcpReplayHistoryV1 } from './importAcpReplayHistory';

function createFakeSession() {
  const calls = {
    fetch: 0,
    sendUser: 0,
    sendAgent: 0,
    updateMetadata: 0,
  };

  const session = {
    async fetchRecentTranscriptTextItemsForAcpImport() {
      calls.fetch += 1;
      return [];
    },
    sendUserTextMessage(_text: string) {
      calls.sendUser += 1;
    },
    sendAgentMessage() {
      calls.sendAgent += 1;
    },
    updateMetadata(_fn: unknown) {
      calls.updateMetadata += 1;
    },
  };

  return { session, calls };
}

describe('importAcpReplayHistoryV1', () => {
  it('fails closed when remoteSessionId contains path separators', async () => {
    const { session, calls } = createFakeSession();

    await importAcpReplayHistoryV1({
      session: session as any,
      provider: 'claude' as any,
      remoteSessionId: 'foo/bar',
      replay: [
        { type: 'message', role: 'user', text: 'hi' },
        { type: 'message', role: 'agent', text: 'hello' },
      ] as any,
      permissionHandler: {
        handleToolCall: () => {
          throw new Error('permission handler should not be called for invalid ids');
        },
      } as any,
    });

    expect(calls.fetch).toBe(0);
    expect(calls.sendUser).toBe(0);
    expect(calls.sendAgent).toBe(0);
    expect(calls.updateMetadata).toBe(0);
  });

  it('imports new messages for valid remoteSessionId', async () => {
    const { session, calls } = createFakeSession();

    await importAcpReplayHistoryV1({
      session: session as any,
      provider: 'claude' as any,
      remoteSessionId: 'session-123',
      replay: [
        { type: 'message', role: 'user', text: 'hi' },
        { type: 'message', role: 'agent', text: 'hello' },
      ] as any,
      permissionHandler: {
        handleToolCall: () => {
          throw new Error('permission handler should not be called when overlap is unambiguous');
        },
      } as any,
    });

    expect(calls.fetch).toBe(1);
    expect(calls.sendUser).toBe(1);
    expect(calls.sendAgent).toBe(1);
    expect(calls.updateMetadata).toBe(1);
  });
});


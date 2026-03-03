import { describe, expect, it, vi } from 'vitest';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { fetchAndApplyMessages } from './syncSessions';

function buildApiMessage(id: string, seq: number): ApiMessage {
  return {
    id,
    seq,
    localId: null,
    content: { t: 'encrypted', c: `encrypted-${id}` },
    createdAt: 1_000 + seq,
  };
}

describe('fetchAndApplyMessages (sidechain parent backfill)', () => {
  it('fetches older pages when the initial page contains only sidechain messages', async () => {
    const applyMessages = vi.fn();
    const markMessagesLoaded = vi.fn();

    const request = vi.fn(async (path: string) => {
      if (path.includes('beforeSeq=')) {
        return new Response(
          JSON.stringify({
            messages: [buildApiMessage('parent', 99)],
            hasMore: false,
            nextBeforeSeq: null,
            nextAfterSeq: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({
          messages: [buildApiMessage('side1', 101), buildApiMessage('side2', 100)],
          hasMore: true,
          nextBeforeSeq: 100,
          nextAfterSeq: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const decryptMessages = vi.fn(async (apiMessages: ApiMessage[]) => {
      return apiMessages.map((m) => {
        if (m.id === 'parent') {
          return {
            id: m.id,
            localId: null,
            createdAt: m.createdAt,
            content: {
              role: 'agent',
              content: {
                type: 'acp',
                provider: 'claude',
                data: {
                  type: 'tool-call',
                  callId: 'tool_task_1',
                  input: '{}',
                  name: 'Task',
                  id: 'uuid_parent',
                },
              },
            },
          };
        }

        return {
          id: m.id,
          localId: null,
          createdAt: m.createdAt,
          content: {
            role: 'agent',
            content: {
              type: 'acp',
              provider: 'claude',
              data: {
                type: 'message',
                message: 'child',
                sidechainId: 'tool_task_1',
              },
            },
          },
        };
      });
    });

    await fetchAndApplyMessages({
      sessionId: 's1',
      getSessionEncryption: () => ({ decryptMessages } as any),
      request,
      sessionReceivedMessages: new Map(),
      applyMessages,
      markMessagesLoaded,
      log: { log: () => {} },
    });

    // Must fetch older messages after the initial page.
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1][0])).toContain('beforeSeq=100');

    // Must apply sidechain page, then apply the parent page.
    expect(applyMessages).toHaveBeenCalledTimes(2);
    const firstBatch = applyMessages.mock.calls[0][1] as any[];
    const secondBatch = applyMessages.mock.calls[1][1] as any[];

    expect(firstBatch.length).toBeGreaterThan(0);
    expect(firstBatch.every((m) => m.isSidechain === true)).toBe(true);

    expect(secondBatch.length).toBeGreaterThan(0);
    expect(secondBatch.some((m) => m.isSidechain === false)).toBe(true);

    expect(markMessagesLoaded).toHaveBeenCalledTimes(1);
  });

  it('fetches older pages when sidechain messages reference a missing owning tool-call', async () => {
    const applyMessages = vi.fn();
    const markMessagesLoaded = vi.fn();

    const request = vi.fn(async (path: string) => {
      if (path.includes('beforeSeq=')) {
        return new Response(
          JSON.stringify({
            messages: [buildApiMessage('parent', 99)],
            hasMore: false,
            nextBeforeSeq: null,
            nextAfterSeq: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({
          messages: [
            // Mix: one normal/root message plus sidechain children.
            buildApiMessage('root', 102),
            buildApiMessage('side1', 101),
            buildApiMessage('side2', 100),
          ],
          hasMore: true,
          nextBeforeSeq: 100,
          nextAfterSeq: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const decryptMessages = vi.fn(async (apiMessages: ApiMessage[]) => {
      return apiMessages.map((m) => {
        if (m.id === 'parent') {
          return {
            id: m.id,
            localId: null,
            createdAt: m.createdAt,
            content: {
              role: 'agent',
              content: {
                type: 'acp',
                provider: 'claude',
                data: {
                  type: 'tool-call',
                  callId: 'tool_task_1',
                  input: '{}',
                  name: 'Task',
                  id: 'uuid_parent',
                },
              },
            },
          };
        }

        if (m.id === 'root') {
          return {
            id: m.id,
            localId: null,
            createdAt: m.createdAt,
            content: {
              role: 'agent',
              content: {
                type: 'acp',
                provider: 'claude',
                data: {
                  type: 'message',
                  message: 'root',
                },
              },
            },
          };
        }

        return {
          id: m.id,
          localId: null,
          createdAt: m.createdAt,
          content: {
            role: 'agent',
            content: {
              type: 'acp',
              provider: 'claude',
              data: {
                type: 'message',
                message: 'child',
                sidechainId: 'tool_task_1',
              },
            },
          },
        };
      });
    });

    await fetchAndApplyMessages({
      sessionId: 's1',
      getSessionEncryption: () => ({ decryptMessages } as any),
      request,
      sessionReceivedMessages: new Map(),
      applyMessages,
      markMessagesLoaded,
      log: { log: () => {} },
    });

    // Must fetch older messages after the initial page to locate the parent tool-call.
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1][0])).toContain('beforeSeq=100');

    // Must apply the initial page, then apply the parent page.
    expect(applyMessages).toHaveBeenCalledTimes(2);
    const firstBatch = applyMessages.mock.calls[0][1] as any[];
    const secondBatch = applyMessages.mock.calls[1][1] as any[];

    expect(firstBatch.some((m) => m.isSidechain === true)).toBe(true);
    expect(secondBatch.some((m) => m.isSidechain === false)).toBe(true);
    expect(markMessagesLoaded).toHaveBeenCalledTimes(1);
  });
});

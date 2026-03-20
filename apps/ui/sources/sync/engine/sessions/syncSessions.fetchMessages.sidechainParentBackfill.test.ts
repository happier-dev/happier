import { describe, expect, it, vi } from 'vitest';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { fetchAndApplyMessages } from './syncSessions';

function buildApiMessage(id: string, seq: number): ApiMessage {
  return {
    id,
    seq,
    localId: null,
    sidechainId: null,
    content: { t: 'encrypted', c: `encrypted-${id}` },
    createdAt: 1_000 + seq,
    updatedAt: 2_000 + seq,
  };
}

describe('fetchAndApplyMessages (sidechain parent backfill)', () => {
  it('does not backfill older pages for sidechain-only pages (sidechains are loaded explicitly)', async () => {
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
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      markMessagesLoaded,
      log: { log: () => {} },
    });

    // Sidechain-heavy pages are handled by explicit `scope=sidechain` fetches. The main transcript
    // fetch should not scan backwards to locate missing parents.
    expect(request).toHaveBeenCalledTimes(1);
    expect(applyMessages).toHaveBeenCalledTimes(1);

    expect(markMessagesLoaded).toHaveBeenCalledTimes(1);
  });

  it('does not backfill older pages when sidechain messages reference a missing owning tool-call', async () => {
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
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      markMessagesLoaded,
      log: { log: () => {} },
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(applyMessages).toHaveBeenCalledTimes(1);
    expect(markMessagesLoaded).toHaveBeenCalledTimes(1);
  });

  it('marks scope=sidechain messages as sidechain messages even when the response omits sidechainId', async () => {
    const applyMessages = vi.fn();
    const markMessagesLoaded = vi.fn();

    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages: [buildApiMessage('side1', 101)],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const decryptMessages = vi.fn(async (apiMessages: ApiMessage[]) => apiMessages.map((m) => ({
      id: m.id,
      seq: m.seq,
      localId: null,
      createdAt: m.createdAt,
      content: {
        role: 'user',
        content: {
          type: 'text',
          text: 'hello',
        },
      },
    })));

    await fetchAndApplyMessages({
      sessionId: 's1',
      scope: 'sidechain',
      sidechainId: 'tool_task_1',
      getSessionEncryption: () => ({ decryptMessages } as any),
      request,
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      markMessagesLoaded,
      log: { log: () => {} },
    });

    expect(applyMessages).toHaveBeenCalledWith('s1', [expect.objectContaining({
      id: 'side1',
      isSidechain: true,
      sidechainId: 'tool_task_1',
    })]);
  });
});

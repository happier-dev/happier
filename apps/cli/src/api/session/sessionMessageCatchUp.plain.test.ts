import { describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', () => ({
  configuration: { serverUrl: 'http://example.test', apiServerUrl: 'http://example.test' },
}));

vi.mock('../client/loopbackUrl', () => ({
  resolveLoopbackHttpUrl: (url: string) => url,
}));

import axios, { AxiosHeaders, type AxiosResponse } from 'axios';

import { HttpStatusError } from '@/api/client/httpStatusError';

import { catchUpSessionMessagesAfterSeq } from './sessionMessageCatchUp';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';

describe('sessionMessageCatchUp (plaintext envelopes)', () => {
  it('emits new-message updates for plaintext transcript messages', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            localId: 'l1',
            createdAt: 123,
            updatedAt: 456,
            sourceCreatedAt: 23,
            sourceUpdatedAt: 56,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body?.t).toBe('new-message');
    expect(updates[0]?.body?.message?.content?.t).toBe('plain');
    expect(updates[0]?.body?.message?.localId).toBe('l1');
    expect(updates[0]?.body?.message?.sidechainId).toBeNull();
    expect(updates[0]?.body?.message?.createdAt).toBe(123);
    expect(updates[0]?.body?.message?.updatedAt).toBe(456);
    expect(updates[0]?.body?.message?.sourceCreatedAt).toBe(23);
    expect(updates[0]?.body?.message?.sourceUpdatedAt).toBe(56);
    expect(updates[0]?.body?.message?.transcriptObservationProvenance).toEqual({
      kind: 'non_dependent',
      source: 'history',
    });
  });

  it('projects persisted catch-up history at source time without feeding live effects', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'historical-agent-message',
            seq: 13,
            localId: 'historical-agent-local',
            createdAt: 1_000,
            updatedAt: 1_100,
            sourceCreatedAt: 123,
            sourceUpdatedAt: 456,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
            content: {
              t: 'plain',
              v: { role: 'agent', content: { type: 'text', text: 'historical output' } },
            },
          },
        ],
      },
    } as any);
    const observeMessage = vi.fn();
    const observeCommittedUserMessageSeq = vi.fn();
    const onConnectedServiceTurnLifecycleEvent = vi.fn();
    const emit = vi.fn();

    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (update) => {
        handleSessionNewMessageUpdate({
          update,
          sessionId: 's1',
          encryptionKey: new Uint8Array(32),
          encryptionVariant: 'legacy',
          receivedMessageIds: new Set<string>(),
          lastObservedMessageSeq: 10,
          lastObservedUserMessageSeq: 0,
          emit,
          observeMessage,
          observeCommittedUserMessageSeq,
          onConnectedServiceTurnLifecycleEvent,
          debug: vi.fn(),
          debugLargeJson: vi.fn(),
        });
      },
    });

    expect(observeMessage).not.toHaveBeenCalled();
    expect(observeCommittedUserMessageSeq).not.toHaveBeenCalled();
    expect(onConnectedServiceTurnLifecycleEvent).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('message', expect.objectContaining({
      createdAt: 123,
      serverCreatedAt: 1_000,
    }));
  });

  it('preserves the exact opaque local id during transcript restart catch-up', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            localId: ' request-1 ',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(updates[0]?.body?.message?.localId).toBe(' request-1 ');
  });

  it('preserves missing transcript timestamps as unavailable in catch-up updates', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.createdAt).toBeNull();
    expect(updates[0]?.body?.message?.createdAt).toBeNull();
    expect(updates[0]?.body?.message?.updatedAt).toBeNull();
  });

  it('ignores transcript messages with malformed seq values', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: '12',
            createdAt: 123,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(updates).toHaveLength(0);
  });

  it('throws terminal auth responses instead of treating them as empty catch-up', async () => {
    const authResponse: AxiosResponse = {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { messages: [] },
    };
    vi.spyOn(axios, 'get').mockResolvedValueOnce(authResponse);

    await expect(
      catchUpSessionMessagesAfterSeq({
        token: 'expired',
        sessionId: 's1',
        afterSeq: 10,
        onUpdate: vi.fn(),
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      code: 'not_authenticated',
      response: { status: 401 },
    } satisfies Partial<HttpStatusError & { code: string }>);
  });
});

import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
  SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
} from '@happier-dev/protocol';

import { deliverTranscriptMessageMutation } from './deliverTranscriptMessageMutation';
import { createTranscriptMessageAppendMutation } from './sessionClientDurableMutationTypes';

describe('deliverTranscriptMessageMutation provenance boundary', () => {
  it('fails closed before every transport for a recovered provenance-free mutation', async () => {
    const socket = {
      connected: true,
      emit: vi.fn(),
      emitWithAck: vi.fn(async () => ({ ok: true, id: 'ordinary-message', seq: 1, localId: 'legacy-id' })),
    };
    const http = vi.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true } });

    const result = await deliverTranscriptMessageMutation({
      token: 'token',
      socket,
      mutation: {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'transcript:session-1:legacy-id',
        source: 'transcript_message_append',
        localId: 'legacy-id',
        content: 'legacy-ciphertext',
        createdAt: 100,
        updatedAt: 100,
      } as Parameters<typeof deliverTranscriptMessageMutation>[0]['mutation'],
    });

    expect(result).toEqual({ delivered: false, reason: 'transcript_message_provenance_missing_or_invalid' });
    expect(socket.emitWithAck).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });

  it('uses only the current-publisher observation contract for provenance-bearing mutations', async () => {
    const events: string[] = [];
    const socket = {
      connected: true,
      emit: vi.fn(),
      emitWithAck: vi.fn(async (event: string, payload: unknown) => {
        events.push(event);
        if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
          expect(payload).toEqual({ v: 1, sessionId: 'session-1' });
          return { ok: true, capability: 'session-transcript-observation-v1' };
        }
        expect(event).toBe(SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1);
        expect(payload).toMatchObject({
          localId: ' historical-id ',
          createdAt: 100,
          updatedAt: 200,
          provenance: { kind: 'non_dependent', source: 'history' },
        });
        return {
          ok: true,
          status: 'observed',
          id: 'message-1',
          seq: 7,
          localId: ' historical-id ',
          didWrite: true,
          ingestedAt: 300,
        };
      }),
    };
    const http = vi.spyOn(axios, 'post');

    const result = await deliverTranscriptMessageMutation({
      token: 'token',
      socket,
      mutation: createTranscriptMessageAppendMutation({
        sessionId: 'session-1',
        localId: ' historical-id ',
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'old' } } },
        messageRole: 'agent',
        createdAt: 100,
        updatedAt: 200,
        provenance: { kind: 'non_dependent', source: 'history' },
      }),
    });

    expect(events).toEqual([
      SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
      SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
    ]);
    expect(result).toMatchObject({ delivered: true, path: 'socket', ack: { id: 'message-1', seq: 7 } });
    expect(http).not.toHaveBeenCalled();
  });

  it('never downgrades provenance to the ordinary HTTP writer', async () => {
    const http = vi.spyOn(axios, 'post');
    const socket = {
      connected: true,
      emit: vi.fn(),
      emitWithAck: vi.fn(async () => ({ ok: false, error: 'unsupported' })),
    };

    const result = await deliverTranscriptMessageMutation({
      token: 'token',
      socket,
      mutation: createTranscriptMessageAppendMutation({
        sessionId: 'session-1',
        localId: 'history-id',
        content: 'cipher',
        createdAt: 100,
        provenance: { kind: 'non_dependent', source: 'history' },
      }),
    });

    expect(result).toEqual({ delivered: false, reason: 'transcript_message_transport_unavailable' });
    expect(http).not.toHaveBeenCalled();
  });

  it('uses the exact released Gemini message seam only for server-v0.2.1', async () => {
    const socket = {
      connected: true,
      emit: vi.fn(),
      emitWithAck: vi.fn(async () => ({
        ok: true,
        id: 'message-1',
        seq: 7,
        localId: 'gemini-segment',
        didWrite: true,
      })),
    };

    const result = await deliverTranscriptMessageMutation({
      token: 'token',
      socket,
      serverContractMode: 'released_server_v0_2_1',
      mutation: createTranscriptMessageAppendMutation({
        sessionId: 'session-1',
        localId: 'gemini-segment',
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Gemini output' } } },
        messageRole: 'agent',
        createdAt: 100,
        updatedAt: 200,
        provenance: { kind: 'non_dependent', source: 'external' },
      }),
    });

    expect(result).toMatchObject({ delivered: true, path: 'socket' });
    expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
    expect(socket.emitWithAck).toHaveBeenCalledWith('message', {
      sid: 'session-1',
      message: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Gemini output' } } },
      localId: 'gemini-segment',
      echoToSender: true,
      sidechainId: null,
      messageRole: 'agent',
    });
  });
});

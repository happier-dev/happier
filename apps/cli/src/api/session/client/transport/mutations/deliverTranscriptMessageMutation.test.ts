import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
  SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
} from '@happier-dev/protocol';

import { deliverTranscriptMessageMutation } from './deliverTranscriptMessageMutation';
import { createTranscriptMessageAppendMutation } from './sessionClientDurableMutationTypes';
import { resolveSessionClientConnectionContract } from '../sessionClientConnectionContract';

function serverContract(
  socket: Readonly<{ connected: boolean }>,
  mode: 'session_sync_v2_pending_input_v1' | 'released_server_v0_2_1' = 'session_sync_v2_pending_input_v1',
) {
  return {
    mode,
    runtimeActivity: mode === 'released_server_v0_2_1' ? 'legacy' : 'v2',
    pendingInput: mode === 'released_server_v0_2_1' ? 'released_server_v0_2_1' : 'v1',
    publisherAuthority: 'indeterminate',
    sessionConnectionEpoch: 1,
    socket,
  } as const;
}

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
    const connectionContract = await resolveSessionClientConnectionContract({
      serverContract: serverContract(socket),
      sessionId: 'session-1',
      socket,
    });

    const result = await deliverTranscriptMessageMutation({
      token: 'token',
      socket,
      connectionContract,
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

  it('keeps custody when the current observation ACK names a different localId', async () => {
    const socket = {
      connected: true,
      emit: vi.fn(),
      emitWithAck: vi.fn(async (event: string) => (
        event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1
          ? { ok: true, capability: 'session-transcript-observation-v1' }
          : {
              ok: true,
              status: 'observed',
              id: 'message-for-another-row',
              seq: 7,
              localId: 'another-local-id',
              didWrite: true,
              ingestedAt: 300,
            }
      )),
    };
    const connectionContract = await resolveSessionClientConnectionContract({
      serverContract: serverContract(socket),
      sessionId: 'session-1',
      socket,
    });

    const result = await deliverTranscriptMessageMutation({
      token: 'token',
      socket,
      connectionContract,
      mutation: createTranscriptMessageAppendMutation({
        sessionId: 'session-1',
        localId: 'expected-local-id',
        content: 'cipher',
        createdAt: 100,
        provenance: { kind: 'non_dependent', source: 'history' },
      }),
    });

    expect(result).toEqual({ delivered: false, reason: 'transcript_message_delivery_failed' });
  });

  it('negotiates transcript observation once for multiple durable rows in one connection epoch', async () => {
    const socket = {
      connected: true,
      emit: vi.fn(),
      emitWithAck: vi.fn(async (event: string, payload: unknown) => {
        if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
          return { ok: true, capability: 'session-transcript-observation-v1' };
        }
        const localId = typeof payload === 'object' && payload && 'localId' in payload
          ? String(payload.localId)
          : 'unknown';
        return {
          ok: true,
          status: 'observed',
          id: `message-${localId}`,
          seq: Number(localId.slice(-1)),
          localId,
          didWrite: true,
          ingestedAt: 300,
        };
      }),
    };
    const connectionContract = await resolveSessionClientConnectionContract({
      serverContract: serverContract(socket),
      sessionId: 'session-1',
      socket,
    });

    for (const localId of ['queued-1', 'queued-2', 'queued-3']) {
      await expect(deliverTranscriptMessageMutation({
        token: 'token',
        socket,
        connectionContract,
        mutation: createTranscriptMessageAppendMutation({
          sessionId: 'session-1',
          localId,
          content: 'cipher',
          createdAt: 100,
          provenance: { kind: 'non_dependent', source: 'history' },
        }),
      })).resolves.toMatchObject({ delivered: true });
    }

    expect(socket.emitWithAck.mock.calls.filter(([event]) => (
      event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1
    ))).toHaveLength(1);
    expect(socket.emitWithAck.mock.calls.filter(([event]) => (
      event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1
    ))).toHaveLength(3);
  });

  it('never downgrades provenance to the ordinary HTTP writer', async () => {
    const http = vi.spyOn(axios, 'post');
    const socket = {
      connected: true,
      emit: vi.fn(),
      emitWithAck: vi.fn(async () => ({ ok: false, error: 'unsupported' })),
    };
    const connectionContract = await resolveSessionClientConnectionContract({
      serverContract: serverContract(socket),
      sessionId: 'session-1',
      socket,
    });

    const result = await deliverTranscriptMessageMutation({
      token: 'token',
      socket,
      connectionContract,
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

  it('distinguishes a post-capability delivery failure from unavailable transport', async () => {
    const socket = {
      connected: true,
      emit: vi.fn(),
      emitWithAck: vi.fn(async (event: string) => (
        event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1
          ? { ok: true, capability: 'session-transcript-observation-v1' }
          : { ok: false, error: 'invalid_observation' }
      )),
    };
    const connectionContract = await resolveSessionClientConnectionContract({
      serverContract: serverContract(socket),
      sessionId: 'session-1',
      socket,
    });

    const result = await deliverTranscriptMessageMutation({
      token: 'token',
      socket,
      connectionContract,
      mutation: createTranscriptMessageAppendMutation({
        sessionId: 'session-1',
        localId: 'rejected-message',
        content: 'cipher',
        createdAt: 100,
        provenance: { kind: 'non_dependent', source: 'history' },
      }),
    });

    expect(result).toEqual({ delivered: false, reason: 'transcript_message_invalid_observation' });
    expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
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
    const connectionContract = await resolveSessionClientConnectionContract({
      serverContract: serverContract(socket, 'released_server_v0_2_1'),
      sessionId: 'session-1',
      socket,
    });

    const result = await deliverTranscriptMessageMutation({
      token: 'token',
      socket,
      connectionContract,
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

  it('keeps custody when the released-v0.2.1 ACK names a different localId', async () => {
    const socket = {
      connected: true,
      emit: vi.fn(),
      emitWithAck: vi.fn(async () => ({
        ok: true,
        id: 'message-for-another-row',
        seq: 7,
        localId: 'another-local-id',
        didWrite: true,
      })),
    };
    const connectionContract = await resolveSessionClientConnectionContract({
      serverContract: serverContract(socket, 'released_server_v0_2_1'),
      sessionId: 'session-1',
      socket,
    });

    const result = await deliverTranscriptMessageMutation({
      token: 'token',
      socket,
      connectionContract,
      mutation: createTranscriptMessageAppendMutation({
        sessionId: 'session-1',
        localId: 'expected-local-id',
        content: 'cipher',
        createdAt: 100,
        provenance: { kind: 'non_dependent', source: 'external' },
      }),
    });

    expect(result).toEqual({ delivered: false, reason: 'transcript_message_delivery_failed' });
  });
});

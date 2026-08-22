import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
  SessionInputAdmissionResultV1Schema,
  SessionPendingEnqueueByMachineRequestV1Schema,
  type SessionInputAdmissionResultV1,
  type SessionPendingEnqueueByMachineRequestV1,
} from '@happier-dev/protocol';
import type { Machine } from '@/api/types';

import { ApiMachineClient } from './apiMachine';

function createMachine(): Machine {
  return {
    id: 'machine-1',
    encryptionKey: new Uint8Array(32).fill(1),
    encryptionVariant: 'legacy',
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

async function enqueueMachineAdmissionWithCancellation(
  client: ApiMachineClient,
  request: SessionPendingEnqueueByMachineRequestV1,
  signal: AbortSignal,
): Promise<SessionInputAdmissionResultV1> {
  return SessionInputAdmissionResultV1Schema.parse(await client.enqueueSessionPendingByMachine(
    request,
    { signal },
  ));
}

describe('ApiMachineClient machine admission transport', () => {
  it('returns a definite rejection when the socket is known disconnected before emit', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const emitWithAck = vi.fn();
    Reflect.set(client, 'socket', { connected: false, emitWithAck });
    const request = SessionPendingEnqueueByMachineRequestV1Schema.parse({
      v: 1,
      sessionId: 'session-1',
      targetMachineId: 'machine-1',
      localId: 'plugin-input-v1:disconnected-before-emit',
      content: {
        t: 'plain',
        v: { role: 'user', content: { type: 'text', text: 'plugin prompt' }, meta: {} },
      },
      requestedAction: { v: 1, kind: 'steer_if_active' },
    });

    await expect(client.enqueueSessionPendingByMachine(request)).resolves.toEqual({
      status: 'rejected',
      code: 'session_input_target_unavailable',
    });
    expect(emitWithAck).not.toHaveBeenCalled();
  });

  it('settles the socket acknowledgement on caller cancellation without serializing the signal', async () => {
    const client = new ApiMachineClient('token', createMachine());
    let acknowledge!: (value: unknown) => void;
    const emitWithAck = vi.fn((_event: string, _payload: unknown) => new Promise<unknown>((resolve) => {
      acknowledge = resolve;
    }));
    Reflect.set(client, 'socket', {
      connected: true,
      timeout: vi.fn(() => ({ emitWithAck })),
    });
    const cancellation = new AbortController();
    const request = SessionPendingEnqueueByMachineRequestV1Schema.parse({
      v: 1,
      sessionId: 'session-1',
      targetMachineId: 'machine-1',
      localId: 'plugin-input-v1:cancelled-machine-ack',
      content: {
        t: 'plain',
        v: {
          role: 'user',
          content: { type: 'text', text: 'plugin prompt' },
          meta: {},
        },
      },
      requestedAction: { v: 1, kind: 'steer_if_active' },
    });

    const pending = enqueueMachineAdmissionWithCancellation(client, request, cancellation.signal);
    await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledOnce());

    try {
      cancellation.abort();
      await expect(pending).resolves.toEqual({
        status: 'outcomeUnknown',
        localId: request.localId,
        code: 'machine_admission_cancelled_after_emit',
      });
      const [event, payload] = emitWithAck.mock.calls[0] ?? [];
      expect(event).toBe(SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1);
      expect(payload).toEqual(request);
      expect(payload).not.toHaveProperty('signal');
    } finally {
      acknowledge({
        v: 1,
        result: { status: 'accepted', localId: request.localId },
      });
      await pending.catch(() => undefined);
    }
  });

  it('rejects cancellation before emit with no possible server effect', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const emitWithAck = vi.fn();
    Reflect.set(client, 'socket', {
      connected: true,
      timeout: vi.fn(() => ({ emitWithAck })),
    });
    const cancellation = new AbortController();
    cancellation.abort();
    const request = SessionPendingEnqueueByMachineRequestV1Schema.parse({
      v: 1,
      sessionId: 'session-1',
      targetMachineId: 'machine-1',
      localId: 'plugin-input-v1:cancelled-before-emit',
      content: {
        t: 'plain',
        v: { role: 'user', content: { type: 'text', text: 'plugin prompt' }, meta: {} },
      },
      requestedAction: { v: 1, kind: 'steer_if_active' },
    });

    await expect(enqueueMachineAdmissionWithCancellation(
      client,
      request,
      cancellation.signal,
    )).resolves.toEqual({
      status: 'rejected',
      code: 'session_input_cancelled',
    });
    expect(emitWithAck).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';

import {
  SOCKET_RPC_EVENTS,
  SocketRpcCancellationPayloadSchema,
  SocketRpcTransportResponseEnvelopeV1Schema,
} from './socket.js';

describe('SOCKET_RPC_EVENTS wire ABI', () => {
  it('preserves the established socket event literals', () => {
    expect(SOCKET_RPC_EVENTS).toEqual({
      REGISTER: 'rpc-register',
      REGISTERED: 'rpc-registered',
      UNREGISTER: 'rpc-unregister',
      UNREGISTERED: 'rpc-unregistered',
      ERROR: 'rpc-error',
      CALL: 'rpc-call',
      REQUEST: 'rpc-request',
      CANCEL: 'rpc-cancel',
      MACHINE_TRANSFER_ENVELOPE: 'machine-transfer-envelope',
    });
  });
});

describe('SocketRpcCancellationPayloadSchema', () => {
  it('accepts only one bounded request correlation field', () => {
    expect(SocketRpcCancellationPayloadSchema.parse({ requestId: 'rpc_request-1' }))
      .toEqual({ requestId: 'rpc_request-1' });
    expect(SocketRpcCancellationPayloadSchema.safeParse({ requestId: '' }).success).toBe(false);
    expect(SocketRpcCancellationPayloadSchema.safeParse({ requestId: 'rpc_request-1', target: 'other' }).success)
      .toBe(false);
  });
});

describe('SocketRpcTransportResponseEnvelopeV1Schema', () => {
  it('accepts only the strict non-secret stopped acknowledgement', () => {
    expect(SocketRpcTransportResponseEnvelopeV1Schema.parse({
      v: 1,
      result: 'opaque-encrypted-result',
      acknowledgement: {
        kind: 'session.stop',
        status: 'stopped',
      },
    })).toEqual({
      v: 1,
      result: 'opaque-encrypted-result',
      acknowledgement: {
        kind: 'session.stop',
        status: 'stopped',
      },
    });

    expect(SocketRpcTransportResponseEnvelopeV1Schema.safeParse({
      v: 1,
      result: 'opaque-encrypted-result',
      acknowledgement: {
        kind: 'session.stop',
        status: 'requested',
      },
    }).success).toBe(false);
    expect(SocketRpcTransportResponseEnvelopeV1Schema.safeParse({
      v: 1,
      result: 'opaque-encrypted-result',
      acknowledgement: {
        kind: 'session.stop',
        status: 'stopped',
        sessionId: 'must-not-leak',
      },
    }).success).toBe(false);
  });

  it('requires an own result property when stopped proof is present', () => {
    expect(SocketRpcTransportResponseEnvelopeV1Schema.safeParse({
      v: 1,
      acknowledgement: {
        kind: 'session.stop',
        status: 'stopped',
      },
    }).success).toBe(false);
  });
});

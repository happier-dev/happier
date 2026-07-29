import { describe, expect, it } from 'vitest';

import {
  SOCKET_RPC_EVENTS,
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
      MACHINE_TRANSFER_ENVELOPE: 'machine-transfer-envelope',
    });
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
});

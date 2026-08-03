import { describe, expect, it } from 'vitest';

import {
  SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1,
  SocketRpcTransportResponseEnvelopeV1Schema,
} from './socketRpc';

describe('SocketRpcTransportResponseEnvelopeV1Schema', () => {
  it('accepts an opaque result with a strict stopped-session acknowledgement', () => {
    expect(SocketRpcTransportResponseEnvelopeV1Schema.parse({
      v: SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1,
      result: 'opaque-encrypted-result',
      acknowledgement: { kind: 'session.stop', status: 'stopped' },
    })).toEqual({
      v: 1,
      result: 'opaque-encrypted-result',
      acknowledgement: { kind: 'session.stop', status: 'stopped' },
    });
  });

  it('rejects unrecognized acknowledgement claims', () => {
    expect(SocketRpcTransportResponseEnvelopeV1Schema.safeParse({
      v: 1,
      result: 'opaque-encrypted-result',
      acknowledgement: { kind: 'session.stop', status: 'requested' },
    }).success).toBe(false);
  });

  it('requires the original result even when stopped proof is present', () => {
    expect(SocketRpcTransportResponseEnvelopeV1Schema.safeParse({
      v: 1,
      acknowledgement: { kind: 'session.stop', status: 'stopped' },
    }).success).toBe(false);
  });
});

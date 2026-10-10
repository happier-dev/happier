import { describe, expect, it } from 'vitest';
import * as socketProtocol from './socket.js';
import { RPC_METHODS } from './methods.js';

it('admits turn abort under its own Action while retaining submit-input capability', () => {
  expect(socketProtocol.resolveSocketRpcSessionAuthorization('session-a:abort')).toMatchObject({
    authority: 'submitAgentInput', actionId: 'session.turn.cancel', routeToSessionOwnerDaemon: true,
  });
});

it('admits optional exact Session read proof on PR evidence without changing Machine routing', () => {
  for (const method of [RPC_METHODS.SCM_PULL_REQUEST_LIST, RPC_METHODS.SCM_PULL_REQUEST_GET]) {
    expect(socketProtocol.resolveSocketRpcSessionAuthorization(`machine:${method}`)).toMatchObject({
      authority: 'readTranscript', optionalSessionScope: true, routeToSessionOwnerDaemon: false,
    });
  }
});

it('keeps Machine access-loss custody server-origin private and closed', () => {
  const marker = { kind: 'machine.accessLoss.serverOrigin' };
  expect(socketProtocol.isSocketRpcMachineAccessLossServerOriginAuthorizationContext(marker)).toBe(true);
  expect(socketProtocol.isSocketRpcMachineAccessLossServerOriginAuthorizationContext({ ...marker, subjectAccountId: 'bob' })).toBe(false);
  expect(socketProtocol.parseSocketRpcAuthorizationContext(marker)).toBeNull();
});

it('preserves the predecessor Session-write shape and rejects additional authority fields', () => {
  const authorization = { kind: 'session.write', sessionId: ' session-a ' };
  expect(socketProtocol.parseSocketRpcAuthorizationContext(authorization))
    .toEqual({ kind: 'session.write', sessionId: 'session-a' });
  expect(socketProtocol.parseSocketRpcAuthorizationContext({ ...authorization, accountId: 'other-account' }))
    .toBeNull();
  expect(socketProtocol.parseSocketRpcAuthorizationContext(Object.assign([], authorization))).toBeNull();
  expect(socketProtocol.parseSocketRpcAuthorizationContext(Object.create(authorization))).toBeNull();
});

import {
  SOCKET_RPC_EVENTS,
  SocketRpcCancellationPayloadSchema,
  SocketRpcTransportResponseEnvelopeV1Schema,
} from './socket.js';

it('admits only non-secret Session transfer routing for attachment kinds', () => {
  const schema = socketProtocol.SessionTransferRoutingV1Schema;
  expect(schema).toBeDefined();
  const routing = { method: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, t: 'session_attachment_upload_v1', sessionId: 'session-a' };
  expect(schema.safeParse(routing).success).toBe(true);
  expect(schema.safeParse({ ...routing, t: 'session_file_download_v1' }).success).toBe(false);
  expect(schema.safeParse({ ...routing, method: RPC_METHODS.READ_FILE }).success).toBe(false);
  expect(schema.safeParse({ ...routing, fileName: 'private.txt' }).success).toBe(false);
  expect(schema.safeParse({ ...routing, sessionId: ' session-a ' }).success).toBe(false);
  expect(schema.safeParse({ method: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
    t: 'session_attachment_download_v1', sessionId: 'session-a' }).success).toBe(true);
  expect(schema.safeParse({ method: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
    t: 'composer_media_stage_inspect_v1', sessionId: 'session-a' }).success).toBe(false);
});

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

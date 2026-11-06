import { describe, expect, it } from 'vitest';
import * as socketProtocol from './socket.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from './methods.js';
import { resolveMachineRpcRoutePolicy } from '../machines/peer/mediation/rpc/routePolicyV1.js';

it('keeps Home Machine-read authority closed and outside generic client authorization', () => {
  const authority = socketProtocol.SocketRpcMachineReadServerOriginAuthorizationContextV1Schema.parse({
    kind: 'machine.read.serverOrigin', accountId: 'alice', machineId: 'machine-a',
  });
  expect(socketProtocol.isSocketRpcMachineReadServerOriginAuthorizationContext(authority)).toBe(true);
  expect(socketProtocol.parseSocketRpcAuthorizationContext(authority)).toBeNull();
  for (const invalid of [{ ...authority, resourceId: 'injected' }, { ...authority, accountId: '' },
    { ...authority, machineId: '' }, { kind: authority.kind }]) {
    expect(socketProtocol.isSocketRpcMachineReadServerOriginAuthorizationContext(invalid)).toBe(false);
  }
});

it('classifies detached execution reads without weakening Session authority or the Session-only broker', () => {
  for (const method of [SESSION_RPC_METHODS.EXECUTION_RUN_GET, SESSION_RPC_METHODS.EXECUTION_RUN_LIST, SESSION_RPC_METHODS.EXECUTION_RUN_WAIT]) {
    expect(socketProtocol.resolveSocketRpcSessionAuthorization(method)).toMatchObject({
      authority: 'readTranscript', routeToSessionOwnerDaemon: true, machineScope: true,
    });
    expect(resolveMachineRpcRoutePolicy(method)).toMatchObject({ routeClass: 'server_required', sharedMachineAccess: 'custodian_only',
      scope: { sessionRequired: false } });
  }
  expect(socketProtocol.resolveSocketRpcSessionAuthorization(SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1))
    .toMatchObject({ authority: 'sessionOwner', routeToSessionOwnerDaemon: true });
  expect(socketProtocol.resolveSocketRpcSessionAuthorization(SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1)?.machineScope).toBeUndefined();
});

it('admits turn abort under its own Action while retaining submit-input capability', () => {
  expect(socketProtocol.resolveSocketRpcSessionAuthorization('session-a:abort')).toMatchObject({
    authority: 'submitAgentInput', actionId: 'session.turn.cancel', routeToSessionOwnerDaemon: true,
  });
});

it('keeps explicit replies on the exact publisher Session with Action authority and origin', () => {
  const method = 'session.message.reply';
  expect(socketProtocol.resolveSocketRpcSessionAuthorization(`session-a:${method}`)).toMatchObject({
    authority: 'sessionOwner', actionId: method, routeToSessionOwnerDaemon: true,
  });
  expect(socketProtocol.isSessionActionRpcMethodV1(`session-a:${method}`)).toBe(true);
  expect(resolveMachineRpcRoutePolicy(method)).toMatchObject({
    routeClass: 'server_required', sharedMachineAccess: 'custodian_only',
    scope: { sessionRequired: true },
  });
});

it('carries Session question origin only through the modern question operations', () => {
  expect(socketProtocol.isSessionActionRpcMethodV1(RPC_METHODS.SESSION_USER_ACTION_ANSWER)).toBe(true);
  expect(socketProtocol.isSessionActionRpcMethodV1(SESSION_RPC_METHODS.SESSION_NEEDS_YOU_RAISE)).toBe(true);
  for (const method of ['permission', 'session.structuredQuestion.respond.v1', RPC_METHODS.APPROVAL_REQUEST_DECIDE]) {
    expect(socketProtocol.isSessionActionRpcMethodV1(method), method).toBe(false);
  }
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

it('keeps Session-read proof separate from write and owner authority', () => {
  const authorization = { kind: 'session.read', sessionId: ' session-a ' };
  expect(socketProtocol.parseSocketRpcAuthorizationContext(authorization))
    .toEqual({ kind: 'session.read', sessionId: 'session-a' });
  for (const invalid of [{ ...authorization, authority: 'sessionOwner' }, { ...authorization, accountId: 'other' },
    { ...authorization, sessionId: '' }, Object.create(authorization)]) {
    expect(socketProtocol.parseSocketRpcAuthorizationContext(invalid)).toBeNull();
  }
});

it('retains only the literal server-proven Session-owner authority in the closed Session-write carrier', () => {
  const authorization = { kind: 'session.write', sessionId: ' session-a ', authority: 'sessionOwner' };
  expect(socketProtocol.parseSocketRpcAuthorizationContext(authorization))
    .toEqual({ kind: 'session.write', sessionId: 'session-a', authority: 'sessionOwner' });
  for (const invalid of [{ ...authorization, authority: 'present_user' }, { ...authorization, authority: true },
    { ...authorization, accountId: 'other-account' }]) {
    expect(socketProtocol.parseSocketRpcAuthorizationContext(invalid)).toBeNull();
  }
});

it('requires Session ownership for native Realtime Start while preserving shared input and question capability', () => {
  expect(socketProtocol.resolveSocketRpcSessionAuthorization(`session-a:${SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START}`))
    .toMatchObject({ authority: 'sessionOwner', routeToSessionOwnerDaemon: true });
  for (const method of [SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, RPC_METHODS.SESSION_USER_ACTION_ANSWER]) {
    expect(socketProtocol.resolveSocketRpcSessionAuthorization(`session-a:${method}`))
      .toMatchObject({ authority: 'submitAgentInput', routeToSessionOwnerDaemon: true });
  }
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

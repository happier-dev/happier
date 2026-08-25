import { describe, expect, it } from 'vitest';

import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  RPC_METHODS,
  SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from '@happier-dev/protocol/rpc';

import { authorizeMachineRpcRequest } from './machineRpcAuthorization';

describe('authorizeMachineRpcRequest', () => {
  it('allows machine RPC methods that do not require session-write authorization', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
    })).resolves.toEqual({ ok: true });
  });

  it('rejects session-write RPCs without authorization', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    });
  });

  it('accepts the released server-v0.2.1 Stop shape without a server authorization envelope', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
      transportResponseEnvelopeVersion: undefined,
    })).resolves.toEqual({ ok: true });
  });

  it('keeps current Stop requests fail-closed when the server authorization proof is absent', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
      transportResponseEnvelopeVersion: 1,
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    });
  });

  it('requires the same session-write authorization for recovery restart V2', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    });
  });

  it('rejects session-write RPCs when decrypted params target another session', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      params: { sessionId: 'sess_2' },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: 'sess_1',
      },
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    });
  });

  it('allows session-write RPCs when authorization and decrypted params target the same session', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      params: { sessionId: 'sess_1' },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: 'sess_1',
      },
    })).resolves.toEqual({ ok: true });
  });

  it('requires matching Session authorization for remote grant inventory and revocation', async () => {
    for (const method of [
      'session.permission.remote.grants.list',
      'session.permission.remote.grants.revoke',
    ]) {
      await expect(authorizeMachineRpcRequest({
        method: `sess_1:${method}`,
        params: { sessionId: 'sess_1' },
        authorization: undefined,
      })).resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      await expect(authorizeMachineRpcRequest({
        method: `sess_1:${method}`,
        params: { sessionId: 'sess_1' },
        authorization: {
          kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
          sessionId: 'sess_1',
        },
      })).resolves.toEqual({ ok: true });
    }
  });

  it('rejects a Session Agent transition with no server-provided edit proof', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    });
  });

  it('rejects a Session Agent transition whose edit proof names another Session', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      params: { sessionId: 'sess_2' },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: 'sess_1',
      },
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    });
  });

  it('allows a Session Agent transition whose edit proof matches the decrypted request', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      params: { sessionId: 'sess_1' },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: 'sess_1',
      },
    })).resolves.toEqual({ ok: true });
  });

});

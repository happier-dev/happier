import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '../../crypto/base64.js';
import { resolveMachineRpcRoutePolicy } from '../../machines/peer/mediation/rpc/routePolicyV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import {
  SESSION_FOLLOW_SOURCE_KEY_PREPARE_AUTHORIZATION_KIND_V1,
  SessionFollowSourceKeyPrepareAuthorizationV1Schema,
  SessionFollowSourceKeyPrepareRequestV1Schema,
  SessionFollowSourceKeyPrepareResponseV1Schema,
  SessionFollowSourceKeyPreparationResultV1Schema,
  projectSessionFollowSourceKeyPreparationAfterSetV1,
  decodeSessionFollowSourceDataEncryptionKeyV1,
  resolveSessionFollowSourceKeyPreparationFailureV1,
  buildSessionFollowSourceKeyPrepareRequestV1,
} from './sessionFollowSourceKeyPreparationV1.js';
import { RPC_ERROR_CODES } from '../../rpc/index.js';

describe('Session Follow source-key preparation V1', () => {
  const sourceDataEncryptionKeyBase64 = encodeBase64(new Uint8Array(32).fill(7));

  it('admits only the strict content-free source/destination authorization tuple', () => {
    const authorization = {
      kind: SESSION_FOLLOW_SOURCE_KEY_PREPARE_AUTHORIZATION_KIND_V1,
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
    };
    expect(SessionFollowSourceKeyPrepareAuthorizationV1Schema.parse(authorization)).toEqual(authorization);
    expect(SessionFollowSourceKeyPrepareAuthorizationV1Schema.safeParse({ ...authorization, accountId: 'caller' }).success).toBe(false);
    expect(SessionFollowSourceKeyPrepareAuthorizationV1Schema.safeParse({ ...authorization, destinationSessionId: 'source' }).success).toBe(false);
  });

  it('requires one canonical padded Base64 Session DEK and decodes exactly 32 bytes', () => {
    const request = {
      v: 1,
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      sourceDataEncryptionKeyBase64,
    };
    expect(SessionFollowSourceKeyPrepareRequestV1Schema.parse(request)).toEqual(request);
    expect(decodeSessionFollowSourceDataEncryptionKeyV1(sourceDataEncryptionKeyBase64)).toEqual(new Uint8Array(32).fill(7));
    expect(SessionFollowSourceKeyPrepareRequestV1Schema.safeParse({ ...request, sourceDataEncryptionKeyBase64: sourceDataEncryptionKeyBase64.replace(/=+$/u, '') }).success).toBe(false);
    expect(SessionFollowSourceKeyPrepareRequestV1Schema.safeParse({ ...request, sourceDataEncryptionKeyBase64: encodeBase64(new Uint8Array(31)) }).success).toBe(false);
    expect(SessionFollowSourceKeyPrepareRequestV1Schema.safeParse({ ...request, ignored: true }).success).toBe(false);
  });

  it('binds admitted source material to the same input without exposing private rule references', () => {
    const material = buildSessionFollowSourceKeyPrepareRequestV1({
      sourceSessionId: 'source', destinationSessionId: 'destination',
      sourceDataEncryptionKeyBase64, localInputId: 'admitted-original',
    });
    expect(material.authorization).toMatchObject({ localInputId: 'admitted-original' });
    expect(material.request).toMatchObject({ localInputId: 'admitted-original' });
  });

  it('rejects private rule references in either native source-key carrier', () => {
    const material = buildSessionFollowSourceKeyPrepareRequestV1({
      sourceSessionId: 'source', destinationSessionId: 'destination', sourceDataEncryptionKeyBase64,
    });
    const rule = { ruleId: 'private-rule', ruleVersion: 1 };
    expect(SessionFollowSourceKeyPrepareAuthorizationV1Schema.safeParse({ ...material.authorization, rule }).success).toBe(false);
    expect(SessionFollowSourceKeyPrepareRequestV1Schema.safeParse({ ...material.request, rule }).success).toBe(false);
  });

  it('returns only the strict installation outcome', () => {
    expect(SessionFollowSourceKeyPrepareResponseV1Schema.parse({ v: 1, outcome: 'installed' })).toEqual({ v: 1, outcome: 'installed' });
    expect(SessionFollowSourceKeyPrepareResponseV1Schema.safeParse({ v: 1, outcome: 'installed', sourceSessionId: 'source' }).success).toBe(false);
  });

  it('keeps a committed edge successful only when preparation is complete or unnecessary', () => {
    const committed = {
      changed: true,
      source: {
        sourceSessionId: 'source',
        destinationSessionId: 'destination',
        policy: { preset: 'quiet' as const },
        deliveryState: 'eligible' as const,
        hasPendingUpdates: false,
      },
    };

    expect(projectSessionFollowSourceKeyPreparationAfterSetV1(committed, { kind: 'prepared' }))
      .toEqual(committed);
    expect(projectSessionFollowSourceKeyPreparationAfterSetV1(committed, { kind: 'not_needed' }))
      .toEqual(committed);
  });

  it('projects a committed-but-waiting edge as an explicit partial Action result', () => {
    const committed = {
      changed: true,
      source: {
        sourceSessionId: 'source',
        destinationSessionId: 'destination',
        policy: { preset: 'quiet' as const },
        deliveryState: 'eligible' as const,
        hasPendingUpdates: false,
      },
    };

    expect(projectSessionFollowSourceKeyPreparationAfterSetV1(committed, {
      kind: 'waiting',
      reason: 'runner_key_unavailable',
      cause: 'machine_content_key_unavailable',
    })).toEqual({
      ok: false,
      errorCode: 'session_follow_source_key_preparation_waiting',
      error: 'session_follow_source_key_preparation_waiting',
      details: {
        status: 'waiting',
        reason: 'runner_key_unavailable',
        cause: 'machine_content_key_unavailable',
        edgeCommitted: true,
        source: committed.source,
      },
    });
  });

  it('accepts old waiting results and only bounded content-free diagnostic causes', () => {
    const waiting = { kind: 'waiting', reason: 'runner_unreachable' };
    expect(SessionFollowSourceKeyPreparationResultV1Schema.parse(waiting)).toEqual(waiting);
    const diagnosed = { ...waiting, cause: 'destination_transport_unavailable' };
    expect(SessionFollowSourceKeyPreparationResultV1Schema.parse(diagnosed)).toEqual(diagnosed);
    expect(SessionFollowSourceKeyPreparationResultV1Schema.safeParse({ ...waiting, cause: 'private HTTP response' }).success).toBe(false);
    expect(SessionFollowSourceKeyPreparationResultV1Schema.safeParse({ ...diagnosed, message: 'private HTTP response' }).success).toBe(false);
  });

  it('classifies Runner preparation failures once for every host', () => {
    const rpcError = (rpcErrorCode: string) => Object.assign(new Error(rpcErrorCode), { rpcErrorCode });
    const transportError = (code: string) => Object.assign(new Error(code), { code });

    expect(resolveSessionFollowSourceKeyPreparationFailureV1(rpcError(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE)))
      .toEqual({ kind: 'waiting', reason: 'unsupported', cause: 'rpc_method_unavailable' });
    expect(resolveSessionFollowSourceKeyPreparationFailureV1(transportError('machine_kind_mismatch')))
      .toEqual({ kind: 'not_needed' });
    expect(resolveSessionFollowSourceKeyPreparationFailureV1(transportError('machine_content_key_unavailable')))
      .toEqual({ kind: 'waiting', reason: 'runner_key_unavailable', cause: 'machine_content_key_unavailable' });
    expect(resolveSessionFollowSourceKeyPreparationFailureV1(transportError('machine_content_mode_mismatch')))
      .toEqual({ kind: 'waiting', reason: 'runner_key_unavailable', cause: 'machine_content_mode_mismatch' });
    expect(resolveSessionFollowSourceKeyPreparationFailureV1(transportError('machine_target_not_current')))
      .toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'machine_target_not_current' });
    expect(resolveSessionFollowSourceKeyPreparationFailureV1(rpcError('RPC_TIMEOUT')))
      .toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'machine_rpc_failed' });
    expect(resolveSessionFollowSourceKeyPreparationFailureV1(new Error('socket closed')))
      .toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'machine_rpc_failed' });
    expect(resolveSessionFollowSourceKeyPreparationFailureV1(undefined))
      .toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'machine_rpc_failed' });
  });

  it('classifies the private carrier as internal and server-required for sharing admission', () => {
    expect(RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE).toBe('daemon.sessionFollow.sourceKey.prepare.v1');
    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE)).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'sharing',
      rpcClassification: 'internal_only',
      scope: { accountRequired: true, machineRequired: true, serverRequired: true },
    });
  });
});

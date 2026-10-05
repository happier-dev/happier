import { describe, expect, it } from 'vitest';

import { RPC_METHODS, SESSION_RPC_METHODS } from './methods.js';
import { isSessionActionRpcMethodV1 } from './socket.js';
import {
  CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
} from '../sessions/presentation/currentSessionPresentationV1.js';
import {
  isSocketRpcCurrentSessionPresentationOriginAuthorizationContext,
  parseSocketRpcAuthorizationContext,
  resolveSocketRpcSessionWriteAuthorization,
  resolveSocketRpcSessionWriteAuthorizationMethod,
  resolveSocketRpcSessionAuthorization,
} from './index.js';

/**
 * Lane 05.4 §14: a shared collaborator's Session-owned Run control is admitted by
 * an explicitly named method with an exact required authority, and executes on the
 * Session owner's daemon. The matrix is closed by name: no `execution.run.*` prefix,
 * "run mutation" family, or read projection may inherit write authority.
 */
describe('Session-control RPC write classification', () => {
  it('accepts only the full strict Session Action caller origin', () => {
    const origin = { v: 1, caller: { kind: 'session', sessionId: 'lead', starterDepth: 2, turnDepth: 4 },
      callerPermissionMode: 'read-only', sourceTurnId: 'turn-original', requestId: 'action-original' };
    const authorization = { kind: 'session.action', sessionId: 'report', origin };
    expect(parseSocketRpcAuthorizationContext(authorization)).toEqual(authorization);
    for (const invalidOrigin of [
      { ...origin, v: 2 }, { ...origin, authority: 'present_user' },
      { ...origin, caller: { kind: 'session', sessionId: 'lead' } },
      { ...origin, callerPermissionMode: 'bypassPermissions' },
      { ...origin, sourceTurnId: '' },
    ]) expect(parseSocketRpcAuthorizationContext({ ...authorization, origin: invalidOrigin })).toBeNull();
    expect(parseSocketRpcAuthorizationContext({ ...authorization, extra: true })).toBeNull();
    for (const unrelated of ['roles.create', 'roles.list', 'session.goal.set', 'session.permission.respond']) {
      expect(isSessionActionRpcMethodV1(`report:${unrelated}`)).toBe(false);
    }
    expect(isSessionActionRpcMethodV1('report:session.roles.configuration.set')).toBe(true);
    expect(isSessionActionRpcMethodV1('report:session.notes.set')).toBe(true);
  });
  it('requires input authority for role configuration writes on the owner daemon', () => {
    expect(resolveSocketRpcSessionWriteAuthorization('session-1:session.roles.configuration.set')).toMatchObject({
      authority: 'submitAgentInput', routeToSessionOwnerDaemon: true,
    });
  });
  it('keeps workflow-step withdrawal on the Session owner daemon under owner authority', () => {
    expect(resolveSocketRpcSessionWriteAuthorization('session-1:session.workflowStep.withdraw')).toEqual({
      method: 'session.workflowStep.withdraw',
      authority: 'sessionOwner',
      routeToSessionOwnerDaemon: true,
    });
  });
  it('keeps restored native client custody under Session-owner control authority', () => {
    expect(resolveSocketRpcSessionAuthorization('session-1:session.providerCliAttach.prepare.v1')).toEqual({
      method: 'session.providerCliAttach.prepare.v1', authority: 'sessionOwner', routeToSessionOwnerDaemon: true,
    });
  });
  it('classifies every declared Session RPC through the one closed map', () => {
    for (const method of Object.values(SESSION_RPC_METHODS)) {
      expect(resolveSocketRpcSessionAuthorization(`session-1:${method}`)).toMatchObject({
        method,
        routeToSessionOwnerDaemon: true,
      });
    }
    expect(resolveSocketRpcSessionAuthorization('session-1:session.unlisted')).toBeNull();
  });
  it('admits Run start and explicit resume under submitAgentInput on the owner daemon', () => {
    for (const method of [SESSION_RPC_METHODS.EXECUTION_RUN_START, SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE]) {
      expect(resolveSocketRpcSessionWriteAuthorization(`session-1:${method}`)).toEqual({
        method,
        authority: 'submitAgentInput',
        routeToSessionOwnerDaemon: true,
      });
    }
  });

  it('keeps Run stop owner-only under the canonical stopSession policy', () => {
    expect(resolveSocketRpcSessionWriteAuthorization(`session-1:${SESSION_RPC_METHODS.EXECUTION_RUN_STOP}`)).toEqual({
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
      authority: 'sessionOwner',
      routeToSessionOwnerDaemon: true,
    });
  });

  it('keeps publisher/runtime truth methods owner-only while human steering stays capability-based', () => {
    for (const method of [
      SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1,
      SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION,
      SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT,
      SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS,
      SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION,
    ]) {
      expect(resolveSocketRpcSessionAuthorization(`session-1:${method}`)).toMatchObject({
        authority: 'sessionOwner',
        routeToSessionOwnerDaemon: true,
      });
    }
  });

  it('limits collaborator Run mutations to start, explicit ensure, and the typed legacy send rejection seam', () => {
    for (const method of [
      SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
    ]) {
      expect(resolveSocketRpcSessionWriteAuthorization(`session-1:${method}`)).toMatchObject({
        authority: 'submitAgentInput',
        routeToSessionOwnerDaemon: true,
      });
    }

    const ownerOnlyRuntimeMutations = [
      SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
      SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
      SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
      SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
      SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
      SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1,
      SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1,
      SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
      SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1,
    ];
    for (const method of ownerOnlyRuntimeMutations) {
      expect(resolveSocketRpcSessionWriteAuthorization(`session-1:${method}`)).toMatchObject({
        authority: 'sessionOwner',
        routeToSessionOwnerDaemon: true,
      });
      expect(resolveSocketRpcSessionWriteAuthorizationMethod(`session-1:${method}`)).toBe(method);
    }

    const reads = [
      SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
      SESSION_RPC_METHODS.EXECUTION_RUN_GET,
      SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
    ];
    for (const method of reads) {
      expect(resolveSocketRpcSessionWriteAuthorization(`session-1:${method}`)).toBeNull();
      expect(resolveSocketRpcSessionWriteAuthorizationMethod(`session-1:${method}`)).toBeNull();
      expect(resolveSocketRpcSessionAuthorization(`session-1:${method}`)).toMatchObject({ authority: 'readTranscript' });
    }
  });

  it('preserves the existing write methods and routes them to the caller as before', () => {
    const stop = resolveSocketRpcSessionWriteAuthorization(`session-1:${RPC_METHODS.STOP_SESSION}`);
    expect(stop).toMatchObject({ authority: 'sessionOwner', routeToSessionOwnerDaemon: false });
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(`session-1:${RPC_METHODS.STOP_SESSION}`)).toBe(RPC_METHODS.STOP_SESSION);
  });

  it('keeps the two resolvers describing the same closed matrix', () => {
    for (const method of [
      SESSION_RPC_METHODS.EXECUTION_RUN_START,
      SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
      SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
    ]) {
      expect(resolveSocketRpcSessionWriteAuthorizationMethod(`session-1:${method}`)).toBe(method);
    }
    expect(resolveSocketRpcSessionWriteAuthorization('session-1:execution.run.startle')).toBeNull();
  });

  it('classifies transcript and permission registrations installed beside Session controls', () => {
    for (const method of [
      RPC_METHODS.SESSION_LOG_TAIL,
      RPC_METHODS.TRANSCRIPT_PAGE,
      RPC_METHODS.TRANSCRIPT_READ_AFTER,
      RPC_METHODS.TRANSCRIPT_FOLLOW,
      RPC_METHODS.TRANSCRIPT_UNFOLLOW,
      RPC_METHODS.TRANSCRIPT_SEARCH,
    ]) {
      expect(resolveSocketRpcSessionAuthorization(`session-1:${method}`)).toMatchObject({
        authority: 'readTranscript',
        routeToSessionOwnerDaemon: true,
      });
    }
    expect(resolveSocketRpcSessionAuthorization(`session-1:${RPC_METHODS.TRANSCRIPT_IMPORT}`)).toMatchObject({
      authority: 'submitAgentInput',
      routeToSessionOwnerDaemon: true,
    });
    expect(resolveSocketRpcSessionAuthorization(`session-1:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`)).toMatchObject({
      authority: 'approveRuntimePermissions',
      routeToSessionOwnerDaemon: true,
    });
  });

  it('classifies current-session presentation custody mutations as Session-owner-only', () => {
    for (const method of [
      CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
      CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
      CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
    ]) {
      expect(resolveSocketRpcSessionAuthorization(`session-1:${method}`)).toEqual({
        method,
        authority: 'sessionOwner',
        routeToSessionOwnerDaemon: true,
        serverMintedContext: 'session.presentation.origin',
      });
      expect(resolveSocketRpcSessionWriteAuthorization(`session-1:${method}`)).toEqual({
        method,
        authority: 'sessionOwner',
        routeToSessionOwnerDaemon: true,
        serverMintedContext: 'session.presentation.origin',
      });
    }
  });

  it('keeps presentation origin private to the exact server-minted socket context', () => {
    const origin = {
      kind: 'session.presentation.origin',
      sessionId: 'session-1',
      accountId: 'owner-1',
      connectionId: 'socket-1',
    };
    expect(isSocketRpcCurrentSessionPresentationOriginAuthorizationContext(origin)).toBe(true);
    expect(isSocketRpcCurrentSessionPresentationOriginAuthorizationContext({ ...origin, focused: true })).toBe(false);
    expect(parseSocketRpcAuthorizationContext(origin)).toBeNull();
  });
});

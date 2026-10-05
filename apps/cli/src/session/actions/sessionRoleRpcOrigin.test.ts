import { describe, expect, it } from 'vitest';
import type { ActionExecutorContext } from '@happier-dev/protocol';

import { resolveSessionRoleRpcOrigin } from './sessionRoleRpcOrigin';

const context: ActionExecutorContext = {
  authority: 'account_automation',
  actionCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 2, turnDepth: 3 },
  sessionInputSource: { sourceSessionId: 'caller-session', sourceTurnId: 'original-turn' },
  actionRequestId: 'original-request', callerPermissionMode: 'default', workspaceWrites: 'deny',
};

function expectOriginUnavailable(input: ActionExecutorContext) {
  let failure: unknown;
  try { resolveSessionRoleRpcOrigin(input); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'role_rpc_origin_unavailable' });
}

describe('Session role RPC origin', () => {
  it('fails closed with the typed origin denial for truthy primitive provenance', () => {
    for (const source of ['untrusted-origin', 1, true]) {
      expectOriginUnavailable({ ...context, sessionInputSource: source });
    }
  });

  it('refuses absent provenance and a source from another Session', () => {
    for (const source of [undefined, null, {}, { sourceSessionId: 'foreign-session', sourceTurnId: 'original-turn' }]) {
      expectOriginUnavailable({ ...context, sessionInputSource: source });
    }
    expectOriginUnavailable({ ...context, actionCaller: { kind: 'host' } });
  });

  it('preserves the current strict origin facts and canonical permission aliases', () => {
    expect(resolveSessionRoleRpcOrigin({ ...context, callerPermissionMode: 'acceptEdits' })).toEqual({
      v: 1, caller: { kind: 'session', sessionId: 'caller-session', starterDepth: 2, turnDepth: 3 },
      callerPermissionMode: 'safe-yolo', causalPermissionAuthority: null,
      sourceTurnId: 'original-turn', requestId: 'original-request', workspaceWrites: 'deny',
    });
    expect(resolveSessionRoleRpcOrigin({ ...context, callerPermissionMode: undefined }))
      .toMatchObject({ callerPermissionMode: null });
  });

  it('retains strict rejection of invalid caller, turn, request, permission and causal authority facts', () => {
    expectOriginUnavailable({ ...context, actionCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: -1, turnDepth: 3 } });
    expectOriginUnavailable({ ...context, sessionInputSource: { sourceSessionId: 'caller-session' } });
    expectOriginUnavailable({ ...context, actionRequestId: '' });
    expectOriginUnavailable({ ...context, callerPermissionMode: 'not-a-permission' });
    expectOriginUnavailable({ ...context, causalPermissionAuthority: { v: 1 } });
  });
});

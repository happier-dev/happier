import { describe, expect, it } from 'vitest';
import { AccountApiTokensCreateActionInputV1Schema } from './accountApiTokens.js';
import { API_TOKEN_SOCKET_EVENT_ACTIONS, resolveSocketRpcSessionAuthorization, SESSION_RPC_METHODS } from '../rpc/index.js';
import { API_TOKEN_FULL_GRANT_V1, evaluateApiTokenGrantV1, resolveApiTokenSessionCapabilityCeilingV1 } from './apiTokenGrant.js';

describe('scoped credential public ingress', () => {
  it('accepts a strict creation grant while refusing unknown grant authority', () => {
    const input = {
      tokenId: '11111111-1111-4111-8111-111111111111', label: 'Leads',
      grant: { v: 1, actions: { families: ['messaging'], ids: [] }, targets: { sessions: ['s1'], machines: [] }, approve: false, origins: [], models: null, permissionModes: null, create: null },
    };
    expect(AccountApiTokensCreateActionInputV1Schema.safeParse(input).success).toBe(true);
    expect(AccountApiTokensCreateActionInputV1Schema.safeParse({ ...input, grant: { ...input.grant, presentUser: true } }).success).toBe(false);
  });
  it('requires submitAgentInput and the declared current-turn Action for abort', () => {
    expect(resolveSocketRpcSessionAuthorization('s1:abort')).toMatchObject({ authority: 'submitAgentInput', actionId: 'session.turn.cancel' });
  });
  it('projects the abort-only capability without granting Send or stopping the process', () => {
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.turn.cancel'] } };
    expect(resolveApiTokenSessionCapabilityCeilingV1(grant).has('submitAgentInput')).toBe(true);
    expect(evaluateApiTokenGrantV1({ grant, actionId: 'session.turn.cancel' }).ok).toBe(true);
    expect(evaluateApiTokenGrantV1({ grant, actionId: 'session.message.send' }).ok).toBe(false);
    expect(evaluateApiTokenGrantV1({ grant, actionId: 'session.stop' }).ok).toBe(false);
  });
  it('declares token Actions on the same closed RPC and event authorization owners', () => {
    const rows = [
      [SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, 'session.message.send'],
      [SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION, 'session.model.set'],
      ['permission', 'session.permission.respond'],
      ['session.permission.respond', 'session.permission.respond'],
      ['session.user_action.answer', 'session.user_action.answer'],
      ['transcript.page', 'transcript.page'],
      ['transcript.readAfter', 'transcript.readAfter'],
      ['transcript.follow', 'session.transcript.get'],
      [SESSION_RPC_METHODS.SESSION_WORK_STATE_GET, 'session.work_state.get'],
    ];
    for (const [method, actionId] of rows) expect(resolveSocketRpcSessionAuthorization(`s1:${method}`)?.actionId).toBe(actionId);
    expect(resolveSocketRpcSessionAuthorization(`s1:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`)?.actionId).toBeUndefined();
    expect(API_TOKEN_SOCKET_EVENT_ACTIONS).toEqual({ message: 'session.message.send' });
  });
});

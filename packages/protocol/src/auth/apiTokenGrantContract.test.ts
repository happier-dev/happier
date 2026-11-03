import { describe, expect, it } from 'vitest';
import { AccountApiTokensCreateActionInputV1Schema } from './accountApiTokens.js';
import { API_TOKEN_SOCKET_EVENT_ACTIONS, resolveSocketRpcSessionAuthorization, SESSION_RPC_METHODS } from '../rpc/index.js';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema, StoredApiTokenGrantV1Schema, evaluateApiTokenGrantV1, resolveApiTokenSessionCapabilityCeilingV1 } from './apiTokenGrant.js';

describe('scoped credential public ingress', () => {
  it('preserves exact Automation authority through persisted reads and rejects unknown restrictions', () => {
    const input = AccountApiTokensCreateActionInputV1Schema.parse({
      tokenId: '11111111-1111-4111-8111-111111111111', label: 'Brief',
      grant: { ...API_TOKEN_FULL_GRANT_V1, automationIds: ['brief'] },
    });
    expect(StoredApiTokenGrantV1Schema.parse(JSON.parse(JSON.stringify(input.grant)))).toEqual(input.grant);
    for (const schema of [ApiTokenGrantV1Schema, StoredApiTokenGrantV1Schema]) {
      expect(schema.safeParse({ ...input.grant, otherAutomationRestriction: ['other'] }).success).toBe(false);
      expect(schema.safeParse({ ...input.grant, automationIds: { ids: ['brief'] } }).success).toBe(false);
    }
    expect(StoredApiTokenGrantV1Schema.parse(API_TOKEN_FULL_GRANT_V1)).toEqual(API_TOKEN_FULL_GRANT_V1);
  });
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
  it.each(['session.turn.cancel', 'session.compact'])('projects the %s capability without granting Send or stopping the process', actionId => {
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] } };
    expect(resolveApiTokenSessionCapabilityCeilingV1(grant).has('submitAgentInput')).toBe(true);
    expect(evaluateApiTokenGrantV1({ grant, actionId }).ok).toBe(true);
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

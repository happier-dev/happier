import { describe, expect, it } from 'vitest';
import { AccountApiTokensCreateActionInputV1Schema } from './accountApiTokens.js';
import { API_TOKEN_SOCKET_EVENT_ACTIONS, resolveSocketRpcSessionAuthorization, SESSION_RPC_METHODS } from '../rpc/index.js';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema, StoredApiTokenGrantV1Schema, evaluateApiTokenGrantV1, resolveApiTokenSessionCapabilityCeilingV1 } from './apiTokenGrant.js';
import { ExternalActionApiTokenServerPrincipalV1Schema, ExternalActionCredentialScopeDiagnosticV1Schema, ExternalActionExecutionAuthorizationBindingV1Schema } from '../actions/externalActionApi.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { actionSpecToActionDefinitionV1 } from '../actions/actionCatalog.js';

describe('scoped credential public ingress', () => {
  it('retains closed Environment authority through token creation, stored reads and relay discovery', () => {
    const grant = { ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['deployments.deploy', 'action.operations.get'] },
      targets: { sessions: [], machines: [], environments: ['staging'] },
    };
    const input = AccountApiTokensCreateActionInputV1Schema.parse({
      tokenId: '11111111-1111-4111-8111-111111111111', label: 'CI', grant,
    });
    const tokenAction = getActionSpec('account.apiTokens.create');
    expect(tokenAction.inputSchema.parse(input)).toEqual(input);
    expect(JSON.stringify(actionSpecToActionDefinitionV1(tokenAction).inputSchema)).toContain('"environments"');
    expect(StoredApiTokenGrantV1Schema.parse(JSON.parse(JSON.stringify(input.grant)))).toEqual(grant);
    const principal = { accountId: 'account', principalId: 'account', credentialId: input.tokenId,
      authority: 'account_automation', grant: input.grant };
    expect(ExternalActionApiTokenServerPrincipalV1Schema.parse(principal).grant).toEqual(grant);
    for (const schema of [ApiTokenGrantV1Schema, StoredApiTokenGrantV1Schema]) {
      for (const targets of [
        { ...grant.targets, environments: ['staging', 'staging'] },
        { ...grant.targets, environments: [''] },
        { ...grant.targets, environments: null },
        { ...grant.targets, environments: { ids: ['staging'] } },
        { ...grant.targets, otherEnvironments: ['production'] },
        { sessions: [], machines: [], environments: [] },
      ]) expect(schema.safeParse({ ...grant, targets }).success).toBe(false);
    }
    const historical = StoredApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
      targets: { sessions: [], machines: ['controller'] } });
    expect(evaluateApiTokenGrantV1({ grant: historical, actionId: 'deployments.deploy',
      environmentId: 'staging', target: { kind: 'machine', machineId: 'controller' } }).ok).toBe(false);
  });
  it('binds exact Environment routing metadata only to CI deploy and own-operation reads', () => {
    const binding = { accountId: 'account', principalId: 'account', credentialId: 'token',
      grant: API_TOKEN_FULL_GRANT_V1, serverIdentityId: 'srv_home', machineId: 'controller',
      custodianAccountId: 'account', installationId: 'installed', actionId: 'deployments.deploy',
      requestId: 'deploy', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'controller' }, environmentId: 'staging' };
    expect(ExternalActionExecutionAuthorizationBindingV1Schema.parse(binding)).toEqual(binding);
    expect(ExternalActionExecutionAuthorizationBindingV1Schema.parse({ ...binding, actionId: 'action.operations.get' }).environmentId)
      .toBe('staging');
    for (const environmentId of [null, '', { id: 'staging' }]) {
      expect(ExternalActionExecutionAuthorizationBindingV1Schema.safeParse({ ...binding, environmentId }).success).toBe(false);
    }
    expect(ExternalActionExecutionAuthorizationBindingV1Schema.safeParse({ ...binding, actionId: 'session.message.send' }).success).toBe(false);
    expect(ExternalActionExecutionAuthorizationBindingV1Schema.safeParse({ ...binding, target: { kind: 'session', sessionId: 's1' } }).success).toBe(false);
    expect(ExternalActionCredentialScopeDiagnosticV1Schema.parse({ admissionStage: 'execution_authorization',
      grantReason: 'environment_not_granted' }).grantReason).toBe('environment_not_granted');
  });
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

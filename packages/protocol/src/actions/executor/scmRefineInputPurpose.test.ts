import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1 } from '../../auth/apiTokenGrant.js';
import { ExternalActionExecutionAuthorizationV1Schema } from '../externalActionApi.js';
import { signExternalActionApprovalInputV1 } from '../externalActionExecutionAuthorization.js';
import { bindScmRefineSavedSessionV1, readHostRootInputCredentialActionV1, verifyScmRefineSavedSessionV1 } from './scmRefineInputPurpose.js';
import type { ActionExecutorContext } from './types.js';

describe('Refine root input purpose', () => {
  it.each(['scm.diffSummary.refine', 'scm.diffSummary.addOutputs', 'scm.diffSummary.discuss'] as const)(
    'spends only the saved Session and root input identity without changing requester custody (%s)', actionId => {
    const keys = nacl.sign.keyPair();
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] } };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root', binding: {
      serverIdentityId: 'home', accountId: 'requester', principalId: 'principal', credentialId: 'pat', grant,
      custodianAccountId: 'requester', machineId: 'machine', installationId: 'installation', actionId,
      requestId: 'input', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
    } });
    const currentness = () => Promise.resolve(true);
    Object.defineProperty(root, 'requesterHttpProjection', { value: { isCurrent: currentness } });
    const authorization = bindScmRefineSavedSessionV1({ authorization: root, sessionId: 'saved',
      sign: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
        actionId: args.actionId, target: args.target, input: args.input, privateKey: keys.secretKey }) });
    expect(root.scmRefineSession).toBeUndefined();
    expect(authorization.binding).toBe(root.binding);
    expect(authorization.requesterHttpProjection?.isCurrent).toBe(currentness);
    expect(verifyScmRefineSavedSessionV1(authorization, keys.publicKey)).toBe(true);
    expect(verifyScmRefineSavedSessionV1({ ...authorization, scmRefineSession: {
      ...authorization.scmRefineSession!, sessionId: 'another' } }, keys.publicKey)).toBe(false);
    const context: ActionExecutorContext = { externalActionExecutionAuthorization: authorization,
      externalActionTarget: root.binding.target, actionCaller: { kind: 'host' }, authority: 'account_automation',
      externalActionCredential: { accountId: 'requester', credentialId: 'pat', principalId: 'principal', grant } };
    const input = { sessionId: 'saved', localId: 'input', message: 'Refine',
      recipient: { kind: 'execution_run', runId: 'retained' }, requestedAction: { v: 1, kind: 'send_now' } };
    const read = (value = input, ctx = context, childId = 'session.message.send', hostInternal = true) =>
      readHostRootInputCredentialActionV1(childId, value, ctx, hostInternal);
    expect(read()).toBe(actionId);
    expect(read()).toBe(actionId); // Exact retry keeps Pending's existing identity.
    expect(read({ ...input, sessionId: 'another' })).toBeNull();
    expect(read({ ...input, localId: 'second-input' })).toBeNull();
    expect(read(input, { ...context, externalActionTarget: { kind: 'machine', machineId: 'another' } })).toBeNull();
    if (actionId === 'scm.diffSummary.refine') {
      expect(read({ ...input, requestedAction: { v: 1, kind: 'enqueue' } })).toBeNull();
    } else {
      expect(read({ ...input, requestedAction: { v: 1, kind: 'steer_if_active' } })).toBe(actionId);
    }
    expect(read(input, context, 'session.stop')).toBeNull();
    expect(read(input, context, 'session.message.send', false)).toBeNull();
    expect(read(input, { ...context, externalActionExecutionAuthorization: {
      ...authorization, binding: { ...authorization.binding, actionId: 'scm.diffSummary.generate' } } })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '../externalActionApi.js';
import type { ActionExecutorContext } from './types.js';
import { admitAccountActionInvokeConfirmationV1, recordPresentUserApprovalV1 } from './approvalReview.js';

function consentContext(): ActionExecutorContext {
  const target = { kind: 'machine', machineId: 'machine-local' } as const;
  return {
    surface: 'plugin', authority: 'account_automation', actionCaller: { kind: 'plugin', pluginId: 'acme.parent' },
    runtimeAccountId: 'alice', serverId: 'home', serverIdentityId: 'home', actionRequestId: 'request',
    externalActionTarget: target,
    externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-proof', binding: {
      serverIdentityId: 'home', accountId: 'alice', custodianAccountId: 'alice',
      authentication: { kind: 'account', tokenEpoch: 0 }, installationId: 'installation',
      machineId: target.machineId, actionId: 'action.invoke', requestId: 'request', requestEnvelopeDigest: 'A'.repeat(43), target,
    } }),
    presentUserConfirmation: { actionId: 'action.invoke', requestId: 'request', accountId: 'alice',
      serverId: 'home', target, inputDigest: 'private-fingerprint' },
  };
}

describe('Account consent mismatch diagnostics', () => {
  it.each(['caller', 'authority', 'action'] as const)('distinguishes a failed %s origin comparison from a surface mismatch', changed => {
    const base = consentContext();
    const context: ActionExecutorContext = changed === 'caller' ? { ...base, actionCaller: { kind: 'host' } }
      : changed === 'authority' ? { ...base, authority: 'present_user' }
        : { ...base, presentUserConfirmation: { ...base.presentUserConfirmation!, actionId: 'execution.run.start' } };
    expect(admitAccountActionInvokeConfirmationV1({}, context, 'private-fingerprint'))
      .toEqual({ admitted: false, mismatch: { field: changed === 'authority' ? 'binding' : 'child_proof' } });
  });

  it.each(['account', 'binding', 'fingerprint_source', 'surface', 'child_proof'] as const)(
    'names only the failed %s comparison', field => {
      let context = consentContext();
      if (field === 'account') context = { ...context, runtimeAccountId: 'private-other-account' };
      if (field === 'binding') context = { ...context, actionRequestId: 'private-other-request' };
      if (field === 'surface') context = { ...context, surface: 'agent' };
      if (field === 'child_proof') context = { ...context, actionCaller: { kind: 'host' }, presentUserConfirmation: undefined };
      const result = admitAccountActionInvokeConfirmationV1({}, context,
        field === 'fingerprint_source' ? 'private-other-fingerprint' : 'private-fingerprint');
      expect(result).toEqual({ admitted: false, mismatch: { field } });
    },
  );

  it('consumes exact consent once and identifies reuse without widening authority', () => {
    const context = consentContext();
    expect(admitAccountActionInvokeConfirmationV1({}, context, 'private-fingerprint')).toEqual({ admitted: true });
    expect(admitAccountActionInvokeConfirmationV1({}, context, 'private-fingerprint'))
      .toEqual({ admitted: false, mismatch: { field: 'child_proof' } });
    expect(context.authority).toBe('account_automation');
  });

  it('retains the admitted host review path and diagnoses its actual comparison', () => {
    const input = { expectedContributorOccurrenceId: 'selected-occurrence' };
    const context: ActionExecutorContext = { ...consentContext(), surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, presentUserConfirmation: undefined,
      presentUserApproval: recordPresentUserApprovalV1({ actionId: 'action.invoke', input,
        requestId: 'request', decidingAccountId: 'alice' }) };
    expect(admitAccountActionInvokeConfirmationV1({ ...input, changed: true }, context, null))
      .toEqual({ admitted: false, mismatch: { field: 'fingerprint_source' } });
    expect(admitAccountActionInvokeConfirmationV1(input, context, null)).toEqual({ admitted: true });
    expect(admitAccountActionInvokeConfirmationV1(input, context, null))
      .toEqual({ admitted: false, mismatch: { field: 'child_proof' } });
  });
});

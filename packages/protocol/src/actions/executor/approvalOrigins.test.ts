import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ApprovalExecutionOriginV1Schema, ApprovalRequestV2Schema } from '../../approvals/approvalRequestV1.js';
import type { ActionExecutorContext } from './types.js';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1 } from '../externalActionExecutionAuthorization.js';
import { buildApprovalExecutionOriginV1, isPresentUserApprovalDecisionForOrigin } from './approvalOrigins.js';
import { projectDeploymentPreparationAdmissionV1 } from '../../deployments/deploymentPreparationAdmissionV1.js';
import { buildMachineSetupTargetApplyInput } from '../../machines/managed/actionsV1.js';

it.each([
  { surface: 'voice', authority: 'present_user', expectedSurface: 'voice' },
  { surface: 'voice', authority: 'account_automation', expectedSurface: 'ui' },
  { surface: 'agent', authority: 'account_automation', expectedSurface: 'ui' },
  { surface: 'mcp', authority: 'account_automation', expectedSurface: 'ui' },
] as const)('retains signed Account $surface/$authority provenance in a required approval', ({ surface, authority, expectedSurface }) => {
  const actionId = 'machines.setup.apply' as const;
  const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const input = { homeId: 'home', machineId: 'machine', targets: [{ homeId: 'home', machineId: 'machine',
    desiredRevision: 0, recipePlans: [], sources: [{ kind: 'direct', setup: {} }] }] };
  const authorization = { v: 1 as const, token: 'verified-at-ingress', binding: {
    serverIdentityId: 'home', accountId: 'account', authentication: { kind: 'account' as const, tokenEpoch: 0 },
    accountEncryptionMode: 'plain' as const, machineId: 'machine', actionId, requestId: 'request', custodianAccountId: 'account',
    installationId: 'installation', requestEnvelopeDigest: 'd'.repeat(43), target,
  } };
  const origin = buildApprovalExecutionOriginV1({ actionId, input, targetSessionId: null, context: {
    surface, authority, actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'account',
    actionRequestId: 'request', externalActionTarget: target, externalActionExecutionAuthorization: authorization,
    signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
      actionId: args.actionId, target: args.target, input: args.input, privateKey: keys.secretKey }),
  } });
  expect(origin).toMatchObject({ surface: expectedSurface, authority, caller: { kind: 'host' },
    accountId: 'account', machineId: 'machine', actionId, requestId: 'request' });
  expect(ApprovalRequestV2Schema.safeParse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'system' }, requestedSurface: surface, actionId, actionArgs: input, summary: 'Install reviewed setup',
    approval: { flow: 'deferred', result: 'required' }, executionOriginV1: origin }).success).toBe(true);
  if (surface === 'voice' && authority === 'present_user') {
    if (!origin) throw new Error('Missing exact signed Voice origin');
    expect(ApprovalExecutionOriginV1Schema.safeParse({ ...origin, authority: 'account_automation' }).success).toBe(false);
    expect(ApprovalExecutionOriginV1Schema.safeParse({ ...origin, accountId: 'another-account' }).success).toBe(false);
    expect(ApprovalExecutionOriginV1Schema.safeParse({ ...origin, externalActionExecutionAuthorization: {
      ...authorization, binding: { ...authorization.binding, authentication: { kind: 'terminal', tokenEpoch: 0 } },
    } }).success).toBe(false);
  }
});

describe('reviewed Discussion Account read authority', () => {
  it('requires the signed approve decision for this Artifact, Home, Account and Machine', () => {
    const artifactId = 'reviewed-artifact';
    const origin = ApprovalExecutionOriginV1Schema.parse({ v: 1, authority: 'account_automation', surface: 'agent',
      caller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 },
      serverId: 'home', serverIdentityId: 'home', accountId: 'account', machineId: 'machine',
      sessionId: 'session', actionId: 'discussion.post', requestId: 'original-post' });
    const binding = { serverIdentityId: 'home', accountId: 'account',
      authentication: { kind: 'account' as const, tokenEpoch: 0 },
      machineId: 'machine', actionId: 'approval.request.decide' as const, requestId: 'decision',
      custodianAccountId: 'account', installationId: 'installation', requestEnvelopeDigest: 'd'.repeat(43),
      target: { kind: 'machine' as const, machineId: 'machine' },
      approvalDecisionAdmission: { artifactId, decision: 'approve' as const } };
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      externalActionExecutionAuthorization: { v: 1, token: 'verified-at-ingress', binding } };
    expect(isPresentUserApprovalDecisionForOrigin({ context, artifactId, origin })).toBe(true);
    const deniedBindings = [
      { ...binding, approvalDecisionAdmission: undefined },
      { ...binding, approvalDecisionAdmission: { artifactId: 'another-artifact', decision: 'approve' as const } },
      { ...binding, approvalDecisionAdmission: { artifactId, decision: 'reject' as const } },
      { ...binding, approvalDecisionAdmission: { artifactId, decision: 'cancel' as const } },
      { ...binding, serverIdentityId: 'another-home' },
      { ...binding, accountId: 'another-account' },
      { ...binding, machineId: 'another-machine' },
      { ...binding, actionId: 'discussion.post' as const },
    ];
    for (const denied of deniedBindings) expect(isPresentUserApprovalDecisionForOrigin({ artifactId, origin,
      context: { ...context, externalActionExecutionAuthorization: { v: 1, token: 'verified-at-ingress', binding: denied } },
    })).toBe(false);
    for (const denied of [
      { ...context, authority: 'account_automation' as const },
      { ...context, surface: 'agent' as const },
      { ...context, actionCaller: origin.caller },
    ]) expect(isPresentUserApprovalDecisionForOrigin({ context: denied, artifactId, origin })).toBe(false);
  });
});

describe('reviewed native root approval origin', () => {
  const template = { serverId: 'home', projectSourceId: 'source', machineId: 'machine',
    environment: { kind: 'create', requestKey: 'create', protection: 'nonProduction', purpose: 'standard',
      deployerMode: 'managers', controllerMachineId: 'machine' }, target: { kind: 'new', installationId: 'installation' } };
  it.each([
    { actionId: 'deployments.deploy', input: { environmentId: 'staging' }, retained: false },
    { actionId: 'deployments.templates.instantiate', input: { ...template, mode: 'apply', deploy: { requestKey: 'deploy' } }, retained: true },
    { actionId: 'deployments.templates.instantiate', input: { ...template, mode: 'preview' }, retained: false },
    { actionId: 'deployments.templates.instantiate', input: { ...template, mode: 'apply' }, retained: false },
    { actionId: 'deployments.environments.create', input: { serverId: 'home', projectSourceId: 'source', requestKey: 'create',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', definition: { from: 'catalogApp',
        templateRef: { sourceId: 'apps', itemId: 'web', version: '1', ref: { kind: 'content', digest: `sha256:${'c'.repeat(64)}` } } } }, retained: true },
  ] as const)('retains admitted deployment root custody for $actionId, retained=$retained', ({ actionId, input, retained }) => {
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const envelope = { v: 1 as const, requestId: 'deployment-request', target, input };
    const authorization = { v: 1 as const, token: 'verified-at-ingress', binding: {
      serverIdentityId: 'home', accountId: 'account', authentication: { kind: 'account' as const, tokenEpoch: 0 },
      accountEncryptionMode: 'plain' as const, machineId: 'machine', actionId, requestId: envelope.requestId,
      custodianAccountId: 'account', installationId: 'installation', target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input),
      ...(retained ? { deploymentChildRoot: true as const } : {}),
    } };
    const origin = buildApprovalExecutionOriginV1({ actionId, input, targetSessionId: null, context: {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
      runtimeAccountId: 'account', actionRequestId: envelope.requestId, originalActionEnvelope: envelope,
      externalActionExecutionAuthorization: authorization, externalActionTarget: target,
      signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
        actionId: args.actionId, target: args.target, input: args.input, privateKey: keys.secretKey }),
    } });
    expect(origin).not.toBeNull();
    expect(origin?.originalActionEnvelope).toEqual(retained ? envelope : undefined);
  });

  it('signs the transported input when native preparation retains an omitted optional member', () => {
    const actionId = 'machines.setup.plan' as const;
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const input = { homeId: 'home', machineId: 'machine', sources: undefined };
    const authorization = { v: 1 as const, token: 'verified-at-ingress', binding: {
      serverIdentityId: 'home', accountId: 'account', authentication: { kind: 'account' as const, tokenEpoch: 0 },
      accountEncryptionMode: 'plain' as const, machineId: 'machine', actionId, requestId: 'request', custodianAccountId: 'account',
      installationId: 'installation', requestEnvelopeDigest: 'd'.repeat(43), target,
    } };
    const origin = buildApprovalExecutionOriginV1({ actionId, input, targetSessionId: null, context: {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
      runtimeAccountId: 'account', actionRequestId: 'request', externalActionTarget: target,
      externalActionExecutionAuthorization: authorization,
      signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
        actionId: args.actionId, target: args.target, input: args.input, privateKey: keys.secretKey }),
    } });
    expect(origin?.externalActionInputSignature).toBeDefined();
    expect(verifyExternalActionApprovalInputV1({ authorizationToken: authorization.token, actionId, target,
      input: JSON.parse(JSON.stringify(input)), publicKey: keys.publicKey,
      signature: origin!.externalActionInputSignature! })).toBe(true);
  });

  it.each(['machines.setup.plan', 'machines.setup.apply', 'machines.setup.remove', 'action.operations.cancel'] as const)(
    'retains the exact signed %s envelope so replay can reopen its reviewed effect', actionId => {
      const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
      const target = { kind: 'machine' as const, machineId: 'machine' };
      const envelope = { v: 1 as const, requestId: 'setup-request', target, input: actionId === 'action.operations.cancel'
        ? { serverId: 'home', machineId: 'machine', operationId: 'retained-operation' }
        : actionId === 'machines.setup.apply'
          ? buildMachineSetupTargetApplyInput({ homeId: 'home', machineId: 'machine', desiredRevision: 0,
            recipePlans: [], sources: [{ kind: 'direct', setup: {} }] })
          : { homeId: 'home', machineId: 'machine' } };
      const binding = { serverIdentityId: 'home', accountId: 'account', authentication: { kind: 'account' as const, tokenEpoch: 0 },
        accountEncryptionMode: 'plain' as const, machineId: 'machine', actionId, requestId: envelope.requestId, custodianAccountId: 'account',
        installationId: 'installation', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target,
        deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, envelope.input) };
      const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: 'home', runtimeAccountId: 'account', actionRequestId: envelope.requestId, originalActionEnvelope: envelope,
        externalActionExecutionAuthorization: { v: 1, token: 'verified-at-ingress', binding }, externalActionTarget: target,
        signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
          actionId: args.actionId, target: args.target, input: args.input, privateKey: keys.secretKey }) };
      expect(buildApprovalExecutionOriginV1({ actionId, input: envelope.input, targetSessionId: null, context }))
        .toMatchObject({ actionId, requestId: envelope.requestId, originalActionEnvelope: envelope });
    });
});

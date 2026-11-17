import axios, { AxiosHeaders } from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import * as machineTransport from '@/session/transport/rpc/machineRpc';
import { createApprovalRequestArtifact } from '@happier-dev/protocol/approvals/creation';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/methodsV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionResponseEnvelopeV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';

afterEach(() => vi.restoreAllMocks());
it('approves exact held remembered consent without re-authoring its origin or issuing a second prepare', async () => {
  const homeId = 'srv_consent_home';
  const workspace = { serverId: homeId, machineId: 'machine', workspaceId: 'checkout', rootPath: '/repo' };
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
  const target = { kind: 'machine' as const, machineId: workspace.machineId };
  const setupReview = { kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const,
    reviewedEffectDigest: 'reviewed', reviewedEffect: { commands: ['printf setup'] } };
  const held = { version: 1 as const, operationId: 'held', revision: 2, actionId: 'projects.prepare',
    scope: { accountId: 'owner', machineId: 'machine' }, state: 'accepted' as const, title: 'Set up a project',
    createdAt: 1, cancellation: 'supported' as const, setupReview,
    domainRef: { kind: 'projectCommand' as const, purpose: 'setup' as const, serverId: homeId,
      machineId: 'machine', workspaceRefId: 'checkout', cwd: '/repo', sourceWorkspace: workspace } };
  const artifacts = new Map<string, { header: Readonly<Record<string, unknown>>; body: string; access: string }>();
  let trust: unknown = null;
  const currentOperation = () => trust ? { ...held, revision: 3, setupReview: undefined } : held;
  const inspection = ProjectDefinitionInspectOutputSchema.parse({ definition: { basis: { kind: 'absent' }, document: null },
    detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] },
    importCandidates: [], setupReview: { reviewedEffectDigest: setupReview.reviewedEffectDigest, reviewedEffect: setupReview.reviewedEffect } });
  const reply = (data: unknown) => ({ status: 200, data, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
  const settings = normalizeActionsSettingsV1({ v: 1, actions: { 'projects.prepare': { approvalRequiredSurfaces: ['cli'] } } });
  const owner = createCliActionExecutorHarness({ token, credentials, serverId: homeId, serverIdentityId: homeId,
    serverHttpBaseUrl: 'https://home.test', sessionId: 'cli-global', mode: 'plain', ctx: null,
    externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation' }, {
    // Authenticated persistence and Home currentness are substituted boundaries;
    // approval creation, transitions, conflict comparison, replay and CLI deps are real.
    approvalsCreate: ({ request }) => createApprovalRequestArtifact({ request, accountId: 'owner', newId: () => 'unused',
      read: async id => artifacts.get(id) ?? null,
      create: async (id, header, body) => { artifacts.set(id, { header, body, access: 'owner' }); } }),
    approvalsGet: async ({ artifactId }) => { const row = artifacts.get(artifactId); return row ? ApprovalRequestV2Schema.parse(JSON.parse(row.body)) : null; },
    approvalsUpdate: async ({ artifactId, request, expectedStatus }) => {
      const row = artifacts.get(artifactId); if (!row) throw new Error('Missing captured approval');
      const transition = decideApprovalRequestTransition(ApprovalRequestV2Schema.parse(JSON.parse(row.body)), request, { expectedStatus });
      if (!transition.ok) return transition;
      artifacts.set(artifactId, { header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request), access: 'owner' });
      return { ok: true };
    },
    isApprovalExecutionOriginCurrent: async () => true,
    readActionsSettings: () => settings,
  }).executor;
  const signedContext = (input: unknown, requestId: string, authorization?: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>): ActionExecutorContext => ({
    surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'owner',
    serverId: homeId, serverIdentityId: homeId, actionRequestId: requestId, externalActionTarget: target,
    externalActionExecutionAuthorization: authorization ?? ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-admission', binding: {
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: homeId,
      machineId: 'machine', installationId: 'installation', actionId: 'projects.prepare', requestId, target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input }),
    } }),
    signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
      actionId: args.actionId, input: args.input, target: args.target, privateKey: keys.secretKey }),
  });
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    expect(new URL(request.url!).pathname).toBe(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1);
    return reply(ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }));
  });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/encryption')) return reply({ mode: 'plain', updatedAt: 1 });
    if (url.endsWith('/v1/machines/machine')) return reply({ machine: { id: 'machine', kind: 'persistent', active: true,
      installationId: 'installation', installationPublicKey: Buffer.from(keys.publicKey).toString('base64'), revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } });
    throw new Error(`Unexpected Home read ${url}`);
  });
  let reauthoredPrepare = false;
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (url.endsWith('/v1/account/project-trust/read')) return reply({ status: 'absent' });
    if (url.endsWith('/v1/account/project-trust/mutate')) {
      const mutation = body as { content?: unknown }; trust = mutation.content;
      return reply({ status: 'updated', revision: 1, cursor: 1 });
    }
    if (url.endsWith('/v1/account/project-rows/read')) {
      const key = { kind: 'workspace-ref', serverId: homeId, id: 'checkout' };
      return reply({ status: 'present', row: { key, revision: 1, content: { t: 'plain', v: { key, value: {
        id: 'checkout', serverId: homeId, machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 } } } } });
    }
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
    const { envelope } = request;
    if (url.endsWith(bindExternalActionExecutionAuthorizationHttpPathV1('projects.prepare'))) return reply(
      ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fresh-replay-admission', binding: {
        accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: homeId,
        accountEncryptionMode: 'plain', machineId: 'machine', installationId: 'installation', actionId: 'projects.prepare',
        requestId: envelope.requestId, target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } }));
    expect(url).toBe('https://home.test/v1/actions/projects.prepare');
    reauthoredPrepare = true;
    const execution = await owner.execute('projects.prepare', envelope.input,
      signedContext(envelope.input, envelope.requestId, request.executionAuthorization));
    return reply(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.prepare', requestId: envelope.requestId, execution }));
  });
  vi.spyOn(machineTransport, 'callExactMachineRpc').mockImplementation(async ({ method }) => {
    if (method === 'daemon.projects.inspect.v1') return inspection;
    if (method === ACTION_OPERATION_RPC_METHODS_V2.get) return { kind: 'found', operation: currentOperation() };
    if (method === 'daemon.projects.prepare.v1') return { operation: currentOperation() };
    throw new Error(`Unexpected Machine read ${method}`);
  });
  const approve = (artifactId: string) => owner.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
    surface: 'cli', authority: 'present_user', runtimeAccountId: 'owner', serverId: homeId, serverIdentityId: homeId, actionRequestId: 'decision' });
  const initial = { workspace, phase: 'setup' };
  const control = await owner.execute('projects.prepare', initial, signedContext(initial, 'initial'));
  expect(control, JSON.stringify(control)).toMatchObject({ ok: true });
  if (!control.ok) throw new Error('Control request unavailable');
  const first = ActionApprovalRequestCreatedResultSchema.parse(control.result);
  const firstDecision = await approve(first.artifactId);
  expect(firstDecision, JSON.stringify(firstDecision)).toMatchObject({ ok: true, result: { execution: { ok: true, result: { operation: { operationId: 'held', setupReview } } } } });
  const input = { workspace, phase: 'setup', consentScope: 'untilChanged', expectedEffectDigest: 'reviewed', heldOperationId: 'held' };
  const replay = await owner.execute('projects.prepare', input, signedContext(input, 'consented'));
  expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true });
  if (!replay.ok) throw new Error('Consent request unavailable');
  const pending = ActionApprovalRequestCreatedResultSchema.parse(replay.result);
  const captured = ApprovalRequestV2Schema.parse(JSON.parse(artifacts.get(pending.artifactId)!.body));
  expect(await owner.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' }, {
    surface: 'agent', authority: 'account_automation', runtimeAccountId: 'owner', serverId: homeId,
    serverIdentityId: homeId, actionCaller: { kind: 'host' }, actionRequestId: 'automation-decision',
  })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
  expect(trust).toBe(null);
  const result = await approve(pending.artifactId);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { execution: { ok: true, result: { operation: { operationId: 'held' } } } } });
  expect(trust).toMatchObject({ t: 'plain', v: { project: { serverId: homeId, projectId: 'project' }, reviewedEffectDigest: 'reviewed' } });
  expect(reauthoredPrepare).toBe(false);
  expect(ApprovalRequestV2Schema.parse(JSON.parse(artifacts.get(pending.artifactId)!.body)).executionOriginV1).toEqual(captured.executionOriginV1);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import * as machineTransport from '@/session/transport/rpc/machineRpc';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import axios, { AxiosHeaders } from 'axios';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineBootstrapV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import nacl from 'tweetnacl';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';

afterEach(() => vi.restoreAllMocks());
const workspace = { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' };
const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4));
const signedTransport = { externalActionMachineRequestPrivateKey: installation.secretKey,
  externalActionMachineInstallationId: 'source-installation', serverIdentityId: 'srv_finite_home' };
// These tests cover the already Home-admitted signed sender, not original
// Account ingress (whose real bearer and HTTP boundary have a separate suite).
function signedContext(actionId: string, input: unknown, context: ActionExecutorContext = {}): ActionExecutorContext {
  const value = input as Readonly<{ choice?: Readonly<{ kind?: string; destination?: Readonly<{ machineId?: string }> }> }>;
  const machineId = value.choice?.destination?.machineId ?? workspace.machineId;
  const target = context.externalActionTarget ?? { kind: 'machine' as const, machineId };
  const actionRequestId = context.actionRequestId ?? 'signed-finite-request';
  return { ...context, actionRequestId, externalActionTarget: target,
    externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-origin', binding: {
      accountId: 'requester', custodianAccountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'srv_finite_home',
      machineId, installationId: 'target-installation', actionId, requestId: actionRequestId,
      target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: actionRequestId, target, input })),
    } }) };
}
function executor() {
  const token = 'requester-token';
  const owner = createCliActionExecutorHarness({ token, credentials: { token, encryption: null }, ...signedTransport,
    sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.test' }).executor;
  return { execute: (...[actionId, input, context]: Parameters<typeof owner.execute>) =>
    owner.execute(actionId, input, signedContext(actionId, input, context)) };
}
describe('Project finite Actions through exact Machine transport', () => {
  it('retains the admitted signed origin’s deferred approval instead of rejecting it as a native output', async () => {
    const receipt = { kind: 'approval_request_created' as const, artifactId: 'target-finite-ask', actionId: 'projects.prepare' };
    vi.spyOn(machineTransport, 'callExactMachineRpc').mockResolvedValue(receipt);
    expect(await executor().execute('projects.prepare', { workspace, phase: 'setup' }, {
      surface: 'agent', authority: 'account_automation', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'projects.prepare': ['agent'] } }),
    })).toEqual({ ok: true, result: receipt });
  });
  it('retains a confirmed finite operation receipt when cancellation occurs while consuming the response', async () => {
    const controller = new AbortController();
    const receipt = ProjectCommandActionOutputV1Schema.parse({ operation: {
      version: 1, operationId: 'accepted-command', actionId: 'projects.compute.exec', requestId: 'original-command-request',
      scope: { accountId: 'requester', machineId: 'selected-worker' }, state: 'accepted', revision: 1,
      createdAt: 1, title: 'Command', progress: { kind: 'indeterminate' }, cancellation: 'supported',
      domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home', machineId: 'selected-worker',
        workspaceRefId: 'worker-copy', cwd: '/worker-repo' },
    } });
    const boundary = vi.spyOn(machineTransport, 'callExactMachineRpc').mockImplementation(async () => {
      controller.abort();
      return receipt;
    });
    // Exact ad-hoc placement needs no SOURCE declaration reads. A signed
    // worker root cannot be reused to authorize projects.inspect on SOURCE.
    const input = { workspace, executable: 'make', argv: ['build'], cwd: '/repo',
      choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'selected-worker' } } };
    expect(await executor().execute('projects.compute.exec', input, {
      surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'projects.compute.exec' },
      signal: controller.signal, actionRequestId: 'original-command-request',
    })).toEqual({ ok: true, result: receipt });
    expect(boundary).toHaveBeenCalledTimes(1);
    expect(boundary).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'selected-worker',
      method: 'daemon.projects.compute.exec.v1', request: input, requestId: 'original-command-request' }));
  });

  it('executes the configurable policy before carrying the unchanged input and original request identity to the exact Machine', async () => {
    const pending = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
    const boundary = vi.spyOn(machineTransport, 'callExactMachineRpc').mockResolvedValue(pending);
    const input = { workspace, phase: 'setup' as const, expectedEffectDigest: 'reviewed' };
    const owner = executor();
    expect(await owner.execute('projects.prepare', input, { surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: false });
    expect(boundary).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    expect(await owner.execute('projects.prepare', input, { surface: 'agent', authority: 'account_automation', signal,
      actionRequestId: 'original-invocation', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'projects.prepare': ['agent'] } }) })).toEqual({ ok: true, result: pending });
    expect(boundary).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', method: 'daemon.projects.prepare.v1',
      request: input, requestId: 'original-invocation', signal, authorityCeiling: 'account_automation' }));
  });
  it('refuses another Home, unsupported output and grants hidden in the semantic input', async () => {
    const boundary = vi.spyOn(machineTransport, 'callExactMachineRpc').mockResolvedValue({ kind: 'prepared' });
    const owner = executor();
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'projects.prepare': ['agent'] } }) };
    expect(await owner.execute('projects.prepare', { workspace: { ...workspace, serverId: 'other' }, phase: 'setup' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(boundary).not.toHaveBeenCalled();
    expect(await owner.execute('projects.prepare', { workspace, phase: 'setup', grant: true }, context)).toMatchObject({ ok: false });
    expect(boundary).not.toHaveBeenCalled();
    expect(await owner.execute('projects.prepare', { workspace, phase: 'setup' }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });
  it('preserves the actual typed human-consent failure before validating successful output', async () => {
    const failure = { ok: false, errorCode: 'project_setup_consent_required', error: 'project_setup_consent_required',
      details: { kind: 'pendingApproval', code: 'project_setup_consent_required',
        reviewedEffect: { commands: [] }, reviewedEffectDigest: 'reviewed' } };
    vi.spyOn(machineTransport, 'callExactMachineRpc').mockResolvedValue(failure);
    expect(await executor().execute('projects.prepare', { workspace, phase: 'setup' }, {
      surface: 'agent', authority: 'account_automation', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'projects.prepare': ['agent'] } }),
    })).toEqual(failure);
  });
  it('preserves exact native selection and revision-qualified value-free ad-hoc bindings', async () => {
    const pending = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
    const boundary = vi.spyOn(machineTransport, 'callExactMachineRpc').mockResolvedValue(pending);
    const owner = executor();
    const choice = { kind: 'workers', destination: { kind: 'machine', machineId: 'selected-worker' } } as const;
    const memoryDemand = { bytes: 4096, basis: { kind: 'declared' } } as const;
    const script = { workspace, selection: { kind: 'native', source: { kind: 'native', tool: 'package_script',
      file: 'package.json', target: 'test' } }, choice: { kind: 'primary' }, expectedEffectDigest: 'reviewed', memoryDemand } as const;
    const compute = { workspace, executable: '/usr/bin/tool', argv: ['arg with spaces', ''], cwd: '/repo/subdir', choice,
      memoryDemand, environmentBindings: { v: 1, bindings: { API_KEY: { ref: 'happier:shared-secret:v1:shared', revision: 2 } } } } as const;
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
        'projects.script.run': ['agent'], 'projects.compute.exec': ['agent'],
      } }) };
    expect(await owner.execute('projects.script.run', script, context)).toEqual({ ok: true, result: pending });
    expect(boundary).toHaveBeenLastCalledWith(expect.objectContaining({ machineId: workspace.machineId,
      method: 'daemon.projects.script.run.v1', request: script }));
    expect(await owner.execute('projects.compute.exec', compute, context)).toEqual({ ok: true, result: pending });
    expect(boundary).toHaveBeenLastCalledWith(expect.objectContaining({ machineId: 'selected-worker',
      method: 'daemon.projects.compute.exec.v1', request: compute }));
    boundary.mockRejectedValueOnce(new machineTransport.MachineRpcTargetNotCurrentError('selected-worker'));
    expect(await owner.execute('projects.compute.exec', compute, { ...context, actionRequestId: 'original-worker-invocation' }))
      .toMatchObject({ ok: false, errorCode: 'action_failed' });
    expect(boundary).toHaveBeenLastCalledWith(expect.objectContaining({ machineId: 'selected-worker',
      request: compute, requestId: 'original-worker-invocation' }));
    expect(boundary.mock.calls.filter(([call]) => call.method === 'daemon.projects.compute.exec.v1')
      .map(([call]) => call.machineId)).not.toContain(workspace.machineId);
    boundary.mockClear();
    expect(await owner.execute('projects.compute.exec', compute, { ...context,
      externalActionTarget: { kind: 'machine', machineId: workspace.machineId },
    })).toMatchObject({ ok: false, errorCode: 'target_not_local' });
    expect(boundary).not.toHaveBeenCalled();
    expect(await owner.execute('projects.compute.exec', { ...compute, environmentBindings: { v: 1,
      bindings: { API_KEY: { ref: 'happier:shared-secret:v1:shared' } } } }, context)).toMatchObject({ ok: false });
    expect(boundary).not.toHaveBeenCalled();
  });

  it.each(['machine', 'pool'] as const)('routes saved %s placement through the real captured Home owner without changing SOURCE intent or falling back', async kind => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 1,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const poolId = '10000000-0000-4000-8000-000000000001';
    const destination = kind === 'machine'
      ? { kind: 'machine' as const, machineId: 'selected-worker' }
      : { kind: 'pool' as const, poolId, selection: 'automatic' as const };
    const memoryDemand = { bytes: 8192, basis: { kind: 'declared' as const } };
    const bytes = JSON.stringify({ version: 1, workspace: { memoryDemand }, scripts: {
      check: { execution: 'portable', source: { kind: 'command', command: 'echo checked' } },
    } });
    const inspection = ProjectDefinitionInspectOutputSchema.parse({
      definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: readProjectManifestDocument(bytes) },
      detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] },
      importCandidates: [],
    });
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'projects.script.run': ['cli'] } });
    const context = { surface: 'cli' as const, actionRequestId: 'original-placement-invocation' };
    let available = true;
    const reply = (data: unknown) => ({ status: 200, data, statusText: 'OK', headers: {},
      config: { headers: new AxiosHeaders() } });
    // Only the captured Home HTTP and exact Machine RPC are substituted. The
    // Action frontdoor, row codecs, precedence and finite pool selector are real.
    const home = vi.spyOn(axios, 'request').mockImplementation(async request => {
      expect(request.url).toMatch(/^https:\/\/home\.test\//);
      expect(request.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      if (request.url?.endsWith('/v1/account/encryption')) return reply({ mode: 'plain', updatedAt: 1 });
      if (request.url?.endsWith('/v1/projects/execution/config/read')) return reply({
        status: 'present', revision: 1, content: { t: 'plain', v: { enabled: true, destination,
          unavailable: 'ask', allowAdHoc: false, scriptOverrides: {}, services: {} } },
      });
      if (request.url?.endsWith('/v1/machines/pools/get')) return reply({
        pool: { id: poolId, name: 'Workers', description: null, revision: 1, createdAt: 1, updatedAt: 1,
          members: [{ machineId: 'ineligible-first-member', priorityTier: 0, enabled: true, state: 'connected' },
            { machineId: 'selected-worker', priorityTier: 0, enabled: true, state: 'connected' }] },
        availability: { state: 'known', connectedCount: 2, enabledCount: 2 },
      });
      throw new Error(`Unexpected captured Home request: ${request.url}`);
    });
    const pending = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
    const installed = ExternalActionMachineBootstrapV1Schema.parse({ id: 'selected-worker', installationId: 'selected-installation',
      kind: 'persistent', active: false, revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'requester', displayName: 'Requester' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return reply({ mode: 'plain', updatedAt: 1 });
      if (url.endsWith('/v1/machines/selected-worker')) return reply({ machine: installed });
      if (url.endsWith('/v1/machines')) return reply([installed]);
      throw new Error(`Unexpected captured Home inventory request: ${url}`);
    });
    const posts = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(request.machineId).toBe(installed.id);
      expect(request.envelope).toEqual({ v: 1, requestId: context.actionRequestId, target: { kind: 'machine', machineId: installed.id }, input });
      if (url === `https://home.test${bindExternalActionExecutionAuthorizationHttpPathV1('projects.script.run')}`) return reply(
        ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-finite-authorization', binding: {
          accountId: 'requester', custodianAccountId: 'requester', authentication: { kind: 'terminal', tokenEpoch: 1 },
          serverIdentityId: 'srv_finite_home', machineId: installed.id, installationId: installed.installationId,
          accountEncryptionMode: 'plain', actionId: 'projects.script.run', requestId: context.actionRequestId,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target: request.envelope.target,
        } }));
      expect(url).toBe('https://home.test/v1/actions/projects.script.run');
      expect(request.executionAuthorization?.binding).toMatchObject({ machineId: installed.id, installationId: installed.installationId,
        requestId: context.actionRequestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) });
      return reply({ v: 1, actionId: 'projects.script.run', requestId: context.actionRequestId, execution: { ok: true, result: pending } });
    });
    const transport = vi.spyOn(machineTransport, 'callExactMachineRpc').mockImplementation(async request => {
      if (request.method === getActionSpec('projects.inspect').bindings?.rpcMethod) {
        expect(request.machineId).toBe(workspace.machineId);
        return inspection;
      }
      if (request.method === getActionSpec('projects.worker.status').bindings?.rpcMethod) {
        expect(request.request).toMatchObject({ workspace: { serverId: 'home', refId: workspace.workspaceId },
          destination: { kind: 'machine', machineId: request.machineId }, purpose: 'finite', memoryDemand });
        return available && request.machineId === 'selected-worker'
          ? { eligible: true, candidate: { serverId: 'home', machineId: request.machineId },
              load: { kind: 'unknown' }, explanation: 'load_unknown' }
          : { eligible: false, candidate: null, load: { kind: 'unknown' }, explanation: 'not_accepting' };
      }
      throw new Error(`Unexpected raw finite delivery: ${request.method}`);
    });
    const owner = createCliActionExecutor({ token, credentials, serverIdentityId: 'srv_finite_home', sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.test', pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: { getActionsSettings: () => settings },
      accountServerActionDeps: createAccountServerActionDeps({ token, credentials,
        serverId: 'home', serverHttpBaseUrl: 'https://home.test' }),
    });
    const input = { workspace, selection: { kind: 'named' as const, name: 'check' } };
    expect(await owner.execute('projects.script.run', input, context)).toEqual({ ok: true, result: pending });
    expect(posts).toHaveBeenCalledTimes(2);
    if (kind === 'pool') expect(home.mock.calls.some(([request]) => request.url?.endsWith('/v1/machines/pools/get'))).toBe(true);
    available = false;
    transport.mockClear();
    expect(await owner.execute('projects.script.run', input, context)).toMatchObject({ ok: false,
      errorCode: 'choice_required' });
    expect(transport.mock.calls.some(([request]) => request.method === 'daemon.projects.script.run.v1')).toBe(false);
    expect(posts).toHaveBeenCalledTimes(2);
  });
});

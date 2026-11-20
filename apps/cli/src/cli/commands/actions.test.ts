import { projectPrivateLabelForRecipientV1, sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { createDeferred } from '@/testkit/async/deferred';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { afterEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

const credentialBoundary = vi.hoisted(() => ({ readStoredCredentials: vi.fn() }));
const approvalTerminal = vi.hoisted(() => ({ promptInput: vi.fn(async () => 'yes'), isInteractiveTerminal: vi.fn(() => false) }));
vi.mock('@/terminal/prompts/promptInput', async importOriginal => ({
  ...await importOriginal<typeof import('@/terminal/prompts/promptInput')>(),
  promptInput: approvalTerminal.promptInput,
  isInteractiveTerminal: approvalTerminal.isInteractiveTerminal,
}));
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: credentialBoundary.readStoredCredentials,
}));
import { handleActionsCommand, resolveActionDefinitionForCliCompletion } from './actions';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { API_TOKEN_FULL_GRANT_V1, FeaturesResponseSchema, createBlockingApprovalCoordinator, createDeploymentApprovalScopeResolverV1, DeploymentEnvironmentGetResultV1Schema, type ApprovalRequest, type ActionExecutorDeps } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, AccountApiTokensCreateActionInputV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { createHostApprovalOriginCurrentness } from '@/session/actions/approvals/hostOriginCurrentness';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SessionGoalControlFailureV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { compileActionCliCommands } from '@/cli/actions/compiledCommands';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { runCompiledActionCliCommand } from '@/cli/actions/executeCommand';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { installAxiosFastifyAdapter, installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import Fastify from 'fastify';
import { registerPlainArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { ArtifactJsonCreateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { executeActionOperationActionV1, type ActionOperationMachineTransportV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import axios from 'axios';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '@happier-dev/protocol/actions/actionSettings';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

it('preserves invitation token guidance at actions invoke dispatch', async () => {
  const token = 'a'.repeat(43);
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
    output.push(String(chunk));
    const callback = args.find(argument => typeof argument === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  await handleActionsCommand(['invoke', 'teams.invitations.accept', '--input-json',
    JSON.stringify({ v: 1, token: `https://app.example/join/${token}?target=opaque&targetBinding=binding` }), '--json']);
  expect(JSON.parse(output.join(''))).toMatchObject({ ok: false, error: {
    code: 'invitation_token_expected', message: expect.stringContaining('open the link in the app'),
  } });
  expect(output.join('')).not.toContain(token);
});

describe('public Action failure evidence', () => {
  it.each(['failed', 'executed'] as const)('projects a %s plugin approval decision at the CLI boundary', async status => {
    const failure = { errorCode: 'plugin_change_failed', error: 'Plugin requires installation review before it can be enabled',
      failureCause: { phase: 'plugins.change.apply', errorClass: 'Error', errorCode: null, httpStatus: null } } as const;
    const request: ApprovalRequest = {
      v: 2, status, createdAtMs: 1, updatedAtMs: 2, createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      actionId: 'plugins.enable', actionArgs: { pluginId: 'acme.development-removal' }, summary: 'Enable plugin',
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home', actionId: 'plugins.enable', requestId: 'enable-request' },
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: status === 'failed' ? { ok: false, executedAtMs: 2, ...failure } : { ok: true, executedAtMs: 2 },
    };
    const { executor } = createCliActionExecutorHarness({ token: 'test-account', sessionId: '', mode: 'plain', ctx: null, serverId: 'home' }, {
      approvalsGet: async () => request,
      approvalsUpdate: async () => { throw new Error('Attempted to update a settled approval'); },
      readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'approval.request.decide': ['cli'] } }),
    });
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    await handleActionsCommand(['invoke', 'approval.request.decide', '--input-json',
      JSON.stringify({ artifactId: 'plugin-approval', decision: 'approve' }), '--json'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: () => ({ execute: (id, input, context) => executor.execute(id, input, {
        ...context, authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' },
      }), resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }),
    });
    if (status === 'failed') {
      expect(JSON.parse(output), output).toMatchObject({ ok: false, kind: 'actions_invoke', error: {
        code: failure.errorCode, message: failure.error, failureCause: failure.failureCause,
      } });
      expect(process.exitCode).toBe(1);
    } else {
      expect(JSON.parse(output), output).toMatchObject({ ok: true, kind: 'actions_invoke', data: { status } });
    }
  });

  it.each([
    { actionId: 'deployments.rollback', input: { serverId: 'home', environmentId: 'environment' }, missing: 'deploymentId' },
    { actionId: 'deployments.teardown', input: { serverId: 'home', environmentId: 'environment', mode: 'preview' }, missing: 'reason' },
  ])('preserves $actionId missing-field diagnostics at invoke output', async ({ actionId, input, missing }) => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    await handleActionsCommand(['invoke', actionId, '--input-json', JSON.stringify(input), '--json']);
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: {
      code: 'invalid_arguments', message: expect.stringContaining(missing),
      details: { issues: expect.arrayContaining([expect.objectContaining({
        code: actionId === 'deployments.teardown' ? 'invalid_value' : 'invalid_type', path: [missing],
      })]) },
    } });
  });

  it.each([
    { cooperation: 'cooperative', prepared: false },
    { cooperation: 'noncooperative', prepared: false },
    { cooperation: 'noncooperative', prepared: true },
  ] as const)('returns control with a Request ID when a $cooperation Action is cancelled (prepared=$prepared)', async ({ cooperation, prepared }) => {
    const closed = createDeferred<void>();
    let requestOpened = false;
    let providerClosed = false;
    const provider = createServer((_request, response) => {
      requestOpened = true;
      response.once('close', () => { providerClosed = true; closed.resolve(); });
      response.flushHeaders();
      response.write('held');
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Missing provider address');
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, plugins: [{
      manifest: createPluginManifestV2Fixture({ id: 'acme.cancel-read', contributes: { actions: [{
        id: 'read', title: 'Read held provider', ...(cooperation === 'cooperative' ? { readOnly: true } : {}), dangerLevel: 'safe',
        scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' },
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }] } }),
      files: { 'daemon.mjs': `export function activate(api) {
        api.actions.register('read', async (_input, context) => {
          const response = await fetch('http://127.0.0.1:${address.port}', ${cooperation === 'cooperative' ? '{ signal: context.signal }' : '{}'});
          return await response.text();
        });
      }` },
    }] });
    const executor = createCliActionExecutor({ token: 'token', sessionId: 'cli-global', mode: 'plain', ctx: null,
      pluginActionExecutionOwner: 'current_process',
      listContributedActionDefinitions: createCommittedContributedActionDefinitionLister(),
      invokeContributedAction: createCommittedContributedActionInvoker(),
    });
    const caller = new AbortController();
    let settled = false;
    const pending = handleActionsCommand(['invoke', 'action.invoke', '--input-json', JSON.stringify({
      action: { pluginId: 'acme.cancel-read', localId: 'read' }, input: {},
    }), '--json'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: () => ({ execute: prepared ? async (actionId, input, context) => {
        const invocation = await executor.prepare(actionId, input, context);
        return invocation.kind === 'ready' ? await invocation.invocation.run() : invocation.result;
      } : executor.execute,
        resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }),
    }, caller.signal).then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect({ requestOpened, output }).toEqual({ requestOpened: true, output: '' }), { timeout: 10_000 });
      caller.abort(new Error('Command interrupted by SIGINT'));
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(JSON.parse(output)).toMatchObject({ ok: false, error: {
        code: 'cancelled', requestId: expect.any(String), details: { outcome: 'unknown' },
      } });
      if (cooperation === 'cooperative') await closed.promise;
      else expect(providerClosed).toBe(false);
    } finally {
      provider.closeAllConnections();
      await pending;
      await fixture.dispose();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each([
    { json: false, phase: 'preview' }, { json: true, phase: 'preview' },
    { json: false, phase: 'set' }, { json: true, phase: 'set' },
  ] as const)('explains a Machine setup prerequisite in CLI output ($phase, json=$json)', async ({ json, phase }) => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    await seedTestServerProfile({ id: 'acl-home', homeId: 'srv_acl_home', serverUrl: 'https://acl-home.example' });
    const reasonCode = phase === 'preview' ? 'native_check_unavailable' : 'native_effect_failed';
    const result = { ...(phase === 'preview'
      ? { kind: 'unavailable', status: { kind: 'unavailable', code: 'provisioning_unavailable' } }
      : { kind: 'failed', code: 'denied', operationId: 'missing-acl' }),
      setup: { outcome: 'not_applied', reasonCode, failure: { kind: reasonCode,
        reason: 'required_fact_unavailable', requiredFact: 'commandExecutable',
        remedy: 'Install the acl package on this Machine, then try again.' } } } as const;
    const actionsSettings = setScopedActionApprovalPreference({ actionId: 'machines.agentIsolation.set',
      scope: { kind: 'machine', machineId: 'machine-1' }, surface: 'cli', mode: 'waived',
      settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) });
    // The host policy snapshot and Machine RPC are boundaries; CLI admission and output stay real.
    const executor = createCliActionExecutorHarness({ token: 'token', sessionId: 'cli-acl', mode: 'plain', ctx: null,
      actionsSettingsProvider: { getActionsSettings: () => actionsSettings } }, {
      ...createUnavailableActionTransportDeps(), machineAgentIsolationAction: async () => result,
    }).executor;
    await handleActionsCommand(['invoke', `machines.agentIsolation.${phase}`, '--server-id', 'acl-home',
      '--input-json', JSON.stringify({ machineId: 'machine-1', enabled: true, memberProvisioning: 'linuxUsersV1',
        ...(phase === 'set' ? { expectedPolicy: { enabled: false }, expectedMetadataVersion: 1, expectedPlanDigest: 'reviewed' } : {}) }),
      ...(json ? ['--json'] : [])], {
      readCredentialsForServerIdFn: async () => credentials('stored_session'),
      createExecutorFn: () => ({ ...executor, resolveSessionTarget: async sessionId => ({ ok: true as const, sessionId }) }),
    });
    const printed = JSON.parse(output);
    expect(json ? printed.data : printed).toMatchObject(result);
  });
  it.each(['connectedServices.quota.get', 'machines.agents.list', 'session.open'] as const)(
    'keeps the typed cause and caller request ID through %s', async actionId => {
      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
        output += String(chunk);
        const callback = args.find(argument => typeof argument === 'function');
        if (typeof callback === 'function') callback();
        return true;
      });
      await seedTestServerProfile({ id: 'failure-home', homeId: 'srv_failure_home', serverUrl: 'https://failure-home.example' });
      const stored = credentials('stored_session');
      const code = actionId === 'connectedServices.quota.get'
        ? 'account_encryption_currentness_unavailable' : actionId === 'session.open' ? 'session_archived' : 'machine_inventory_unavailable';
      // HTTP and Machine RPC are the boundaries. Keep the real quota reader,
      // Machine adapter, Action executor and public CLI projection below them.
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (actionId !== 'session.open') throw Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
        if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } };
        return { status: 200, data: { session: createSessionRecordFixture({ id: 'c111111111111111111111111',
          active: false, archivedAt: 10, encryptionMode: 'plain', machineId: 'machine-1',
          metadata: JSON.stringify({ path: '/repo', machineId: 'machine-1', flavor: 'codex' }),
        }) } };
      });
      const executor = createActionExecutor(createCliActionDeps({
        token: stored.token, credentials: stored, sessionId: '', mode: 'plain', ctx: null,
        serverId: 'failure-home', serverHttpBaseUrl: 'https://failure-home.example',
        machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: async () => {
          throw Object.assign(new Error('Inventory unavailable'), { code,
            stage: 'capabilities.detect', details: { reason: 'fixture_unavailable' } });
        } },
      }));
      const input = actionId === 'connectedServices.quota.get'
        ? { source: { bindingKind: 'account', ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'fixture-account' } } }
        : actionId === 'session.open' ? { sessionId: 'c111111111111111111111111', intent: 'resume' }
        : { machineId: 'machine-1', agentId: 'codex' };
      await handleActionsCommand(['invoke', actionId, '--server-id', 'failure-home', '--input-json', JSON.stringify(input),
        '--request-id', 'fixture-public-failure', '--json'], {
        readCredentialsForServerIdFn: async () => stored,
        createExecutorFn: () => ({ ...executor, resolveSessionTarget: async sessionId => ({ ok: true as const, sessionId }) }),
      });
      expect(JSON.parse(output)).toMatchObject({ ok: false, error: {
        // Untyped transport exceptions remain diagnostics; only the explicit
        // Session refusal above owns the public domain failure envelope.
        code: actionId === 'session.open' ? code : 'action_failed', requestId: 'fixture-public-failure',
        ...(actionId === 'session.open' ? {} : { failureCause: {
          phase: actionId === 'machines.agents.list' ? 'capabilities.detect' : 'dispatch', errorCode: code,
        } }),
      } });
      expect(process.exitCode).toBe(1);
    },
  );
});

function credentials(provenance: 'api_token' | 'stored_session'): StoredCredentials {
  return { token: 'token', encryption: null, credentialProvenance: provenance };
}

function finiteDeploymentTransport(submit: NonNullable<ActionExecutorDeps['deploymentAction']>) {
  const transport: NonNullable<ActionExecutorDeps['deploymentAction']> = async (actionId, input, context) => {
    if (actionId !== 'deployments.environments.get') return submit(actionId, input, context);
    if (!('environmentId' in input)) throw new Error('Expected Environment');
    return DeploymentEnvironmentGetResultV1Schema.parse({ ok: true,
      environment: createDeploymentEnvironmentHeaderV1({ id: input.environmentId, serverId: input.serverId, projectSourceId: 'source',
        owner: { kind: 'account', accountId: 'account' }, controllerMachineId: 'controller', contentArtifactId: 'content',
        capabilities: { editData: false, role: 'manager', read: true, deploy: true, manage: true,
          manageBindings: true, manageTargets: true, delete: true } }), targetLinks: [] });
  };
  return transport;
}

function finiteDeploymentExecutor(submit: NonNullable<ActionExecutorDeps['deploymentAction']>) {
  const transport = finiteDeploymentTransport(submit);
  return createCliActionExecutorHarness({ token: 'token', sessionId: '', mode: 'plain', ctx: null, serverId: 'home' }, {
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"teams.invitations.accept": Object.keys(ActionSurfaceSchema.shape), "deployments.rollback": Object.keys(ActionSurfaceSchema.shape), "deployments.teardown": Object.keys(ActionSurfaceSchema.shape), "action.invoke": Object.keys(ActionSurfaceSchema.shape), "machines.agentIsolation.set": Object.keys(ActionSurfaceSchema.shape), "connectedServices.quota.get": Object.keys(ActionSurfaceSchema.shape), "machines.agents.list": Object.keys(ActionSurfaceSchema.shape), "session.open": Object.keys(ActionSurfaceSchema.shape), "deployments.environments.get": Object.keys(ActionSurfaceSchema.shape), "browser.diagnostics.snapshot": Object.keys(ActionSurfaceSchema.shape), "projects.open": Object.keys(ActionSurfaceSchema.shape), "projects.script.run": Object.keys(ActionSurfaceSchema.shape), "deployments.deploy": Object.keys(ActionSurfaceSchema.shape), "action.operations.get": Object.keys(ActionSurfaceSchema.shape), "session.goal.get": Object.keys(ActionSurfaceSchema.shape), "account.apiTokens.list": Object.keys(ActionSurfaceSchema.shape), "account.apiTokens.revoke": Object.keys(ActionSurfaceSchema.shape), "account.apiTokens.revokeAll": Object.keys(ActionSurfaceSchema.shape), "approval.request.decide": Object.keys(ActionSurfaceSchema.shape), "account.apiTokens.create": Object.keys(ActionSurfaceSchema.shape), "daemon.filesystem.upload": Object.keys(ActionSurfaceSchema.shape), "memory.search": Object.keys(ActionSurfaceSchema.shape), "workflow.run.start": Object.keys(ActionSurfaceSchema.shape), "deployments.domains.add": Object.keys(ActionSurfaceSchema.shape), "session.list": Object.keys(ActionSurfaceSchema.shape), "home.public_profiles.restrict": Object.keys(ActionSurfaceSchema.shape), "machines.list": Object.keys(ActionSurfaceSchema.shape), "action.spec.search": Object.keys(ActionSurfaceSchema.shape), "action.spec.get": Object.keys(ActionSurfaceSchema.shape), "teams.identity.connections.list": Object.keys(ActionSurfaceSchema.shape), "identity.providers.list": Object.keys(ActionSurfaceSchema.shape), "session.status.get": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(), deploymentAction: transport,
    resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport) }).executor;
}

function contributedActionDefinition() {
  return {
    kindVersion: 1,
    id: 'example.plugin/actions/do-work',
    title: 'Do work',
    description: 'Runs the contributed operation.',
    safety: 'danger',
    placements: [],
    slash: null,
    bindings: null,
    examples: { mcp: { argsExample: '{"note":"Review this","mode":"safe"}' } },
    surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: true, rpc: false, api: true, plugin: true },
    inputHints: {
      title: 'Do work',
      fields: [
        { path: 'note', title: 'Note', widget: 'text', required: true },
        {
          path: 'mode',
          title: 'Mode',
          widget: 'select',
          options: [
            { value: 'safe', label: 'Safe' },
            { value: 'fast', label: 'Fast' },
          ],
        },
        {
          path: 'attempts',
          title: 'Attempts',
          widget: 'integer',
          requiredWhen: { op: 'eq', path: 'mode', value: 'fast' },
        },
      ],
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        note: { type: 'string', minLength: 1 },
        mode: { type: 'string', enum: ['safe', 'fast'] },
        attempts: { type: 'integer', minimum: 1, maximum: 5 },
        config: { type: 'object' },
      },
      required: ['note'],
    },
  } as const;
}

describe('actions root command', () => {
  it.each([false, true])('collects forwarded approval through the ordinary CLI decision (yes: %s)', async yes => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const notice = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    approvalTerminal.promptInput.mockClear();
    const input = { browserSessionId: 'session', viewId: 'view' };
    const receipt = { v: 1, machineId: 'machine', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [] };
    // Another surface may have completed the approval before this terminal
    // decides it. Artifact persistence and the browser daemon are boundaries.
    const request: ApprovalRequest = { v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'browser.diagnostics.snapshot',
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home', actionId: 'browser.diagnostics.snapshot', requestId: 'browser-request' },
      actionArgs: input, summary: 'Browser diagnostics', decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { ok: true, effectAttempted: true, executedAtMs: 2, result: receipt } };
    const native = vi.fn(async () => ({ kind: 'approval_request_created', artifactId: 'cli-forwarded', actionId: request.actionId }));
    const stored: StoredCredentials = { ...credentials('stored_session'),
      token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature` };
    const artifact = { id: 'cli-forwarded', ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/artifacts/cli-forwarded') return { status: 200, data: artifact };
      throw new Error(`Unexpected forwarded-approval Home read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (new URL(String(url)).pathname === '/v1/artifacts/read') return artifactReadResponse(body,
        id => id === artifact.id ? artifact : null);
      throw new Error('Unexpected forwarded-approval Home write');
    });
    approvalTerminal.isInteractiveTerminal.mockReturnValueOnce(!yes);
    await handleActionsCommand(['invoke', request.actionId, '--input-json', JSON.stringify(input), ...(yes ? ['--yes'] : []), '--json'], {
      readCredentialsFn: async () => stored,
      // Full credentialed host owns person authority; only Home HTTP and the
      // browser daemon are substituted, including the already-settled receipt.
      createExecutorFn: params => ({ ...createCliActionExecutor({ ...params, token: stored.token, credentials: stored,
        sessionId: '', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://forwarded-home.test',
        runtimeActionExecute: native }),
        resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }),
    });
    expect(JSON.parse(output), output).toMatchObject({ ok: true, data: receipt });
    expect(notice.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
      v: 1, ok: true, kind: 'actions_invoke', data: {
        kind: 'approval_request_created', artifactId: 'cli-forwarded', actionId: request.actionId,
      },
    });
    expect(approvalTerminal.promptInput).toHaveBeenCalledTimes(yes ? 0 : 1);
    expect(native).toHaveBeenCalledOnce();
  });

  it('wait preserves a settled result from an Action that declares an operation', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    await seedTestServerProfile({ id: 'home', homeId: 'srv_wait_home', serverUrl: 'https://wait-home.example' });
    const result = { kind: 'ambiguous' as const, candidates: [] };
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"projects.open": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(),
      projectsOpen: async () => result });
    await handleActionsCommand(['invoke', 'projects.open', '--server-id', 'home', '--input-json', JSON.stringify({
      serverId: 'srv_wait_home', machineId: 'machine', source: { kind: 'folder', path: '/repo' },
      materialization: { kind: 'attach' },
    }), '--wait', '--json'], {
      readCredentialsForServerIdFn: async () => credentials('api_token'),
      createExecutorFn: () => ({ ...executor, resolveSessionTarget: async () => { throw new Error('No Session'); } }),
    });
    expect(JSON.parse(output), output).toMatchObject({ ok: true, data: result });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each(['succeeded', 'resumed', 'held', 'deferred', 'deferred-other', 'uncertain', 'mismatched'] as const)('finite operation uses one owner wait for %s', async outcome => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const store = createActionOperationStore();
    const scope = { accountId: 'account', machineId: 'controller' };
    const actionId = outcome === 'deferred-other' ? 'projects.script.run' : 'deployments.deploy';
    store.create({ operationId: 'operation', actionId, scope,
      title: 'Deploy', cancellation: 'unsupported', inputIdentity: 'reviewed' });
    store.markRunning('operation');
    const receipt = { ok: true as const, environmentId: 'staging', revision: 2,
      deploymentId: 'deployment', deploymentRevision: 1, state: 'succeeded' as const };
    // Only the Machine RPC hop is substituted. The operation adapter, snapshot
    // producer, strict response schema, executor and CLI stay real.
    const rpc = vi.fn<ActionOperationMachineTransportV1>(async () => {
      if (outcome === 'resumed') store.updateProgress('operation', { kind: 'phase', phase: 'waiting_for_approval', label: 'Waiting' });
      if (outcome === 'succeeded' || outcome === 'resumed') store.succeed('operation', receipt);
      else if (outcome === 'deferred' || outcome === 'deferred-other') store.succeed('operation', { kind: 'approval_request_created', actionId, artifactId: 'approval' });
      else if (outcome === 'held') store.updateProgress('operation', { kind: 'phase', phase: 'waiting_for_approval', label: 'Waiting' });
      else store.updateObservation('operation', { kind: 'outcome_uncertain', code: 'outcome_unknown' });
      const operation = store.get(scope, 'operation');
      return { kind: 'found' as const, operation: outcome === 'mismatched' ? { ...operation, operationId: 'another-operation' } : operation };
    });
    const operationInputs: unknown[] = [];
    const executor = createCliActionExecutorHarness({ token: 'token', sessionId: '', mode: 'plain', ctx: null, serverId: 'home' }, {
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"projects.script.run": Object.keys(ActionSurfaceSchema.shape), "deployments.deploy": Object.keys(ActionSurfaceSchema.shape), "action.operations.get": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(),
      actionOperationAction: args => {
        operationInputs.push(args.input);
        return executeActionOperationActionV1({ ...args, transport: async request => rpc(request) });
      } }).executor;
    await handleActionsCommand(['invoke', 'action.operations.get', '--input-json', JSON.stringify({
      serverId: 'home', machineId: 'controller', operationId: 'operation',
    }), '--wait', '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: () => ({ ...executor, resolveSessionTarget: async () => { throw new Error('No Session'); } }),
    });
    const successful = outcome === 'succeeded' || outcome === 'resumed';
    const held = outcome === 'held' || outcome === 'deferred' || outcome === 'deferred-other';
    expect(process.exitCode ?? 0, output).toBe(successful ? 0 : held ? 3 : 5);
    expect(JSON.parse(output)).toMatchObject(successful ? { ok: true, data: receipt }
      : { ok: false, error: { code: held ? 'approval_waiting' : 'outcome_unknown' } });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ payload: { operationId: 'operation', waitForTerminal: true } }));
    expect(operationInputs).toEqual([{ serverId: 'home', machineId: 'controller', operationId: 'operation', waitForTerminal: true }]);
  });

  it.each(['succeeded', 'held', 'missing', 'mismatched', 'home-alias', 'foreign-home'] as const)('finite pending submission observes its recorded host for %s', async outcome => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const addressHome = outcome === 'home-alias' ? 'srv_finite_home' : outcome === 'foreign-home' ? 'srv_foreign_home' : 'home';
    if (outcome === 'home-alias' || outcome === 'foreign-home') await seedTestServerProfile({
      id: 'home', homeId: 'srv_finite_home', serverUrl: 'https://finite-home.example',
    });
    const scope = { accountId: 'account', machineId: 'original-host' };
    const store = createActionOperationStore();
    store.create({ operationId: 'operation', actionId: 'deployments.deploy', scope,
      title: 'Deploy', cancellation: 'unsupported', inputIdentity: 'reviewed' });
    store.markRunning('operation');
    const receipt = { ok: true as const, environmentId: 'staging', revision: 2,
      deploymentId: 'deployment', deploymentRevision: 1, state: 'succeeded' as const };
    const submit = vi.fn(async () => ({ ok: true as const, environmentId: 'staging', revision: 2,
      kind: 'pending' as const, actionOperationId: 'operation', ...(outcome !== 'missing' ? { operation: {
        serverId: addressHome, machineId: 'original-host', operationId: outcome === 'mismatched' ? 'another-operation' : 'operation',
      } } : {}) }));
    const deployment = finiteDeploymentTransport(submit);
    const rpc = vi.fn<ActionOperationMachineTransportV1>(async request => {
      expect(request).toMatchObject({ serverId: addressHome, machineId: 'original-host',
        payload: { operationId: 'operation', waitForTerminal: true } });
      if (outcome === 'held') store.updateProgress('operation', { kind: 'phase', phase: 'waiting_for_approval', label: 'Waiting' });
      else store.succeed('operation', receipt);
      return { kind: 'found', operation: store.get(scope, 'operation') };
    });
    const executor = createCliActionExecutorHarness({ token: 'token', sessionId: '', mode: 'plain', ctx: null, serverId: 'home',
      serverIdentityId: await resolveServerProfileHomeIdentityId('home') ?? undefined }, {
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"deployments.deploy": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(),
      // Current Environment metadata names a different controller. Only the
      // original returned operation address may select the observation host.
      deploymentAction: deployment,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deployment),
      actionOperationAction: args => executeActionOperationActionV1({ ...args, transport: rpc }) }).executor;
    await handleActionsCommand(['invoke', 'deployments.deploy', '--input-json', JSON.stringify({
      serverId: 'home', environmentId: 'staging', expectedRevision: 1, targetLinkId: 'target',
      expectedTargetLinkRevision: 1, contentArtifactId: 'content', contentHeaderVersion: 1,
      contentBodyVersion: 1, requestKey: 'run-1',
    }), '--wait', '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: () => ({ ...executor,
        resolveSessionTarget: async () => { throw new Error('No Session'); } }),
    });
    const successful = outcome === 'succeeded' || outcome === 'home-alias';
    expect(process.exitCode ?? 0, output).toBe(successful ? 0 : outcome === 'held' ? 3 : 5);
    expect(JSON.parse(output)).toMatchObject(successful ? { ok: true, data: receipt }
      : { ok: false, error: { code: outcome === 'held' ? 'approval_waiting' : 'outcome_unknown' } });
    expect(submit).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledTimes(outcome === 'missing' || outcome === 'mismatched' || outcome === 'foreign-home' ? 0 : 1);
  });

  it.each([
    ['succeeded', 0, undefined],
    ['running_unverified', 0, undefined],
    ['failed', 1, 'deployment_failed'],
    ['cancelled', 1, 'cancelled'],
    ['waitingApproval', 1, 'invalid_action_output'],
    ['outcome_unknown', 5, 'outcome_unknown'],
    ['queued', 5, 'outcome_unknown'],
    ['running', 5, 'outcome_unknown'],
  ] as const)('finite deployment %s has exit %s without another submission', async (state, exitCode, code) => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const receipt = { ok: true as const, environmentId: 'staging', revision: 2,
      deploymentId: 'deployment', deploymentRevision: 1, state };
    // Deployment storage/effect transport is the system boundary; parsing,
    // Action admission and the CLI outcome projection remain real.
    const submit = vi.fn(async () => receipt);
    const executor = finiteDeploymentExecutor(submit);
    await handleActionsCommand(['invoke', 'deployments.deploy', '--input-json', JSON.stringify({
      serverId: 'home', environmentId: 'staging', expectedRevision: 1, targetLinkId: 'target',
      expectedTargetLinkRevision: 1, contentArtifactId: 'content', contentHeaderVersion: 1,
      contentBodyVersion: 1, requestKey: 'run-1',
    }), '--wait', '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: () => ({ ...executor, resolveSessionTarget: async () => { throw new Error('No Session'); } }),
    });
    expect(process.exitCode ?? 0, output).toBe(exitCode);
    expect(JSON.parse(output)).toMatchObject(code ? { ok: false, error: { code } } : { ok: true, data: receipt });
    expect(submit).toHaveBeenCalledOnce();
  });

  it('finite controller-offline failure keeps its typed remedy and exit distinct from Ask and failure', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const details = { role: 'controller' as const, machineIds: ['controller'], nextActions: ['start' as const] };
    const submit = vi.fn(async () => ({ ok: false as const, errorCode: 'machine_unavailable', error: 'machine_unavailable', details }));
    const executor = finiteDeploymentExecutor(submit);
    await handleActionsCommand(['invoke', 'deployments.deploy', '--input-json', JSON.stringify({
      serverId: 'home', environmentId: 'staging', expectedRevision: 1, targetLinkId: 'target',
      expectedTargetLinkRevision: 1, contentArtifactId: 'content', contentHeaderVersion: 1,
      contentBodyVersion: 1, requestKey: 'run-1',
    }), '--wait', '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: () => ({ ...executor, resolveSessionTarget: async () => { throw new Error('No Session'); } }),
    });
    expect(process.exitCode, output).toBe(4);
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'machine_unavailable', details } });
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([false, true])('opens a Session not already viewed by the signed-in client (exact Machine: %s)', async exactMachine => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sessionId = `c${'a'.repeat(24)}`;
    const stored = credentials('stored_session');
    const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
    const addressOwner = createCliActionExecutorFromCredentials({ credentials: stored, readCredentials: async () => stored });
    const opened: string[] = [];
    let severalClients = false;
    const { selectRpcTarget } = await import('../../../../server/sources/app/api/socket/rpc/rpcTargetSelection');
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      clientActionExecute: createClientActionReverseDispatcher(() => ({
        hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
        // Replace only the network hop; the real CLI, Action executor and
        // dispatcher must select the App without a mounted destination Session.
        callConnectedClientRpc: async (method, _request, options) => {
          if (method !== RPC_METHODS.UI_ACTION_EXECUTE) return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
          const receiver = (id: string) => ({ id, timeout: () => ({ emitWithAck: async () => {
            opened.push(sessionId);
            return { v: 1, execution: { ok: true, result: { status: 'opened', sessionId, serverId: 'home' } } };
          } }) });
          const selection = selectRpcTarget({ targets: severalClients ? [receiver('app-a'), receiver('app-b')] : [receiver('app-b')],
            answeringClient: options.answeringClient });
          if (selection.type === 'ambiguous') return { ok: false, errorCode: 'RPC_CLIENT_AMBIGUOUS', answeringClients: selection.clients };
          if (selection.type !== 'target') return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
          options.onIssued();
          return { ok: true, result: await selection.target.timeout(0).emitWithAck('rpc-request', _request) };
        },
      })),
    });
    await handleActionsCommand(['invoke', 'session.open', '--input-json', JSON.stringify({ sessionId }),
      ...(exactMachine ? ['--machine-id', 'machine_1'] : []), '--json'], {
      readCredentialsFn: async () => stored,
      createExecutorFn: () => ({ ...executor, resolveSessionTarget: addressOwner.resolveSessionTarget }),
    });
    expect(opened).toEqual([sessionId]);
    severalClients = true;
    await handleActionsCommand(['invoke', 'session.open', '--input-json', JSON.stringify({ sessionId }),
      '--client-id', 'app-b', ...(exactMachine ? ['--machine-id', 'machine_1'] : []), '--json'], {
      readCredentialsFn: async () => stored,
      createExecutorFn: () => ({ ...executor, resolveSessionTarget: addressOwner.resolveSessionTarget }),
    });
    expect(opened, JSON.stringify(vi.mocked(console.log).mock.calls)).toEqual([sessionId, sessionId]);
    expect(process.exitCode ?? 0).toBe(0);
  });
  it.each(['invoke', 'friendly'] as const)('preserves native Goal failure evidence in the %s JSON envelope', async surface => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const goalControlFailure = SessionGoalControlFailureV1Schema.parse({ phase: 'native_effect' });
    // Session RPC is the system boundary; Action dispatch and both CLI adapters stay real.
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.goal.get": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...createUnavailableActionTransportDeps(),
      sessionGoalGet: async () => ({ ok: false, errorCode: 'codex_goal_thread_unavailable',
        error: 'codex_goal_thread_unavailable', goalControlFailure }),

    });
    const deps = {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: () => ({ ...executor,
        resolveSessionTarget: async (sessionId: string) => ({ ok: true as const, sessionId }) }),
    };
    if (surface === 'invoke') {
      await handleActionsCommand(['invoke', 'session.goal.get', '--input-json',
        JSON.stringify({ sessionId: 'goal-session' }), '--json'], deps);
    } else {
      // Goal currently exposes generic invoke only; exercise the shared friendly
      // adapter with its real compiler and canonical Goal schema, without adding a command.
      const [command] = compileActionCliCommands([{ spec: getActionSpec('session.goal.get'),
        binding: { path: ['session', 'goal', 'get'], positionals: ['sessionId'], visibility: 'canonical' } }]);
      if (!command) throw new Error('Missing friendly Goal command');
      await runCompiledActionCliCommand({ command, argv: ['session', 'goal', 'get', 'goal-session', '--json'], deps });
    }
    expect(JSON.parse(output)).toEqual({ v: 1, ok: false,
      kind: surface === 'invoke' ? 'actions_invoke' : 'session_goal_get',
      error: { code: 'codex_goal_thread_unavailable', message: 'codex_goal_thread_unavailable',
        requestId: expect.any(String), goalControlFailure } });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    { facet: { phase: 'provider_completion' }, expected: { phase: 'provider_completion' } },
    { facet: { phase: 'native_effect', nativeError: 'private native content' }, expected: undefined },
    { facet: { phase: 'unknown_native_phase' }, expected: undefined },
  ])('projects only closed Goal evidence from a nested friendly failure: $facet', async ({ facet, expected }) => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.goal.get": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...createUnavailableActionTransportDeps(),
      // The supported `code` failure spelling reaches the nested CLI normalizer
      // through a real Action success; native response data is a boundary.
      sessionGoalGet: async () => ({ ok: false, code: 'native_goal_refused', goalControlFailure: facet }),

    });
    const [command] = compileActionCliCommands([{ spec: getActionSpec('session.goal.get'),
      binding: { path: ['session', 'goal', 'get'], positionals: ['sessionId'], visibility: 'canonical' } }]);
    if (!command) throw new Error('Missing friendly Goal command');
    await runCompiledActionCliCommand({ command, argv: ['session', 'goal', 'get', 'goal-session', '--json'], deps: {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: () => ({ ...executor,
        resolveSessionTarget: async (sessionId: string) => ({ ok: true as const, sessionId }) }),
    } });
    expect(JSON.parse(output)).toEqual({ v: 1, ok: false, kind: 'session_goal_get',
      error: { code: 'native_goal_refused', ...(expected ? { goalControlFailure: expected } : {}) } });
    expect(process.exitCode).toBe(1);
  });

  it.each(['account.apiTokens.list', 'account.apiTokens.revoke', 'account.apiTokens.revokeAll'] as const)(
    'admits %s through the generic command and the canonical approval owner', async actionId => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const coordinator = createBlockingApprovalCoordinator();
    const cancellation = new AbortController();
    let request: ApprovalRequest | null = null;
    const list = vi.fn(async () => ({ tokens: [] }));
    const revoke = vi.fn(async () => ({ revoked: true }));
    const revokeAll = vi.fn(async () => ({ revokedCount: 1 }));
    const { executor } = createCliActionExecutorHarness({ token: 'synthetic-account', sessionId: '', mode: 'plain', ctx: null }, {
      // Native Account HTTP and Artifact persistence are the system boundaries.
      accountApiTokensListAction: list, accountApiTokensRevokeAction: revoke, accountApiTokensRevokeAllAction: revokeAll,
      readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, actions: { ['account.apiTokens.revoke']: { approvalRequiredSurfaces: Object.keys(ActionSurfaceSchema.shape) }, ['account.apiTokens.revokeAll']: { approvalRequiredSurfaces: Object.keys(ActionSurfaceSchema.shape) } } }),
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'cli-lifecycle-approval' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
      approvalsWaitForDecision: async args => ({ ...await coordinator.waitForDecision(args), request: request! }),
      approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
    });
    const invoke = handleActionsCommand(['invoke', actionId, '--input-json', JSON.stringify(
      actionId === 'account.apiTokens.revoke' ? { tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d' } : {}), '--json'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: () => ({ execute: (...[id, input, context]: Parameters<typeof executor.execute>) => executor.execute(id, input, {
        ...context, authority: 'present_user', runtimeAccountId: 'account-1', serverId: 'home-1', defaultSessionMachineId: 'token-machine',
      }), resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }),
    }, cancellation.signal);
    try {
      if (actionId !== 'account.apiTokens.list') {
        await vi.waitFor(() => expect(request).not.toBeNull());
        expect(revoke).not.toHaveBeenCalled(); expect(revokeAll).not.toHaveBeenCalled();
        expect(await executor.execute('approval.request.decide', { artifactId: 'cli-lifecycle-approval', decision: 'approve' }, {
          surface: 'ui', authority: 'present_user', serverId: 'home-1', actionCaller: { kind: 'host' },
        })).toMatchObject({ ok: true });
      }
      await invoke;
      expect(JSON.parse(output)).toMatchObject({ ok: true });
      expect((actionId === 'account.apiTokens.list' ? list : actionId === 'account.apiTokens.revoke' ? revoke : revokeAll))
        .toHaveBeenCalledOnce();
    } finally { cancellation.abort(); coordinator.dispose(); await invoke; }
  });
  it('invokes API-token creation through real parsing, approval, and live caller custody', async () => {
    installAxiosRequestMethodAdapter();
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const tokenId = 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d';
    const label = sealPrivateLabelV1({ mode: 'plain', binding: { entity: 'account_api_token', field: 'label', id: tokenId }, value: 'CLI trigger' });
    const result = { token: `hap_v1_${tokenId}_${'S'.repeat(43)}`, apiToken: {
      tokenId, label: projectPrivateLabelForRecipientV1({ stored: label, recipientAccountId: 'account-1' }), displayPrefix: 'hap_v1_dd03e74b', createdAt: '2026-10-16T00:00:00.000Z',
      expiresAt: null, lastUsedAt: null, hasEncryptionAccess: false, hasUnattendedTeamAccess: false,
      grant: API_TOKEN_FULL_GRANT_V1, parentTokenId: null, activeChildCount: 0, embedConfig: null,
    } };
    const cancellation = new AbortController();
    const stored: StoredCredentials = { ...credentials('stored_session'),
      token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature` };
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {
      serverIdentity: { serverIdentityId: 'srv_token-home' },
      encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' },
    } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
    const sockets = await createRequesterCurrentnessSocketHarness();

    const trace: string[] = [];
    onTestFailed(() => console.error('Token approval fixture trace:', JSON.stringify(trace)));
    sockets.server.on('connection', socket => {
      socket.on(SOCKET_RPC_EVENTS.REGISTER, packet => { trace.push('socket:register'); socket.emit(SOCKET_RPC_EVENTS.REGISTERED, packet); });
    socket.on(SOCKET_RPC_EVENTS.CALL, (packet, ack) => {
      trace.push('socket:call');
      socket.emit(SOCKET_RPC_EVENTS.REQUEST, { ...packet, callerAuthority: 'present_user' },
        (result: unknown) => ack({ ok: true, result }));
    });
    });
    const home = Fastify();
    const artifacts = registerPlainArtifactRoutes(home, 'account-1');
    const createdArtifactIds: string[] = [];
    home.addHook('preHandler', async request => {
      if (request.method === 'POST' && request.url === '/v1/artifacts') {
        createdArtifactIds.push(ArtifactJsonCreateHttpInputV1Schema.parse(request.body).id);
      }
    });
    home.get('/v1/account/encryption/currentness', async () => ({
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    }));
    home.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    const restoreHttp = installAxiosFastifyAdapter({ app: home, origin: sockets.serverUrl });
    onTestFinished(async () => { cancellation.abort(); restoreHttp(); await home.close(); await sockets.close(); });
    const effect = vi.fn(async () => { trace.push('effect'); return result; });
    home.post(ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, async request => {
      expect(AccountApiTokensCreateActionInputV1Schema.parse(request.body)).toMatchObject({ tokenId, label });
      return await effect();
    });
    const settings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1,
      actions: { ['account.apiTokens.create']: { approvalRequiredSurfaces: Object.keys(ActionSurfaceSchema.shape) } } } });
    approvalTerminal.isInteractiveTerminal.mockReturnValueOnce(true);
    try {
      await handleActionsCommand(['invoke', 'account.apiTokens.create', '--input-json', JSON.stringify({ tokenId, label }), '--json'], {
        readCredentialsFn: async () => stored,
        createExecutorFn: params => ({ ...createCliActionExecutor({ ...params, token: stored.token, credentials: stored,
          sessionId: '', mode: 'plain', ctx: null, serverId: 'home-1', serverIdentityId: 'srv_token-home',
          serverHttpBaseUrl: sockets.serverUrl, runtimeActionMachineId: 'token-machine',
          isApprovalExecutionOriginCurrent: createHostApprovalOriginCurrentness({ credentials: stored,
            serverId: 'home-1', serverApiUrl: sockets.serverUrl,
            resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: sockets.serverUrl, token: stored.token }),
            checkDaemonOrigin: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials: stored,
              machineId: 'token-machine', serverId: 'home-1', serverApiUrl: sockets.serverUrl }),
          }),
          onApprovalRequested: async (...args) => { trace.push('approval-requested'); return await params.onApprovalRequested?.(...args); },
          actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings, allowEnvironmentOverride: false }),
          accountServerActionDeps: createAccountServerActionDeps({ token: stored.token, credentials: stored,
            serverId: 'home-1', serverIdentityId: 'srv_token-home', serverHttpBaseUrl: sockets.serverUrl }) }),
          resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }),
      }, cancellation.signal);
      expect(JSON.parse(output), output).toMatchObject({ ok: true, data: result });
      expect(effect).toHaveBeenCalledOnce();
      expect(createdArtifactIds).toHaveLength(1);
      const approval = artifacts.read(createdArtifactIds[0]!);
      expect(approval).toBeDefined();
      expect(JSON.stringify(approval)).not.toContain(result.token);
    } finally { cancellation.abort(); }
  });
  it('refuses a filesystem byte transfer without local custody before reading credentials', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const readCredentialsFn = vi.fn(async () => credentials('stored_session'));
    await handleActionsCommand(['invoke', 'daemon.filesystem.upload', '--machine-id', 'machine-1', '--input-json', JSON.stringify({
      rootPath: '/repo', path: 'literal \n ', source: { sourceId: 'source-1', sizeBytes: 4 }, overwrite: false,
    }), '--json'], { readCredentialsFn });
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(readCredentialsFn).not.toHaveBeenCalled();
  });
  it.each(['global', 'project'] as const)('dispatches %s mixed-corpus memory search through the real Action executor', async (type) => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find((argument) => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const result = { v: 1 as const, ok: true as const, hits: [], documents: { state: 'unavailable' as const } };
    // The daemon RPC is the system boundary; CLI parsing and Action admission remain real.
    const daemonMemorySearch = vi.fn(async () => result);
    const scope = type === 'project' ? { type, projectRef: { serverId: 'home', projectKey: 'payments' } } : { type };
    const query = { v: 1, query: 'decision', scope, mode: 'deep', corpora: ['sessions', 'documents'] };
    await handleActionsCommand(['invoke', 'memory.search', '--input-json', JSON.stringify({ machineId: 'machine_1', query }), '--json'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: () => ({
        ...createCliActionExecutorHarness({ token: 'token', sessionId: '', mode: 'plain', ctx: null }, { daemonMemorySearch }).executor,
        resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); },
      }),
    });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: true, data: result });
    expect(daemonMemorySearch).toHaveBeenCalledWith({ machineId: 'machine_1', query, serverId: null });
  });

  it('carries standalone Workflow project selection as target context, never Action input', async () => {
    const execute = vi.fn(async () => ({ ok: true, result: { run: { id: 'run-1' }, admission: 'created' } }));
    await handleActionsCommand([
      'invoke', 'workflow.run.start',
      '--machine-id', 'machine-1',
      '--project-directory', '/repo/packages/app',
      '--workspace-ref-id', 'workspace-1',
      '--input-json', JSON.stringify({
        runId: '11111111-1111-4111-8111-111111111111',
        source: { kind: 'inline', definition: { version: 1, inputs: [], defaults: {}, blocks: ['work'] } },
      }),
      '--json',
    ], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: (() => ({ execute })) as any,
    });
    expect(execute).toHaveBeenCalledWith(
      'workflow.run.start',
      expect.not.objectContaining({ project: expect.anything() }),
      expect.objectContaining({
        externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo/packages/app', workspaceRefId: 'workspace-1' } },
      }),
    );
  });

  it('describes request ids as correlation unless the Action owns idempotency', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleActionsCommand(['--help']);

    const help = log.mock.calls.map(([value]) => String(value)).join('\n');
    expect(help).toContain('--request-id <id>');
    expect(help).toContain('Request correlation identifier');
    expect(help).not.toContain('Idempotency request identifier');
  });

  it.each([['deployments.deploy', true], ['deployments.domains.add', true], ['session.list', false], ['home.public_profiles.restrict', false]] as const)(
    'finite invocation help and parser agree for %s', async (actionId, supported) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const readCredentialsFn = vi.fn();
      await handleActionsCommand(['invoke', actionId, '--help'], { readCredentialsFn });
      expect(readCredentialsFn).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join('\n').includes('--wait')).toBe(supported);
      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
        output += String(chunk);
        const callback = args.find(argument => typeof argument === 'function');
        if (typeof callback === 'function') callback();
        return true;
      });
      await handleActionsCommand(['invoke', actionId, '--wait', '--unknown-option', '--json'], { readCredentialsFn });
      const envelope = JSON.parse(output);
      expect(envelope).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
      const [reason, ...usage] = envelope.error.message.split('\n');
      expect(reason).toContain(`Unknown option: ${supported ? '--unknown-option' : '--wait'}`);
      expect(usage.join('\n').includes('--wait')).toBe(supported);
      expect(readCredentialsFn).not.toHaveBeenCalled();
    });

  it('shows help from a concrete subcommand without reading credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn();

    await handleActionsCommand(['search', '--help'], { readCredentialsFn });

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('happier actions search');
    expect(process.exitCode).toBeUndefined();
  });

  it('preserves canonical Action failure code, candidates, and details as expected exit 1', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk); args.find((value) => typeof value === 'function')?.(); return true;
    }) as any);
    const execute = vi.fn(async () => ({ ok: false, errorCode: 'action_disabled', error: 'Disabled by policy', details: { policy: 'deny' } }));
    await handleActionsCommand(['get', 'machines.list', '--json'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: (() => ({ execute })) as any,
    });
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: { code: 'action_disabled', message: 'Disabled by policy', details: { policy: 'deny' } },
    });
    expect(process.exitCode).toBe(1);
  });

  it('uses the real stored-credential source so a token-only PAT reaches public transport composition', async () => {
    credentialBoundary.readStoredCredentials.mockResolvedValue(credentials('api_token'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true, result: { actionSpecs: [] } }));
    const createExecutorFn = vi.fn(() => ({ execute }));
    await handleActionsCommand(['search', 'machine', 'actions'], { createExecutorFn: createExecutorFn as any });
    expect(credentialBoundary.readStoredCredentials).toHaveBeenCalledOnce();
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ credentialProvenance: 'api_token' }),
      externalActionClient: true,
    }));
    expect(execute).toHaveBeenCalledWith(
      'action.spec.search',
      { query: 'machine actions' },
      expect.objectContaining({ surface: 'cli' }),
    );
  });

  it.each(['stored_session', 'api_token'] as const)('uses the same API surface for built-in and contributed invoke with %s credentials', async (provenance) => {
    vi.spyOn(process.stdout, 'write').mockImplementation(((...args: any[]) => { args.find((value) => typeof value === 'function')?.(); return true; }) as any);
    const execute = vi.fn(async (actionId: string, _input: unknown, _context: unknown) => actionId === 'action.spec.get'
      ? { ok: true as const, result: { actionSpec: contributedActionDefinition() } }
      : { ok: true as const, result: { invoked: true } });
    const deps = {
      readCredentialsFn: async () => credentials(provenance),
      createExecutorFn: (() => ({ execute })) as any,
    };
    await handleActionsCommand(['invoke', 'machines.list', '--input-json', '{}'], deps);
    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--input-json', '{"note":"hi"}'], deps);
    expect(execute.mock.calls[0]).toEqual(['machines.list', {}, expect.objectContaining({
      surface: 'cli',
    })]);
    expect(execute.mock.calls[1]).toEqual([
      'action.spec.get',
      { id: 'example.plugin/actions/do-work', includeOutputSchema: true },
      expect.objectContaining({ surface: 'cli' }),
    ]);
    expect(execute.mock.calls[2]).toEqual(['action.invoke', {
      action: { pluginId: 'example.plugin', localId: 'do-work' }, input: { note: 'hi' },
    }, expect.objectContaining({ surface: 'cli' })]);
  });

  it.each([
    {
      actionId: 'teams.identity.connections.list',
      inputArgs: ['--v', '1', '--team-id', 'team_1'],
    },
    {
      actionId: 'identity.providers.list',
      inputArgs: [],
    },
  ])('does not let generic invoke bypass the exact-Home requirement for $actionId', async ({ actionId, inputArgs }) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn(async () => credentials('stored_session'));
    const createExecutorFn = vi.fn();

    await handleActionsCommand([
      'invoke',
      actionId,
      ...inputArgs,
    ], {
      readCredentialsFn,
      createExecutorFn: createExecutorFn as never,
    });

    expect(error.mock.calls.flat().join('\n')).toContain('--server-id');
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(createExecutorFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    { v: 1, ok: true, hits: [] },
    { v: 1, ok: false, errorCode: 'memory_disabled', error: 'Memory is disabled' },
  ])('preserves an admitted Action result unchanged when its own result contains ok=$ok', async (result) => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      args.find((value) => typeof value === 'function')?.();
      return true;
    }) as any);
    const execute = vi.fn(async () => ({ ok: true as const, result }));

    await handleActionsCommand([
      'invoke',
      'memory.search',
      '--input-json',
      '{"machineId":"machine_1","query":{"v":1,"query":"needle","scope":{"type":"global"},"mode":"hints"}}',
      '--json',
    ], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(JSON.parse(output)).toEqual({
      v: 1,
      ok: true,
      kind: 'actions_invoke',
      data: result,
    });
    expect(process.exitCode).toBe(0);
  });

  it('accepts the Protocol request-id grammar instead of imposing a CLI-only ASCII subset', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(((...args: any[]) => {
      args.find((value) => typeof value === 'function')?.();
      return true;
    }) as any);
    const execute = vi.fn(async () => ({ ok: true as const, result: { invoked: true } }));

    await handleActionsCommand(['invoke', 'machines.list', '--request-id', 'corrélation-☃', '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).toHaveBeenCalledWith(
      'machines.list',
      {},
      expect.objectContaining({ actionRequestId: 'corrélation-☃' }),
    );
    expect(process.exitCode).toBe(0);
  });

  it('rejects a request id beyond the Protocol-owned limit', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      args.find((value) => typeof value === 'function')?.();
      return true;
    }) as any);
    const execute = vi.fn();

    await handleActionsCommand(['invoke', 'machines.list', '--request-id', 'x'.repeat(129), '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(process.exitCode).toBe(1);
  });

  it('rejects request-id outer whitespace instead of silently changing the Protocol identity', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      args.find((value) => typeof value === 'function')?.();
      return true;
    }) as any);
    const execute = vi.fn();

    await handleActionsCommand(['invoke', 'machines.list', '--request-id', ' correlation ', '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(process.exitCode).toBe(1);
  });

  it('emits a stable invalid_arguments JSON envelope for a missing option value', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      const callback = args.find((value) => typeof value === 'function');
      callback?.();
      return true;
    }) as any);
    await handleActionsCommand(['invoke', 'machines.list', '--input-json', '--json'], {
      readCredentialsFn: vi.fn(), createExecutorFn: vi.fn() as any,
    });
    expect(JSON.parse(output)).toMatchObject({ v: 1, ok: false, error: { code: 'invalid_arguments' } });
    expect(process.exitCode).toBe(1);
  });

  it.each(['stored_session', 'api_token'] as const)('binds an exact machine and uses canonical get input for %s credentials', async (provenance) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true, result: { actionSpec: { id: 'machines.list', title: 'Machines', inputSchema: {} } } }));
    const createExecutorFn = vi.fn(() => ({ execute }));
    await handleActionsCommand(['get', 'machines.list', '--machine-id', 'machine-1'], {
      readCredentialsFn: async () => credentials(provenance),
      createExecutorFn: createExecutorFn as any,
    });
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({ externalActionClient: true, machineId: 'machine-1' }));
    expect(execute).toHaveBeenCalledWith('action.spec.get', { id: 'machines.list' }, expect.objectContaining({
      surface: 'cli',
    }));
    expect(process.exitCode).toBeUndefined();
  });

  it('binds discovery credentials and endpoint to the same exact saved Home', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true, result: { actionSpecs: [] } }));
    const createExecutorFn = vi.fn(() => ({ execute }));
    const readCredentialsFn = vi.fn();
    const readCredentialsForServerIdFn = vi.fn(async () => credentials('stored_session'));
    const getServerProfileFn = vi.fn(async () => ({
      id: 'home-a',
      name: 'Home A',
      serverUrl: 'https://home-a.example',
      webappUrl: 'https://home-a.example',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
    }));

    await handleActionsCommand(
      ['search', 'machines', '--server-id', 'home-a'],
      {
        readCredentialsFn,
        readCredentialsForServerIdFn,
        getServerProfileFn,
        createExecutorFn: createExecutorFn as any,
      },
    );

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(readCredentialsForServerIdFn).toHaveBeenCalledWith('home-a');
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'home-a',
      serverApiUrl: 'https://home-a.example',
      externalActionClient: true,
    }));
    expect(createExecutorFn).not.toHaveBeenCalledWith(expect.objectContaining({
      serverIdentityId: expect.anything(),
    }));
  });

  it('binds contributed discovery and invocation to one exact saved Home', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async (actionId: string, _input: unknown) => actionId === 'action.spec.get'
      ? { ok: true as const, result: { actionSpec: contributedActionDefinition() } }
      : { ok: true as const, result: { ok: true } });
    const createExecutorFn = vi.fn(() => ({ execute }));
    const readCredentialsFn = vi.fn();
    const readCredentialsForServerIdFn = vi.fn(async () => credentials('stored_session'));
    const profile = await seedTestServerProfile({
      id: 'profile-a', homeId: 'srv_home_stable_a', serverUrl: 'https://public-a.example',
      localServerUrl: 'http://127.0.0.1:5353',
    });
    const getServerProfileFn = vi.fn(async () => profile);

    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--note', 'hi', '--server-id', 'profile-a'],
      {
        readCredentialsFn,
        readCredentialsForServerIdFn,
        getServerProfileFn: getServerProfileFn as any,
        createExecutorFn: createExecutorFn as any,
      },
    );

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(readCredentialsForServerIdFn).toHaveBeenCalledWith('profile-a');
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'token' }),
      serverId: 'profile-a',
      serverIdentityId: 'srv_home_stable_a',
      serverApiUrl: 'http://127.0.0.1:5353',
      externalActionClient: true,
    }));
    expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual(['action.spec.get', 'action.invoke']);
  });

  it.each([
    ['missing', ['--server-id']],
    ['duplicate', ['--server-id', 'home-a', '--server-id', 'home-b']],
  ] as const)('rejects a %s exact-Home selector before reading credentials', async (_case, selector) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn();
    const readCredentialsForServerIdFn = vi.fn();
    await handleActionsCommand(
      ['invoke', 'session.list', ...selector],
      { readCredentialsFn, readCredentialsForServerIdFn, createExecutorFn: vi.fn() as any },
    );
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(readCredentialsForServerIdFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects unknown options before reading credentials', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn(async () => credentials('stored_session'));
    await handleActionsCommand(['search', '--bogus'], { readCredentialsFn, createExecutorFn: vi.fn() as any });
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('accepts ordinary Action fields without whole-input JSON', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async (_actionId: string, _input: unknown) => ({ ok: true, result: { sessions: [] } }));
    await handleActionsCommand(
      ['invoke', 'session.list', '--limit', '5', '--archived-only', '--json'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const [actionId, input] = execute.mock.calls[0]!;
    expect(actionId).toBe('session.list');
    expect(input).toMatchObject({ limit: 5, archivedOnly: true });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('resolves a built-in invoke Session selector exactly once before execution', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true as const, result: { active: true } }));
    const resolveSessionTarget = vi.fn(async () => ({ ok: true as const, sessionId: 'session_exact' }));
    await handleActionsCommand(['invoke', 'session.status.get', '--input-json', JSON.stringify({ sessionId: 'prefix' })], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: (() => ({ execute, resolveSessionTarget })) as any,
    });
    expect(resolveSessionTarget).toHaveBeenCalledOnce();
    expect(resolveSessionTarget).toHaveBeenCalledWith('prefix');
    expect(execute).toHaveBeenCalledWith(
      'session.status.get',
      expect.objectContaining({ sessionId: 'session_exact' }),
      expect.objectContaining({ defaultSessionId: 'session_exact' }),
    );
  });

  it('preserves typed ambiguous Session candidates and invokes no built-in effect', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk); args.find((value) => typeof value === 'function')?.(); return true;
    }) as any);
    const execute = vi.fn();
    await handleActionsCommand(['invoke', 'session.status.get', '--input-json', JSON.stringify({ sessionId: 'ambiguous' }), '--json'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: (() => ({
        execute,
        resolveSessionTarget: vi.fn(async () => ({ ok: false as const, code: 'ambiguous_session', candidates: ['a', 'b'] })),
      })) as any,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: { code: 'ambiguous_session', candidates: ['a', 'b'] },
    });
  });

  it('does not reinterpret a contributed input field named sessionId as a host Session selector', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const definition = {
      ...contributedActionDefinition(),
      inputHints: null,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    } as const;
    const execute = vi.fn(async (actionId: string, _input: unknown) => actionId === 'action.spec.get'
      ? { ok: true as const, result: { actionSpec: definition } }
      : { ok: true as const, result: { ok: true } });
    const resolveSessionTarget = vi.fn();
    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--session-id', 'opaque-plugin-value'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: (() => ({ execute, resolveSessionTarget })) as any,
    });
    expect(resolveSessionTarget).not.toHaveBeenCalled();
    expect(execute.mock.calls[1]?.[1]).toMatchObject({ input: { sessionId: 'opaque-plugin-value' } });
  });

  it('keeps whole-input JSON usable and rejects a duplicated field source', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async (_actionId: string, _input: unknown) => ({ ok: true, result: { sessions: [] } }));
    const createExecutorFn = vi.fn(() => ({ execute }));
    await handleActionsCommand(
      ['invoke', 'session.list', '--input-json', '{"limit":7}', '--json'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: createExecutorFn as any,
      },
    );
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ limit: 7 });

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn(async () => credentials('api_token'));
    await handleActionsCommand(
      ['invoke', 'session.list', '--input-json', '{"limit":7}', '--limit', '9'],
      { readCredentialsFn, createExecutorFn: vi.fn() as any },
    );
    expect(process.exitCode).toBe(1);
    expect(readCredentialsFn).not.toHaveBeenCalled();
  });

  it.each([['--help', '--json'], ['--input-json', '{}', '--json']])('rejects retired combined Publish through the unknown Action boundary with %j', async (...args) => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn(async () => credentials('api_token'));
    await handleActionsCommand(['invoke', 'deployments.publish', ...args], { readCredentialsFn });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      ok: false, error: { code: 'invalid_arguments' },
    });
    expect(readCredentialsFn).not.toHaveBeenCalled();
  });

  it('rejects an unknown Action field before reading credentials', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn(async () => credentials('api_token'));
    await handleActionsCommand(['invoke', 'session.list', '--not-a-field', 'x'], {
      readCredentialsFn, createExecutorFn: vi.fn() as any,
    });
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('restores sectioned contributed schemas before completion and CLI input validation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pluginId = 'example.plugin';
    const actionId = `${pluginId}/actions/do-work`;
    const inputSchema = { type: 'object', additionalProperties: false, required: ['note'],
      properties: { note: { type: 'string', allOf: [{ $ref: '#/definitions/Note' }] }, wait: { type: 'boolean' } },
      definitions: { Note: { type: 'string', pattern: '^review:' } } };
    const outputSchema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
    // Authored plugin bytes/native effects are synthetic; committed source,
    // activation, catalog, schema discovery and input validation stay real.
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, plugins: [{
      manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { actions: [{
        id: 'do-work', title: 'Do work', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'],
        execution: { target: 'daemon' }, inputSchema, resultSchema: outputSchema,
        inputHints: { fields: [{ path: 'note', title: 'Note', widget: 'text', required: true }] },
      }] } }),
      files: { 'daemon.mjs': 'const inputs = []; export function readInputs() { return inputs; } export function activate(api) { api.actions.register("do-work", async input => { inputs.push(input); return { ok: true }; }); }' },
    }] });
    onTestFinished(() => fixture.dispose());
    const readInputs = fixture.modulesByPluginId.get(pluginId)?.readInputs;
    if (typeof readInputs !== 'function') throw new Error('Authored Action fixture has no native input reader');
    const executor = createCliActionExecutor({ token: 'token', sessionId: 'cli-global', mode: 'plain', ctx: null,
      pluginActionExecutionOwner: 'current_process',
      listContributedActionDefinitions: createCommittedContributedActionDefinitionLister(),
      invokeContributedAction: createCommittedContributedActionInvoker(),
    });
    const deps = { readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: () => ({ execute: executor.execute,
        resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }) };
    await expect(resolveActionDefinitionForCliCompletion(actionId, [], deps))
      .resolves.toMatchObject({ inputSchema, outputSchema });
    await handleActionsCommand(['invoke', actionId, '--note', 'review:done'], deps);
    expect(process.exitCode).toBeUndefined();
    expect(readInputs()).toEqual([{ note: 'review:done' }]);
    await handleActionsCommand(['invoke', actionId, '--note', 'review:wait', '--wait'], deps);
    expect(process.exitCode).toBeUndefined();
    expect(readInputs()).toEqual([{ note: 'review:done' }, { note: 'review:wait', wait: true }]);
    await handleActionsCommand(['invoke', actionId, '--note', 'invalid'], deps);
    expect(process.exitCode).toBe(1);
    expect(readInputs()).toEqual([{ note: 'review:done' }, { note: 'review:wait', wait: true }]);
  });

  it('discovers a contributed Action and compiles its canonical fields before invocation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async (actionId: string, _input: unknown) => actionId === 'action.spec.get'
      ? { ok: true as const, result: { actionSpec: contributedActionDefinition() } }
      : { ok: true as const, result: { ok: true } });
    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--note', 'hi', '--mode', 'safe', '--config-json', '{"retries":2}', '--json'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
    );
    expect(execute.mock.calls[0]).toEqual([
      'action.spec.get',
      { id: 'example.plugin/actions/do-work', includeOutputSchema: true },
      expect.objectContaining({ surface: 'cli' }),
    ]);
    const [actionId, input] = execute.mock.calls[1]!;
    expect(actionId).toBe('action.invoke');
    expect(input).toMatchObject({
      action: { pluginId: 'example.plugin', localId: 'do-work' },
      input: { note: 'hi', mode: 'safe', config: { retries: 2 } },
    });
  });

  it('rejects a contributed unknown field after discovery and before invocation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true as const, result: { actionSpec: contributedActionDefinition() } }));

    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--bogus', 'x'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'action.spec.get',
      { id: 'example.plugin/actions/do-work', includeOutputSchema: true },
      expect.objectContaining({ surface: 'cli' }),
    );
    expect(process.exitCode).toBe(1);
  });

  it('validates contributed field input against the discovered canonical schema before invocation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true as const, result: { actionSpec: contributedActionDefinition() } }));

    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--note', 'hello', '--mode', 'unknown'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('rejects a duplicated contributed field source instead of silently overwriting the JSON', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async (actionId: string, _input: unknown, _context: unknown) => actionId === 'action.spec.get'
      ? { ok: true as const, result: { actionSpec: contributedActionDefinition() } }
      : { ok: true as const, result: { ok: true } });

    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--input-json', '{"note":"from-json"}', '--note', 'from-flag'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
    );
    // Discovery ran; the invocation did not, and neither source silently won.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--input-json', '{"note":"from-json"}', '--mode', 'safe'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
    );
    expect(execute.mock.calls[2]?.[0]).toBe('action.invoke');
    expect(execute.mock.calls[2]?.[1]).toMatchObject({
      input: { note: 'from-json', mode: 'safe' },
    });
  });

  it('rejects a mismatched contributed discovery response before invocation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: {
        actionSpec: { ...contributedActionDefinition(), id: 'example.plugin/actions/different' },
      },
    }));

    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--input-json', '{"note":"hello"}'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(2);
  });

  it('uses the JSON-only predecessor fallback only when action discovery is unsupported', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async (actionId: string, _input: unknown, _context: unknown) => actionId === 'action.spec.get'
      ? { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action:action.spec.get' }
      : { ok: true as const, result: { ok: true } });

    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--input-json', '{"note":"legacy"}'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
    );

    expect(execute.mock.calls[1]).toEqual([
      'action.invoke',
      {
        action: { pluginId: 'example.plugin', localId: 'do-work' },
        input: { note: 'legacy' },
      },
      expect.objectContaining({ surface: 'cli' }),
    ]);
    expect(error.mock.calls.flat().join('\n')).toContain('legacy JSON-only');
    expect(process.exitCode).toBeUndefined();
  });

  it('does not reinterpret a discovery denial as the legacy JSON-only fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: false as const, errorCode: 'action_disabled', error: 'Disabled by policy' }));

    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--input-json', '{"note":"blocked"}'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('renders discovered contributed fields for invoke help without invoking the Action', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true as const, result: { actionSpec: contributedActionDefinition() } }));

    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--help'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    const help = log.mock.calls.flat().join('\n');
    expect(help).toContain('happier actions invoke example.plugin/actions/do-work');
    expect(help).toContain('--note');
    expect(help).toContain('--mode');
    expect(help).toContain('safe');
    expect(help).toContain('--attempts');
    expect(help).toContain('(number)');
    expect(help).toContain('[conditionally required]');
    expect(help).toContain('1–5');
    expect(help).toContain('Safety: danger.');
    expect(help).toContain('Example input: {"note":"Review this","mode":"safe"}');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('renders a precise JSON-only help page when the runtime cannot publish the definition', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:action.spec.get',
    }));

    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--help'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    const help = log.mock.calls.flat().join('\n');
    expect(help).toContain('happier actions invoke example.plugin/actions/do-work');
    expect(help).toContain('--input-json <json>');
    expect(help).toContain('Canonical definition unavailable');
    expect(help).not.toContain('Use a query and --limit');
    expect(error.mock.calls.flat().join('\n')).toContain('legacy JSON-only');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('passes cancellation to both contributed discovery and invocation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const controller = new AbortController();
    const execute = vi.fn(async (actionId: string, _input: unknown, _context: unknown) => actionId === 'action.spec.get'
      ? { ok: true as const, result: { actionSpec: contributedActionDefinition() } }
      : { ok: true as const, result: { ok: true } });

    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--note', 'hello'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
      controller.signal,
    );

    expect(execute.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
    expect(execute.mock.calls[1]?.[2]).toMatchObject({ signal: controller.signal });
  });

  it('classifies an unexpected dependency exception as exit 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handleActionsCommand(['search', 'machines'], {
      readCredentialsFn: async () => { throw new Error('dependency exploded'); },
      createExecutorFn: vi.fn() as any,
    });
    expect(process.exitCode).toBe(2);
  });
});

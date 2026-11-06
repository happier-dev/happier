import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const credentialBoundary = vi.hoisted(() => ({ readStoredCredentials: vi.fn() }));
const approvalTerminal = vi.hoisted(() => ({ promptInput: vi.fn(async () => 'yes') }));
vi.mock('@/terminal/prompts/promptInput', async importOriginal => ({
  ...await importOriginal<typeof import('@/terminal/prompts/promptInput')>(),
  promptInput: approvalTerminal.promptInput,
}));
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: credentialBoundary.readStoredCredentials,
}));
import { handleActionsCommand, resolveActionDefinitionForCliCompletion } from './actions';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { API_TOKEN_FULL_GRANT_V1, createBlockingApprovalCoordinator, type ApprovalRequest } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
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
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createDeploymentApprovalScopeResolverV1, DeploymentEnvironmentGetResultV1Schema, type ActionExecutorDeps } from '@happier-dev/protocol';
import { executeActionOperationActionV1, type ActionOperationMachineTransportV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

function credentials(provenance: 'api_token' | 'stored_session'): StoredCredentials {
  return { token: 'token', encryption: null, credentialProvenance: provenance };
}

function finiteDeploymentTransport(submit: NonNullable<ActionExecutorDeps['deploymentAction']>) {
  const transport: NonNullable<ActionExecutorDeps['deploymentAction']> = async (actionId, input, context) => {
    if (actionId !== 'deployments.environments.get') return submit(actionId, input, context);
    if (!('environmentId' in input)) throw new Error('Expected Environment');
    return DeploymentEnvironmentGetResultV1Schema.parse({ ok: true,
      environment: { v: 1, id: input.environmentId, serverId: 'home', projectSourceId: 'source', revision: 1,
        owner: { kind: 'account', accountId: 'account' }, protection: 'nonProduction', purpose: 'standard',
        deployerMode: 'managers', controllerMachineId: 'controller', createdByAccountId: 'account',
        contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1,
        capabilities: { role: 'manager', read: true, deploy: true, manage: true,
          manageBindings: true, manageTargets: true, delete: true }, createdAtMs: 1, updatedAtMs: 1 }, targetLinks: [] });
  };
  return transport;
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
    await handleActionsCommand(['invoke', request.actionId, '--input-json', JSON.stringify(input), ...(yes ? ['--yes'] : []), '--json'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: params => ({ ...createCliActionExecutorHarness({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null,
        onApprovalRequested: params.onApprovalRequested }, { ...createUnavailableActionTransportDeps(),
        runtimeActionExecute: native, approvalsGet: async () => request,
        approvalsUpdate: async () => ({ ok: true }) }).executor,
        resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }),
    });
    expect(JSON.parse(output), output).toMatchObject({ ok: true, data: receipt });
    expect(notice.mock.calls.flat().join(' ')).toContain('cli-forwarded');
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
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      projectsOpen: async () => result, isActionApprovalRequired: () => false });
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
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      // Current Environment metadata names a different controller. Only the
      // original returned operation address may select the observation host.
      deploymentAction: deployment,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deployment),
      actionOperationAction: args => executeActionOperationActionV1({ ...args, transport: rpc }),
      isActionApprovalRequired: () => false });
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
      ...createUnavailableActionTransportDeps(),
      sessionGoalGet: async () => ({ ok: false, errorCode: 'codex_goal_thread_unavailable',
        error: 'codex_goal_thread_unavailable', goalControlFailure }),
      isActionApprovalRequired: () => false,
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
      error: { code: 'codex_goal_thread_unavailable', message: 'codex_goal_thread_unavailable', goalControlFailure } });
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
      ...createUnavailableActionTransportDeps(),
      // The supported `code` failure spelling reaches the nested CLI normalizer
      // through a real Action success; native response data is a boundary.
      sessionGoalGet: async () => ({ ok: false, code: 'native_goal_refused', goalControlFailure: facet }),
      isActionApprovalRequired: () => false,
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
      isActionApprovalRequired: id => id === 'account.apiTokens.revoke' || id === 'account.apiTokens.revokeAll',
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
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const tokenId = 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d';
    const result = { token: `hap_v1_${tokenId}_${'S'.repeat(43)}`, apiToken: {
      tokenId, label: 'CLI trigger', displayPrefix: 'hap_v1_dd03e74b', createdAt: '2026-10-16T00:00:00.000Z',
      expiresAt: null, lastUsedAt: null, hasEncryptionAccess: false, hasUnattendedTeamAccess: false,
      grant: API_TOKEN_FULL_GRANT_V1, parentTokenId: null, activeChildCount: 0, embedConfig: null,
    } };
    const coordinator = createBlockingApprovalCoordinator();
    const cancellation = new AbortController();
    let request: ApprovalRequest | null = null;
    let onApprovalRequested: Parameters<typeof createCliActionExecutorHarness>[0]['onApprovalRequested'];
    const effect = vi.fn(async () => result);
    const { executor } = createCliActionExecutorHarness({ token: 'synthetic-account', sessionId: '', mode: 'plain', ctx: null,
      onApprovalRequested: (artifactId, signal, decide) => onApprovalRequested?.(artifactId, signal, decide) }, {
      // Account HTTP/Artifact persistence and device credential provenance are boundaries.
      accountApiTokensCreateAction: effect,
      isActionApprovalRequired: id => id === 'account.apiTokens.create',
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'cli-token-approval' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
      approvalsWaitForDecision: async args => ({ ...await coordinator.waitForDecision(args), request: request! }),
      approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
    });
    const invoke = handleActionsCommand(['invoke', 'account.apiTokens.create', '--input-json', JSON.stringify({ tokenId, label: 'CLI trigger' }), '--json'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: params => { onApprovalRequested = params.onApprovalRequested; return ({
        execute: (...[id, input, context]: Parameters<typeof executor.execute>) => executor.execute(id, input, {
          ...context, authority: 'present_user', runtimeAccountId: 'account-1', serverId: 'home-1', defaultSessionMachineId: 'token-machine',
        }),
        // This server lookup boundary must remain unreachable for an Account Action.
        resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); },
      }); },
    }, cancellation.signal);
    try {
      // ACT-ADMIT-ONCE-2: CLI result custody returns a deferred receipt and the
      // ordinary terminal confirmation decides it, without a blocking waiter.
      await invoke;
      expect(JSON.parse(output)).toMatchObject({ ok: true, data: result });
      expect(effect).toHaveBeenCalledOnce();
      expect(JSON.stringify(request)).not.toContain(result.token);
    } finally { cancellation.abort(); coordinator.dispose(); await invoke; }
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
      { limit: 200 },
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
      properties: { note: { type: 'string', allOf: [{ $ref: '#/definitions/Note' }] } },
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
    await handleActionsCommand(['invoke', actionId, '--note', 'invalid'], deps);
    expect(process.exitCode).toBe(1);
    expect(readInputs()).toEqual([{ note: 'review:done' }]);
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

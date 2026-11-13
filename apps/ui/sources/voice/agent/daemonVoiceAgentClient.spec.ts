import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ProviderBoundModelRefSchema} from '@happier-dev/protocol/providers/selection/v1';
import { ExecutionRunEnsureOrStartRequestSchema, ExecutionRunEnsureResponseSchema } from '@happier-dev/protocol/execution/runs/index';
import type { ExternalActionRequesterInvocationBaseV1 } from '@happier-dev/protocol/sessions/creation/externalActionRequesterInvocationBaseV1';
import { createDeferred, createSessionFixture } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } from '@/dev/testkit/fixtures/executionRunCapabilitiesDescribe';

const network = await installSessionOpsNetworkBoundary();
const { createSocketIoAckTimeoutError } = await import('@happier-dev/sync-client');
let home: Awaited<ReturnType<typeof network.addHome>>;
let voiceScope: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope;
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { readLocalConversationVoiceSettings, writeVoiceProviderSettingsConfig } = await import('@/sync/domains/settings/voiceSettings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { parseToken } = await import('@/utils/auth/parseToken');
const { buildAgentUniverseBackendTargetKey } = await import('@/agents/catalog/agentUniverse');

// The synthetic daemon reply belongs to the external Socket.IO boundary. The
// real scoped RPC owner still authenticates the Account, reads Session crypto,
// frames the request, classifies ACK failures and validates client responses.
const daemonRpc = vi.fn<(request: {
  sessionId: string; method: string; payload: Record<string, unknown>; timeoutMs: number | null;
  scope: { serverId: string; accountId: string };
}) => Promise<unknown>>();
const daemonAction = vi.fn<(request: Readonly<{ actionId: 'execution.run.start' | 'execution.run.ensure';
  input: Record<string, unknown>; signal?: AbortSignal | null }>) => Promise<unknown>>();
let actionBoundaries: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>>[] = [];
const admittedRunInvocations = new Map<string, ExternalActionRequesterInvocationBaseV1>();
function admittedRunStart() {
  const input = daemonAction.mock.calls[0]?.[0].input;
  if (!input) throw new Error('Expected a signed Run Start request');
  const { sessionId: _sessionId, ...start } = input;
  const request = ExecutionRunEnsureOrStartRequestSchema.parse({ start });
  if (!request.start) throw new Error('Expected Run Start input');
  return request.start;
}

const settingsState = {
  get current(): ReturnType<typeof settingsParse> { return storage.getState().settings; },
  set current(value: unknown) { storage.setState({ settings: settingsParse(value) }); },
};

function installDaemonBoundary() {
  network.setHttpResponder(async (input, init) => {
    for (const boundary of actionBoundaries) {
      const response = await boundary.handle(new URL(String(input)), init);
      if (response) return response;
    }
    const path = new URL(String(input)).pathname;
    if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
      features: { voice: { enabled: true } }, capabilities: { serverIdentity: { serverIdentityId: 'srv_voice_client' } },
    }));
    if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
    if (path === '/v2/sessions/read-batch') return null;
    const match = /^\/v2\/sessions\/([^/]+)$/.exec(path);
    if (!match) return null;
    const session = createSessionFixture({ id: decodeURIComponent(match[1]), serverId: home.id, active: true,
      metadata: { host: 'tester.local', machineId: 'machine-1', path: '/workspace', flavor: 'codex' } });
    return Response.json(createPlainSessionByIdResponseFixture(session));
  });
  network.setRpcResponder(async request => {
    if (!request.token || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) {
      throw new Error('Expected an authenticated daemon RPC with an object payload');
    }
    if (request.method === RPC_METHODS.CAPABILITIES_DESCRIBE) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
    if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
        || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) {
      // Mirror daemon admission at the public schema, including Profile custody.
      // A responsive Socket alone does not prove the daemon accepts the request.
      ExecutionRunEnsureOrStartRequestSchema.parse(request.payload);
    }
    return daemonRpc({
      sessionId: request.targetId, method: request.method, payload: request.payload as Record<string, unknown>,
      timeoutMs: request.timeoutMs, scope: { serverId: voiceScope.serverId, accountId: parseToken(request.token) },
    });
  });
}
afterAll(() => network.dispose());

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ state: 'resolved'; value: T } | { state: 'rejected'; reason: unknown } | { state: 'pending' }> {
  return await Promise.race([
    promise.then(
      (value) => ({ state: 'resolved', value } as const),
      (reason) => ({ state: 'rejected', reason } as const),
    ),
    sleep(timeoutMs).then(() => ({ state: 'pending' } as const)),
  ]);
}

describe('DaemonVoiceAgentClient', () => {
  it('starts Voice with the exact brokered Team model for chat and commit', async () => {
    const team = { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: 'muse-resource',
      expectedResourceRevision: 7, deliveryMode: 'brokered',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'muse-fast' } as const;
    daemonAction.mockResolvedValueOnce({ ok: true, runId: 'run_team_voice', created: true });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    await expect(new DaemonVoiceAgentClient(voiceScope).start({
      sessionId: 's1', agentId: 'codex', chatModelId: team.modelId, commitModelId: team.modelId,
      chatTeamCredentialModel: team, commitTeamCredentialModel: team,
      permissionIntent: 'read-only', idleTtlSeconds: 300, initialContext: 'ctx',
    })).resolves.toMatchObject({ voiceAgentId: 'run_team_voice' });
    const request = admittedRunStart();
    expect(request.teamCredentialModel).toEqual(team);
    expect(request.modelSelection).toBeUndefined();
    expect(request.intentInput).toMatchObject({ commitTeamCredentialModel: team });
  });
  it('retains the connected account diagnostic at the Voice RPC boundary', async () => {
    const uxDiagnostic = { code: 'connected_service_credential_reconnect_required', failurePhase: 'materialization',
      source: 'spawn_resume', serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', retryable: false,
      suggestedActions: ['reconnect_profile', 'open_connected_accounts'] };
    daemonAction.mockResolvedValueOnce({ ok: false, error: uxDiagnostic.code, errorCode: uxDiagnostic.code,
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' }, uxDiagnostic } });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    await expect(new DaemonVoiceAgentClient(voiceScope).start({
      sessionId: 's1', agentId: 'codex', chatModelId: 'fast', commitModelId: 'fast',
      permissionIntent: 'read-only', idleTtlSeconds: 300, initialContext: 'ctx',
    })).rejects.toMatchObject({ rpcErrorCode: uxDiagnostic.code, uxDiagnostic });
  });
  it('preserves a configured ACP Session target and exact model identity at daemon admission', async () => {
    daemonAction.mockResolvedValueOnce({ ok: true, runId: 'run_acp', created: true });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    await expect(new DaemonVoiceAgentClient(voiceScope).start({
      sessionId: 's1', agentSource: 'session', backendTarget: { kind: 'backend', backendId: 'qa-c-exact-args',
        configuredBackendId: 'qa-c-exact-args', sourceKind: 'configured' }, chatModelId: 'acp-chat', commitModelId: 'acp-commit',
      permissionIntent: 'read-only', idleTtlSeconds: 300, initialContext: 'ctx',
    })).resolves.toMatchObject({ voiceAgentId: 'run_acp' });
    expect(admittedRunStart()).toMatchObject({
      backendTarget: { kind: 'backend', backendId: 'qa-c-exact-args', configuredBackendId: 'qa-c-exact-args', sourceKind: 'configured' },
      modelSelection: { agentTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:qa-c-exact-args',
        providerConnectionId: null, modelId: 'acp-chat' },
      intentInput: { commitModelSelection: { agentTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:qa-c-exact-args',
        providerConnectionId: null, modelId: 'acp-commit' } },
    });
  });
  it('admits an Account Launch Profile without claiming plugin execution Profile custody', async () => {
    daemonAction.mockResolvedValueOnce({ ok: true, runId: 'run_persona', created: true });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    await expect(new DaemonVoiceAgentClient(voiceScope).start({
      sessionId: 's1', agentSource: 'session', agentId: 'codex', launchProfileId: '  account-persona  ',
      permissionIntent: 'read-only', idleTtlSeconds: 300, initialContext: 'ctx',
    })).resolves.toMatchObject({ voiceAgentId: 'run_persona' });
    const startRequest = admittedRunStart();
    expect(startRequest?.launchProfileId).toBe('account-persona');
    expect(startRequest?.profileId).toBeUndefined();
    expect(startRequest?.profileSourceCustody).toBeUndefined();
  });
  it('starts an inherited Voice choice through the signed Run Action', async () => {
    daemonAction.mockResolvedValue({ ok: true, runId: 'run_inherited', created: true });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    await expect(new DaemonVoiceAgentClient(voiceScope).start({
      sessionId: 's1', agentSource: 'session', agentId: 'codex', permissionIntent: 'read-only',
      idleTtlSeconds: 300, initialContext: 'ctx',
    })).resolves.toMatchObject({ voiceAgentId: 'run_inherited' });
    expect(daemonAction.mock.calls[0]?.[0]).toMatchObject({
      actionId: 'execution.run.start',
      input: { sessionId: 's1', intent: 'voice_agent' },
    });
  });
  it('carries a custom native Voice chat choice as an exact explicit model tuple', async () => {
    daemonAction.mockResolvedValueOnce({ ok: true, runId: 'run_native', created: true });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    await new DaemonVoiceAgentClient(voiceScope).start({
      sessionId: 's1', agentSource: 'session', agentId: 'codex', chatModelId: 'custom-chat',
      permissionIntent: 'read-only', idleTtlSeconds: 300, initialContext: 'ctx',
    });
    expect(admittedRunStart()).toMatchObject({
      modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'custom-chat' },
    });
  });

  it('carries a custom native commit choice as an exact explicit model tuple', async () => {
    daemonAction.mockResolvedValueOnce({ ok: true, runId: 'run_native_commit', created: true });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    await new DaemonVoiceAgentClient(voiceScope).start({
      sessionId: 's1', agentSource: 'agent', agentId: 'codex', chatModelId: 'custom-chat', commitModelId: 'custom-commit',
      permissionIntent: 'read-only', idleTtlSeconds: 300, initialContext: 'ctx',
    });
    const start = admittedRunStart();
    expect(start).toMatchObject({ intentInput: {
      commitModelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'custom-commit' },
    } });
  });

  beforeEach(async () => {
    network.resetRequests();
    actionBoundaries = [];
    admittedRunInvocations.clear();
    home = await network.addHome('https://voice-client.example.test', 'account-a', { serverIdentityId: 'srv_voice_client' });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(home.id);
    voiceScope = account.accountLifetime.scope;
    account.dispose();
    const session = createSessionFixture({ id: 's1', serverId: voiceScope.serverId, active: true,
      metadata: { host: 'tester.local', machineId: 'machine-1', path: '/workspace', flavor: 'codex' } });
    storage.setState({ sessions: { ...storage.getState().sessions, s1: session },
      sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId,
        [voiceScope.serverId]: { ...storage.getState().sessionListRowsByServerId[voiceScope.serverId], s1: session } } });
    installDaemonBoundary();
    daemonRpc.mockReset();
    daemonAction.mockReset();
    actionBoundaries = await Promise.all((['execution.run.start', 'execution.run.ensure'] as const).map(actionId =>
      createExternalActionAccountHttpBoundary({ serverUrl: home.serverUrl, serverIdentityId: 'srv_voice_client',
        accountId: 'account-a', machineId: 'machine-1', actionId, tokenEpoch: 0,
        failure: result => result && typeof result === 'object' && 'ok' in result && result.ok === false
          && 'error' in result && typeof result.error === 'string'
          ? { error: result.error, errorCode: 'errorCode' in result && typeof result.errorCode === 'string' ? result.errorCode : 'action_failed',
              ...('details' in result ? { details: result.details } : {}) } : null,
        execute: async (input, context) => {
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a Run Action request');
          const result = await daemonAction({ actionId, input: { ...input }, signal: context.signal });
          if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) return result;
          if (actionId === 'execution.run.ensure') {
            const runId = 'runId' in input && typeof input.runId === 'string' ? input.runId : '';
            return ExecutionRunEnsureResponseSchema.parse({ ok: true, actionInvocation: admittedRunInvocations.get(runId) });
          }
          const { caller, surface, authority } = context.invocation;
          const actionInvocation = { caller, surface, authority };
          if ('runId' in result && typeof result.runId === 'string') admittedRunInvocations.set(result.runId, actionInvocation);
          return { ...result, callId: 'voice-call-1', sidechainId: 'voice-sidechain-1', actionInvocation };
        },
      })));
    settingsState.current = {
      experiments: true,
      featureToggles: { voice: true, 'voice.agent': true, 'execution.runs': true },
      voice: {
        providerId: 'local_conversation',
        providers: {
          local_conversation: { schemaVersion: 1, config: {
            streaming: {
              enabled: false,
              turnReadPollIntervalMs: 25,
              turnReadMaxEvents: 64,
              turnStreamTimeoutMs: 300000,
            },
            networkTimeoutMs: 15000,
          } },
        },
      },
    };
  });

  it.each(['  Greeting.\n ', ' \n ', ''])('keeps explicitly admitted greeting bytes in the daemon request: %j', async welcomeText => {
    daemonRpc.mockResolvedValueOnce({ ok: true, result: { assistantText: 'welcome' } });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    await new DaemonVoiceAgentClient(voiceScope)
      .welcome({ sessionId: 'history', voiceAgentId: 'run', welcomeText });
    expect(daemonRpc.mock.calls[0]?.[0].payload).toMatchObject({
      actionId: 'voice_agent.welcome', input: { welcomeText },
    });
  });

  it('preserves the signed Start failure code', async () => {
    daemonAction.mockResolvedValueOnce({ ok: false, error: 'unsupported', errorCode: 'VOICE_AGENT_UNSUPPORTED',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    await expect(
      client.start({
        sessionId: 's1',
        agentSource: 'agent',
        agentId: 'codex',
        verbosity: 'short',
        chatModelId: 'fast',
        commitModelId: 'fast',
        permissionIntent: 'read-only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
      }),
    ).rejects.toMatchObject({ message: 'unsupported', rpcErrorCode: 'VOICE_AGENT_UNSUPPORTED' });
  });

  it.each([undefined, '', '   '])('rejects missing or blank agentId before RPC (%s)', async (agentId) => {
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    await expect(
      client.start({
        sessionId: 's1',
        agentSource: 'session',
        ...(agentId === undefined ? {} : { agentId }),
        verbosity: 'short',
        chatModelId: 'fast',
        commitModelId: 'fast',
        permissionIntent: 'read-only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
      }),
    ).rejects.toMatchObject({
      message: 'voice_agent_selection_unavailable',
      code: 'VOICE_AGENT_SELECTION_UNAVAILABLE',
    });

    expect(daemonAction).not.toHaveBeenCalled();
  });

  it('ensures the exact retained Run without starting a replacement', async () => {
    daemonAction.mockResolvedValue({ ok: true, runId: 'run_old', created: true });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);
    const params = {
        sessionId: 's1',
        agentSource: 'agent',
        agentId: 'codex',
        verbosity: 'short',
        chatModelId: 'fast',
        commitModelId: 'fast',
        commitIsolation: true,
        permissionIntent: 'read-only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
        retentionPolicy: 'resumable',
    } satisfies import('./types').VoiceAgentStartParams;
    const admitted = await client.start(params);
    expect(admitted.actionInvocation).toMatchObject({ caller: { kind: 'host' }, surface: 'voice', authority: 'present_user' });
    daemonAction.mockClear();
    await expect(client.start({ ...params, existingRunId: 'run_old' })).resolves.toEqual(admitted);

    expect(daemonAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'execution.run.ensure',
        input: {
          sessionId: 's1',
          runId: 'run_old',
          resume: true,
        },
      }),
    );
    expect(daemonAction).toHaveBeenCalledTimes(1);
  });

  it('carries independent chat and commit Provider selections without endpoint or secret material', async () => {
    daemonAction.mockResolvedValueOnce({ ok: true, runId: 'run_provider', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);
    const chatModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'agent:happier.agent.opencode/opencode',
      providerConnectionId: 'voice-openai-compatible-chat',
      modelId: 'chat-model',
    });
    const commitModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'agent:happier.agent.opencode/opencode',
      providerConnectionId: 'voice-openai-compatible-chat',
      modelId: 'commit-model',
    });

    await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'opencode',
      verbosity: 'short',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      chatModelSelection,
      commitModelSelection,
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 0,
        overrides: { temperature: { updatedAt: 0, value: 0.2 } },
      },
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
    });

    const call = daemonAction.mock.calls[0]?.[0] as any;
    expect(call.actionId).toBe('execution.run.start');
    expect(call.input).toMatchObject({
      modelId: 'chat-model',
      modelSelection: chatModelSelection,
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      intentInput: { commitModelSelection },
      sessionConfigOptionOverrides: {
        overrides: { temperature: { value: 0.2 } },
      },
    });
    expect(JSON.stringify(call.input)).not.toMatch(/baseUrl|apiKey|secret/i);
  });

  it.each(['chat', 'commit'] as const)(
    'admits a Provider-bound %s selection through signed Start',
    async (role) => {
        daemonAction.mockResolvedValueOnce({ ok: true, runId: `run_${role}`, created: true } as any);

      const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
      const client = new DaemonVoiceAgentClient(voiceScope);
      const providerSelection = ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'agent:happier.agent.opencode/opencode',
        providerConnectionId: 'voice-openai-compatible-chat',
        modelId: `${role}-model`,
      });

      await client.start({
        sessionId: 's1',
        agentSource: 'agent',
        agentId: 'opencode',
        verbosity: 'short',
        chatModelId: role === 'chat' ? providerSelection.modelId : 'native-chat',
        commitModelId: role === 'commit' ? providerSelection.modelId : 'native-commit',
        ...(role === 'chat'
          ? { chatModelSelection: providerSelection }
          : { commitModelSelection: providerSelection }),
        permissionIntent: 'read-only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
      });

      expect(daemonAction).toHaveBeenCalledTimes(1);
      expect(daemonAction).toHaveBeenCalledWith(expect.objectContaining({
        actionId: 'execution.run.start',
      }));
    },
  );

  it('preserves exact native model selections through signed Start', async () => {
    daemonAction.mockResolvedValueOnce({ ok: true, runId: 'run_native', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);
    const chatModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: buildAgentUniverseBackendTargetKey('codex'),
      providerConnectionId: null,
      modelId: 'chat-model',
    });
    const commitModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: buildAgentUniverseBackendTargetKey('codex'),
      providerConnectionId: null,
      modelId: 'commit-model',
    });

    await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'codex',
      verbosity: 'short',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      chatModelSelection,
      commitModelSelection,
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
    });

    expect(daemonAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'execution.run.start',
    }));
  });

  it('forwards replay seed requests through signed Start', async () => {
    daemonAction.mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'codex',
      verbosity: 'short',
      chatModelId: 'fast',
      commitModelId: 'fast',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sys_voice',
        transcriptEpoch: 3,
        strategy: 'summary_plus_recent',
        recentMessagesCount: 12,
        summaryRunner: {
          v: 1,
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          modelId: 'default',
          permissionMode: 'no_tools',
        },
      },
    } as any);

    expect(daemonAction).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
            replay: expect.objectContaining({
              kind: 'voice_session.v1',
              previousSessionId: 'sys_voice',
              transcriptEpoch: 3,
              strategy: 'summary_plus_recent',
              recentMessagesCount: 12,
            }),
        }),
      }),
    );
  });

  it('does not impose a deadline on the signed Start request', async () => {
    const entered = createDeferred<void>();
    const response = createDeferred<unknown>();
    daemonAction.mockImplementationOnce(async () => { entered.resolve(); return await response.promise; });

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    let settled = false;
    const starting = client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'claude',
      verbosity: 'short',
      chatModelId: 'fast',
      commitModelId: 'fast',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
    }).finally(() => { settled = true; });
    await entered.promise;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const networkTimeoutMs = readLocalConversationVoiceSettings(settingsState.current.voice).networkTimeoutMs;
      await vi.advanceTimersByTimeAsync(networkTimeoutMs);
      expect(settled).toBe(false);
      response.resolve({ ok: true, runId: 'run_1', created: true });
      await expect(starting).resolves.toMatchObject({ voiceAgentId: 'run_1' });
    } finally {
      vi.useRealTimers();
      response.resolve({ ok: true, runId: 'run_1', created: true });
      await starting;
    }
  });

  it('keeps an explicit provider bootstrap budget separate from the acknowledgement lifetime', async () => {
    daemonAction.mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'claude',
      verbosity: 'short',
      chatModelId: 'fast',
      commitModelId: 'fast',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
      bootstrapTimeoutMs: 90_000,
    });

    expect(daemonAction).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ bootstrapTimeoutMs: 90_000 }),
      }),
    );
  });

  it('uses an unbounded acknowledgement lifetime for Voice action and stream lifecycle RPCs', async () => {
    daemonRpc.mockImplementation(async ({ method, payload }: any) => {
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION) {
        return payload.actionId === 'voice_agent.welcome'
          ? { ok: true, result: { assistantText: 'welcome' } }
          : { ok: true, result: { commitText: 'commit' } };
      }
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) return { streamId: 'stream-v1' };
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) return { streamId: 'stream-v2' };
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) return { ok: true };
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);
    await client.welcome({ sessionId: 's1', voiceAgentId: 'run-1' });
    await client.commit({ sessionId: 's1', voiceAgentId: 'run-1', kind: 'session_instruction' });
    await client.startTurnStream({ sessionId: 's1', voiceAgentId: 'run-1', userText: 'v1' });
    await client.startTurnStream({
      sessionId: 's1',
      voiceAgentId: 'run-1',
      userText: 'v2',
      userTranscript: { mode: 'persist', localId: 'local-1' },
    });
    await client.cancelTurnStream({ sessionId: 's1', voiceAgentId: 'run-1', streamId: 'stream-v2' });

    expect(daemonRpc.mock.calls.map(([call]) => ({
      method: call.method,
      timeoutMs: call.timeoutMs,
    }))).toEqual([
      { method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, timeoutMs: null },
      { method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, timeoutMs: null },
      { method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, timeoutMs: null },
      { method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2, timeoutMs: null },
      { method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL, timeoutMs: null },
    ]);
  });

  it('admits the configured speech latency target on the real streamed turn request', async () => {
    const { ExecutionRunTurnStreamStartRequestSchema} = await import('@happier-dev/protocol/execution/runs/streaming');
    const local = readLocalConversationVoiceSettings(settingsState.current.voice);
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
      voice: writeVoiceProviderSettingsConfig(settingsState.current.voice, 'local_conversation', {
        ...local, streaming: { ...local.streaming, ttsChunkChars: 120 },
      }),
    }, settingsState.current));
    expect(readLocalConversationVoiceSettings(settingsState.current.voice).streaming.ttsChunkChars).toBe(120);
    let admittedTarget: unknown;
    daemonRpc.mockImplementation(async ({ method, payload }) => {
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) {
        admittedTarget = ExecutionRunTurnStreamStartRequestSchema.parse(payload).speechSegmentTargetChars;
        return { streamId: 'target-stream' };
      }
      return {
        streamId: 'target-stream', nextCursor: 1, done: true,
        events: [{ t: 'voice_output', output: { v: 1, kind: 'turn_final', turnId: 'target-stream', seq: 0, text: 'Done.' } }],
      };
    });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);
    await expect(client.sendTurn({ sessionId: 's1', voiceAgentId: 'run-1', userText: 'go' }))
      .resolves.toMatchObject({ assistantText: 'Done.' });
    expect(admittedTarget).toBe(120);
  });

  it('keeps default native resets distinct from omitted inherited model choices', async () => {
    daemonAction.mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'codex',
      verbosity: 'short',
      chatModelId: 'default',
      commitModelId: 'default',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
    });

    expect(admittedRunStart()).toMatchObject({ modelSelection: null, commitModelId: 'default' });
    const payload = daemonAction.mock.calls[0]?.[0].input;
    expect(payload).not.toHaveProperty('chatModelId');
  });

  it('surfaces an acknowledgement timeout as outcome-unknown without retrying Start', async () => {
    daemonAction
      .mockRejectedValueOnce(createSocketIoAckTimeoutError())
      .mockResolvedValueOnce({ ok: true, runId: 'run_retry', created: true } as any);

    const { DaemonVoiceAgentClient, VoiceAgentStartOutcomeUnknownError } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    const error = await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'codex',
      verbosity: 'short',
      chatModelId: 'fast',
      commitModelId: 'fast',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
    }).catch((caught: unknown) => caught);

    expect(daemonAction).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(VoiceAgentStartOutcomeUnknownError);
    expect(error).toMatchObject({
      code: 'VOICE_AGENT_START_OUTCOME_UNKNOWN',
      message: 'Voice agent start acknowledgement was not received; outcome is unknown',
    });
  });

  it('forwards displayUserText separately from the execution payload when starting a turn stream', async () => {
    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    daemonRpc.mockResolvedValueOnce({ streamId: 'stream-1' } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    await expect(
      client.startTurnStream({
        sessionId: 'session-1',
        voiceAgentId: 'run-1',
        userText: 'Context updates since your last voice turn:\n\nSession asks a question.\n\nUser said:\nCreate the file.',
        displayUserText: 'Create the file.',
      } as any),
    ).resolves.toEqual({ streamId: 'stream-1' });

    expect(daemonRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
        payload: expect.objectContaining({
          runId: 'run-1',
          message: expect.stringContaining('Context updates since your last voice turn'),
          displayMessage: 'Create the file.',
        }),
      }),
    );
  });

  it('uses v2 for explicit transcript custody and preserves the opaque local id', async () => {
    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    daemonRpc.mockResolvedValueOnce({ streamId: 'stream-1' } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    await client.startTurnStream({
      sessionId: 'session-1',
      voiceAgentId: 'run-1',
      userText: 'Outer prompt',
      userTranscript: { mode: 'persist', localId: ' opaque-local-id ' },
    });

    expect(daemonRpc).toHaveBeenCalledTimes(1);
    expect(daemonRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
      payload: expect.objectContaining({
        userTranscript: { mode: 'persist', localId: ' opaque-local-id ' },
      }),
    }));
  });

  it('fails closed when v2 is unavailable without retrying legacy v1', async () => {
    daemonRpc.mockRejectedValueOnce(
      Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    await expect(client.startTurnStream({
      sessionId: 'session-1',
      voiceAgentId: 'run-1',
      userText: 'Outer prompt',
      userTranscript: { mode: 'persist', localId: 'opaque-local-id' },
    })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });

    expect(daemonRpc).toHaveBeenCalledTimes(1);
  });

  it('commits a direct-shortcut user transcript with the exact caller local id', async () => {
    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    daemonRpc.mockResolvedValueOnce({ ok: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    await expect(client.commitUserTranscript({
      sessionId: 'session-1',
      voiceAgentId: 'run-1',
      text: 'Approve it.',
      displayText: 'Approve the requested action.',
      localId: ' opaque-shortcut-id ',
    })).resolves.toEqual({ ok: true });

    // Current writer consumed by the prospective predecessor reader at
    // ../remote-dev@0649e4de85aacf08476063fef1990f418ce8e80b:
    // apps/cli/src/rpc/handlers/executionRuns.ts.
    expect(daemonRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1,
      payload: {
        runId: 'run-1',
        message: 'Approve it.',
        displayMessage: 'Approve the requested action.',
        localId: ' opaque-shortcut-id ',
      },
    }));
  });

  it('preserves a Provider-bound Start refusal without falling back', async () => {
    daemonAction.mockResolvedValueOnce({ ok: false, error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);
    const chatModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'agent:happier.agent.opencode/opencode',
      providerConnectionId: 'voice-openai-compatible-chat',
      modelId: 'fast',
    });

    await expect(
      client.start({
        sessionId: 's1',
        agentSource: 'agent',
        agentId: 'opencode',
        verbosity: 'short',
        chatModelId: 'fast',
        commitModelId: 'fast',
        chatModelSelection,
        permissionIntent: 'read-only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
      }),
    ).rejects.toMatchObject({ message: 'RPC method not available', rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });

    expect(daemonAction).toHaveBeenCalledTimes(1);
    expect(daemonAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'execution.run.start',
    }));
  });

  it('treats malformed Start receipts as outcome-unknown without retrying', async () => {
    daemonAction.mockResolvedValueOnce({ runId: 123 } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    await expect(
      client.start({
        sessionId: 's1',
        agentSource: 'session',
        agentId: 'codex',
        verbosity: 'short',
        chatModelId: 'fast',
        commitModelId: 'fast',
        permissionIntent: 'read-only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
      }),
    ).rejects.toMatchObject({ code: 'VOICE_AGENT_START_OUTCOME_UNKNOWN',
      cause: { message: 'execution_run_invalid_response' } });
    expect(daemonAction).toHaveBeenCalledTimes(1);
  });

  it('returns commitText from execution.run.action result payloads', async () => {
    daemonRpc.mockResolvedValueOnce({ ok: true, result: { commitText: 'c1' } } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);
    await expect(
      client.commit({ sessionId: 's1', voiceAgentId: 'run_1', kind: 'session_instruction' }),
    ).resolves.toEqual({ commitText: 'c1' });
  });

  it('throws invalid_rpc_response for malformed stream read payloads', async () => {
    daemonRpc.mockResolvedValueOnce({ streamId: 's1', events: 'bad' as any, nextCursor: 1, done: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    await expect(
      client.readTurnStream({
        sessionId: 'session-1',
        voiceAgentId: 'm1',
        streamId: 'stream-1',
        cursor: 0,
      }),
    ).rejects.toThrow('invalid_rpc_response');
  });

  it('sendTurn aborts the in-flight turn and cancels the daemon stream when the signal fires', async () => {
    settingsState.current = {
      voice: {
        providerId: 'local_conversation',
        providers: {
          local_conversation: { schemaVersion: 1, config: {
            streaming: {
              enabled: false,
              turnReadPollIntervalMs: 10,
              turnReadMaxEvents: 64,
              turnStreamTimeoutMs: null,
            },
            networkTimeoutMs: 15000,
          } },
        },
      },
    };

    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    let cancelCalled = false;
    const readEntered = createDeferred<void>();
    const cancelEntered = createDeferred<void>();
    daemonRpc.mockImplementation(async (args: any) => {
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) {
        return { streamId: 'stream-1' } as any;
      }
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        readEntered.resolve();
        return { streamId: 'stream-1', events: [], nextCursor: 0, done: false } as any;
      }
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) {
        cancelCalled = true;
        cancelEntered.resolve();
        return { ok: true } as any;
      }
      throw new Error(`unexpected rpc method: ${String(args?.method ?? '')}`);
    });

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    const controller = new AbortController();
    const sendPromise = client.sendTurn({
      sessionId: 'session-1',
      voiceAgentId: 'm1',
      userText: 'hello',
      signal: controller.signal,
    });

    await readEntered.promise;
    expect(daemonRpc.mock.calls.some(([request]) =>
      request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ)).toBe(true);

    const halfway = await settleWithin(sendPromise, 40);
    expect(halfway.state).toBe('pending');

    controller.abort();

    const outcome = await settleWithin(sendPromise, 300);
    expect(outcome.state).toBe('rejected');
    expect(String(outcome.state === 'rejected' ? (outcome.reason as any)?.name ?? '' : '')).toBe('AbortError');
    await cancelEntered.promise;
    expect(cancelCalled).toBe(true);
  });

  it('sendTurn does not fall back to networkTimeoutMs when turnStreamTimeoutMs is null', async () => {
    settingsState.current = {
      voice: {
        providerId: 'local_conversation',
        providers: {
          local_conversation: { schemaVersion: 1, config: {
            streaming: {
              enabled: false,
              turnReadPollIntervalMs: 10,
              turnReadMaxEvents: 64,
              turnStreamTimeoutMs: null,
            },
            networkTimeoutMs: 25,
          } },
        },
      },
    };

    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    let readCount = 0;
    daemonRpc.mockImplementation(async (args: any) => {
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) {
        return { streamId: 'stream-1' } as any;
      }
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        readCount += 1;
        if (readCount >= 8) {
          return {
            streamId: 'stream-1',
            events: [{ t: 'done', assistantText: 'ok', actions: [] }],
            nextCursor: readCount,
            done: true,
          } as any;
        }
        return { streamId: 'stream-1', events: [], nextCursor: readCount, done: false } as any;
      }
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) {
        return { ok: true } as any;
      }
      throw new Error(`unexpected rpc method: ${String(args?.method ?? '')}`);
    });

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient(voiceScope);

    const sendPromise = client.sendTurn({ sessionId: 'session-1', voiceAgentId: 'm1', userText: 'hello' });

    const halfway = await settleWithin(sendPromise, 40);
    expect(halfway.state, halfway.state === 'rejected' ? String(halfway.reason) : undefined).toBe('pending');

    const outcome = await settleWithin(sendPromise, 300);
    expect(outcome.state).toBe('resolved');
    expect(outcome.state === 'resolved' ? outcome.value : null).toEqual({ assistantText: 'ok', actions: [] });
    expect(readCount).toBeGreaterThanOrEqual(8);
  });

});

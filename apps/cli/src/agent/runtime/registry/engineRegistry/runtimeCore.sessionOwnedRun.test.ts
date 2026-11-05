import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { accountSettingsParse, FeaturesResponseSchema, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { loadMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import type {
  AgentExecutionRunRuntime,
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntimeContextV1,
  AgentRuntime,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  ResolvedAgentContribution,
  ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';
import { createExecutionRunOccurrenceWitnessRegistry } from '@/agent/runtime/bridges/executionRun/runOccurrenceWitness';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { AgentState, Metadata } from '@/api/types';
import { createNativeAgentSessionWorkStateService } from './nativeAgentSessionWorkState';

import { createEmptyBackendExecutionSurfaces } from '../engineRegistryTypes';
import type { NativeAgentSessionRunToolBindingRequest } from '../engineRegistryTypes';
import { resolveBackendRuntimeCore, resolveSessionOwnedRunToolPolicy } from './runtimeCore';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import { createRunScopedExecutionPermissionHandler } from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';
import { createExecutionRunAccountSettingsSnapshotResolver } from '@/api/machine/resolveExecutionRunAccountSettingsSnapshot';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createManifestAgentCatalogEntry } from '@/plugins/projection/registry/agentCliMetadata';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createClaudeNativeAgentSdkContext } from '../../../../../../../packages/plugins/claude/src/agent/runtime/nativeServices';
import { createClaudeUnifiedResumeChoiceStartupHandler } from '../../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/resumeChoice/startup';
import { parseClaudeScreenState } from '../../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/screenState';
import { createFakeControlPort } from '../../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/tuiControls/fakeControlPort';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerSessionClientRuntimeHandlers } from '@/api/session/client/executionRuns/registerSessionClientRuntimeHandlers';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { applySessionRuntimeControls } from '@/api/session/sessionRuntimeControls';
import { decodeExecutionRunProfileResult } from '@happier-dev/protocol/execution/runs/resultContract';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetInMemoryAccountSettingsContextForTests(); });

const AGENT_ID = 'acme.session-agent';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      // Source runtime tests do not consume a remote host's ignored package-build failures.
      if (String(args[0]).replaceAll('\\', '/').endsWith('/.project/tmp/bundled-plugin-publication/failures.json')) return '[]';
      return fs.readFileSync(...args);
    },
  };
});

function createContributions() {
  const backend = {
    id: AGENT_ID,
    agentId: AGENT_ID,
    provenance: 'external',
    source: { kind: 'path' },
    definition: { kindVersion: 1, id: AGENT_ID, agentId: AGENT_ID },
    pluginId: AGENT_ID,
  } as unknown as ResolvedAgentRuntimeContribution;
  const agent = {
    id: AGENT_ID,
    identity: { pluginId: AGENT_ID, localId: AGENT_ID },
    provenance: 'external',
    source: { kind: 'path' },
    definition: { kindVersion: 1, id: AGENT_ID, ownedBackendIds: [AGENT_ID] },
    richDefinition: {
      provenance: 'external',
      definition: {
        id: AGENT_ID,
        title: { key: 'agents.acme.title', fallback: 'Acme' },
        description: { key: 'agents.acme.description', fallback: 'Acme' },
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
          tools: { delivery: 'native_mcp' },
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn'],
            cancel: true,
            executionRunContext: { versions: [1] },
            workStateSources: [{ id: 'tasks', itemKinds: ['task'] }],
          },
        },
      },
    },
    pluginId: AGENT_ID,
  } as unknown as ResolvedAgentContribution;
  if (agent.richDefinition?.provenance !== 'external') throw new Error('Expected external Agent fixture');
  const catalogEntry = createManifestAgentCatalogEntry({
    agentId: AGENT_ID, pluginId: AGENT_ID, definition: agent.richDefinition.definition,
    cli: null, provenance: 'external',
  });
  const contributes = createResolvedContributionRegistry({ agents: [{ ...agent, catalogEntry }] });
  return { backend, agent, contributes };
}

describe('resolveBackendRuntimeCore Session-owned Execution Run scope', () => {
  it('publishes a terminal child workspace trust question through the real child context', async () => {
    const { backend, agent } = createContributions();
    setActiveAccountSettingsSnapshot({ scopeKey: 'child-trust', source: 'network', settingsVersion: 1,
      settings: accountSettingsParse({}), rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] },
    });
    let state: AgentState = { requests: {}, completedRequests: {} };
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'trust-parent', encryptionMode: 'plain', logger: () => {} });
    // Session persistence/RPC ingress and the native terminal are the boundaries.
    const parent = { sessionId: 'trust-parent', rpcHandlerManager,
      getMetadataSnapshot: () => ({ path: '/parent', machineId: 'machine-a' }),
      getAgentStateSnapshot: () => state, updateMetadata: async () => undefined,
      updateAgentState: async (update: (previous: AgentState) => AgentState) => { state = update(state); },
      enqueueAgentMessageCommitted: async () => undefined,
      setExecutionRunWorkerUpdateSource: () => {},
    };
    const permissions = new ProviderEnforcedPermissionHandler(parent as unknown as ApiSessionClient, { logPrefix: '[ChildTrust]' });
    const token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"trust-owner"}').toString('base64url')}.`;
    const metadata = createTestMetadata({ path: '/parent', machineId: 'machine-a' });
    const controls: SessionRuntimeControls = {};
    applySessionRuntimeControls(controls, { readPermissionHandler: () => permissions });
    // Compose the actual Session RPC registrar with the existing runtime permission owner.
    // Registration must not create a competing responder that settles only AgentState.
    const registration = registerSessionClientRuntimeHandlers({
      rpcHandlerManager, token, serverId: 'trust-home', serverUrl: 'http://127.0.0.1:1',
      readOwnerAccountCredentials: async () => ({ token, encryption: null }),
      metadataPath: '/parent', metadata, sessionId: parent.sessionId,
      session: parent as unknown as ApiSessionClient, getSessionMetadata: () => metadata,
      sessionRuntimeControls: controls,
      enqueueSessionUserMessage: async () => {},
      enqueueUserTextMessageCommitted: async () => ({ persisted: true, delivered: true }),
      enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: true }),
      enqueueVoiceAgentTranscriptTurnCommitted: async () => ({ persisted: true, delivered: true }),
      sendAgentMessageEphemeral: () => ({ accepted: true, epoch: 0 }),
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
    });
    const trust = 'Accessing workspace:\n/tmp/new-child\nQuick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder\nEnter to confirm · Esc to cancel';
    const focusedTrust = trust.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust this folder', '❯ Yes, I trust this folder');
    const port = createFakeControlPort({ captures: [trust, focusedTrust, '──────────────────────────────\n❯ \n──────────────────────────────'] });
    let startup: ReturnType<typeof createClaudeUnifiedResumeChoiceStartupHandler> | undefined;
    let context: AgentSessionRuntimeContext | undefined;
    const adapter = await resolveBackendRuntimeCore({
      backend, agent, runtimeRegistry: null, executionSurfaces: createEmptyBackendExecutionSurfaces(),
      runtimeOwner: { backendId: AGENT_ID,
        selected: { kind: 'plugin_engine', ownerId: AGENT_ID, provenance: 'external', pluginId: AGENT_ID }, candidates: [] },
      nativeAgentRuntime: { sessions: { open: async (_request, childContext) => {
        context = childContext;
        startup = createClaudeUnifiedResumeChoiceStartupHandler({ ctx: createClaudeNativeAgentSdkContext(childContext),
          sessionId: parent.sessionId, port, settleMs: 0, wait: async () => undefined });
        await startup.handle(parseClaudeScreenState(trust));
        return { send: async () => ({ status: 'admitted' }), cancel: async () => ({ status: 'notRunning' }),
          watch: () => ({ dispose() {} }), dispose: async () => { await startup?.dispose(); } };
      } } },
      nativeAgentRuntimeIdentity: { pluginId: AGENT_ID, pluginVersion: '1.0.0', agentId: AGENT_ID,
        localAgentId: 'default', occurrenceId: 'agent-occurrence', sourceCustody: { kind: 'managed', immutableGenerationId: 'child-trust-generation', installSource: 'npm' },
        isCurrent: () => true },
      // The real runner operation bundle has no live Session permission binding.
      createNativeAgentInvocationServices: async () => createUnavailablePluginServices(),
    });
    const runtime = adapter!.runtimeCore.createExecutionRunBackend({
      scope: 'session_owned', cwd: '/tmp/new-child', runId: 'trust-child', controllerOccurrenceId: 'trust-child-occurrence',
      backendId: AGENT_ID, permissionMode: 'read_only',
      start: { intent: 'delegate', runClass: 'bounded', retentionPolicy: 'ephemeral', ioMode: 'request_response' },
      sessionInteractionHost: { session: parent as unknown as ApiSessionClient, machineId: 'machine-a', permissionHandler: controls.readPermissionHandler!()!,
        readOwnerAccountCredentials: async () => ({ token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } }),
      },
    });
    try {
      await runtime!.provisionRuntime!();
      await vi.waitFor(() => expect(Object.keys(state.requests ?? {})).toHaveLength(1));
      const [requestId, request] = Object.entries(state.requests ?? {})[0]!;
      expect(requestId).toContain('execution-run:trust-child:trust-child-occurrence:');
      expect(request).toMatchObject({ tool: 'AskUserQuestion', arguments: { happierDialog: { dialogId: 'trust_folder' } } });
      expect(port.sentLiteral).toEqual([]);
      await rpcHandlerManager.handleRequest({ method: `${parent.sessionId}:session.user_action.answer`,
        params: { id: requestId, approved: true, answers: { claudeUnifiedTerminalTrustFolder: ['trust_once'] } },
        callerAuthority: 'present_user',
      });
      await vi.waitFor(() => expect(state.requests?.[requestId]).toBeUndefined());
      expect(port.sentKeys).toEqual(['ArrowDown', 'Enter']);
      expect(state.completedRequests?.[requestId]).toMatchObject({ status: 'approved' });
      await expect(context!.services.sessions.current!.permissions.requestDecision({ requestId: 'unadmitted-edit', toolName: 'Edit', input: {} }))
        .resolves.toEqual({ decision: 'denied' });
    } finally {
      await startup?.dispose();
      await runtime?.dispose();
      await permissions.abortPendingRequestsAndFlush('test cleanup');
      await registration.dispose();
      applySessionRuntimeControls(controls, null);
    }
  });

  it.each([
    { mode: 'read_only', writes: 'deny' as const, read: { decision: 'approved' }, edit: { decision: 'denied' } },
    { mode: 'no_tools', writes: 'deny' as const, read: { decision: 'denied' }, edit: { decision: 'denied' } },
    { mode: 'default', writes: 'deny' as const, read: null, edit: { decision: 'denied' } },
    { mode: 'default', writes: 'allow' as const, read: null, edit: null },
  ])('enforces the $mode Run ceiling without a recipe allowlist (workspace writes=$writes)', async ({ mode, writes, read, edit }) => {
    const parent = createExecutionRunPermissionHandler({ permissionMode: 'default', backendId: AGENT_ID });
    const scope = createRunScopedExecutionPermissionHandler({ runId: 'child', controllerOccurrenceId: 'child-occurrence', handler: parent,
      toolPolicy: resolveSessionOwnedRunToolPolicy({ agentId: AGENT_ID, parentMetadata: null,
        options: { permissionMode: mode, workspaceWrites: writes } }),
    });
    expect(scope.handler.getImmediateDecision?.('read', 'Read', { file_path: '/pinned/context.txt' })).toEqual(read);
    expect(scope.handler.getImmediateDecision?.('edit', 'Edit', { file_path: '/pinned/context.txt', old_string: 'before', new_string: 'after' })).toEqual(edit);
    await scope.dispose('Test completed');
  });

  it.each([
    { label: 'legacy omission', causal: {}, expected: 'approved_for_session' },
    { label: 'own undefined', causal: { causalPermissionAuthority: undefined }, expected: 'denied' },
    { label: 'own null', causal: { causalPermissionAuthority: null }, expected: 'denied' },
    { label: 'valid admission', causal: { causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const,
      admittedPermissionCeiling: 'default' as const } }, expected: 'approved_for_session' },
  ])('preserves $label through the attached Run permission projection', async ({ causal, expected }) => {
    const parent = createExecutionRunPermissionHandler({ permissionMode: 'default', backendId: AGENT_ID, allowedTools: ['Read'] });
    const options: Parameters<typeof resolveSessionOwnedRunToolPolicy>[0]['options'] = {
      permissionMode: 'default', start: { allowedTools: ['Read'], unlistedTools: 'deny' },
    };
    // Model invalid/lost authority at the host boundary without asserting that
    // its malformed value satisfies the admitted authority TypeScript type.
    for (const [key, value] of Object.entries(causal)) Reflect.defineProperty(options, key, { value, enumerable: true });
    const run = createRunScopedExecutionPermissionHandler({ runId: 'child', controllerOccurrenceId: 'child-occurrence', handler: parent,
      toolPolicy: resolveSessionOwnedRunToolPolicy({ agentId: AGENT_ID, parentMetadata: null, options }),
    });
    await expect(run.handler.handleToolCall('read', 'Read', { file_path: '/repo/a' })).resolves.toEqual({ decision: expected });
    await run.dispose('Test completed');
  });
  it.each([
    {},
    { allowedTools: ['Read'], unlistedTools: 'deny' as const },
    { allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'ask' as const },
  ])('refuses a child recipe that broadens a confined parent before native open: %j', async (toolPolicy) => {
    const { backend, agent } = createContributions();
    const open = vi.fn();
    const adapter = await resolveBackendRuntimeCore({
      backend, agent, executionSurfaces: createEmptyBackendExecutionSurfaces(),
      runtimeOwner: { backendId: AGENT_ID,
        selected: { kind: 'plugin_engine', ownerId: AGENT_ID, provenance: 'external', pluginId: AGENT_ID }, candidates: [] },
      nativeAgentRuntime: { sessions: { open } } as unknown as AgentRuntime,
      nativeAgentRuntimeIdentity: { pluginId: AGENT_ID, pluginVersion: '1.0.0', agentId: AGENT_ID,
        occurrenceId: 'agent-occurrence', isCurrent: () => true },
    } as never);
    expect(() => adapter?.runtimeCore.createExecutionRunBackend({
      scope: 'session_owned', cwd: '/parent', runId: 'child', controllerOccurrenceId: 'child-occurrence',
      callId: 'child-call', sidechainId: 'child-side', backendId: AGENT_ID, permissionMode: 'yolo',
      start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable', ...toolPolicy },
      sessionInteractionHost: { session: { sessionId: 'parent', getMetadataSnapshot: () => ({
        path: '/parent', allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny',
      }) }, machineId: 'machine-a', permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }), abortPendingRequestAndFlush: async () => undefined,
      } },
    } as never)).toThrow(expect.objectContaining({ executionRunErrorCode: 'execution_run_not_allowed' }));
    expect(open).not.toHaveBeenCalled();
  });

  it('admits the same confined parent policy when the Run list is reordered', async () => {
    const { backend, agent } = createContributions();
    const open = vi.fn();
    const adapter = await resolveBackendRuntimeCore({
      backend, agent, executionSurfaces: createEmptyBackendExecutionSurfaces(),
      runtimeOwner: { backendId: AGENT_ID,
        selected: { kind: 'plugin_engine', ownerId: AGENT_ID, provenance: 'external', pluginId: AGENT_ID }, candidates: [] },
      nativeAgentRuntime: { sessions: { open } } as unknown as AgentRuntime,
      nativeAgentRuntimeIdentity: { pluginId: AGENT_ID, pluginVersion: '1.0.0', agentId: AGENT_ID,
        occurrenceId: 'agent-occurrence', isCurrent: () => true },
    } as never);
    const runtime = adapter?.runtimeCore.createExecutionRunBackend({
      scope: 'session_owned', cwd: '/parent', runId: 'child', controllerOccurrenceId: 'child-occurrence',
      callId: 'child-call', sidechainId: 'child-side', backendId: AGENT_ID, permissionMode: 'read-only',
      start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable',
        allowedTools: ['WebSearch', 'mcp__wilson-brief__*'], unlistedTools: 'deny' },
      sessionInteractionHost: { session: { sessionId: 'parent', getMetadataSnapshot: () => ({
        path: '/parent', allowedTools: ['mcp__wilson-brief__*', 'WebSearch'], unlistedTools: 'deny',
      }) }, machineId: 'machine-a', permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }), abortPendingRequestAndFlush: async () => undefined,
      } },
    } as never);
    expect(runtime).toBeDefined();
    expect(open).not.toHaveBeenCalled();
    await runtime?.dispose();
  });

  it('keeps parent tasks and readiness authoritative across retained siblings and late child publications', async () => {
    const { backend, agent } = createContributions();
    let metadata = { path: '/parent', machineId: 'machine-a' } as Metadata;
    let agentState: AgentState = { capabilities: { inFlightSteerAvailable: true } };
    const parent = {
      sessionId: 'session-a',
      getMetadataSnapshot: () => metadata,
      updateMetadata: async (update: (value: Metadata) => Metadata) => { metadata = update(metadata); },
      updateAgentState: async (update: (value: AgentState) => AgentState) => { agentState = update(agentState); },
    };
    const publication = {
      sourceSequence: 1, observedAtMs: 1,
      items: [{ localId: 'parent-task', kind: 'task' as const, origin: 'vendor' as const,
        status: 'active' as const, title: 'Parent task', updatedAtMs: 1 }],
    };
    const parentPublication = await createNativeAgentSessionWorkStateService({
      session: parent, pluginId: AGENT_ID, contributionId: AGENT_ID, agentId: AGENT_ID,
      occurrenceId: 'agent-occurrence', declarations: [{ id: 'tasks', itemKinds: ['task'] }],
      isCurrent: () => true,
    }).publisher('tasks').publish(publication);
    expect(parentPublication.status).toBe('applied');
    const parentMetadata = structuredClone(metadata);
    const parentReadiness = structuredClone(agentState);
    const contexts: AgentSessionRuntimeContext[] = [];
    const adapter = await resolveBackendRuntimeCore({
      backend, agent, executionSurfaces: createEmptyBackendExecutionSurfaces(),
      runtimeOwner: { backendId: AGENT_ID,
        selected: { kind: 'plugin_engine', ownerId: AGENT_ID, provenance: 'external', pluginId: AGENT_ID }, candidates: [] },
      nativeAgentRuntime: { sessions: { open: async (_request, context) => {
        contexts.push(context);
        return { send: async () => ({ status: 'admitted' as const }), cancel: async () => ({ status: 'notRunning' as const }),
          watch: () => ({ dispose() {} }), dispose() {} } satisfies AgentSessionRuntime;
      } } } satisfies AgentRuntime,
      nativeAgentRuntimeIdentity: { pluginId: AGENT_ID, pluginVersion: '1.0.0', agentId: AGENT_ID,
        occurrenceId: 'agent-occurrence', isCurrent: () => true },
    } as never);
    const runs = [];
    for (const runId of ['child-a', 'child-b']) {
      const run = adapter!.runtimeCore.createExecutionRunBackend({
        scope: 'session_owned', cwd: '/parent', runId, controllerOccurrenceId: `${runId}-occurrence`,
        callId: `${runId}-call`, sidechainId: runId, backendId: AGENT_ID, permissionMode: 'default',
        start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' },
        sessionInteractionHost: { session: parent, machineId: 'machine-a', permissionHandler: {
          handleToolCall: async () => ({ decision: 'approved' }), abortPendingRequestAndFlush: async () => undefined,
        } },
      } as never)!;
      await run.provisionRuntime();
      runs.push(run);
    }
    for (const context of contexts) {
      await context.workState.publisher('tasks').publish({ ...publication,
        items: [{ ...publication.items[0], localId: 'child-task', title: 'Child task' }] });
      context.session.services.activeInput.bind({
        isTurnInFlight: () => false, canSteer: () => false, onPromptQueued() {},
        applyPermissionIntentDuringTurn: () => { throw new Error('Not exercised by publication test'); },
        clearTerminalComposer: () => { throw new Error('Not exercised by publication test'); }, interruptPendingInputAndRun() {},
      });
      context.session.services.activeInput.publishStatus({
        steerAvailable: false, steerUnavailableReason: 'turn_settling', stateUpdatedAtMs: 2,
        terminalComposerDraftPresent: false, terminalComposerClearSupported: false,
        inFlightConfigurationApplySupported: false, pendingInputInterruptAndRunLocalId: null,
        pendingInputInterruptAndRunStateAt: null,
      });
    }
    expect(metadata).toEqual(parentMetadata);
    expect(agentState).toEqual(parentReadiness);
    await runs[0].dispose();
    await expect(contexts[0].workState.publisher('tasks').publish({ ...publication, sourceSequence: 2 }))
      .rejects.toThrow();
    expect(metadata).toEqual(parentMetadata);
    expect(agentState).toEqual(parentReadiness);
    await runs[1].dispose();
  });
  it.each([
    {
      label: 'retained',
      start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' },
    },
    {
      label: 'bounded',
      start: { intent: 'review', runClass: 'bounded', retentionPolicy: 'ephemeral' },
    },
  ])('refuses a $label Session-owned Run when its parent host custody is missing', async ({ start }) => {
    const { backend, agent } = createContributions();
    const open = vi.fn();
    const adapter = await resolveBackendRuntimeCore({
      backend,
      agent,
      executionSurfaces: createEmptyBackendExecutionSurfaces(),
      runtimeOwner: {
        backendId: AGENT_ID,
        selected: { kind: 'plugin_engine', ownerId: AGENT_ID, provenance: 'external', pluginId: AGENT_ID },
        candidates: [],
      },
      nativeAgentRuntime: { sessions: { open } } as unknown as AgentRuntime,
      nativeAgentRuntimeIdentity: {
        pluginId: AGENT_ID,
        pluginVersion: '1.0.0',
        agentId: AGENT_ID,
        generation: 'agent-generation',
        isCurrent: () => true,
      },
    } as never);

    expect(() => adapter?.runtimeCore.createExecutionRunBackend({
      scope: 'session_owned',
      cwd: '/run/missing-parent',
      runId: 'run-missing-parent',
      controllerOccurrenceId: 'run-missing-parent-occurrence',
      callId: 'run-missing-parent-call',
      sidechainId: 'run-missing-parent-sidechain',
      backendId: AGENT_ID,
      permissionMode: 'default',
      start,
    } as never)).toThrow(expect.objectContaining({
      code: 'execution_run_interaction_unavailable',
    }));
    expect(open).not.toHaveBeenCalled();
  });

  it('constructs a truthful execution-run context only for explicit detached scope', async () => {
    const { backend, agent, contributes } = createContributions();
    const sessionOpen = vi.fn();
    let openedContext: AgentExecutionRunRuntimeContextV1 | null = null;
    const readOpenedContext = (): AgentExecutionRunRuntimeContextV1 | null => openedContext;
    const executionRunOpen = vi.fn(async (request: AgentExecutionRunOpenRequest, context: AgentExecutionRunRuntimeContextV1) => {
      openedContext = context;
      const events: AgentExecutionRunEvent[] = [
        { kind: 'run-start', runId: request.runId, sequence: 1, emittedAtMs: 1 },
        { kind: 'output-delta', runId: request.runId, sequence: 2, emittedAtMs: 2,
          channel: 'assistant', text: '{"verdict":"done"}' },
        { kind: 'run-complete', runId: request.runId, sequence: 3, emittedAtMs: 3 },
      ];
      return {
        send: vi.fn(async () => ({ status: 'admitted' as const })),
        stop: vi.fn(async () => ({ status: 'notRunning' as const })),
        watch: vi.fn((listener: (event: AgentExecutionRunEvent) => void) => {
          for (const event of events) listener(event);
          return { dispose: vi.fn() };
        }),
        dispose: vi.fn(async () => undefined),
      } satisfies AgentExecutionRunRuntime;
    });
    const adapter = await resolveBackendRuntimeCore({
      backend,
      agent,
      // This direct runtime fixture supplies the real catalog projection used
      // for Agent delivery admission without activating unrelated plugin services.
      runtimeRegistry: { contributes },
      executionSurfaces: createEmptyBackendExecutionSurfaces(),
      runtimeOwner: {
        backendId: AGENT_ID,
        selected: { kind: 'plugin_engine', ownerId: AGENT_ID, provenance: 'external', pluginId: AGENT_ID },
        candidates: [],
      },
      nativeAgentRuntime: {
        sessions: {
          open: sessionOpen,
          executionRunContextV1: { open: executionRunOpen },
        },
      } as unknown as AgentRuntime,
      nativeAgentRuntimeIdentity: {
        pluginId: AGENT_ID,
        pluginVersion: '1.0.0',
        agentId: AGENT_ID,
        generation: 'agent-generation',
        isCurrent: () => true,
      },
    } as never);

    const snapshot: ActiveAccountSettingsSnapshot = {
      source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      mcpServerCatalog: await loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => ({
        status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, bindings: [{
          id: 'wilson-brief-all', serverId: 'wilson-brief', enabled: true,
          target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1,
        }], servers: [{
          id: 'wilson-brief', name: 'wilson-brief', transport: 'stdio',
          stdio: { command: process.execPath, args: ['--version'] },
          env: { WILSON_TOKEN: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:wilson-token' } },
          createdAt: 1, updatedAt: 1,
        }] } },
      }) }),
      savedSecretCatalogState: 'ready', savedSecretResources: [{
        resourceId: 'wilson-token', ownerAccountId: 'owner', displayName: 'Test token', kind: 'token',
        encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'wilson-token', mode: 'plain',
          content: { v: 1, name: 'Test token', kind: 'token', value: 'synthetic-token' } }),
      }],
    };

    const ownerToken = `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true, credentialResources: { enabled: true } } }, capabilities: {} });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(features)));
    // Home transport is replaced; the detached Run consumes the actual Machine
    // snapshot resolver, shared-resource admission and MCP materializer.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const target = new URL(String(url));
      expect(target.origin).toBe('https://detached-run-owner.test');
      if (target.pathname === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (target.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (target.pathname === '/v1/account/entity-rows/mcp' && snapshot.mcpServerCatalog?.status === 'ready') return {
        status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: snapshot.mcpServerCatalog.catalog } },
      };
      if (target.pathname === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [{
        resourceId: 'wilson-token', encryptionMode: 'plain', recipientEnvelope: null,
        storedContent: snapshot.savedSecretResources?.[0]?.storedContent,
        entry: { ref: 'happier:shared-secret:v1:wilson-token', source: 'shared_resource', relationship: 'owner',
          ownerAccountId: 'owner', name: 'Test token', kind: 'token', revision: 1, materialStatus: 'ready',
          capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
      }] } };
      return { status: 404, data: {} };
    });
    const resolveOwnerSnapshot = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'machine-a',
      serverHttpBaseUrl: 'https://detached-run-owner.test', readCredentials: async () => ({ token: ownerToken, encryption: null }),
      isOwnerCurrent: () => true, onSettings: () => {} });

    const runtime = adapter?.runtimeCore.createExecutionRunBackend({
      scope: 'detached',
      cwd: '/run/detached',
      runId: 'run-detached',
      controllerOccurrenceId: 'run-detached-occurrence',
      callId: 'run-detached-call',
      sidechainId: 'run-detached-sidechain',
      backendId: AGENT_ID,
      permissionMode: 'default',
      start: { intent: 'agent', runClass: 'long_lived', retentionPolicy: 'resumable',
        instructions: 'Check the supplied goal and most recent turn.', localInputId: 'judge-input',
        resultContract: { kind: 'json', schema: { type: 'object', properties: { verdict: { enum: ['progress', 'no_progress', 'done'] } }, required: ['verdict'], additionalProperties: false } },
        capabilitySelection: { mcp: {
        v: 1, managedServersEnabled: false, forceIncludeServerIds: ['wilson-brief'], forceExcludeServerIds: [],
      } } },
      machineId: 'machine-a', resolveAccountSettingsSnapshot: resolveOwnerSnapshot,
    } as never);
    const messages: import('@/agent/core/AgentMessage').AgentMessage[] = [];
    runtime?.subscribeMessages(message => messages.push(message));
    await expect(runtime?.provisionRuntime({ initialPrompt: 'Run independently' })).resolves.toEqual({
      runtimeId: 'run-detached',
    });

    try {
      expect(sessionOpen).not.toHaveBeenCalled();
      expect(executionRunOpen).toHaveBeenCalledOnce();
      await expect(runtime?.waitForTurnCompletion?.()).resolves.toBeUndefined();
      const output = messages.filter(message => message.type === 'model-output').map(message => message.textDelta ?? message.fullText ?? '').join('');
      const openedRun = executionRunOpen.mock.calls[0]?.[0];
      if (!openedRun || !('resultContract' in openedRun)) throw new Error('Expected bounded Run result contract');
      expect(decodeExecutionRunProfileResult(output, openedRun.resultContract))
        .toEqual({ ok: true, value: { verdict: 'done' } });
      expect(executionRunOpen.mock.calls[0]?.[0]).toMatchObject({ localInputId: 'judge-input', resultContract: { kind: 'json' } });
      const mcpServers = executionRunOpen.mock.calls[0]?.[0].mcpServers;
      expect(Object.keys(mcpServers ?? {})).toEqual(['wilson-brief']);
      const server = mcpServers?.['wilson-brief'];
      expect(server?.env).not.toHaveProperty('WILSON_TOKEN');
      const configPath = server?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
      if (!configPath) throw new Error('Expected owned secure MCP launcher configuration');
      const launcherConfig: unknown = JSON.parse(await readFile(configPath, 'utf8'));
      expect(launcherConfig).toMatchObject({
        command: process.execPath, args: ['--version'], env: { WILSON_TOKEN: 'synthetic-token' },
      });
      const observedContext = readOpenedContext();
      if (!observedContext) throw new Error('Expected detached Execution Run context');
      expect(observedContext).toMatchObject({
        scope: { kind: 'execution_run', executionRunId: 'run-detached' },
        executionRun: { id: 'run-detached' },
      });
      expect(observedContext).not.toHaveProperty('session');
      expect(observedContext.executionRun.services).not.toHaveProperty('transcripts');
    } finally {
      await runtime?.dispose();
    }
  });

  it('opens with the Run-bound tool profile and materializes terminal images after committing to the Run sidechain', async () => {
    const { backend, agent } = createContributions();
    const runtimeLifetime = new AbortController();
    const witness: AgentInvocationTurnAdmissionWitness = {
      inputId: 'input-run-a',
      turnId: 'turn-run-a',
      userMessageSeq: 1,
      userMessageSeqs: [1],
    };
    const controller = {
      kind: 'backend',
      controllerOccurrenceId: 'run-a-occurrence-1',
    } as ExecutionRunController;
    const occurrences = createExecutionRunOccurrenceWitnessRegistry(new Map([['run-a', controller]]));
    occurrences.register({
      runId: 'run-a',
      sidechainId: 'sidechain-a',
      runtimeLifetimeSignal: runtimeLifetime.signal,
      controller: controller as Extract<ExecutionRunController, { kind: 'backend' }>,
      readActiveTurnAdmissionWitness: () => witness,
    });

    const enqueued: { provider: string; body: Record<string, unknown> }[] = [];
    const publicationOrder: string[] = [];
    type MediaRequest = Parameters<NonNullable<NonNullable<Parameters<typeof resolveBackendRuntimeCore>[0]['executionSurfaces']['externalSession']>['materializeTranscriptMedia']>>[0];
    const materialized: MediaRequest[] = [];
    const parentSession = {
      sessionId: 'session-a',
      getMetadataSnapshot: () => ({ path: '/parent', machineId: 'machine-a' }),
      updateMetadata: async () => undefined,
      updateAgentState: async () => undefined,
      fetchCommittedTranscriptLocalIdBaseline: async () => ({ localIds: new Set<string>(), complete: true }),
      enqueueAgentMessageCommitted: async (provider: string, body: Record<string, unknown>) => {
        enqueued.push({ provider, body });
        publicationOrder.push('commit');
        return { persisted: true, delivered: true };
      },
    };
    // The parent's durable writer must never receive a Session-owned Run event.
    const parentEnqueue = vi.spyOn(parentSession, 'enqueueAgentMessageCommitted');

    const disposeRunToolBinding = vi.fn();
    const skills = { pluginRoot: '/skills/session-a/runs/run-a', skillsRoot: '/skills/session-a/runs/run-a/skills',
      items: [{ name: 'child-only', skillId: 'child-skill', digest: 'sha256:child', directory: '/skills/session-a/runs/run-a/skills/child-only' }], nativeDisables: [] };
    let toolBindingRequest: NativeAgentSessionRunToolBindingRequest | null = null;
    const composeRunToolBinding = vi.fn(async (request: NativeAgentSessionRunToolBindingRequest) => {
      toolBindingRequest = request;
      return {
        mcpServers: { happier: { command: 'happier-mcp', args: ['--run', request.runId] } },
        skills,
        supportedSessionReadActions: [],
        dispose: disposeRunToolBinding,
      };
    });

    let openedContext: AgentSessionRuntimeContext | null = null;
    let openedMcpServers: unknown = undefined;
    let openedSkills: unknown = undefined;
    const open = vi.fn(async (request: { mcpServers?: unknown; skills?: unknown }, context: AgentSessionRuntimeContext) => {
      openedMcpServers = request.mcpServers;
      openedSkills = request.skills;
      openedContext = context;
      await context.session.services.transcripts.publishSessionEvent({ type: 'switch', mode: 'local' });
      await context.session.services.transcripts.followSource!({ providerSessionId: 'native-run-a', replay: 'fresh' });
      throw new Error('stop-after-open-request');
    });

    // Native Agent source transport and durable transcript persistence are the boundaries;
    // Run composition, terminal follow, and transcript projection remain real.
    const externalSessionHostOperations: NonNullable<Parameters<typeof resolveBackendRuntimeCore>[0]['externalSessionHostOperations']> = {
      bindSession: () => ({
        executeFollow: async () => ({ status: 'unavailable', code: 'not-configured' }),
        executeProviderSessionFollow: async ({ listener }) => {
          await listener({
            kind: 'data', providerSessionId: 'native-run-a', source: { kind: 'claudeConfig', projectId: 'project' },
            fromCursor: null, nextCursor: 'image-cursor',
            items: [{ id: 'image-item', timestampMs: 10, kind: 'event',
              toolResultMedia: { sourceMessageId: 'image-source-message', toolCallId: 'read-image' },
              data: { role: 'agent', content: { type: 'acp', agentId: AGENT_ID, data: {
                type: 'tool-result', callId: 'read-image', output: [{ type: 'image' }],
              } } },
            }],
          });
          return { status: 'following', startingCursor: null, subscription: { dispose: async () => undefined } };
        },
        retire: async () => undefined,
      }),
    };
    const executionSurfaces: Parameters<typeof resolveBackendRuntimeCore>[0]['executionSurfaces'] = {
      ...createEmptyBackendExecutionSurfaces(),
      externalSession: {
        validateSource: ({ source }) => ({ ok: true, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => { throw new Error('Follow supplies the source page'); },
        readAfterTranscript: async () => ({ outcome: 'already_current' }),
        materializeTranscriptMedia: async request => {
          request.signal?.throwIfAborted();
          materialized.push(request);
          publicationOrder.push('media');
        },
      },
    };
    const adapter = await resolveBackendRuntimeCore({
      backend,
      agent,
      executionSurfaces,
      externalSessionHostOperations,
      runtimeOwner: {
        backendId: AGENT_ID,
        selected: { kind: 'plugin_engine', ownerId: AGENT_ID, provenance: 'external', pluginId: AGENT_ID },
        candidates: [],
      },
      nativeAgentRuntime: { sessions: { open } } as unknown as AgentRuntime,
      nativeAgentRuntimeIdentity: {
        pluginId: AGENT_ID,
        pluginVersion: '1.0.0',
        agentId: AGENT_ID,
        generation: 'agent-generation',
        isCurrent: () => true,
      },
    } as never);

    const runtime = adapter?.runtimeCore.createExecutionRunBackend({
      scope: 'session_owned',
      cwd: '/run/a',
      runId: 'run-a',
      controllerOccurrenceId: 'run-a-occurrence-1',
      backendId: AGENT_ID,
      permissionMode: 'default',
      start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' },
      sessionInteractionHost: {
        session: parentSession,
        machineId: 'machine-a',
        permissionHandler: {
          handleToolCall: async () => ({ decision: 'approved' }),
          abortPendingRequestAndFlush: vi.fn(async () => undefined),
        },
        composeRunToolBinding,
      },
      sessionOwnedRunScope: {
        runId: 'run-a',
        workDepth: 4,
        sidechainId: 'sidechain-a',
        readCurrentRunOccurrence: occurrences.reader.readCurrentRunOccurrence,
        publishSupportedSessionReadActions: vi.fn(),
        projectRunTranscriptSession: () => ({
          sessionId: parentSession.sessionId,
          requiresDurableTurnCompletionMarker: true,
          updateMetadata: parentSession.updateMetadata,
          enqueueAgentMessageCommitted: async (
            provider: string,
            body: Record<string, unknown>,
          ) => await parentSession.enqueueAgentMessageCommitted(
            provider,
            { ...body, sidechainId: 'sidechain-a' },
          ),
        }),
      },
    } as never);
    expect(runtime, 'retained Session-owned Run runtime').toBeTruthy();

    const openFailure = await runtime!.provisionRuntime().catch((error: unknown) => error);

    // The Run's own tool profile reached the provider open request.
    expect(openedMcpServers).toEqual({ happier: { command: 'happier-mcp', args: ['--run', 'run-a'] } });
    expect(openedSkills).toEqual(skills);
    expect(toolBindingRequest!.agentId).toBe(AGENT_ID);
    expect(composeRunToolBinding).toHaveBeenCalledTimes(1);
    expect(toolBindingRequest!.runId).toBe('run-a');
    expect(toolBindingRequest!.cwd).toBe('/run/a');
    expect(toolBindingRequest!.getPermissionMode()).toBe('default');
    // The Run's occurrence owner answers currentness; the parent turn is not borrowed.
    expect(toolBindingRequest!.readCurrentRunOccurrence('run-a')?.sidechainId).toBe('sidechain-a');
    expect(toolBindingRequest!.isCurrent()).toBe(true);
    // Host-service transcript publication landed in the Run sidechain, not the main transcript.
    expect(openedContext).toBeTruthy();
    expect(parentEnqueue).toHaveBeenCalledTimes(2);
    expect(enqueued[0]?.body).toMatchObject({ sidechainId: 'sidechain-a', type: 'event' });
    expect(enqueued[1]?.body).toMatchObject({ sidechainId: 'sidechain-a', type: 'tool-result', callId: 'read-image' });
    expect(publicationOrder).toEqual(['commit', 'commit', 'media']);
    expect(materialized).toEqual([expect.objectContaining({
      source: { kind: 'claudeConfig', projectId: 'project' }, remoteSessionId: 'native-run-a',
      itemId: 'image-item', sourceMessageId: 'image-source-message', toolCallId: 'read-image', cursor: 'image-cursor',
      signal: expect.any(AbortSignal),
    })]);
    expect(openFailure).toMatchObject({ message: 'stop-after-open-request' });

    // A failed open releases the Run-specific tool binding, never the parent's.
    expect(disposeRunToolBinding).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getActionSpec, listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyExitEvent, PtyProcess } from '@/terminal/pty/provider';
import { executeProjectFiniteProcess } from '@/workspaces/projectSetup/projectSetupExecution';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';

import { createHostActionOperationRuntime } from './createHostActionOperationRuntime';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { registerActionOperationRpcHandlers } from './actionOperationRpcHandlers';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { normalizeSessionCreateSpawnRequest } from '@/cli/commands/session/create/normalizeSessionCreateSpawnRequest';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { computeDaemonSpawnRequestKey, createSpawnRequestCoalescer } from '@/daemon/spawn/spawnRequestCoalescer';

describe('finite host operation custody', () => {
  it.each((['acknowledged-content', 'unknown-secret'] as const).flatMap(phase =>
    (['existing', 'new'] as const).map(project => ({ phase, project }))))(
    'retains a template partial result ($phase, $project Project) and rejoins its creation intent without repeating generated-secret effects', async ({ phase, project }) => {
    let sequence = 0;
    let effects = 0;
    const runtime = createHostActionOperationRuntime({ machineId: 'target', resolveAccountId: async () => 'owner',
      generateOperationId: () => `template-operation-${++sequence}` });
    const input = { mode: 'apply', serverId: 'home', machineId: 'target',
      ...(project === 'existing' ? { projectSourceId: 'project' }
        : { newProject: { name: 'New Project', requestKey: 'create-project', owner: { kind: 'account' as const, accountId: 'owner' } } }),
      templateRef: { sourceId: 'builtin:apps', itemId: 'app', version: '1',
        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      environment: { kind: 'create', name: 'App', requestKey: 'create-app', protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'target' },
      target: { kind: 'new', installationId: 'installation' }, destination: { kind: 'stored' }, bindings: [] };
    const retained = { kind: 'partial', phase: phase === 'unknown-secret' ? 'generation' : 'bindings', errorCode: 'deployment_conflict',
      ...(phase === 'unknown-secret' ? { unknownSecret: { name: 'SECOND_PASSWORD', phase: 'runtime', ref: 'happier:shared-secret:v1:candidate' } }
        : { environmentId: 'created-environment', revision: 2, definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` } }),
      savedSecrets: [{ name: 'DB_PASSWORD', phase: 'runtime', source: { kind: 'secret', ref: 'happier:shared-secret:v1:saved-secret', resourceRevision: 1 } }],
    };
    const invoke = (value: typeof input, requestId: string) => runtime.observeExecution({ actionId: 'deployments.templates.instantiate',
      input: value, actionRequestId: requestId, execute: async () => {
        effects += 1;
        return { ok: false, errorCode: retained.errorCode, error: retained.errorCode, details: retained };
      } });
    const first = await invoke(input, 'transport-one');
    expect(first).toMatchObject({ ok: false, details: retained });
    expect(await invoke(input, 'transport-two')).toEqual(first);
    expect(effects, 'A transport retry must observe the existing operation, preserving acknowledged refs').toBe(1);
    expect(await runtime.handlers.getV2({ operationId: 'template-operation-1' })).toMatchObject({ kind: 'found', operation: {
      state: 'failed', error: { errorCode: 'deployment_conflict', details: retained },
    } });
    expect(await invoke({ ...input, environment: { ...input.environment, name: 'Changed' } }, 'transport-three'))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    expect(effects).toBe(1);
    expect(await invoke({ ...input, machineId: 'another-target' }, 'transport-four')).toMatchObject({ ok: false, details: retained });
    expect(effects).toBe(2);
    await invoke({ ...input, mode: 'preview' }, 'preview-request');
    await invoke({ ...input, mode: 'preview' }, 'preview-request');
    expect(effects).toBe(4);
    expect((await runtime.handlers.listV2({})).items).toHaveLength(2);
    expect(await invoke({ ...input, environment: { ...input.environment, requestKey: 'independent-create' } }, 'transport-five'))
      .toMatchObject({ ok: false, details: retained });
    expect(effects).toBe(5);
  });
  // Open's native registrar owns observation across direct and relay calls;
  // its composed settlement keeper exercises this same outer adapter.
  it.each(listActionSpecs().filter(spec => spec.operation && spec.id !== 'projects.open' && spec.id !== 'localServices.launcher.start').map(spec => spec.id))(
    'supplies the incumbent runner acceptance to the admitted %s effect', async actionId => {
      const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'requester',
        generateOperationId: () => 'replayed-operation' });
      const result = await runtime.runActionOperation({ actionId, input: {}, context: { actionRequestId: 'original-request' },
        execute: async context => {
          expect(context.operationAcceptance).toMatchObject({ actionId, operationId: 'replayed-operation' });
          // Nested adapters consume that same acceptance instead of opening a second operation.
          return runtime.runActionOperation({ actionId, input: {}, context, execute: async current => {
            expect(current.operationAcceptance).toBe(context.operationAcceptance);
            return { ok: true, result: { completed: true } };
          } });
        } });
      expect(result).toEqual({ ok: true, result: { completed: true } });
      expect(runtime.store.list({ accountId: 'requester', machineId: 'machine' }).items)
        .toMatchObject([{ operationId: 'replayed-operation', actionId, requestId: 'original-request', state: 'succeeded' }]);
      expect(await runtime.runner.waitForTerminal({ accountId: 'requester', machineId: 'machine' }, 'replayed-operation'))
        .toMatchObject({ state: 'succeeded', result: { completed: true } });
    });
  it('offers Stop for machine setup without settling until its process owner observes exit', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'owner', generateOperationId: () => 'setup' });
    let exited!: () => void;
    const exit = new Promise<void>(resolve => { exited = resolve; });
    let stopRequested = false;
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const request = runtime.observeExecution({ actionId: 'machines.environment.apply', input: { homeId: 'home', machineId: 'guest', presetId: 'preset', presetRevision: 1 },
      actionRequestId: 'setup-request', execute: async ({ signal, operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ state: 'running', domainRef: { kind: 'machineEnvironment', serverId: 'home', machineId: 'guest', preset: { id: 'preset', revision: 1 }, terminalId: 'actual-terminal' } });
        // Only physical process exit is substituted. Real host runner/store
        // owns the cancellation signal and cannot turn Stop into settlement.
        signal.addEventListener('abort', () => { stopRequested = true; }, { once: true });
        started(); await exit;
        return signal.aborted ? { ok: false, errorCode: 'cancelled', error: 'cancelled' } : { ok: true, result: { operationId: 'setup', terminalId: 'actual-terminal' } };
      } });
    await start;
    try {
      expect(await runtime.handlers.cancel({ operationId: 'setup' })).toEqual({ kind: 'requested' });
      expect(stopRequested).toBe(true);
      expect(await runtime.handlers.getV2({ operationId: 'setup' })).toMatchObject({ kind: 'found', operation: { state: 'running' } });
      exited(); await request;
      expect(await runtime.handlers.getV2({ operationId: 'setup', waitForTerminal: true })).toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
    } finally { exited(); await request; }
  });
  it('does not project an unknown machine setup process outcome as terminal failure', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'owner', generateOperationId: () => 'uncertain-setup' });
    expect(await runtime.observeExecution({ actionId: 'machines.environment.apply', input: {}, actionRequestId: 'setup-request',
      execute: async ({ operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ state: 'running', domainRef: { kind: 'machineEnvironment', serverId: 'home', machineId: 'guest',
          preset: { id: 'preset', revision: 1 }, terminalId: 'actual-terminal' } });
        // Native terminal supervision is the system boundary. An unavailable
        // exit observation is not proof that the owned process stopped.
        return { ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' };
      } })).toMatchObject({ ok: false, errorCode: 'outcome_uncertain' });
    expect(await runtime.handlers.getV2({ operationId: 'uncertain-setup' })).toMatchObject({ kind: 'found', operation: {
      state: 'running', observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' }, domainRef: { kind: 'machineEnvironment', terminalId: 'actual-terminal' } } });
  });
  it('keeps ordinary pending Session creation unconfirmed and re-enters its same request with resume-only admission', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'actual-spawn-operation' });
    const nativeModes: Array<boolean | undefined> = [];
    // The native Session creation/nonce transport is the system boundary. The
    // actual Action executor, admission, operation identity and store stay real.
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      sessionSpawnNew: async (input): Promise<import('@happier-dev/protocol').SessionSpawnNewResultV1> => {
      nativeModes.push(input.resumeActionRequest);
      return input.resumeActionRequest ? { type: 'success', disposition: 'rejoined', sessionId: 'actual-session',
        executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' } } : { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
    } });
    const input = { executionTarget: { serverId: 'home', machineId: 'guest' }, directory: { kind: 'managed' as const },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } } };
    const invoke = () => runtime.observeExecution({ actionId: 'session.spawn_new', input, actionRequestId: 'original-creation',
      execute: context => executor.execute('session.spawn_new', input, { ...context, surface: 'cli', authority: 'present_user',
        presentUserConfirmation: { actionId: 'session.spawn_new' } }) });
    expect(await invoke()).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'unknown' } });
    const pendingOperation = await runtime.handlers.getV2({ operationId: 'actual-spawn-operation' });
    expect(pendingOperation, JSON.stringify(pendingOperation)).toMatchObject({ kind: 'found', operation: {
      state: 'running', requestId: 'original-creation', domainRef: { kind: 'spawnAttempt', id: 'original-creation' },
      observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' },
    } });
    expect(await invoke()).toMatchObject({ ok: true, result: { type: 'success', disposition: 'rejoined', sessionId: 'actual-session' } });
    expect(nativeModes).toEqual([undefined, true]);
    expect(await runtime.handlers.getV2({ operationId: 'actual-spawn-operation' })).toMatchObject({ kind: 'found', operation: {
      state: 'succeeded', result: { type: 'success', sessionId: 'actual-session' },
    } });
    expect(runtime.store.get({ accountId: 'requester', machineId: 'guest' }, 'actual-spawn-operation'))
      .not.toHaveProperty('observation');
  });
  it('keeps one keyed Session creation call attached after acceptance until its operation settles', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'settling-spawn-operation' });
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    let accepted!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    let returned = false;
    const request = runtime.observeExecution({ actionId: 'session.spawn_new', input: {}, actionRequestId: 'one-call-creation',
      execute: async ({ operationAcceptance }) => {
        operationAcceptance!.accept({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' });
        accepted();
        await completion;
        return { ok: true as const, result: { type: 'success' as const, disposition: 'created' as const,
          sessionId: 'created-session', executionTarget: { serverId: 'home', machineId: 'guest' },
          organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' as const } } };
      } }).then(result => { returned = true; return result; });

    await acceptance;
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(runtime.store.get({ accountId: 'requester', machineId: 'guest' }, 'settling-spawn-operation'))
      .toMatchObject({ state: 'running', requestId: 'one-call-creation' });

    release();
    await expect(request).resolves.toMatchObject({ ok: true, result: {
      type: 'success', disposition: 'created', sessionId: 'created-session',
    } });
    expect(runtime.store.get({ accountId: 'requester', machineId: 'guest' }, 'settling-spawn-operation'))
      .toMatchObject({ state: 'succeeded', result: { type: 'success', sessionId: 'created-session' } });
  });
  it('returns a terminal Session creation refusal after acceptance instead of swallowing it as pending', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'refused-spawn-operation' });
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    let accepted!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    const request = runtime.observeExecution({ actionId: 'session.spawn_new', input: {}, actionRequestId: 'refused-creation',
      execute: async ({ operationAcceptance }) => {
        operationAcceptance!.accept({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' });
        accepted();
        await completion;
        return { ok: true as const, result: { type: 'error' as const, code: 'spawn_failed' as const, retryable: false } };
      } });

    await acceptance;
    release();
    await expect(request).resolves.toEqual({ ok: true, result: {
      type: 'error', code: 'spawn_failed', retryable: false,
    } });
    expect(runtime.store.get({ accountId: 'requester', machineId: 'guest' }, 'refused-spawn-operation'))
      .toMatchObject({ state: 'succeeded', result: { type: 'error', code: 'spawn_failed', retryable: false } });
  });
  it('releases an aborted Session creation waiter without cancelling or duplicating its keyed operation', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'detached-spawn-operation' });
    const caller = new AbortController();
    const disconnect = new Error('caller disconnected');
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    let accepted!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    let executions = 0;
    const execute = async ({ operationAcceptance }: Parameters<Parameters<typeof runtime.observeExecution>[0]['execute']>[0]) => {
      executions += 1;
      operationAcceptance!.accept({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' });
      accepted();
      await completion;
      return { ok: true as const, result: { type: 'success' as const, disposition: 'created' as const,
        sessionId: 'created-session', executionTarget: { serverId: 'home', machineId: 'guest' },
        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' as const } } };
    };
    const input = { creationKey: 'detached-creation' };
    const request = runtime.observeExecution({ actionId: 'session.spawn_new', input,
      actionRequestId: input.creationKey, rpcContext: { signal: caller.signal }, execute });
    let detached = false;
    void request.catch(() => { detached = true; });
    try {
      await acceptance;
      caller.abort(disconnect);
      await vi.waitFor(() => expect(detached).toBe(true));
      await expect(request).rejects.toBe(disconnect);
      expect(runtime.store.get({ accountId: 'requester', machineId: 'guest' }, 'detached-spawn-operation'))
        .toMatchObject({ state: 'running', requestId: input.creationKey });

      const retry = runtime.observeExecution({ actionId: 'session.spawn_new', input,
        actionRequestId: input.creationKey, execute });
      release();
      await expect(retry).resolves.toMatchObject({ ok: true, result: {
        type: 'success', disposition: 'created', sessionId: 'created-session',
      } });
      expect(executions).toBe(1);
    } finally {
      release();
      await request.catch(() => undefined);
    }
  });
  it('retries a Discussion birth after HTTP 503 through the same ordinary creator instead of replaying its failed result forever', async () => {
    let operationSequence = 0;
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'owner',
      generateOperationId: () => `discussion-birth-operation-${++operationSequence}` });
    const input = { creationKey: 'participant-slot', executionTarget: { serverId: 'home', machineId: 'guest' },
      directory: { kind: 'managed' as const },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      discussionParticipant: { discussionId: 'discussion', participantSlotId: 'participant-slot' }, initialTriggers: [],
      connectedServices: { v: 2 as const, bindingsByServiceId: {} }, memoryEnabled: false };
    let available = false;
    let committed: Record<string, unknown> | null = null;
    let nativeStarts = 0;
    const creationTags: string[] = [];
    resetServerFeaturesClientForTests();
    // HTTP and the native machine transport are the only replaced boundaries;
    // Action admission, operation custody, birth metadata and creator stay real.
    vi.stubGlobal('fetch', vi.fn(async value => String(value).endsWith('/v1/features')
      ? Response.json({ features: {}, capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })
      : Response.json({ id: 'owner' })));
    vi.spyOn(axios, 'get').mockImplementation(async url => String(url).includes('/v1/access-keys/')
      ? { status: 200, data: { accessKey: 'existing' } }
      : { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } });
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: committed ? [committed] : [] } };
      if (!String(url).endsWith('/v1/sessions')) throw new Error(`Unexpected birth HTTP request ${url}`);
      const body = raw as ReturnType<typeof buildSessionMetadataEnvelopeCreateFields> & { tag: string };
      creationTags.push(body.tag);
      if (!available) return { status: 503, data: { error: 'database_transaction_conflict_exhausted' } };
      expect(committed).toBeNull();
      committed = { id: 'backing-session', seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        metadataLayoutVersion: body.metadataLayoutVersion, metadata: body.sharedMetadata.ciphertext,
        ownerMetadata: body.ownerMetadata, metadataVersion: 1, encryptionMode: 'plain',
        agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null };
      return { status: 200, data: { session: committed, created: true } };
    });
    try {
      const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
        sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {}, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
        sessionSpawnDirectTargetTransport: { machineId: 'guest',
          prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'managed', directoryCreationRequired: false, checkout: null }),
          spawnedSession: { spawn: async request => {
            expect(committed).not.toBeNull();
            expect(request).toMatchObject({ existingSessionId: 'backing-session' });
            expect(request).not.toHaveProperty('pendingFirstInput');
            nativeStarts++;
            return { type: 'success', sessionId: 'backing-session' };
          }, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) },
        } }));
      const invoke = (value = input) => runtime.observeExecution({ actionId: 'session.spawn_new', input: value,
        actionRequestId: input.creationKey, execute: context => executor.execute('session.spawn_new', value,
          { ...context, surface: 'cli', authority: 'present_user', serverId: 'home', presentUserConfirmation: { actionId: 'session.spawn_new' } }) });
      expect(await invoke()).toMatchObject({ ok: true, result: { type: 'error', code: 'spawn_failed', retryable: true,
        launchError: { message: 'Unexpected status from /v1/sessions: 503' } } });
      expect(committed).toBeNull();
      expect(nativeStarts).toBe(0);
      expect(creationTags).toHaveLength(1);
      const firstReceipt = runtime.store.get({ accountId: 'owner', machineId: 'guest' }, 'discussion-birth-operation-1');
      expect(firstReceipt).toMatchObject({ state: 'succeeded', result: { type: 'error', retryable: true } });
      expect(await invoke({ ...input, memoryEnabled: true })).toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
      expect(creationTags).toHaveLength(1);
      available = true;
      const completed = await invoke();
      expect(completed).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'backing-session' } });
      expect(creationTags).toHaveLength(2);
      expect(new Set(creationTags).size).toBe(1);
      expect(nativeStarts).toBe(1);
      expect(await invoke()).toEqual(completed);
      expect(creationTags).toHaveLength(2);
      expect(nativeStarts).toBe(1);
      expect(runtime.store.get({ accountId: 'owner', machineId: 'guest' }, 'discussion-birth-operation-1')).toEqual(firstReceipt);
      expect(runtime.store.list({ accountId: 'owner', machineId: 'guest' }).items).toHaveLength(2);
    } finally {
      vi.restoreAllMocks(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests();
    }
  });
  it('explicitly retries ordinary creation failures with the same native nonce without replaying the failed receipt', async () => {
    let operationSequence = 0;
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'owner',
      generateOperationId: () => `ordinary-birth-operation-${++operationSequence}` });
    const input = { creationKey: 'ordinary-creation', executionTarget: { serverId: 'home', machineId: 'guest' },
      directory: { kind: 'managed' as const },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      initialTriggers: [], connectedServices: { v: 2 as const, bindingsByServiceId: {} }, memoryEnabled: false };
    const credentials = { token: 'token', encryption: null } as const;
    const coalescer = createSpawnRequestCoalescer({ recentSuccessTtlMs: 60_000 });
    let committed: ReturnType<typeof createCurrentSessionProjectionRecordFixture> | null = null;
    let nativeStarts = 0;
    const nativeAdmissions: Array<{ tag: string | undefined; nonce: string | undefined }> = [];
    resetServerFeaturesClientForTests();
    // The native machine adapter and HTTP are genuine boundaries. The ordinary
    // Action creator and daemon's existing nonce coalescer are not substituted.
    vi.stubGlobal('fetch', vi.fn(async value => String(value).endsWith('/v1/features')
      ? Response.json({ features: {}, capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })
      : Response.json({ id: 'owner' })));
    vi.spyOn(axios, 'get').mockImplementation(async url => String(url).includes('/v2/sessions/')
      ? { status: 200, data: { session: committed } }
      : { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } });
    vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: committed ? [committed] : [] } };
      throw new Error(`Unexpected ordinary birth HTTP request ${url}`);
    });
    try {
      const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials,
        sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {}, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
        sessionSpawnDirectTargetTransport: { machineId: 'guest',
          prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'managed', directoryCreationRequired: false, checkout: null }),
          spawnedSession: { spawn: request => coalescer.run(computeDaemonSpawnRequestKey(request), async () => {
            nativeAdmissions.push({ tag: request.sessionCreationTag, nonce: request.spawnNonce });
            if (nativeAdmissions.length === 1) return { type: 'error', errorCode: 'SPAWN_FAILED',
              errorMessage: 'Unexpected status from /v1/sessions: 503' };
            expect(committed).toBeNull();
            const fields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'plain',
              storedContentMode: 'plain', agentState: null,
              metadata: buildCommittedLaunchMetadata({ options: request, directory: '/repo' }) });
            committed = createCurrentSessionProjectionRecordFixture({ id: 'ordinary-session', encryptionMode: 'plain', share: null,
              effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
              metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
              ownerMetadata: fields.ownerMetadata, dataEncryptionKey: null });
            nativeStarts++;
            return { type: 'success', sessionId: committed.id, sessionCreationOutcome: {
              disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
          }), resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) },
        } }));
      const invoke = () => runtime.observeExecution({ actionId: 'session.spawn_new', input, actionRequestId: input.creationKey,
        execute: context => executor.execute('session.spawn_new', input, { ...context, surface: 'cli', authority: 'present_user',
          serverId: 'home', presentUserConfirmation: { actionId: 'session.spawn_new' } }) });
      expect(await invoke()).toMatchObject({ ok: true, result: { type: 'error', code: 'spawn_failed', retryable: true } });
      expect(nativeStarts).toBe(0);
      const completed = await invoke();
      expect(completed).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'ordinary-session' } });
      expect(nativeAdmissions).toHaveLength(2);
      expect(nativeAdmissions[0]?.nonce).toBeTruthy();
      expect(nativeAdmissions[1]).toEqual(nativeAdmissions[0]);
      expect(await invoke()).toEqual(completed);
      expect(nativeAdmissions).toHaveLength(2);
      expect(nativeStarts).toBe(1);
    } finally {
      vi.restoreAllMocks(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests();
    }
  });
  it('rejoins the same CLI creation after selection timestamps refresh, while refusing changed launch values', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'same-cli-spawn' });
    const nativeModes: Array<boolean | undefined> = [];
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      sessionSpawnNew: async input => {
        nativeModes.push(input.resumeActionRequest);
        return input.resumeActionRequest ? { type: 'success', disposition: 'rejoined', sessionId: 'original-session',
          executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
          initialInput: { status: 'notRequested' } } : { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
      } });
    const normalize = async (now: number, modelId = 'gpt-6-luna', effort = 'low') =>
      (await normalizeSessionCreateSpawnRequest({ directory: '/workspace', backendTargetKey: null, modelId,
        configOptions: { reasoning_effort: effort }, initialInput: { text: 'Reply once' } }, {
        activeServerId: 'home', defaultAgentId: 'codex', readSettings: async () => ({ machineId: 'guest' }),
        readAgentDefinitions: () => readAgentCatalogSnapshot().agentDefinitionsById.values(),
        now: () => now,
      })).input;
    const invoke = (input: Awaited<ReturnType<typeof normalize>>) => runtime.observeExecution({ actionId: 'session.spawn_new',
      input, actionRequestId: 'original-attempt', execute: context => executor.execute('session.spawn_new', input,
        { ...context, surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'session.spawn_new' } }) });
    const original = await normalize(100);
    expect(await invoke(original)).toMatchObject({ ok: true, result: { type: 'pending' } });
    const settled = await invoke(await normalize(200));
    expect(settled).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'original-session' } });
    expect(await invoke(await normalize(300))).toEqual(settled);
    for (const changed of [await normalize(400, 'other-model'), await normalize(400, 'gpt-6-luna', 'high'),
      { ...await normalize(400), initialInput: { text: 'Different prompt' } }]) {
      expect(await invoke(changed)).toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    }
    expect(nativeModes).toEqual([undefined, true]);
    expect(original.modelSelection?.updatedAt).toBe(100);
    expect(original.configuration?.options.reasoning_effort).toEqual({ value: 'low', updatedAtMs: 100 });
  });
  it.each(['machines.managed.acquire', 'machines.managed.bootstrap.retry'] as const)('keeps %s linked to its managed row and cancels the containing admitted lifetime', async actionId => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
      generateOperationId: () => 'managed-start' });
    let release!: () => void;
    const boundary = new Promise<void>(resolve => { release = resolve; });
    let aborted = false;
    await runtime.observeExecution({ actionId, input: { managedId: 'managed' }, actionRequestId: 'request',
      execute: async ({ signal, operationAcceptance, operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: 'managed' } });
        operationAcceptance?.accept({ managedId: 'managed', operation: { operationId: 'managed-start' } });
        operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: 'managed',
          bootstrapTask: { id: 'actual-task', taskKind: 'remote.ssh.bootstrapMachine.v1' } } });
        // Native completion is the system boundary. The actual runner/store
        // remains alive after acceptance and owns the public Stop signal.
        signal.addEventListener('abort', () => { aborted = true; release(); }, { once: true });
        await boundary;
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    try {
      expect(await runtime.handlers.getV2({ operationId: 'managed-start' })).toMatchObject({ kind: 'found', operation: {
        domainRef: { kind: 'managedMachine', id: 'managed', bootstrapTask: { id: 'actual-task' } }, cancellation: 'supported',
      } });
      expect(await runtime.handlers.cancel({ operationId: 'managed-start' })).toEqual({ kind: 'requested' });
      expect(aborted).toBe(true);
      expect(await runtime.handlers.getV2({ operationId: 'managed-start', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'cancelled', domainRef: { kind: 'managedMachine', id: 'managed' } } });
    } finally { release(); }
  });
  it.each(['machines.managed.power.set', 'machines.managed.delete'] as const)('cancels the actual accepted %s idle observer through its containing Action signal', async actionId => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
      generateOperationId: () => 'managed-idle' });
    let release!: () => void;
    let aborted = false;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    await runtime.observeExecution({ actionId, input: { when: 'after-idle' }, actionRequestId: 'intent',
      execute: async ({ signal, operationAcceptance, operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ progress: { phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine' } });
        operationAcceptance?.accept({ kind: 'accepted', managedId: 'managed', intentRevision: 1,
          operation: { operationId: 'managed-idle' } });
        signal.addEventListener('abort', () => { aborted = true; release(); }, { once: true });
        await waiting;
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    try {
      expect(await runtime.handlers.cancel({ operationId: 'managed-idle' })).toEqual({ kind: 'requested' });
      expect(aborted).toBe(true);
      expect(await runtime.handlers.get({ operationId: 'managed-idle', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
    } finally { release(); }
  });
  it('reports legacy requester attribution incomplete without cancelling the unknown process', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => 'guest',
      custodyBinding: { serverId: 'home', installationId: 'installation' } });
    let release!: () => void;
    const exit = new Promise<void>(resolve => { release = resolve; });
    let aborted = false;
    await runtime.observeExecution({ actionId: 'projects.script.run', input: {}, execute: async ({ signal, operationOwnerUpdate }) => {
      operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
        machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project' } });
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      await exit; return { ok: true, result: null };
    } });
    try {
      expect(await runtime.cleanupRequesterMachineOperations({ serverId: 'home', machineId: 'worker',
        requesterAccountId: 'guest', installationId: 'installation', verifyCurrentMachineAdmission: async () => true }))
        .toEqual({ kind: 'incomplete' });
      expect(aborted).toBe(false);
    } finally { release(); }
  });
  it('cancels the exact requester FIFO before waiting for physical completion and preserves other requesters', async () => {
    const runtime = createHostActionOperationRuntime({ serverId: 'home', machineId: 'worker', resolveAccountId: async () => 'custodian',
      custodyBinding: { serverId: 'home', installationId: 'installation' }, generateOperationId: (() => {
        let next = 0; return () => `operation-${++next}`;
      })() });
    const admission = (actorAccountId: string) => ({ signal: new AbortController().signal,
      machineAdmission: { actorAccountId, custodianAccountId: 'custodian', machineId: 'worker', installationId: 'installation',
        role: 'use' as const, encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => true });
    const finite = createProjectWorkerAdmission({ machineId: 'worker', admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: 1 },
        source: 'default', metadataVersion: 1 }) });
    let release!: () => void;
    const processExit = new Promise<void>(resolve => { release = resolve; });
    let stopped = false;
    const started: string[] = [];
    const run = (requester: string, requestId: string) => runtime.observeExecution({ actionId: 'projects.script.run',
      input: {}, actionRequestId: requestId, rpcContext: admission(requester),
      execute: context => finite.execute({ operationId: context.operationAcceptance!.operationId,
        requesterAccountId: requester, workspaceRefId: 'workspace', signal: context.signal,
        accept: handle => {
          context.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
            machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project' } });
          context.operationAcceptance!.accept(handle);
        },
        run: async reservation => {
          started.push(requestId);
          reservation.phase('running');
          context.operationOwnerUpdate.update({ state: 'running' });
          reservation.signal.addEventListener('abort', () => { stopped = true; }, { once: true });
          // Only OS completion is substituted: runner, FIFO and custody stay real.
          await processExit;
          return { kind: 'process_settled', result: reservation.signal.aborted
            ? { ok: false, errorCode: 'cancelled', error: 'cancelled' } : { ok: true, result: null } };
        },
      }) });
    await run('guest', 'resident');
    await run('guest', 'queued');
    await run('other', 'other-requester');
    await vi.waitFor(() => expect(started).toEqual(['resident']));
    expect(await finite.load()).toMatchObject({ kind: 'known', running: 1, queued: 2 });
    const subject = { serverId: 'home', machineId: 'worker', requesterAccountId: 'guest', installationId: 'installation',
      verifyCurrentMachineAdmission: async () => true };
    expect(await runtime.cleanupRequesterMachineOperations({ ...subject, serverId: 'other-home' })).toEqual({ kind: 'incomplete' });
    expect(await runtime.cleanupRequesterMachineOperations({ ...subject, installationId: 'old-installation' })).toEqual({ kind: 'incomplete' });
    expect(await runtime.cleanupRequesterMachineOperations({ ...subject, verifyCurrentMachineAdmission: async () => false })).toEqual({ kind: 'incomplete' });
    expect(stopped).toBe(false);
    let settled = false;
    const cleanup = runtime.cleanupRequesterMachineOperations({ serverId: 'home', machineId: 'worker',
      requesterAccountId: 'guest', installationId: 'installation', verifyCurrentMachineAdmission: async () => true })
      .then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(stopped).toBe(true));
    await vi.waitFor(() => expect(runtime.store.get({ accountId: 'guest', machineId: 'worker' }, 'operation-2')?.state)
      .toBe('cancelled'));
    expect(settled).toBe(false);
    expect(started).toEqual(['resident']);
    expect(await finite.load()).toMatchObject({ kind: 'known', running: 1, queued: 1 });
    expect(runtime.store.get({ accountId: 'other', machineId: 'worker' }, 'operation-3')?.state).toBe('accepted');
    release();
    expect(await cleanup).toEqual({ kind: 'settled' });
    expect(runtime.store.get({ accountId: 'guest', machineId: 'worker' }, 'operation-1')?.state).toBe('cancelled');
    await vi.waitFor(() => expect(runtime.store.get({ accountId: 'other', machineId: 'worker' }, 'operation-3')?.state)
      .toBe('succeeded'));
    expect(started).toEqual(['resident', 'other-requester']);
    expect(finite.dependencies()).toEqual([]);
  });
  it('attributes the canonical Action RPC observation to the verified requester, not the custodian', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => 'custodian',
      custodyBinding: { serverId: 'home', installationId: 'installation' },
      generateOperationId: () => 'transported-operation' });
    const keys = tweetnacl.sign.keyPair();
    // Only the signed Home HTTP verifier is substituted; dispatch and the
    // actual CLI executor retain their ordinary unavailable-target behavior.
    const network = vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: 200,
      data: { v: 1, ok: true }, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } }));
    try {
      const rpc = new RpcHandlerManager({ scopePrefix: 'worker', encryptionMode: 'plain',
        authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'worker',
          resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => 'installation',
          verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
            privateKey: keys.secretKey, daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid' }) }),
      });
      const spec = getActionSpec('projects.script.run');
      registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionSpecs: [spec],
        actionExecutor: createActionExecutor(createCliActionDeps({ token: '', sessionId: '', mode: 'plain', ctx: null })),
        observeExecution: runtime.observeExecution });
      await rpc.handleRequest({ method: `worker:${spec.bindings!.rpcMethod}`, params: {
        workspace: { serverId: 'home', machineId: 'worker', workspaceId: 'workspace', rootPath: '/project' },
        selection: { kind: 'named', name: 'build' },
      }, machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'custodian', machineId: 'worker',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' } });
      expect(runtime.store.get({ accountId: 'guest', machineId: 'worker' }, 'transported-operation'))
        .toMatchObject({ scope: { accountId: 'guest', machineId: 'worker' } });
      expect(runtime.store.get({ accountId: 'custodian', machineId: 'worker' }, 'transported-operation')).toBeNull();
    } finally { network.mockRestore(); }
  });
  it('owns a transported operation by its verified actor and withholds a held reply after access loss', async () => {
    expect(getActionSpec('projects.script.run').operation).toBeDefined();
    let activeAccountId = 'custodian';
    const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => activeAccountId,
      custodyBinding: { serverId: 'home', installationId: 'installation' },
      generateOperationId: () => 'guest-operation' });
    const keys = tweetnacl.sign.keyPair();
    let current = true;
    let release!: () => void;
    const exit = new Promise<void>(resolve => { release = resolve; });
    // The HTTP access verifier and process-exit notification are genuine boundaries.
    const network = vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: current ? 200 : 403,
      data: current ? { v: 1, ok: true } : { code: 'access_denied' }, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } }));
    try {
      const rpc = new RpcHandlerManager({ scopePrefix: 'worker', encryptionMode: 'plain',
        authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'worker',
          resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => 'installation',
          verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
            privateKey: keys.secretKey, daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid' }) }),
      });
      registerActionOperationRpcHandlers(rpc, runtime.handlers);
      rpc.registerHandler('execute-project', async (input: unknown, context?: RpcHandlerContext) => runtime.observeExecution({
        actionId: 'projects.script.run', input, rpcContext: context, execute: async operation => {
          operation.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
            machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project' } });
          await exit;
          return { ok: true, result: { privateResult: 'guest-only' } };
        },
      }));
      const machineAdmission = { actorAccountId: 'guest', custodianAccountId: 'custodian', machineId: 'worker',
        installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
      const call = (method: string, params: unknown) => rpc.handleRequest({ method: `worker:${method}`, params, machineAdmission });
      expect(await call('execute-project', { accountId: 'custodian' })).toMatchObject({ ok: true, result: {
        operation: { scope: { accountId: 'guest', machineId: 'worker' }, state: 'accepted' },
      } });
      expect(runtime.store.get({ accountId: 'custodian', machineId: 'worker' }, 'guest-operation')).toBeNull();
      expect((await runtime.activity.read()).items).toContainEqual(expect.objectContaining({ ownerRef: 'guest-operation',
        attribution: { serverId: 'home', accountId: 'guest', machineId: 'worker', installationId: 'installation' },
      }));
      const waiting = call(ACTION_OPERATION_RPC_METHODS_V1.get, { operationId: 'guest-operation', waitForTerminal: true });
      // Let the admitted long observation reach its real retained invocation before revocation.
      await vi.waitFor(() => expect(rpc.getActiveHandlerExecutions()).toContainEqual(expect.objectContaining({
        method: ACTION_OPERATION_RPC_METHODS_V1.get,
      })));
      await new Promise<void>(resolve => setImmediate(resolve));
      activeAccountId = 'different-account';
      current = false;
      release();
      expect(await waiting).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(runtime.store.get({ accountId: 'guest', machineId: 'worker' }, 'guest-operation')).toMatchObject({ state: 'succeeded' });
      expect(runtime.store.readRequesterWorkAttribution('guest-operation')).toEqual({ serverId: 'home', accountId: 'guest',
        machineId: 'worker', installationId: 'installation' });
      expect(runtime.store.get({ accountId: 'different-account', machineId: 'worker' }, 'guest-operation')).toBeNull();
    } finally { release(); network.mockRestore(); }
  });
  it('retries the same unconfirmed live process Stop and settles only after its observed exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-repeated-stop-'));
    const exits = new Set<(exit: PtyExitEvent) => void>();
    const process: PtyProcess = { pid: 12345, ownedProcessGroupId: 12345, write() {}, resize() {}, kill() {},
      onData: () => ({ dispose() {} }),
      onExit: listener => { exits.add(listener); return { dispose: () => exits.delete(listener) }; } };
    let attempts = 0;
    const terminals = createTerminalPtySessionManager({ ptyProvider: { spawn: () => process }, env: {}, platform: 'linux',
      probeProcessGroup: () => 'absent',
      stopProcessTree: async () => { attempts++; if (attempts === 1) throw new Error('OS tree Stop unconfirmed'); },
      config: { bufferMaxBytes: 100000, bufferMaxEvents: 1000,
        bufferRetentionMs: 600000, urlParseBufferLimit: 32768, maxWriteChunkBytes: 16384, defaultCols: 80, defaultRows: 24 } });
    try {
      const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => 'account',
        generateOperationId: () => 'repeat-stop' });
      await runtime.observeExecution({ actionId: 'projects.compute.exec', input: {}, execute: async operation => {
        const launch = await authorizeResolvedProjectExecLaunchForHost({ launch: { command: '/managed/process', args: [], cwd: root, env: {} },
          signal: operation.signal, assertCurrent: () => undefined,
          projectLaunch: { status: 'ready', reviewedEffectDigest: 'reviewed', environment: {
            selection: { kind: 'host' }, root, platform: 'linux', io: { resolveTool: async () => null,
              run: async () => { throw new Error('Host environment never evaluates a native tool'); } } } } });
        try { return (await executeProjectFiniteProcess({ workspace: { id: 'workspace', serverId: 'home', machineId: 'worker',
          rootPath: root, createdAtMs: 1 }, purpose: 'exec', requesterAccountId: 'account', operation, terminalSessions: terminals, launch })).result; }
        finally { launch.release(); }
      } });
      expect(await runtime.handlers.cancel({ operationId: 'repeat-stop' })).toEqual({ kind: 'requested' });
      await expect.poll(() => runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')?.observation)
        .toMatchObject({ kind: 'stop_unconfirmed' });
      expect(runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')).toMatchObject({ state: 'running' });
      expect(await runtime.handlers.cancel({ operationId: 'repeat-stop' })).toEqual({ kind: 'requested' });
      await expect.poll(() => attempts).toBe(2);
      expect(runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')).not.toHaveProperty('settledAt');
      for (const exit of exits) exit({ exitCode: 0, signal: 0 });
      // An outstanding stop_unconfirmed observation makes public wait return
      // early; wait for the real process owner to consume its exit first.
      await expect.poll(() => runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')?.state)
        .toBe('cancelled');
      expect(await runtime.handlers.get({ operationId: 'repeat-stop', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
      expect(runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')).not.toHaveProperty('observation');
    } finally { terminals.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it('keeps a managed bootstrap task discoverable after acceptance while its native task remains running', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
      generateOperationId: () => 'managed' });
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    await expect(runtime.observeExecution({ actionId: 'machines.managed.acquire', input: {}, actionRequestId: 'request',
      execute: async ({ operationAcceptance, operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ domainRef: { kind: 'systemTask', id: 'task', taskKind: 'remote.ssh.bootstrapMachine.v1' } });
        operationAcceptance?.accept({ managedId: 'machine', operation: { operationId: 'managed' } });
        await pending;
        return { ok: true, result: { managedId: 'machine', operation: { operationId: 'managed' } } };
      },
    })).resolves.toMatchObject({ ok: true, result: { managedId: 'machine' } });
    const acceptedOperation = await runtime.handlers.getV2({ operationId: 'managed' });
    expect(acceptedOperation, JSON.stringify(acceptedOperation)).toMatchObject({ kind: 'found', operation: {
      state: 'running', scope: { accountId: 'account', machineId: 'controller' },
      domainRef: { kind: 'systemTask', id: 'task', taskKind: 'remote.ssh.bootstrapMachine.v1' },
    } });
    settle();
    expect(await runtime.handlers.get({ operationId: 'managed', waitForTerminal: true })).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
  });
  it('routes relocation cancellation to its supported owner without settling an unknown native start', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'source', resolveAccountId: async () => 'account',
      generateOperationId: () => 'move', supportsCoreCancellation: actionId => actionId === 'projects.service.relocate' });
    const request = runtime.observeExecution({ actionId: 'projects.service.relocate', input: { requestId: 'move-1' },
      execute: async ({ signal, operationAcceptance }) => {
        operationAcceptance?.accept({ status: 'accepted', operationId: 'move' });
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { ok: false, errorCode: 'outcome_uncertain', error: 'native start is unknown' };
      },
    });
    await expect(request).resolves.toMatchObject({ ok: true });
    expect(await runtime.handlers.cancel({ operationId: 'move' })).toEqual({ kind: 'requested' });
    expect(await runtime.handlers.getV2({ operationId: 'move', waitForTerminal: true }))
      .toMatchObject({ kind: 'found', operation: { state: 'running', cancellation: 'unsupported',
        observation: { kind: 'outcome_uncertain' } } });
    expect(await runtime.handlers.cancel({ operationId: 'move' })).toEqual({ kind: 'unsupported' });
  });
  it('offers Stop for a finite producer and settles only its observed cancelled process', async () => {
    expect(getActionSpec('projects.script.run').operation).toBeDefined();
    const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => 'account',
      generateOperationId: () => 'finite' });
    let processCancelled = false;
    const reply = await runtime.observeExecution({ actionId: 'projects.script.run', input: {}, actionRequestId: 'request',
      execute: async ({ operationOwnerUpdate, signal }) => {
        operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
          machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project' } });
        await new Promise<void>(resolve => signal.addEventListener('abort', () => { processCancelled = true; resolve(); }, { once: true }));
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    expect(reply).toMatchObject({ ok: true, result: { operation: { state: 'accepted', cancellation: 'supported' } } });
    expect(processCancelled).toBe(false);
    expect(await runtime.handlers.cancel({ operationId: 'finite' })).toEqual({ kind: 'requested' });
    const cancelledOperation = await runtime.handlers.getV2({ operationId: 'finite', waitForTerminal: true });
    expect(cancelledOperation, JSON.stringify(cancelledOperation))
      .toMatchObject({ kind: 'found', operation: { state: 'cancelled', domainRef: { kind: 'projectCommand' } } });
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { ArtifactReadHeadersBatchInputV1Schema, ArtifactReadHeadersBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import tweetnacl from 'tweetnacl';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { Credentials, StoredCredentials } from '@/persistence';
import {
  AgentStateRequestStore,
  type AgentStateResponseTargetDispatch,
} from '@/agent/permissions/agentStateRequestStore';
import type { AgentState } from '@/api/types';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createVoiceSessionRuntimeThroughNativeFactory } from './testkit/nativeSessionContext';
import { createExecutionRunHostBackendFromConversationRuntime, type AgentExecutionRunConversationRuntimeV1, type AgentRuntime, type AgentSessionRuntime, type AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildRunScopedExecutionPermissionRequestId } from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunHostRunScopeBinding } from '@/agent/runtime/registry/engineRegistryTypes';
import { resolveCliEngineRegistry, type ResolvedCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import type { ExecutionRunAppliedParentSelection } from './runtime/openInputs';
import {
  createTestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntimeOptions,
} from '@/agent/runtime/bridges/executionRun/testkit';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { runGit } from '@/scm/rpc/__tests__/testRpcHarness';
import {
  accountSettingsParse,
  buildSystemSessionMetadataV1,
  ExecutionRunResumeHandleSchema,
  FeaturesResponseSchema,
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { SavedSecretOperationAdmissionError } from "@/settings/secrets/savedSecretCatalogRead";
import { registerExecutionRunRpcHandlers } from '@/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers';
import * as daemonControlHttp from '@/daemon/controlHttp';
import { readRetainedExecutionRunRecord, retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { configuration } from '@/configuration';
import { resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createMutableApiSessionClientFixture, type MutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import {
  clearActiveAccountSettingsSnapshot,
  setActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  commitActivePromptLibraryCatalog,
  commitActiveProfileCatalog,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { ReviewCommentCreateRequestV1Schema, ReviewCommentV1Schema } from '@happier-dev/protocol';
import { createReviewRunCommentService } from '@/agent/executionRuns/profiles/review/reviewComments';
import { createCliReviewCommentActionExecutorFromCredentials } from '@/agent/reviews/comments/executor';

type TestRuntimeFactoryInput = Parameters<typeof import('./runtime/create').createExecutionRunRuntime>[0];
type NativePromptRuntimeFactory = (opts: TestRuntimeFactoryInput) => ExecutionRunHostRuntime;
type TestRuntimeFactory = (opts: TestRuntimeFactoryInput) => ExecutionRunHostRuntime | NativePromptRuntimeFactory;

const TEST_PRIMARY_BACKEND_ID = `${'primary'}.${'backend'}` as never;
const TEST_SECONDARY_BACKEND_ID = `${'secondary'}.${'backend'}` as never;
const CONNECTED_SERVICES_REGISTRATION = {
  v: 1 as const,
  activationId: '11111111-1111-4111-8111-111111111111',
  runKey: 'replaced-at-runtime',
  agentId: TEST_PRIMARY_BACKEND_ID,
  materializationKey: 'replaced-at-runtime',
  connectedServicesBindings: {
    v: 2 as const,
    bindingsByServiceId: {},
  },
  connectedServiceSelectionsEnv: {},
  sessionDirectory: '/tmp/project',
  materializedRoot: null,
};
let defaultExecutionRunManagerTestCwd = '';
let defaultExecutionRunManagerPluginHomeDir = '';
let defaultExecutionRunManagerEngineRegistry: ResolvedCliEngineRegistry;
let shutdownDefaultExecutionRunManagerPluginRuntime:
  | (() => Promise<void>)
  | null = null;
const defaultVoiceAccountCredentials: StoredCredentials = {
  token: `header.${Buffer.from(JSON.stringify({ sub: 'execution-run-manager-account' })).toString('base64url')}.signature`,
  encryption: null,
};
let restoreDefaultVoiceAccountHttp: (() => void) | null = null;
let restoreReviewCommentHttp: (() => void) | null = null;
const managerParentSessions: MutableApiSessionClientFixture[] = [];

const {
  createExecutionRunRuntimeMock,
  dispatchBridgeLifecycleHookEvent,
  readCredentials,
  readStoredCredentials,
  runtimeFactoryRef,
  resolveReplaySeedDraft,
} = vi.hoisted(() => {
  const runtimeFactoryRef: { current: TestRuntimeFactory | null } = { current: null };
  return {
    createExecutionRunRuntimeMock: vi.fn((opts: TestRuntimeFactoryInput): ExecutionRunHostRuntime => {
      const factory = runtimeFactoryRef.current;
      if (!factory) {
        throw new Error('Test execution-run runtime factory was not configured');
      }
      const runtime = factory(opts);
      return typeof runtime === 'function' ? runtime(opts) : runtime;
    }),
    dispatchBridgeLifecycleHookEvent: vi.fn().mockResolvedValue(undefined),
    readCredentials: vi.fn<() => Promise<Credentials | null>>(),
    readStoredCredentials: vi.fn<() => Promise<StoredCredentials | null>>(async () => null),
    runtimeFactoryRef,
    resolveReplaySeedDraft: vi.fn(),
  };
});

vi.mock('./createExecutionRunBridgeRuntime', () => ({
  createExecutionRunBridgeRuntime: createExecutionRunRuntimeMock,
}));

vi.mock('../../../plugins/runtime/hooks/execution/dispatchBridgeLifecycleHookEvent', () => ({
  dispatchBridgeLifecycleHookEvent,
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readCredentials,
  readStoredCredentials,
}));

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft,
}));

import { ExecutionRunHostBridge as ExecutionRunManager } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';

beforeAll(async () => {
  defaultExecutionRunManagerTestCwd = mkdtempSync(join(tmpdir(), 'happier-execution-run-manager-workspace-'));
  runGit(defaultExecutionRunManagerTestCwd, ['init', '--initial-branch=main']);
  defaultExecutionRunManagerPluginHomeDir = mkdtempSync(
    join(tmpdir(), 'happier-execution-run-manager-plugin-home-'),
  );
  const [
    { pluginReloadController },
    { resolveExecutablePluginRuntimeRegistry },
  ] = await Promise.all([
    import('@/plugins/runtime/reload/singleton'),
    import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry'),
  ]);
  const registry = await resolveExecutablePluginRuntimeRegistry({
    happyHomeDir: defaultExecutionRunManagerPluginHomeDir,
    generation: 1,
    // These bridge tests inject the external Agent runtime factory. Their real
    // host registry has no installed plugin demand; unrelated bundled Agents
    // must not be activated without their own admitted source custody.
    pluginIds: [],
  });
  const adoption = await pluginReloadController.adoptPreparedRuntimeRegistry({
    registry,
    changedPluginIds: [],
    durableRevision: 1,
    runningSessionDisposition: 'retainRunningSessions',
  });
  if (!adoption.ok) {
    throw new Error('Failed to publish the execution-run manager test plugin runtime');
  }
  defaultExecutionRunManagerEngineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: registry });
  shutdownDefaultExecutionRunManagerPluginRuntime = async () => {
    await pluginReloadController.shutdown({ timeoutMs: 5_000 });
  };
});

afterAll(async () => {
  await shutdownDefaultExecutionRunManagerPluginRuntime?.();
  shutdownDefaultExecutionRunManagerPluginRuntime = null;
  if (defaultExecutionRunManagerTestCwd) {
    rmSync(defaultExecutionRunManagerTestCwd, { recursive: true, force: true });
    defaultExecutionRunManagerTestCwd = '';
  }
  if (defaultExecutionRunManagerPluginHomeDir) {
    rmSync(defaultExecutionRunManagerPluginHomeDir, {
      recursive: true,
      force: true,
    });
    defaultExecutionRunManagerPluginHomeDir = '';
  }
});

beforeEach(() => {
  runtimeFactoryRef.current = null;
  createExecutionRunRuntimeMock.mockClear();
  dispatchBridgeLifecycleHookEvent.mockClear();
  admitDefaultVoiceAccountFixture();
  // Review completion persists findings through the real service and signed
  // transport. Only Home's HTTP response and the installation key are fixtures.
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    if (path !== '/v1/reviews/comments') throw new Error(`Unexpected manager Account write: ${path}`);
    const { authorIntent, clientMutationId, eventEnvelope, ...input } = ReviewCommentCreateRequestV1Schema.parse(body);
    const comment = ReviewCommentV1Schema.parse({ ...input,
      v: 1, id: `comment-${input.runId}-${input.findingId}`, threadId: `comment-${input.runId}-${input.findingId}`,
      accountId: 'execution-run-manager-account', bodyVersion: 1,
      author: { kind: 'agent', agentId: input.engineId, sessionId: input.sessionId },
      state: authorIntent === 'open' ? 'open' : 'proposed', flags: {}, dispositions: {}, edits: [], transitions: [],
      createdAt: 1, updatedAt: 1, serverRevision: 1,
    });
    return { status: 200, data: { comment } };
  });
  restoreReviewCommentHttp = () => post.mockRestore();
});

function admitDefaultVoiceAccountFixture() {
  if (restoreDefaultVoiceAccountHttp) return;
  const scopeKey = resolveAccountSettingsScopeKey(defaultVoiceAccountCredentials);
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
  const bound = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
  commitActivePromptLibraryCatalog({ ...bound, catalog: { status: 'ready', rows: [{ revision: 1,
    record: { key: 'voice', value: { v: 1, scope: { kind: 'voice' }, entries: [] } } },
    { revision: 1, record: { key: 'role-overrides', value: { v: 1, overrides: {} } } }],
    tombstones: [], diagnostics: [] } });
  commitActiveProfileCatalog({ ...bound, catalog: { status: 'ready', authority: 'active', control: null,
    controlRevision: 'absent', referenceGuardRevision: 'absent', diagnostics: [], records: [] } });
  // Generic bridge fixtures still prepare through the real qualified reader.
  // This HTTP boundary represents their ordinary, plain Account Sessions.
  const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (!path.startsWith('/v2/sessions/')) throw new Error(`Unexpected manager Account read: ${path}`);
    const id = path.slice('/v2/sessions/'.length);
    return { status: 200, data: { session: { id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      archivedAt: null, encryptionMode: 'plain', metadataVersion: 0, agentState: null, agentStateVersion: 0,
      pendingCount: 0, pendingVersion: 0, share: null, dataEncryptionKey: null, metadata: '{}' } } };
  });
  restoreDefaultVoiceAccountHttp = () => http.mockRestore();
}

afterEach(async () => {
  await Promise.all(managerParentSessions.splice(0).map(session => session.close()));
  restoreReviewCommentHttp?.();
  restoreReviewCommentHttp = null;
  if (!restoreDefaultVoiceAccountHttp) return;
  restoreDefaultVoiceAccountHttp?.();
  restoreDefaultVoiceAccountHttp = null;
  clearActiveAccountSettingsSnapshot();
});

it.each([
  {
    name: 'missing',
    requestedRevision: 1,
    resources: [],
    expectedCode: 'provider_binding_changed',
  },
  {
    name: 'stale',
    requestedRevision: 6,
    resources: [{
      resourceId: 'shared-key',
      ownerAccountId: 'owner-account',
      displayName: 'Shared key',
      kind: 'apiKey' as const,
      encryptionMode: 'plain' as const,
      revision: 7,
      materialStatus: 'access_removed' as const,
      storedContent: null,
    }],
    expectedCode: 'provider_binding_changed',
  },
])('rejects a $name launch secret reference before creating any Run effect', async ({
  requestedRevision,
  resources,
  expectedCode,
}) => {
  const createRuntime = vi.fn(() => createTestExecutionRunHostRuntime());
  const sendAcp = vi.fn(async () => {});
  const manager = createExecutionRunManager({
    parentProvider: TEST_PRIMARY_BACKEND_ID,
    cwd: process.cwd(),
    createRuntime,
    sendAcp,
    getNowMs: () => 1_700_000_000_000,
    resolveAccountSettingsSnapshot: async () => ({
      source: 'network',
      settings: accountSettingsParse({}),
      settingsVersion: 1,
      loadedAtMs: 1_700_000_000_000,
      settingsSecretsReadKeys: [],
      savedSecretResources: resources,
      savedSecretCatalogState: 'ready',
    }),
  });

  await expect(manager.start({
    sessionId: 'parent_session_1',
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
    instructions: 'do not create a run',
    permissionMode: 'read_only',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
    secretReferenceOverlay: {
      v: 1,
      bindings: {
        API_KEY: {
          ref: 'happier:shared-secret:v1:shared-key',
          revision: requestedRevision,
        },
      },
    },
  })).rejects.toMatchObject({
    code: expectedCode,
    details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
  });

  expect(createRuntime).not.toHaveBeenCalled();
  expect(sendAcp).not.toHaveBeenCalled();
  expect(dispatchBridgeLifecycleHookEvent).not.toHaveBeenCalled();
  expect((manager as unknown as { runs: Map<string, ExecutionRunState> }).runs.size)
    .toBe(0);
  expect((manager as unknown as { controllers: Map<string, ExecutionRunController> }).controllers.size)
    .toBe(0);
});

it('denies a Run before effects when operation refresh observes a missed shared revocation', async () => {
  const createRuntime = vi.fn(() => createTestExecutionRunHostRuntime());
  const manager = createExecutionRunManager({
    parentProvider: TEST_PRIMARY_BACKEND_ID,
    cwd: process.cwd(),
    createRuntime,
    sendAcp: vi.fn(async () => {}),
    resolveAccountSettingsSnapshot: async () => {
      throw new SavedSecretOperationAdmissionError({
        reason: 'reference_stale',
        reference: 'happier:shared-secret:v1:shared-key',
      });
    },
  });

  await expect(manager.start({
    sessionId: 'parent_session_1',
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
    instructions: 'do not use revoked material',
    permissionMode: 'read_only',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
    secretReferenceOverlay: {
      v: 1,
      bindings: {
        API_KEY: {
          ref: 'happier:shared-secret:v1:shared-key',
          revision: 7,
        },
      },
    },
  })).rejects.toMatchObject({
    code: 'provider_binding_changed',
    details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
  });
  expect(createRuntime).not.toHaveBeenCalled();
  expect((manager as unknown as { runs: Map<string, ExecutionRunState> }).runs.size).toBe(0);
});

it('starts with a current reference while passing only materialized process-local values to the runtime', async () => {
  const createRuntime = vi.fn(() => createTestExecutionRunHostRuntime({
    onSendPrompt: async () => {},
    onWaitForTurnCompletion: async () => {},
  }));
  const resolveAccountSettingsSnapshot = vi.fn(async () => ({
    source: 'network' as const,
    settings: accountSettingsParse({}),
    settingsVersion: 1,
    loadedAtMs: 1_700_000_000_000,
    settingsSecretsReadKeys: [],
    savedSecretCatalogState: 'ready' as const,
    savedSecretResources: [{
      resourceId: 'shared-key',
      ownerAccountId: 'owner-account',
      displayName: 'Shared key',
      kind: 'apiKey' as const,
      encryptionMode: 'plain' as const,
      revision: 7,
      materialStatus: 'ready' as const,
      storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId: 'shared-key',
        mode: 'plain',
        content: { v: 1, name: 'Shared key', kind: 'apiKey', value: 'current-value' },
      }),
    }],
  }));
  const manager = createExecutionRunManager({
    parentProvider: TEST_PRIMARY_BACKEND_ID,
    cwd: process.cwd(),
    createRuntime,
    sendAcp: async () => {},
    getNowMs: () => 1_700_000_000_000,
    resolveAccountSettingsSnapshot,
  });

  const started = await manager.start({
    sessionId: 'parent_session_1',
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
    instructions: 'use current secret',
    permissionMode: 'read_only',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
    secretReferenceOverlay: {
      v: 1,
      bindings: {
        API_KEY: {
          ref: 'happier:shared-secret:v1:shared-key',
          revision: 7,
        },
      },
    },
  });

  expect(createExecutionRunRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
    secretReferenceEnvironment: { API_KEY: 'current-value' },
  }));
  expect(resolveAccountSettingsSnapshot).toHaveBeenCalledExactlyOnceWith({
    secretReferenceOverlay: {
      v: 1,
      bindings: {
        API_KEY: {
          ref: 'happier:shared-secret:v1:shared-key',
          revision: 7,
        },
      },
    },
  });
  expect(JSON.stringify(manager.get(started.runId))).not.toContain('current-value');
  await manager.stop(started.runId);
});

function createManagerParentHost(sessionId = 'parent_session_1', applied: ExecutionRunAppliedParentSelection = {
  status: 'applied', backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
  modelId: null, connectedServices: null,
}) {
  const session = createMutableApiSessionClientFixture({ sessionId });
  managerParentSessions.push(session);
  return {
    session,
    machineId: 'manager-fixture-machine',
    permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Manager fixture]' }),
    // The parent Agent's applied configuration is a runtime boundary observation.
    // Child resolution, role admission and retained Run policy remain real.
    readAppliedChildSelection: async () => applied,
  };
}

function createExecutionRunManager(
  opts: ConstructorParameters<typeof ExecutionRunManager>[0] & Readonly<{ createRuntime: TestRuntimeFactory }>,
): ExecutionRunManager {
  const { createRuntime, ...bridgeOptions } = opts;
  runtimeFactoryRef.current = createRuntime;
  return new ExecutionRunManager({
    ...bridgeOptions,
    // Account preference transport is the external boundary; this fixture chooses Important.
    resolveRunReportPolicy: bridgeOptions.resolveRunReportPolicy ?? (async () => ({ preset: 'important' })),
    reviewComments: bridgeOptions.reviewComments ?? createReviewRunCommentService({
      cwd: defaultExecutionRunManagerTestCwd,
      scope: { workspace: { machineId: 'manager-fixture-machine', path: defaultExecutionRunManagerTestCwd } },
      execute: createCliReviewCommentActionExecutorFromCredentials({
        credentials: defaultVoiceAccountCredentials,
        resolveAccountEncryptionMode: async () => 'plain',
        resolvePrincipalSigningContext: async () => ({
          machineId: 'manager-fixture-machine', installationId: 'manager-fixture-installation',
          privateKeyBase64Url: Buffer.from(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey).toString('base64url'),
        }),
      }),
    }),
    resolveExecutionRunProfileCatalog: bridgeOptions.resolveExecutionRunProfileCatalog ?? (() => ({
      profileCatalog: bridgeOptions.executionRunProfileCatalog ?? buildExecutionRunProfileCatalog(),
      engineRegistry: defaultExecutionRunManagerEngineRegistry,
      // The fixture Agent's external model catalog explicitly supports JSON.
      // Keep admission real rather than bypassing structured-output policy.
      readNativeOfferedModel: async ({ modelId }) => ({
        id: modelId, name: modelId, capabilities: { structuredOutput: 'supported' },
      }),
    })),
    sessionInteractionHost: bridgeOptions.sessionInteractionHost ?? createManagerParentHost(),
    cwd: bridgeOptions.cwd === process.cwd() ? defaultExecutionRunManagerTestCwd : bridgeOptions.cwd,
    // The production RPC factory supplies these authenticated inputs. A bare
    // bridge has no Account authority and correctly refuses bound preparation.
    resolveVoicePromptPreparation: bridgeOptions.resolveVoicePromptPreparation ?? (async args => {
      admitDefaultVoiceAccountFixture();
      return await resolveCliVoicePromptPreparation({ ...args, credentials: defaultVoiceAccountCredentials,
        serverId: configuration.activeServerId, directory: args.workingDirectory ?? undefined });
    }),
  });
}

it('refuses attached omission before Run effects when the applied parent is unavailable', async () => {
  const createRuntime = vi.fn(() => createTestExecutionRunHostRuntime());
  const manager = createExecutionRunManager({
    parentProvider: TEST_PRIMARY_BACKEND_ID, cwd: process.cwd(), createRuntime, sendAcp: async () => {},
    sessionInteractionHost: createManagerParentHost('parent_session_1', { status: 'unavailable' }),
  });
  try {
    await expect(manager.start({
      sessionId: 'parent_session_1', intent: 'agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    })).rejects.toMatchObject({
      code: 'execution_run_parent_selection_unavailable',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(createRuntime).not.toHaveBeenCalled();
  } finally {
    await manager.dispose();
  }
});

it('keeps a terminal waiter registered from the first running publication until canonical terminal state', async () => {
  const runtime = createTestExecutionRunHostRuntime({
    onWaitForTurnCompletion: () => new Promise<void>(() => {}),
    onCancel: async () => {},
  });
  let manager!: ExecutionRunManager;
  let waiter: Promise<void> | null = null;
  let waiterSettled = false;
  manager = createExecutionRunManager({
    parentProvider: TEST_PRIMARY_BACKEND_ID,
    cwd: process.cwd(),
    createRuntime: () => runtime,
    sendAcp: async () => {},
    onPublicStateUpdated: (run) => {
      if (run.status !== 'running' || waiter) return;
      waiter = manager.waitForTerminal(run.runId);
      void waiter.then(() => {
        waiterSettled = true;
      });
    },
    getNowMs: () => 1_700_000_000_000,
  });

  const started = await manager.start({
    sessionId: 'parent_session_1',
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
    instructions: 'wait for cancellation',
    permissionMode: 'read_only',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
  });

  await Promise.resolve();
  expect(waiter).not.toBeNull();
  expect(waiterSettled).toBe(false);

  await manager.stop(started.runId);
  await expect(waiter).resolves.toBeUndefined();
  expect(waiterSettled).toBe(true);
});

async function readExecutionRunTurnStreamUntilDone(args: Readonly<{
  manager: ExecutionRunManager;
  runId: string;
  streamId: string;
  maxEvents?: number;
  maxReads?: number;
}>): Promise<Array<unknown>> {
  let lastEvents: Array<unknown> = [];

  for (let i = 0; i < (args.maxReads ?? 8); i += 1) {
    const read = await args.manager.readTurnStream(args.runId, {
      streamId: args.streamId,
      cursor: 0,
      ...(typeof args.maxEvents === 'number' ? { maxEvents: args.maxEvents } : {}),
    });
    expect(read.ok).toBe(true);
    lastEvents = (read as { events: Array<unknown> }).events;
    if ((read as { done?: boolean }).done === true) {
      return lastEvents;
    }
    await Promise.resolve();
  }

  return lastEvents;
}

type PromptRuntimeHandler = (
  runtime: TestExecutionRunHostRuntime,
  sessionId: string,
  prompt: string,
) => void | Promise<void>;

function createPromptRuntime(
  onSendPrompt: PromptRuntimeHandler,
  opts: Pick<TestExecutionRunHostRuntimeOptions,
    'resumeSupported' | 'providerSessionId' | 'onProvisionRuntime' | 'onCancel' | 'onWaitForTurnCompletion' | 'onDispose'> = {},
): NativePromptRuntimeFactory {
  return factoryInput => {
  let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
  let sessionId = '';
  let turnId: string | null = null;
  let sequence = 0;
  let fullText = '';
  let disposed = false;
  const base = () => ({ sessionId, sequence: sequence++, emittedAtMs: Date.now() });
  const externalSession: AgentSessionRuntime = {
      watch(value) {
        listener = value;
        if (opts.providerSessionId) listener({ ...base(), kind: 'provider-session-id', providerSessionId: opts.providerSessionId });
        return { dispose() { listener = undefined; } };
      },
      async send(request) {
        const inputTurnId = request.delivery.turnId;
        turnId = inputTurnId;
        fullText = '';
        listener?.({ ...base(), kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        listener?.({ ...base(), kind: 'turn-start', turnId: inputTurnId, startedBy: 'host' });
        await onSendPrompt(runtime, sessionId, request.input.text);
        // Native completion is an event, independent from send admission. The
        // real host owns joining it, cancellation and terminal publication.
        void (async () => {
          try {
            await opts.onWaitForTurnCompletion?.();
            if (!disposed && turnId === inputTurnId) {
              listener?.({ ...base(), kind: 'turn-complete', turnId: inputTurnId });
              turnId = null;
            }
          } catch (error) {
            if (!disposed && turnId === inputTurnId) {
              listener?.({ ...base(), kind: 'turn-failed', turnId: inputTurnId,
                diagnostic: { code: 'fixture_provider_failed', severity: 'error', message: error instanceof Error ? error.message : String(error) } });
              turnId = null;
            }
          }
        })();
        return { status: 'admitted' };
      },
      async cancel(request) {
        await opts.onCancel?.(sessionId);
        if (turnId === request.turnId) {
          listener?.({ ...base(), kind: 'turn-cancelled', turnId: request.turnId, cause: request.reason });
          turnId = null;
        }
        return { status: 'requested', turnId: request.turnId };
      },
      async dispose() {
        disposed = true;
        await opts.onDispose?.();
      },
  };
  const createConversation = (): AgentExecutionRunConversationRuntimeV1 => ({
    send: request => externalSession.send(request),
    cancel: request => externalSession.cancel!(request),
    dispose: () => externalSession.dispose(),
    watch(listener) {
      return externalSession.watch(event => {
        const { sequence: _sequence, sessionId: _sessionId, ...fact } = event;
        listener(fact);
      });
    },
  });
  const agent: AgentRuntime = { sessions: {
    async open(request) {
      sessionId = request.sessionId;
      await opts.onProvisionRuntime?.(request.kind === 'resume' ? { resumeRuntimeId: request.providerSessionId } : {});
      return externalSession;
    },
    executionRunContextV1: {
      async openConversation(request) {
        if (request.kind === 'fork') throw new Error('Fixture fork is not supported');
        await opts.onProvisionRuntime?.(request.kind === 'resume' ? { resumeRuntimeId: request.checkpointId } : {});
        return createConversation();
      },
      async open(request) {
        if (request.kind === 'fork') throw new Error('Fixture fork is not supported');
        await opts.onProvisionRuntime?.(request.kind === 'resume' ? { resumeRuntimeId: request.checkpointId } : {});
        return createExecutionRunHostBackendFromConversationRuntime({ request,
          readCheckpointId: event => event.kind === 'provider-session-id' ? event.providerSessionId : null,
          openConversation: async () => createConversation(),
        });
      },
    },
  } };
  const native = createVoiceSessionRuntimeThroughNativeFactory({ runtime: agent, modelId: 'manager-fixture',
    runtimeOptions: { ...factoryInput,
      accountSettings: factoryInput.accountSettings ? accountSettingsParse(factoryInput.accountSettings) : null },
    capabilities: { open: opts.resumeSupported ? ['create', 'resume'] : ['create'], delivery: ['newTurn'], cancel: true,
      // The external fixture has no filesystem effect channel and enforces
      // read-only roles; its detached facet above is the declared SDK v1 owner.
      workspaceWrites: 'deny', executionRunContext: { versions: [1] } } });
  // Inherit the lazy runtime's live accessors; spreading it would snapshot the
  // not-yet-opened completion and input-custody ports as undefined.
  const runtime: TestExecutionRunHostRuntime = Object.freeze(Object.assign(Object.create(native) as ExecutionRunHostRuntime, { emitMessage(message: AgentMessage) {
    if (message.type === 'event' && message.name === 'provider_session_id') {
      const payload = message.payload;
      if (payload && typeof payload === 'object' && 'sessionId' in payload && typeof payload.sessionId === 'string') {
        listener?.({ ...base(), kind: 'provider-session-id', providerSessionId: payload.sessionId });
        return;
      }
    }
    if (!turnId) throw new Error(`Fixture output ${message.type} has no native turn`);
    if (message.type === 'model-output') {
      const text = message.textDelta ?? (message.fullText?.startsWith(fullText) ? message.fullText.slice(fullText.length) : message.fullText) ?? '';
      fullText = message.fullText ?? fullText + text;
      listener?.({ ...base(), kind: 'message-delta', turnId, channel: 'assistant', text,
        ...(message.messageId ? { messageId: message.messageId } : {}) });
      return;
    }
    if (message.type === 'tool-call') {
      listener?.({ ...base(), kind: 'tool-call', turnId, toolCallId: message.callId, toolName: message.toolName,
        input: AgentRuntimeJsonValueV1Schema.parse(message.args) });
      return;
    }
    if (message.type === 'tool-result') {
      listener?.({ ...base(), kind: 'tool-result', turnId, toolCallId: message.callId,
        output: AgentRuntimeJsonValueV1Schema.parse(message.result), ...(message.isError === undefined ? {} : { isError: message.isError }) });
      return;
    }
    throw new Error(`Unsupported external Agent fixture output: ${message.type}`);
  } }));
  return runtime;
  };
}

function createStaticJsonRuntime(responseText: string): NativePromptRuntimeFactory {
  return createPromptRuntime((runtime) => {
    runtime.emitMessage({ type: 'model-output', fullText: responseText });
  });
}

function createDelayedJsonRuntime(responseText: string, delayMs: number): NativePromptRuntimeFactory {
  let done: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone: (() => void) | null = null;
  const finish = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    resolveDone?.();
  };
  return createPromptRuntime(
    (runtime) => {
      done = new Promise((resolve) => {
        resolveDone = resolve;
        timer = setTimeout(() => {
          timer = null;
          runtime.emitMessage({ type: 'model-output', fullText: responseText });
          resolve();
        }, delayMs);
      });
    },
    {
      onCancel: finish,
      onDispose: finish,
      onWaitForTurnCompletion: async () => {
        await (done ?? Promise.resolve());
      },
    },
  );
}

function createReviewResumeRuntime(): Readonly<{
  createRuntime: () => NativePromptRuntimeFactory;
  prompts: string[];
  loadSessionCalls: string[];
  providerSessionId: string;
}> {
  const prompts: string[] = [];
  const loadSessionCalls: string[] = [];
  const providerSessionId = 'vendor_review_1';

  const createRuntime = () => createPromptRuntime(
    (promptRuntime, _sessionId, prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        promptRuntime.emitMessage({ type: 'event', name: 'provider_session_id', payload: { sessionId: providerSessionId } } as AgentMessage);
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText: JSON.stringify({
            summary: 'Initial summary.',
            overviewMarkdown: '## Overview\n\nInitial overview.',
            findings: [
              {
                id: 'f1',
                title: 'Example',
                severity: 'low',
                category: 'style',
                summary: 'One paragraph.',
              },
            ],
            questions: [],
            assumptions: [],
          }),
        });
        return;
      }

      promptRuntime.emitMessage({
        type: 'model-output',
        fullText: JSON.stringify({
          answerMarkdown: 'Clarified answer.',
          updatedFindings: [
            {
              id: 'f1',
              title: 'Example',
              severity: 'medium',
              category: 'correctness',
              summary: 'Updated summary.',
              whyItMatters: 'Now clearly broken.',
              evidence: 'Confirmed locally.',
              confidence: 0.9,
            },
          ],
          questions: [],
          assumptions: [],
        }),
      });
    },
    {
      resumeSupported: true,
      onProvisionRuntime: async (opts) => {
        if (opts?.resumeRuntimeId) {
          loadSessionCalls.push(opts.resumeRuntimeId);
        }
      },
    },
  );

  return { createRuntime, prompts, loadSessionCalls, providerSessionId };
}

describe('ExecutionRunManager (review intent)', () => {
  it('cancels only the exact current retained Run turn without terminalizing the Run', async () => {
    const cancel = vi.fn(async () => {});
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createTestExecutionRunHostRuntime(),
      sendAcp: async () => {},
    });
    const internals = manager as unknown as {
      runs: Map<string, ExecutionRunState>;
      controllers: Map<string, ExecutionRunController>;
    };
    const lifetime = new AbortController();
    const controller = {
      kind: 'backend',
      backend: {
        ...createTestExecutionRunHostRuntime({ onCancel: cancel }),
        interaction: {
          kind: 'retained_agent_session.v1',
          capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
        },
      },
      runtimeId: 'run-a',
      cancelled: false,
      turnInFlight: true,
      turnEpoch: 7,
      turnCancelReason: null,
      turnCancelEpoch: null,
      currentInputTurn: { turnId: 'turn-a', inputIds: ['input-a'], state: 'active' },
      executionRunOccurrence: {
        runId: 'run-a',
        sidechainId: 'sidechain-a',
        occurrenceId: 'occurrence-a',
        runtimeLifetimeSignal: lifetime.signal,
        isCurrent: () => internals.controllers.get('run-a') === controller,
        readActiveTurnAdmissionWitness: () => null,
      },
    } as unknown as ExecutionRunController;
    internals.runs.set('run-a', {
      runId: 'run-a', sessionId: 'parent-session', sidechainId: 'sidechain-a', status: 'running',
    } as unknown as ExecutionRunState);
    internals.controllers.set('run-a', controller);

    await expect(manager.cancelCurrentTurn('run-a', {
      occurrenceId: 'occurrence-a', turnId: 'turn-a',
    })).resolves.toEqual({
      ok: true, status: 'requested', runId: 'run-a', occurrenceId: 'occurrence-a', turnId: 'turn-a',
    });
    expect(cancel).toHaveBeenCalledWith('run-a');
    expect(internals.runs.get('run-a')?.status).toBe('running');
    expect(internals.controllers.get('run-a')).toBe(controller);

    await expect(manager.cancelCurrentTurn('run-a', {
      occurrenceId: 'occurrence-a', turnId: 'turn-a',
    })).resolves.toMatchObject({ ok: true, status: 'already_requested' });
    expect(cancel).toHaveBeenCalledTimes(1);

    await expect(manager.cancelCurrentTurn('run-a', {
      occurrenceId: 'stale-occurrence', turnId: 'turn-a',
    })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_not_current' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('projects live input turns from the canonical controller occurrence instead of stale persisted state', () => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createTestExecutionRunHostRuntime(),
      sendAcp: async () => {},
    });
    const internals = manager as unknown as {
      runs: Map<string, ExecutionRunState>;
      controllers: Map<string, ExecutionRunController>;
    };
    const lifetime = new AbortController();
    const controller = {
      kind: 'backend',
      backend: createTestExecutionRunHostRuntime(),
      cancelled: false,
      currentInputTurn: { turnId: 'current-turn', inputIds: ['current-input'], state: 'active' },
      lastInputTurn: { turnId: 'previous-turn', inputIds: ['previous-input'], state: 'completed' },
      executionRunOccurrence: {
        runId: 'run-a', sidechainId: 'sidechain-a', occurrenceId: 'current-occurrence',
        runtimeLifetimeSignal: lifetime.signal,
        isCurrent: () => internals.controllers.get('run-a') === controller,
        readActiveTurnAdmissionWitness: () => null,
      },
    } as unknown as ExecutionRunController;
    internals.runs.set('run-a', {
      runId: 'run-a', callId: 'call-a', sessionId: 'parent-session', sidechainId: 'sidechain-a',
      depth: 0,
      intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      backendId: TEST_PRIMARY_BACKEND_ID, instructions: '', permissionMode: 'read_only',
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
      inputTurns: {
        occurrenceId: 'retired-occurrence',
        last: { turnId: 'retired-turn', inputIds: ['retired-input'], state: 'completed' },
      },
    } as ExecutionRunState);
    internals.controllers.set('run-a', controller);

    expect(manager.getPublic('run-a')?.inputTurns).toEqual({
      occurrenceId: 'current-occurrence',
      current: { turnId: 'current-turn', inputIds: ['current-input'], state: 'active' },
      last: { turnId: 'previous-turn', inputIds: ['previous-input'], state: 'completed' },
    });
  });

  it('awaits one exact input settlement from controller events without polling run state', async () => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createTestExecutionRunHostRuntime(),
      sendAcp: async () => {},
    });
    const internals = manager as unknown as {
      runs: Map<string, ExecutionRunState>;
      controllers: Map<string, ExecutionRunController>;
      emitPublicStateUpdated(runId: string): void;
    };
    const controller = {
      kind: 'backend', backend: createTestExecutionRunHostRuntime(), cancelled: false,
      inputTurnOccurrenceId: 'current-occurrence',
      currentInputTurn: { turnId: 'turn-a', inputIds: ['input-a'], state: 'active' },
    } as unknown as ExecutionRunController;
    internals.runs.set('run-a', {
      runId: 'run-a', callId: 'call-a', sessionId: null, sidechainId: 'sidechain-a',
      depth: 0,
      intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      backendId: TEST_PRIMARY_BACKEND_ID, instructions: '', permissionMode: 'read_only',
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
    } as ExecutionRunState);
    internals.controllers.set('run-a', controller);

    let settled = false;
    const waiting = manager.waitForInputTurn('run-a', 'input-a').then((observation) => {
      settled = true;
      return observation;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    Object.assign(controller, {
      currentInputTurn: undefined,
      lastInputTurn: { turnId: 'turn-a', inputIds: ['input-a'], state: 'completed' },
    });
    internals.emitPublicStateUpdated('run-a');

    await expect(waiting).resolves.toEqual({
      occurrenceId: 'current-occurrence',
      turn: { turnId: 'turn-a', inputIds: ['input-a'], state: 'completed' },
    });
    expect(settled).toBe(true);
  });

  it('stops exact-input observation when the process-local controller is unavailable', async () => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createTestExecutionRunHostRuntime(),
      sendAcp: async () => {},
    });
    const internals = manager as unknown as {
      runs: Map<string, ExecutionRunState>;
    };
    internals.runs.set('run-a', {
      runId: 'run-a', callId: 'call-a', sessionId: null, sidechainId: 'sidechain-a',
      depth: 0,
      intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      backendId: TEST_PRIMARY_BACKEND_ID, instructions: '', permissionMode: 'read_only',
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response', status: 'running', startedAtMs: 1,
    } as ExecutionRunState);

    await expect(manager.waitForInputTurn('run-a', 'input-a')).resolves.toBeNull();
  });

  it('stamps Run terminal transcript records with only the matching retained input-turn witness', async () => {
    const enqueueUserTextMessageCommitted = vi.fn(async () => ({ persisted: true as const, delivered: true as const }));
    const enqueueAgentMessageCommitted = vi.fn(async (
      _provider: string,
      _body: ACPMessageData,
      _opts: Readonly<{ meta?: Record<string, unknown> }>,
    ) => ({ persisted: true as const, delivered: false as const }));
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createStaticJsonRuntime('{"summary":"ok"}'),
      sendAcp: async () => {},
      sessionInteractionHost: {
        session: {
          sessionId: 'parent-session',
          getMetadataSnapshot: () => null,
          updateMetadata: vi.fn(),
          updateAgentState: vi.fn(),
          enqueueAgentMessageCommitted,
          enqueueUserTextMessageCommitted,
        },
        machineId: 'machine-a',
        permissionHandler: { handleToolCall: vi.fn() },
      } as never,
    });
    const internals = manager as unknown as {
      runs: Map<string, ExecutionRunState>;
      controllers: Map<string, ExecutionRunController>;
      createSessionOwnedRunScope: (runId: string) => ExecutionRunHostRunScopeBinding | null;
    };
    internals.runs.set('run-a', {
      sessionId: 'parent-session', sidechainId: 'sidechain-a', intent: 'review',
    } as unknown as ExecutionRunState);
    internals.controllers.set('run-a', {
      kind: 'backend', cancelled: false, pendingInputAcceptance: Promise.resolve('accepted'),
      currentInputTurn: {
        turnId: 'turn-a', inputIds: ['input-a', 'input-b'], state: 'active',
      },
    } as unknown as ExecutionRunController);

    const target = internals.createSessionOwnedRunScope('run-a')!.projectRunTranscriptSession();
    const opts = {
      localId: 'turn-a:task_complete',
      meta: { runtimeTurnId: 'turn-a' },
      provenance: { kind: 'non_dependent', source: 'external' } as const,
      // This transcript-only fixture owns its OS publication lifetime; it does not provision a Run backend.
      admission: { signal: new AbortController().signal },
    };
    await target.enqueueUserTextMessageCommitted?.('Native child input', { ...opts, localId: 'child-user' });
    expect(enqueueUserTextMessageCommitted).toHaveBeenCalledWith('Native child input', expect.objectContaining({
      sidechainId: 'sidechain-a', localId: 'child-user',
    }));
    await target.enqueueAgentMessageCommitted('claude', { type: 'task_complete', id: 'turn-a' }, opts);
    await target.enqueueAgentMessageCommitted('claude', { type: 'task_complete', id: 'turn-z' }, {
      ...opts, localId: 'turn-z:task_complete', meta: { runtimeTurnId: 'turn-z' },
    });

    expect(enqueueAgentMessageCommitted.mock.calls[0]?.[1]).toMatchObject({ sidechainId: 'sidechain-a' });
    expect(enqueueAgentMessageCommitted.mock.calls[0]?.[2]?.meta).toMatchObject({
      happierExecutionRunInputTurnV1: {
        turnId: 'turn-a', inputIds: ['input-a', 'input-b'], state: 'active',
      },
    });
    expect(enqueueAgentMessageCommitted.mock.calls[1]?.[2]?.meta)
      .not.toHaveProperty('happierExecutionRunInputTurnV1');
    const controller = internals.controllers.get('run-a')!;
    if (controller.kind !== 'backend') throw new Error('Expected backend controller');
    let acceptInput!: (value: 'accepted') => void;
    controller.pendingInputAcceptance = new Promise(resolve => { acceptInput = resolve; });
    const retiredWrite = target.enqueueUserTextMessageCommitted!('Late child input', { ...opts, localId: 'late-user' });
    internals.controllers.delete('run-a');
    acceptInput('accepted');
    await expect(retiredWrite).rejects.toMatchObject({ code: 'execution_run_transcript_custody_unavailable' });
    expect(enqueueUserTextMessageCommitted).toHaveBeenCalledOnce();
  });

  it('emits SubAgentRun tool-call, sidechain message, and tool-result with review_findings.v2 meta', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    let lastPrompt = '';
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (_opts: { backendId: string; permissionMode: string }) =>
        createPromptRuntime(async (runtime, _sessionId, prompt) => {
          lastPrompt = prompt;
          // Defer to keep the completion async (closer to real backends).
          await new Promise((r) => setTimeout(r, 5));
          runtime.emitMessage({
            type: 'tool-call',
            toolName: 'read_file',
            callId: 't1',
            args: { path: 'README.md' },
          } as AgentMessage);
          runtime.emitMessage({
            type: 'tool-result',
            toolName: 'read_file',
            callId: 't1',
            result: 'OK',
          } as AgentMessage);
          runtime.emitMessage({
            type: 'model-output',
            fullText: JSON.stringify({
              findings: [
                {
                  id: 'f1',
                  title: 'Example',
                  severity: 'low',
                  category: 'style',
                  summary: 'One paragraph.',
                },
              ],
              summary: 'Summary.',
            }),
          });
        }),
      sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });
    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      modelId: 'claude-opus-5',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1,
        overrides: {
          reasoning_effort: { updatedAt: 1, value: 'high' },
          api_token: { updatedAt: 1, value: 'must-not-survive' },
        },
      },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(started.runId).toMatch(/^run_/);
    expect(started.callId).toMatch(/^subagent_run_/);
    expect(started.requestedConfiguration).toEqual({
      modelId: 'claude-opus-5',
      reasoningEffort: 'high',
    });

    // Wait for completion since the fake backend is async.
    await manager.waitForTerminal(started.runId);
    const final = manager.get(started.runId);
    expect(final?.status, JSON.stringify(final?.error)).toBe('succeeded');
    expect(manager.getPublic(started.runId)).toMatchObject({
      requestedConfiguration: {
        modelId: 'claude-opus-5',
        reasoningEffort: 'high',
      },
    });
    // Prompt contract: review runs must include a strict JSON output schema.
    expect(lastPrompt).toContain('"findings"');

    const toolCall = sent.find((m) => (m.body as any)?.type === 'tool-call');
    expect(toolCall).toBeTruthy();
    expect((toolCall?.body as any).name).toBe('SubAgentRun');
    expect((toolCall?.body as any)?.input?.runId).toBe(started.runId);
    expect((toolCall?.body as any)?.input?.requestedConfiguration).toEqual({
      modelId: 'claude-opus-5',
      reasoningEffort: 'high',
    });
    expect(JSON.stringify(started)).not.toContain('must-not-survive');
    expect(JSON.stringify(manager.getPublic(started.runId))).not.toContain('must-not-survive');
    expect(JSON.stringify((toolCall?.body as any)?.input)).not.toContain('must-not-survive');

    const sidechainToolCall = sent.find((m) => (m.body as any)?.type === 'tool-call' && (m.body as any)?.name === 'read_file');
    expect(sidechainToolCall).toBeTruthy();
    expect((sidechainToolCall?.body as any)?.sidechainId).toBe(started.callId);
    expect((sidechainToolCall?.body as any)?.callId).toBe(`sc:${started.callId}:t1`);

    const sidechainToolResult = sent.find((m) => (m.body as any)?.type === 'tool-result' && (m.body as any)?.callId === `sc:${started.callId}:t1`);
    expect(sidechainToolResult).toBeTruthy();
    expect((sidechainToolResult?.body as any)?.sidechainId).toBe(started.callId);

    const sidechain = sent.find((m) => (m.body as any)?.type === 'message');
    expect((sidechain?.body as any)?.message).toContain('Summary.');
    // Sidechain message must not leak the strict JSON payload.
    expect(String((sidechain?.body as any)?.message ?? '')).not.toContain('"findings"');

    const toolResult = [...sent].reverse().find((m) => (m.body as any)?.type === 'tool-result');
    expect(toolResult).toBeTruthy();
    const meta = toolResult?.meta as any;
    expect(meta?.happier?.kind).toBe('review_findings.v2');
  });

  it('prefers a per-run bounded timeout over the manager default for bounded review runs', async () => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createDelayedJsonRuntime(JSON.stringify({ findings: [], summary: 'late' }), 30),
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
      boundedTimeoutMs: 10,
    });

    const startParams = {
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      boundedTimeoutMs: 100,
    } as const;

    const started = await manager.start(startParams);
    await manager.waitForTerminal(started.runId);

    expect(manager.get(started.runId)?.status).toBe('succeeded');
  });

  it('returns start() before backend session provisioning completes (UI can dismiss draft immediately)', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];

    let startSessionCalled = false;
    let startSessionResolved = false;
    let resolveStartSession!: () => void;
    const startSessionPromise = new Promise<void>((resolve) => {
      resolveStartSession = () => {
        startSessionResolved = true;
        resolve();
      };
    });

    const runtime = createPromptRuntime(
      (promptRuntime) => {
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText: JSON.stringify({ summary: 'Ok', findings: [] }),
        });
      },
      {
        onProvisionRuntime: async () => {
          startSessionCalled = true;
          await startSessionPromise;
        },
      },
    );

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const startPromise = manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    // Prevent deadlocks if start() ever regresses to awaiting backend.startSession().
    // The assertion below (startSessionResolved === false) proves start() returned before provisioning completed.
    const autoResolveStartSession = setTimeout(() => {
      resolveStartSession();
    }, 2_000);

    const started = await startPromise;
    await vi.waitFor(() => expect(startSessionCalled).toBe(true));
    clearTimeout(autoResolveStartSession);

    expect(startSessionCalled).toBe(true);
    expect(startSessionResolved).toBe(false);

    // Now allow the run to proceed and complete so the test doesn't leak background work.
    if (!startSessionResolved) {
      resolveStartSession();
    }
    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status, JSON.stringify(manager.get(started.runId)?.error)).toBe('succeeded');
  });

  it('forwards terminal output + file edits into the run sidechain transcript', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];

    // This legacy AgentMessage projection case is independent of native Session
    // lifecycle; the public Session event union has no raw terminal-output fact.
    const runtime = createTestExecutionRunHostRuntime({
      onWaitForTurnCompletion: async () => {},
      onSendPrompt: async () => {
        runtime.emitMessage({ type: 'terminal-output', data: 'hello from terminal' } as AgentMessage);
        runtime.emitMessage({
          type: 'fs-edit',
          description: 'Edited README',
          path: 'README.md',
          diff: 'diff --git a/README.md b/README.md',
        } as AgentMessage);
        runtime.emitMessage({
          type: 'model-output',
          fullText: JSON.stringify({ summary: 'Ok', findings: [] }),
        });
      },
    });

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await manager.waitForTerminal(started.runId);

    const terminal = sent.find((m) => (m.body as any)?.type === 'terminal-output')?.body as any;
    expect(terminal).toBeTruthy();
    expect(terminal.sidechainId).toBe(started.callId);
    expect(String(terminal.callId ?? '')).toBe(`sc:${started.callId}:happier:terminal-output`);
    expect(terminal.data).toBe('hello from terminal');

    const terminalToolCall = sent.find(
      (m) => (m.body as any)?.type === 'tool-call' && (m.body as any)?.callId === terminal.callId,
    )?.body as any;
    expect(terminalToolCall).toBeTruthy();
    expect(terminalToolCall.name).toBe('terminal-output');
    expect(terminalToolCall.sidechainId).toBe(started.callId);

    const fileEdit = sent.find((m) => (m.body as any)?.type === 'file-edit')?.body as any;
    expect(fileEdit).toBeTruthy();
    expect(fileEdit.sidechainId).toBe(started.callId);
    expect(fileEdit.filePath).toBe('README.md');
    expect(fileEdit.description).toBe('Edited README');
  });

  it('repairs non-json review output by requesting a strict JSON reformat once', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const prompts: string[] = [];

    const runtime = createPromptRuntime((promptRuntime, _sessionId, prompt) => {
        prompts.push(prompt);
        // First attempt: model violates contract (no JSON).
        if (prompts.length === 1) {
          promptRuntime.emitMessage({ type: 'model-output', fullText: 'Not JSON, sorry.' });
          return;
        }
        // Second attempt: obey strict JSON.
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText: JSON.stringify({ summary: 'Ok', findings: [] }),
        });
      });

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status, JSON.stringify(manager.get(started.runId)?.error)).toBe('succeeded');
    expect(prompts.length).toBe(2);
    // Repair prompts must still require a bare JSON object as the final response.
    expect(prompts[1]).toContain('valid JSON');
    expect(prompts[1]).toContain('JSON.parse');
    expect(prompts[1]).toContain('Do not wrap it in markdown code fences');
  });

  it('starts a resumable review follow-up child run that reuses the original vendor session', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const { createRuntime, prompts, loadSessionCalls, providerSessionId } = createReviewResumeRuntime();
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime,
      sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'streaming',
    });
    await manager.waitForTerminal(started.runId);

    expect((manager.get(started.runId)?.resumeHandle as any)?.providerSessionId).toBe(providerSessionId);

    const followUp = await manager.applyAction(started.runId, {
      actionId: 'review.follow_up',
      input: {
        findingIds: ['f1'],
        messageMarkdown: 'Please clarify why this matters.',
      },
    });

    expect(followUp.ok, JSON.stringify(followUp)).toBe(true);
    const followUpRunId = String((followUp as any).result?.runId ?? '');
    expect(followUpRunId).not.toBe('');
    await manager.waitForTerminal(followUpRunId);

    expect(loadSessionCalls).toEqual([providerSessionId]);
    expect(prompts.at(-1)).toContain('Please clarify why this matters.');
    expect(manager.getStructuredMeta(followUpRunId)?.kind).toBe('review_follow_up.v1');
    expect((manager.getStructuredMeta(followUpRunId) as any)?.payload?.requestMarkdown).toBe('Please clarify why this matters.');
  });

  it('refuses review follow-up while running and after cancellation', async () => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createDelayedJsonRuntime(JSON.stringify({ summary: 'Late', findings: [] }), 50_000),
      sendAcp: async () => {},
    });
    try {
      const started = await manager.start({
        sessionId: 'parent_session_1', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: 'Review.', permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'streaming',
      });
      const request = { actionId: 'review.follow_up', input: { findingIds: ['f1'], messageMarkdown: 'Why?' } };
      expect(await manager.applyAction(started.runId, request)).toMatchObject({
        ok: false, errorCode: 'execution_run_busy',
      });
      await manager.stop(started.runId);
      await manager.waitForTerminal(started.runId);
      expect(await manager.applyAction(started.runId, request)).toMatchObject({
        ok: false, errorCode: 'review_follow_up_ended',
      });
    } finally {
      await manager.dispose();
    }
  });

  it('refuses a retained review handle for a different Agent target', async () => {
    const { createRuntime, loadSessionCalls } = createReviewResumeRuntime();
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID, cwd: process.cwd(),
      createRuntime, sendAcp: async () => {},
    });
    let recoveredManager: ExecutionRunManager | undefined;
    try {
      const started = await manager.start({
        sessionId: 'parent_session_1', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: 'Review.', permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'streaming',
      });
      await manager.waitForTerminal(started.runId);
      const run = manager.get(started.runId);
      expect(run?.resumeHandle?.kind).toBe('provider_session.v1');
      if (!run?.resumeHandle) throw new Error('Expected retained provider handle');
      // Replace the completed host before testing recovery so its queued
      // checkpoints cannot overwrite the persisted mismatch under test.
      await manager.dispose();
      const wrongTarget = readBackendTargetRefV2({ kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID });
      await retainExecutionRunState({ ...run, resumeHandle: ExecutionRunResumeHandleSchema.parse({
        ...run.resumeHandle, backendTarget: wrongTarget,
      }) });
      expect((await readRetainedExecutionRunRecord(started.runId))?.state.resumeHandle?.backendTarget).toEqual(wrongTarget);
      recoveredManager = createExecutionRunManager({
        parentProvider: TEST_PRIMARY_BACKEND_ID, cwd: process.cwd(),
        createRuntime, sendAcp: async () => {},
      });
      const result = await recoveredManager.applyAction(started.runId, {
        actionId: 'review.follow_up', input: { findingIds: ['f1'], messageMarkdown: 'Why?' },
      });
      const current = recoveredManager.get(started.runId);
      const persisted = await readRetainedExecutionRunRecord(started.runId);
      expect(result, JSON.stringify({
        currentTarget: current?.backendTarget,
        currentResumeTarget: current?.resumeHandle?.backendTarget,
        persistedTarget: persisted?.state.backendTarget,
        persistedResumeTarget: persisted?.state.resumeHandle?.backendTarget,
        nativeLoadCount: loadSessionCalls.length,
      })).toMatchObject({ ok: false, errorCode: 'review_follow_up_resume_unavailable' });
      expect(loadSessionCalls).toEqual([]);
    } finally {
      await recoveredManager?.dispose();
      await manager.dispose();
    }
  });

  it('refuses a fresh-child fallback for a non-resumable review', async () => {
    const prompts: string[] = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () =>
        createPromptRuntime(
          (runtime, _sessionId, prompt) => {
            prompts.push(prompt);
            if (prompts.length === 1) {
              runtime.emitMessage({
                type: 'model-output',
                fullText: JSON.stringify({
                  summary: 'Initial summary.',
                  overviewMarkdown: '## Overview\n\nInitial overview.',
                  findings: [
                    {
                      id: 'f1',
                      title: 'Example',
                      severity: 'low',
                      category: 'style',
                      summary: 'One paragraph.',
                    },
                  ],
                  questions: [],
                  assumptions: [],
                }),
              });
              return;
            }

            runtime.emitMessage({
              type: 'model-output',
              fullText: JSON.stringify({
                answerMarkdown: 'Fallback answer.',
                questions: [],
                assumptions: [],
              }),
            });
          },
        ),
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });
    await manager.waitForTerminal(started.runId);

    const followUp = await manager.applyAction(started.runId, {
      actionId: 'review.follow_up',
      input: {
        findingIds: ['f1'],
        messageMarkdown: 'Please clarify the impact.',
      },
    });
    expect(followUp).toMatchObject({ ok: false, errorCode: 'review_follow_up_not_resumable' });
    expect(prompts).toHaveLength(1);
  });

  it('refuses a fresh-child fallback when a reviewer has no resume support', async () => {
    const prompts: string[] = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () =>
        createPromptRuntime(
          (runtime, _sessionId, prompt) => {
            prompts.push(prompt);
            if (prompts.length === 1) {
              runtime.emitMessage({
                type: 'model-output',
                fullText: JSON.stringify({
                  summary: 'Initial summary.',
                  overviewMarkdown: '## Overview\n\nInitial overview.',
                  findings: [
                    {
                      id: 'f1',
                      title: 'Example',
                      severity: 'low',
                      category: 'style',
                      summary: 'One paragraph.',
                    },
                  ],
                  questions: [],
                  assumptions: [],
                }),
              });
              return;
            }

            runtime.emitMessage({
              type: 'model-output',
              fullText: JSON.stringify({
                answerMarkdown: 'Fallback answer.',
                questions: [],
                assumptions: [],
              }),
            });
          },
        ),
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: ['code', 'rabbit'].join('') },
      modelSelection: null,
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'streaming',
    });
    await manager.waitForTerminal(started.runId);

    expect(manager.get(started.runId)?.resumeHandle ?? null).toBeNull();

    const followUp = await manager.applyAction(started.runId, {
      actionId: 'review.follow_up',
      input: {
        findingIds: ['f1'],
        messageMarkdown: 'Please clarify the impact.',
      },
    });
    expect(followUp).toMatchObject({ ok: false, errorCode: 'review_follow_up_resume_unavailable' });
    expect(prompts).toHaveLength(1);
  });

  it('can stop a running execution run and emit a terminal tool-result', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (_opts: { backendId: string; permissionMode: string }) =>
        createDelayedJsonRuntime(JSON.stringify({ summary: 'late', findings: [] }), 50_000),
      sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const stopped = await manager.stop(started.runId);
    expect(stopped.ok).toBe(true);
    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('cancelled');

    const toolResult = [...sent].reverse().find((m) => (m.body as any)?.type === 'tool-result');
    expect((toolResult?.body as any)?.output?.status).toBe('cancelled');
  });

  it('settles the terminal waiter and disposes once when stopped-run transcript custody fails', async () => {
    const dispose = vi.fn(async () => {});
    const runtime = createTestExecutionRunHostRuntime({ onDispose: dispose });
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async (_provider: string, body: ACPMessageData) => {
        if (body.type === 'tool-result') {
          throw new Error('transcript unavailable');
        }
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });
    const terminalWaiter = manager.waitForTerminal(started.runId);

    await expect(manager.stop(started.runId)).rejects.toMatchObject({
      code: 'execution_run_transcript_custody_unavailable',
    });
    await expect(terminalWaiter).resolves.toBeUndefined();
    expect(manager.get(started.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'execution_run_transcript_custody_unavailable' },
    });
    expect(dispose).toHaveBeenCalledTimes(1);

    await manager.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not synthesize a resumable resumeHandle from provider_session_id events when the backend cannot resume', async () => {
    const providerSessionId = '1433467f-ff14-4292-b5b2-2aac77a808f0';
    const runtime = createPromptRuntime((promptRuntime) => {
      promptRuntime.emitMessage({ type: 'event', name: 'provider_session_id', payload: { sessionId: providerSessionId } } as AgentMessage);
      promptRuntime.emitMessage({ type: 'model-output', fullText: JSON.stringify({ findings: [], summary: 'ok' }) });
    });

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await manager.waitForTerminal(started.runId);

    const finished = manager.get(started.runId);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.resumeHandle ?? null).toBeNull();
  });
});

describe('ExecutionRunManager (memory_hints intent)', () => {
  it('does not materialize tool-call/tool-result or sidechain messages in the carrier transcript', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createStaticJsonRuntime('{"ok":true}'),
      sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'memory_hints',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Return JSON only.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await manager.waitForTerminal(started.runId);
    const final = manager.get(started.runId);
    expect(final?.status).toBe('succeeded');
    expect(sent).toEqual([]);
  });
});

describe('ExecutionRunManager (streaming sidechain)', () => {
  it('emits streaming sidechain chunks for model-output when ioMode=streaming', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const commits: Array<{
      provider: string;
      body: unknown;
      localId: string;
      meta?: Record<string, unknown>;
    }> = [];

    const runtime = createPromptRuntime((promptRuntime) => {
        promptRuntime.emitMessage({ type: 'model-output', fullText: 'Plan in progress.\n' });
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText:
            'Plan in progress.\n' +
            JSON.stringify({
              summary: 'Ok',
              sections: [{ title: 'One', items: ['A'] }],
              risks: [],
              milestones: [],
            }),
        });
      });

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      streamedTranscriptSession: {
        enqueueAgentMessageCommitted: async (provider, body, opts) => {
          commits.push({ provider, body, localId: opts.localId, meta: opts.meta });
          return { persisted: true, delivered: false };
        },
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'plan',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Make a plan.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });

    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('succeeded');

    const sidechainCommits = commits.filter(
      (row) => (row.body as any)?.type === 'message' && (row.body as any)?.sidechainId === started.sidechainId,
    );
    expect(sidechainCommits.length).toBeGreaterThanOrEqual(1);
    const concatenatedStreamingText = sidechainCommits.map((row) => String((row.body as any)?.message ?? '')).join('');
    expect(concatenatedStreamingText).toContain('Plan in progress');
    expect((sidechainCommits[0]?.meta as any)?.happierStreamSegmentV1?.segmentState).toBe('streaming');
    const finalCommit = sidechainCommits[sidechainCommits.length - 1]!;
    expect((finalCommit.meta as any)?.happierStreamSegmentV1?.segmentState).toBe('complete');

    // When streaming output is emitted, the bounded completion should not inject a duplicate
    // "final" sidechain message in addition to the streaming segment.
    const nonStreamingSidechainMessages = sent.filter((m) => (m.body as any)?.type === 'message' && (m.body as any)?.sidechainId === started.sidechainId);
    expect(nonStreamingSidechainMessages).toHaveLength(0);
  });

  it('streams review progress without leaking the trailing strict JSON payload', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const commits: Array<{
      provider: string;
      body: unknown;
      localId: string;
      meta?: Record<string, unknown>;
    }> = [];

    const runtime = createPromptRuntime((promptRuntime) => {
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText: 'Working...\n\n{ "summary": "Ok", ',
        });
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText:
            'Working...\n\n' +
            JSON.stringify({
              summary: 'Ok',
              findings: [],
            }),
        });
      });

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      streamedTranscriptSession: {
        enqueueAgentMessageCommitted: async (provider, body, opts) => {
          commits.push({ provider, body, localId: opts.localId, meta: opts.meta });
          return { persisted: true, delivered: false };
        },
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });

    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('succeeded');

    const sidechainCommits = commits.filter(
      (row) => (row.body as any)?.type === 'message' && (row.body as any)?.sidechainId === started.sidechainId,
    );
    expect(sidechainCommits.length).toBeGreaterThanOrEqual(1);

    const concatenatedStreamingText = sidechainCommits.map((row) => String((row.body as any)?.message ?? '')).join('');
    expect(concatenatedStreamingText).toContain('Working');
    expect(concatenatedStreamingText).not.toContain('"findings"');

    // A final prose message is allowed so users get a clear terminal note.
    const finalNonStreaming = sent.find(
      (m) => (m.body as any)?.type === 'message' && (m.body as any)?.sidechainId === started.sidechainId,
    );
    expect(String((finalNonStreaming?.body as any)?.message ?? '')).toContain('Working');
    expect(String((finalNonStreaming?.body as any)?.message ?? '')).not.toContain('"findings"');
  });
});

describe('ExecutionRunManager (long-lived runs)', () => {
  function createPromptEchoRuntime(): NativePromptRuntimeFactory {
    return createPromptRuntime((runtime, _sessionId, prompt) => {
      runtime.emitMessage({ type: 'model-output', fullText: `reply:${prompt}` });
    });
  }

  it('returns a detached handle before provisioning and orders an immediate send after initial instructions', async () => {
    let releaseProvision!: () => void;
    let markProvisionStarted!: () => void;
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const provisionStarted = new Promise<void>((resolve) => {
      markProvisionStarted = resolve;
    });
    const prompts: string[] = [];
    const runtime = createPromptRuntime(
      (_runtime, _sessionId, prompt) => {
        prompts.push(prompt);
      },
      {
        onProvisionRuntime: async () => {
          markProvisionStarted();
          await provisionGate;
        },
      },
    );
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async () => {},
    });
    const startPromise = manager.start({
      sessionId: null,
      intent: 'agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Initial work.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await provisionStarted;
    const startOutcome = await Promise.race([
      startPromise.then((started) => ({ kind: 'started' as const, started })),
      new Promise<{ kind: 'still_waiting' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'still_waiting' }), 30);
      }),
    ]);
    const send = startOutcome.kind === 'started'
      ? manager.send(startOutcome.started.runId, { message: 'Follow-up work.' })
      : Promise.resolve({ ok: false });
    expect(prompts).toEqual([]);

    releaseProvision();
    const started = await startPromise;
    await expect(send).resolves.toEqual({ ok: true });

    expect(startOutcome).toMatchObject({ kind: 'started', started: { runId: started.runId } });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[0]).toContain('Initial work.');
    expect(prompts[1]).toBe('Follow-up work.');
    await manager.stop(started.runId);
  });

  it('publishes and disposes once when stop races detached completion', async () => {
    let releaseCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let releasePublication!: () => void;
    const publication = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let releaseCancel!: () => void;
    const cancel = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => { markCancelStarted = resolve; });
    const dispose = vi.fn(async () => {});
    let terminalFactsAdmitted = 0;
    let resolveFirstTerminalFact!: () => void;
    const firstTerminalFact = new Promise<void>((resolve) => {
      resolveFirstTerminalFact = resolve;
    });
    const runtime = createPromptRuntime(() => {}, {
      onWaitForTurnCompletion: async () => {
        await completion;
        throw new Error('provider completion failed');
      },
      onCancel: async () => {
        markCancelStarted();
        await cancel;
      },
      onDispose: dispose,
    });
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async (_provider: string, body: ACPMessageData) => {
        if (body.type !== 'tool-result') return;
        terminalFactsAdmitted += 1;
        resolveFirstTerminalFact();
        await publication;
      },
      getNowMs: () => 1_700_000_000_000,
    });
    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await expect(manager.send(started.runId, { message: 'hello' })).resolves.toEqual({ ok: true });
    const stop = manager.stop(started.runId);
    await cancelStarted;
    releaseCompletion();
    await firstTerminalFact;
    releaseCancel();
    await Promise.resolve();
    releasePublication();

    const stopped = await stop;
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ ok: true });
    await expect(manager.waitForTerminal(started.runId)).resolves.toBeUndefined();
    expect(terminalFactsAdmitted).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.get(started.runId)?.status).not.toBe('running');
  });

  it('publishes host-owned cancelled truth when the backend cancel never settles', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const dispose = vi.fn(async () => {});
    let cancelAttempts = 0;
    const runtime = createTestExecutionRunHostRuntime({
      // The turn never completes and the leaf cancel never settles: the plugin
      // backend is wedged, yet host-owned terminal truth must still publish.
      onWaitForTurnCompletion: () => new Promise<void>(() => {}),
      onCancel: () => {
        cancelAttempts += 1;
        return new Promise<void>(() => {});
      },
      onDispose: dispose,
    });
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });
    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await expect(manager.send(started.runId, { message: 'hello' })).resolves.toEqual({ ok: true });
    const terminalWaiter = manager.waitForTerminal(started.runId);

    await expect(manager.stop(started.runId)).resolves.toMatchObject({ ok: true });
    await expect(terminalWaiter).resolves.toBeUndefined();
    expect(manager.get(started.runId)?.status).toBe('cancelled');
    expect(cancelAttempts).toBe(1);
    const terminalToolResult = [...sent].reverse().find((m) => (m.body as any)?.type === 'tool-result');
    expect((terminalToolResult?.body as any)?.output?.status).toBe('cancelled');

    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('settles an arbitrary detached finish failure without orphaning the running run', async () => {
    const baseCatalog = buildExecutionRunProfileCatalog();
    class FailingProfileMap<K, V> extends Map<K, V> {
      failReads = false;

      override get(key: K): V | undefined {
        if (this.failReads) throw new Error('profile stale');
        return super.get(key);
      }
    }
    const profiles = new FailingProfileMap(baseCatalog.builtInProfilesByIntent.entries());
    const catalog = Object.freeze({
      ...baseCatalog,
      builtInProfilesByIntent: profiles,
    });
    let releaseCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const dispose = vi.fn(async () => {});
    const runtime = createTestExecutionRunHostRuntime({
      onWaitForTurnCompletion: async () => {
        await completion;
        throw new Error('provider completion failed');
      },
      onDispose: dispose,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      executionRunProfileCatalog: catalog,
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    try {
      const started = await manager.start({
        sessionId: 'parent_session_1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: '',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });

      await expect(manager.send(started.runId, { message: 'hello' })).resolves.toEqual({ ok: true });
      profiles.failReads = true;
      releaseCompletion();
      await expect(manager.waitForTerminal(started.runId)).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(manager.get(started.runId)).toMatchObject({
        status: 'failed',
        error: { code: 'execution_run_failed', message: 'provider completion failed' },
      });
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await manager.dispose();
    }
  });

  it('retains ambiguous send custody until stop and preserves terminal transcript failure', async () => {
    const dispose = vi.fn(async () => {});
    const runtime = createTestExecutionRunHostRuntime({
      onSendPrompt: async () => {
        throw new Error('provider send failed');
      },
      onDispose: dispose,
    });
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async (_provider: string, body: ACPMessageData) => {
        if (body.type === 'tool-result') throw new Error('transcript unavailable');
      },
      getNowMs: () => 1_700_000_000_000,
    });
    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });
    const terminalWaiter = manager.waitForTerminal(started.runId);
    let terminalSettled = false;
    void terminalWaiter.then(() => { terminalSettled = true; });

    await expect(manager.send(started.runId, { message: 'hello' })).resolves.toMatchObject({
      ok: false, errorCode: 'execution_run_send_outcome_unknown',
    });
    expect(manager.get(started.runId)?.status).toBe('running');
    expect(terminalSettled).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    await expect(manager.send(started.runId, { message: 'do not duplicate ambiguous input' })).resolves.toMatchObject({
      ok: false, errorCode: 'execution_run_busy',
    });
    await expect(manager.stop(started.runId)).rejects.toMatchObject({
      code: 'execution_run_transcript_custody_unavailable',
    });
    await expect(terminalWaiter).resolves.toBeUndefined();
    expect(manager.get(started.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'execution_run_transcript_custody_unavailable' },
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    await manager.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('settles detached completion recovery while retaining the typed custody failure', async () => {
    const dispose = vi.fn(async () => {});
    const runtime = createTestExecutionRunHostRuntime({
      onWaitForTurnCompletion: async () => {
        throw new Error('provider completion failed');
      },
      onDispose: dispose,
    });
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async (_provider: string, body: ACPMessageData) => {
        if (body.type === 'tool-result') throw new Error('transcript unavailable');
      },
      getNowMs: () => 1_700_000_000_000,
    });
    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });
    const terminalWaiter = manager.waitForTerminal(started.runId);

    await expect(manager.send(started.runId, { message: 'hello' })).resolves.toEqual({ ok: true });
    await expect(terminalWaiter).resolves.toBeUndefined();
    expect(manager.get(started.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'execution_run_transcript_custody_unavailable' },
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    await manager.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('reports an undelivered execution-run response target back to the AgentState store', async () => {
    let responseTargetHandler: ((dispatch: AgentStateResponseTargetDispatch) => unknown) | null = null;
    const unregisterPermissionHandler = vi.fn();
    const permissionStore = {
      registerResponseTargetHandler: vi.fn((_kind: string, handler: (dispatch: AgentStateResponseTargetDispatch) => unknown) => {
        responseTargetHandler = handler;
        return unregisterPermissionHandler;
      }),
    };
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptRuntime(() => {}),
      sendAcp: async () => {},
      getPermissionRequestStore: () => permissionStore as never,
      getNowMs: () => 1_700_000_000_000,
    });

    try {
      await manager.start({
        sessionId: 'parent_session_1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: 'first',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });
      const respond = vi.spyOn(manager, 'respondToPermissionRequest').mockResolvedValue({
        ok: false,
        errorCode: 'execution_run_permission_not_delivered',
        error: 'Permission response was not delivered',
      });
      expect(responseTargetHandler).not.toBeNull();

      const responseTarget = {
        kind: 'execution_run_host_bridge',
        sessionId: 'parent_session_1',
        runId: 'run-1',
        callId: 'call-1',
        sidechainId: 'sidechain-1',
        backendId: 'backend-1',
        runtimeKind: 'acp',
        providerRequestId: 'provider-request-1',
        controllerOccurrenceId: 'occurrence-1',
      } as const;
      const requestId = buildRunScopedExecutionPermissionRequestId({
        runId: responseTarget.runId,
        controllerOccurrenceId: responseTarget.controllerOccurrenceId,
        providerRequestId: responseTarget.providerRequestId,
      });

      const mismatchedDelivery = await responseTargetHandler!({
        requestId: `${requestId}-mismatch`,
        responseTarget,
        completedRequest: { status: 'approved', decision: 'approved' },
      });
      expect(mismatchedDelivery).toBe(false);
      expect(respond).not.toHaveBeenCalled();

      const delivery = await responseTargetHandler!({
        requestId,
        responseTarget,
        completedRequest: { status: 'approved', decision: 'approved' },
      });

      expect(respond).toHaveBeenCalledWith('run-1', expect.objectContaining({
        requestId: 'provider-request-1',
        approved: true,
      }));
      expect(delivery).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

  it('acknowledges provider-delivered permission custody exactly once and terminalizes transcript failure', async () => {
    let agentState: AgentState = {
      requests: Object.create(null),
      completedRequests: Object.create(null),
    };
    const permissionStore = new AgentStateRequestStore({
      target: {
        scopeId: 'execution-run-permission-custody',
        readState: () => agentState,
        updateState: (updater) => {
          agentState = updater(agentState);
        },
      },
      logPrefix: '[ExecutionRunPermissionCustodyTest]',
    });
    const providerDelivery = vi.fn(async () => ({ delivered: true as const }));
    const sendAcp = vi.fn(async (_provider: string, body: ACPMessageData) => {
      if (body.type === 'permission-response') throw new Error('transcript unavailable');
    });
    const dispose = vi.fn(async () => {});
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createTestExecutionRunHostRuntime({
        onRespondToPermission: providerDelivery,
        onDispose: dispose,
      }),
      sendAcp,
      getPermissionRequestStore: () => permissionStore,
      getNowMs: () => 1_700_000_000_000,
    });
    const directResults: Awaited<ReturnType<typeof manager.respondToPermissionRequest>>[] = [];
    const respondToPermissionRequest = manager.respondToPermissionRequest.bind(manager);
    vi.spyOn(manager, 'respondToPermissionRequest').mockImplementation(async (...args) => {
      const result = await respondToPermissionRequest(...args);
      directResults.push(result);
      return result;
    });

    try {
      const started = await manager.start({
        sessionId: 'parent_session_1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: '',
        permissionMode: 'default',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });
      const run = manager.get(started.runId)!;
      const controller = (manager as unknown as {
        controllers: Map<string, ExecutionRunController>;
      }).controllers.get(started.runId);
      if (!controller || controller.kind !== 'backend') throw new Error('expected backend controller');
      const providerRequestId = 'provider-permission-1';
      const requestId = buildRunScopedExecutionPermissionRequestId({
        runId: run.runId,
        controllerOccurrenceId: controller.controllerOccurrenceId,
        providerRequestId,
      });
      permissionStore.publishRequest({
        requestId,
        toolName: 'Bash',
        toolInput: { command: 'git status' },
        createdAt: 1,
        responseTarget: {
          kind: 'execution_run_host_bridge',
          sessionId: run.sessionId,
          runId: run.runId,
          callId: run.callId,
          sidechainId: run.sidechainId,
          backendId: run.backendId,
          runtimeKind: 'acp',
          providerRequestId,
          controllerOccurrenceId: controller.controllerOccurrenceId,
        },
      });

      await expect(permissionStore.completeRequest({
        requestId,
        status: 'approved',
        decision: 'approved',
      })).resolves.toBe(true);

      await vi.waitFor(() => {
        expect(manager.get(run.runId)).toMatchObject({
          status: 'failed',
          error: { code: 'execution_run_transcript_custody_unavailable' },
        });
        expect(agentState.completedRequests?.[requestId]?.responseTarget).toBeUndefined();
      });
      expect(directResults).toEqual([{
        ok: false,
        errorCode: 'execution_run_transcript_custody_unavailable',
        error: 'Permission response was delivered but its transcript fact was not admitted to durable custody',
        delivery: { delivered: true },
      }]);
      expect(permissionStore.readCompletedResponseTarget(requestId)).toBeNull();
      expect(providerDelivery).toHaveBeenCalledOnce();
      expect(providerDelivery).toHaveBeenCalledWith(providerRequestId, true);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await manager.dispose();
    }
  });

  it('retains a provider-undelivered permission response target for replay', async () => {
    let agentState: AgentState = {
      requests: Object.create(null),
      completedRequests: Object.create(null),
    };
    const permissionStore = new AgentStateRequestStore({
      target: {
        scopeId: 'execution-run-permission-undelivered',
        readState: () => agentState,
        updateState: (updater) => {
          agentState = updater(agentState);
        },
      },
      logPrefix: '[ExecutionRunPermissionUndeliveredTest]',
    });
    const providerDelivery = vi.fn(async () => ({
      delivered: false as const,
      reason: 'unknown_request' as const,
    }));
    const sendAcp = vi.fn(async (_provider: unknown, _body: ACPMessageData) => {});
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createTestExecutionRunHostRuntime({
        onRespondToPermission: providerDelivery,
      }),
      sendAcp,
      getPermissionRequestStore: () => permissionStore,
      getNowMs: () => 1_700_000_000_000,
    });

    try {
      const started = await manager.start({
        sessionId: 'parent_session_1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: '',
        permissionMode: 'default',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });
      const run = manager.get(started.runId)!;
      const controller = (manager as unknown as {
        controllers: Map<string, ExecutionRunController>;
      }).controllers.get(started.runId);
      if (!controller || controller.kind !== 'backend') throw new Error('expected backend controller');
      const providerRequestId = 'provider-permission-undelivered';
      const requestId = buildRunScopedExecutionPermissionRequestId({
        runId: run.runId,
        controllerOccurrenceId: controller.controllerOccurrenceId,
        providerRequestId,
      });
      const responseTarget = {
        kind: 'execution_run_host_bridge',
        sessionId: run.sessionId,
        runId: run.runId,
        callId: run.callId,
        sidechainId: run.sidechainId,
        backendId: run.backendId,
        runtimeKind: 'acp',
        providerRequestId,
        controllerOccurrenceId: controller.controllerOccurrenceId,
      } as const;
      permissionStore.publishRequest({
        requestId,
        toolName: 'Bash',
        toolInput: { command: 'git status' },
        createdAt: 1,
        responseTarget,
      });

      await expect(permissionStore.completeRequest({
        requestId,
        status: 'approved',
        decision: 'approved',
      })).resolves.toBe(true);

      await vi.waitFor(() => expect(providerDelivery).toHaveBeenCalledOnce());
      expect(permissionStore.readCompletedResponseTarget(requestId)).toMatchObject({ responseTarget });
      expect(manager.get(run.runId)?.status).toBe('running');
      expect(sendAcp.mock.calls.some(([, body]) => body.type === 'permission-response')).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

  it('rejects a delayed permission response from a retired controller occurrence', async () => {
    const sendAcp = vi.fn(async (_provider: unknown, _body: ACPMessageData) => {});
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptRuntime(() => {}),
      sendAcp,
      getNowMs: () => 1_700_000_000_000,
    });

    try {
      const started = await manager.start({
        sessionId: 'parent_session_1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: 'first',
        permissionMode: 'default',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });
      const run = manager.get(started.runId)!;
      const internals = manager as unknown as {
        controllers: Map<string, ExecutionRunController>;
      };
      const retired = internals.controllers.get(started.runId);
      if (!retired || retired.kind !== 'backend') throw new Error('expected backend controller');
      const respondToPermission = vi.fn()
        .mockResolvedValueOnce({ delivered: false as const, reason: 'unknown_request' as const })
        .mockResolvedValue({ delivered: true as const });
      internals.controllers.set(started.runId, {
        ...retired,
        backend: createTestExecutionRunHostRuntime({ onRespondToPermission: respondToPermission }),
        controllerOccurrenceId: 'occurrence-current',
      });
      sendAcp.mockClear();

      await expect(manager.respondToPermissionRequest(started.runId, {
        requestId: 'provider-request-reused',
        approved: true,
        responseTarget: {
          kind: 'execution_run_host_bridge',
          sessionId: run.sessionId,
          runId: run.runId,
          callId: run.callId,
          sidechainId: run.sidechainId,
          backendId: run.backendId,
          runtimeKind: 'acp',
          providerRequestId: 'provider-request-reused',
          controllerOccurrenceId: 'occurrence-retired',
        } as never,
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'execution_run_invalid_action_input',
      });
      expect(respondToPermission).not.toHaveBeenCalled();

      const currentResponseTarget = {
        kind: 'execution_run_host_bridge',
        sessionId: run.sessionId,
        runId: run.runId,
        callId: run.callId,
        sidechainId: run.sidechainId,
        backendId: run.backendId,
        runtimeKind: 'acp',
        providerRequestId: 'provider-request-reused',
        controllerOccurrenceId: 'occurrence-current',
      } as const;
      await expect(manager.respondToPermissionRequest(started.runId, {
        requestId: 'provider-request-reused',
        approved: true,
        responseTarget: currentResponseTarget,
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'execution_run_permission_not_delivered',
      });
      expect(sendAcp).not.toHaveBeenCalled();

      await expect(manager.respondToPermissionRequest(started.runId, {
        requestId: 'provider-request-reused',
        approved: true,
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'execution_run_invalid_action_input',
      });
      expect(respondToPermission).toHaveBeenCalledOnce();

      await expect(manager.respondToPermissionRequest(started.runId, {
        requestId: 'provider-request-reused',
        approved: true,
        responseTarget: {
          kind: 'execution_run_host_bridge',
          sessionId: run.sessionId,
          runId: run.runId,
          callId: run.callId,
          sidechainId: run.sidechainId,
          backendId: run.backendId,
          runtimeKind: 'acp',
          providerRequestId: 'provider-request-reused',
        } as never,
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'execution_run_invalid_action_input',
      });
      expect(respondToPermission).toHaveBeenCalledOnce();

      await expect(manager.respondToPermissionRequest(started.runId, {
        requestId: 'provider-request-reused',
        approved: true,
        responseTarget: currentResponseTarget,
      })).resolves.toEqual({ ok: true, delivery: { delivered: true } });
      expect(respondToPermission).toHaveBeenCalledTimes(2);
      expect(respondToPermission).toHaveBeenCalledWith('provider-request-reused', true);
    } finally {
      await manager.dispose();
    }
  });

  it('resolves broker authority only from the exact live controller occurrence', async () => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptRuntime(() => {}),
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });
    try {
      const started = await manager.start({
        sessionId: 'parent_session_authority',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: 'first',
        permissionMode: 'default',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });
      const current = manager.resolveLiveBrokerAuthority({
        v: 1,
        executionRunId: started.runId,
        expectedIntent: 'delegate',
        expectedOccurrenceId: null,
      });
      expect(current).toMatchObject({
        status: 'current',
        executionRunId: started.runId,
        parentSessionId: 'parent_session_authority',
      });
      if (current.status !== 'current') throw new Error('expected current occurrence');
      expect(manager.resolveLiveBrokerAuthority({
        v: 1,
        executionRunId: started.runId,
        expectedIntent: 'delegate',
        expectedOccurrenceId: 'retired-occurrence',
      })).toEqual({ status: 'not_current', reason: 'occurrence_mismatch' });

      const internals = manager as unknown as { controllers: Map<string, ExecutionRunController> };
      const controller = internals.controllers.get(started.runId);
      if (!controller) throw new Error('expected controller');
      controller.cancelled = true;
      expect(manager.resolveLiveBrokerAuthority({
        v: 1,
        executionRunId: started.runId,
        expectedIntent: 'delegate',
        expectedOccurrenceId: current.occurrenceId,
      })).toEqual({ status: 'not_current', reason: 'runtime_unavailable' });
    } finally {
      await manager.dispose();
    }
  });

  it('publishes stable idle authority before backend readiness and later reads the admitted turn', async () => {
    let releaseReadiness!: () => void;
    const readiness = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    let active = false;
    const base = createTestExecutionRunHostRuntime({ runtimeId: 'provider-backed-child' });
    const runtime: ExecutionRunHostRuntime = {
      ...base,
      async readResumeSupport() {
        await readiness;
        return true;
      },
      readActiveTurnAdmissionWitness: () => active
        ? ({ turnId: 'provider-turn-1' } as ReturnType<NonNullable<ExecutionRunHostRuntime['readActiveTurnAdmissionWitness']>>)
        : null,
    };
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });
    try {
      const starting = manager.start({
        sessionId: 'parent_provider_authority',
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        permissionMode: 'default',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });
      const internals = manager as unknown as { controllers: Map<string, ExecutionRunController> };
      await vi.waitFor(() => expect(internals.controllers.size).toBe(1));
      const runId = [...internals.controllers.keys()][0]!;
      const idle = manager.resolveLiveBrokerAuthority({
        v: 1,
        executionRunId: runId,
        expectedOccurrenceId: null,
      });
      expect(idle).toMatchObject({ status: 'current', runtimeState: 'idle' });
      expect(idle).toMatchObject({ activeTurnId: null });
      if (idle.status !== 'current') throw new Error('expected accepted controller occurrence');
      active = true;
      expect(manager.resolveLiveBrokerAuthority({
        v: 1,
        executionRunId: runId,
        expectedOccurrenceId: idle.occurrenceId,
      })).toMatchObject({
        status: 'current',
        occurrenceId: idle.occurrenceId,
        runtimeState: 'active_turn',
        activeTurnId: 'provider-turn-1',
      });
      releaseReadiness();
      await starting;
    } finally {
      releaseReadiness();
      await manager.dispose();
    }
  });

  it('attests a detached Run from the same stable live controller occurrence', async () => {
    let active = false;
    const base = createTestExecutionRunHostRuntime({ runtimeId: 'detached-runtime-child' });
    const runtime: ExecutionRunHostRuntime = {
      ...base,
      readActiveTurnAdmissionWitness: () => active
        ? ({ turnId: 'detached-turn-1' } as ReturnType<NonNullable<ExecutionRunHostRuntime['readActiveTurnAdmissionWitness']>>)
        : null,
    };
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });
    try {
      const started = await manager.start({
        sessionId: null,
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        permissionMode: 'default',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });
      const idle = manager.resolveLiveBrokerAuthority({
        v: 1,
        executionRunId: started.runId,
        expectedIntent: 'agent',
        expectedOccurrenceId: null,
      });
      expect(idle).toMatchObject({
        status: 'current',
        parentSessionId: null,
        runtimeState: 'idle',
      });
      if (idle.status !== 'current') throw new Error('expected detached controller occurrence');
      active = true;
      expect(manager.resolveLiveBrokerAuthority({
        v: 1,
        executionRunId: started.runId,
        expectedIntent: 'agent',
        expectedOccurrenceId: idle.occurrenceId,
      })).toMatchObject({
        status: 'current',
        parentSessionId: null,
        occurrenceId: idle.occurrenceId,
        runtimeState: 'active_turn',
      });
      await manager.stop(started.runId);
      expect(manager.resolveLiveBrokerAuthority({
        v: 1,
        executionRunId: started.runId,
        expectedIntent: 'agent',
        expectedOccurrenceId: idle.occurrenceId,
      })).toMatchObject({ status: 'not_current' });
    } finally {
      await manager.dispose();
    }
  });

  it.each([
    ['attached', 'parent_direct_material'],
    ['detached', null],
  ] as const)('binds %s Run direct material authority to its exact Provider resource', async (_kind, sessionId) => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptRuntime(() => {}),
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });
    try {
      const started = await manager.start({
        sessionId,
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        teamCredentialModel: {
          kind: 'team_credential_provider_model',
          resourceId: 'resource-current',
          teamId: 'team-1',
          expectedResourceRevision: 7,
          deliveryMode: 'direct',
          agentTargetKey: buildBackendTargetKeyV2(readBackendTargetRefV2({ kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID })),
          modelId: 'model-current' as never,
        },
        permissionMode: 'default',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });
      const request = {
        v: 1 as const,
        executionRunId: started.runId,
        expectedOccurrenceId: null,
        expectedDirectMaterialUse: {
          resourceId: 'resource-current',
          slot: { kind: 'provider_model' as const },
          sourceMemberKey: 'provider-member',
        },
      };
      expect(manager.resolveLiveBrokerAuthority(request)).toMatchObject({
        status: 'current', parentSessionId: sessionId,
      });
      expect(manager.resolveLiveBrokerAuthority({
        ...request,
        expectedDirectMaterialUse: { ...request.expectedDirectMaterialUse, resourceId: 'resource-substitute' },
      })).toEqual({ status: 'not_current', reason: 'identity_mismatch' });

      const brokered = await manager.start({
        sessionId,
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        teamCredentialModel: {
          kind: 'team_credential_provider_model',
          resourceId: 'resource-current',
          teamId: 'team-1',
          expectedResourceRevision: 7,
          deliveryMode: 'brokered',
          agentTargetKey: buildBackendTargetKeyV2(readBackendTargetRefV2({ kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID })),
          modelId: 'model-current' as never,
        },
        permissionMode: 'default',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });
      expect(manager.resolveLiveBrokerAuthority({
        ...request,
        executionRunId: brokered.runId,
      })).toEqual({ status: 'not_current', reason: 'identity_mismatch' });
    } finally {
      await manager.dispose();
    }
  });

  it('attests each Run\'s own accepted provider-model selection, or null when it inherits its parent', async () => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptRuntime(() => {}),
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });
    try {
      const launch = {
        sessionId: 'parent_run_selection',
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        permissionMode: 'default',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      } as const;
      const selected = await manager.start({
        ...launch,
        teamCredentialModel: {
          kind: 'team_credential_provider_model',
          resourceId: 'resource-run-b',
          teamId: 'team-b',
          expectedResourceRevision: 3,
          deliveryMode: 'brokered',
          agentTargetKey: buildBackendTargetKeyV2(readBackendTargetRefV2({ kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID })),
          modelId: 'model-b' as never,
        },
      });
      const inheriting = await manager.start(launch);
      expect(manager.resolveLiveBrokerAuthority({
        v: 1, executionRunId: selected.runId, expectedOccurrenceId: null,
      })).toMatchObject({
        status: 'current',
        parentSessionId: 'parent_run_selection',
        teamCredentialProviderModel: { resourceId: 'resource-run-b', deliveryMode: 'brokered' },
      });
      expect(manager.resolveLiveBrokerAuthority({
        v: 1, executionRunId: inheriting.runId, expectedOccurrenceId: null,
      })).toMatchObject({ status: 'current', teamCredentialProviderModel: null });
    } finally {
      await manager.dispose();
    }
  });

  it('projects idle Voice Follow currentness without accepting an intent substitution', async () => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptRuntime(() => {}),
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });
    try {
      const started = await manager.start({
        sessionId: 'parent_voice_authority',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        permissionMode: 'default',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        initialContext: 'Voice context',
        bootstrapMode: 'none',
      });
      const current = manager.resolveLiveBrokerAuthority({
        v: 1,
        executionRunId: started.runId,
        expectedIntent: 'voice_agent',
        expectedOccurrenceId: null,
      });
      expect(current).toMatchObject({
        status: 'current',
        parentSessionId: 'parent_voice_authority',
        intent: 'voice_agent',
        runtimeState: 'idle',
      });
      if (current.status !== 'current') throw new Error('expected current Voice occurrence');
      expect(manager.resolveLiveBrokerAuthority({
        v: 1,
        executionRunId: started.runId,
        expectedIntent: 'voice_agent',
        expectedOccurrenceId: current.occurrenceId,
      })).toMatchObject({
        status: 'current',
        occurrenceId: current.occurrenceId,
      });
      expect(manager.resolveLiveBrokerAuthority({
        v: 1,
        executionRunId: started.runId,
        expectedIntent: 'agent',
        expectedOccurrenceId: null,
      })).toEqual({ status: 'not_current', reason: 'identity_mismatch' });
    } finally {
      await manager.dispose();
    }
  });

  it('disposes running backend resources and unregisters permission response handling idempotently', async () => {
    const unregisterPermissionHandler = vi.fn();
    const permissionStore = {
      registerResponseTargetHandler: vi.fn(() => unregisterPermissionHandler),
    };
    const disposeCalls: string[] = [];
    const provisioned: string[] = [];
    let runtimeIndex = 0;
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => {
        runtimeIndex += 1;
        const index = runtimeIndex;
        return createPromptRuntime(
          () => {},
          {
            onProvisionRuntime: async () => { provisioned.push(`runtime_${index}`); },
            onDispose: async () => {
              disposeCalls.push(`runtime_${index}`);
            },
          },
        );
      },
      sendAcp: async () => {},
      getPermissionRequestStore: () => permissionStore as never,
      getNowMs: () => 1_700_000_000_000,
    });

    await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });
    await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID },
      instructions: '',
      modelSelection: null,
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    expect(manager.getRunningCount()).toBe(2);
    await vi.waitFor(() => expect(provisioned).toEqual(['runtime_1', 'runtime_2']));

    await manager.dispose();
    await manager.dispose();

    expect(manager.getRunningCount()).toBe(0);
    // The owner settles independent Runs concurrently; each resource must be
    // disposed exactly once, without imposing a cross-Run completion order.
    expect([...disposeCalls].sort()).toEqual(['runtime_1', 'runtime_2']);
    expect(permissionStore.registerResponseTargetHandler).toHaveBeenCalledTimes(1);
    expect(unregisterPermissionHandler).toHaveBeenCalledTimes(1);
  });

  function createPromptEchoResumeRuntime(): NativePromptRuntimeFactory {
    return createPromptRuntime(
      (runtime, _sessionId, prompt) => {
        runtime.emitMessage({ type: 'model-output', fullText: `reply:${prompt}` });
      },
      { resumeSupported: true, providerSessionId: 'vendor_echo_session' },
    );
  }

  function createReadyHandshakePromptEchoRuntime(): NativePromptRuntimeFactory {
    let sendCount = 0;
    return createPromptRuntime(
      (runtime, _sessionId, prompt) => {
        sendCount += 1;
        runtime.emitMessage({
          type: 'model-output',
          fullText: sendCount === 1 ? 'READY' : `reply:${prompt}`,
        });
      },
    );
  }

  it('passes the parent session state target through to the execution-run runtime factory', async () => {
    const enqueueRegisteredSessionStateFieldMutation = vi.fn();
    const seen: Array<Record<string, unknown>> = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      parentSessionStateTarget: {
        sessionId: 'parent_session_1',
        enqueueRegisteredSessionStateFieldMutation,
      },
      createRuntime: (opts) => {
        seen.push(opts);
        return createPromptEchoRuntime();
      },
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID },
      instructions: 'Review this repo.',
      modelSelection: null,
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      runId: expect.stringMatching(/^run_/),
      scope: 'session_owned',
      backendId: TEST_SECONDARY_BACKEND_ID,
      permissionMode: 'read_only',
      parentSessionStateTarget: {
        sessionId: 'parent_session_1',
        enqueueRegisteredSessionStateFieldMutation,
      },
    });
  });

  it('keeps detached retained Runs run-rooted even when the manager owns a parent Session host', async () => {
    const seen: TestRuntimeFactoryInput[] = [];
    const parentSessionStateTarget = {
      sessionId: 'parent_session_1',
      enqueueRegisteredSessionStateFieldMutation: vi.fn(),
    };
    const sessionInteractionHost = {
      session: {
        sessionId: 'parent_session_1',
        getMetadataSnapshot: () => null,
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn(),
        enqueueAgentMessageCommitted: vi.fn(),
      },
      machineId: 'machine-a',
      permissionHandler: { handleToolCall: vi.fn() },
    } as never;
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      parentSessionStateTarget,
      sessionInteractionHost,
      createRuntime: (opts) => {
        seen.push(opts);
        return createPromptEchoResumeRuntime();
      },
      sendAcp: async () => {},
    });

    try {
      await manager.start({
        sessionId: null,
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID },
        instructions: 'Keep this detached conversation resumable.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ scope: 'detached' });
      expect(seen[0]).not.toHaveProperty('parentSessionStateTarget');
      expect(seen[0]).not.toHaveProperty('happierSessionId');
      expect(seen[0]).not.toHaveProperty('sessionInteractionHost');
      expect(seen[0]).not.toHaveProperty('sessionOwnedRunScope');
    } finally {
      await manager.dispose();
    }
  });

  it('surfaces transcript persistence in public state for voice_agent runs', async () => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptEchoRuntime(),
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      transcript: { persistenceMode: 'persistent', epoch: 3 },
    });

    expect((manager.getPublic(started.runId) as any)?.transcript).toMatchObject({
      persistenceMode: 'persistent',
      epoch: 3,
    });
  });

  it('applies voice_agent prepareStartParams before starting replay-backed runs', async () => {
    vi.mocked(readStoredCredentials).mockResolvedValue({
      token: 'credential-token',
      encryption: null,
    });
    vi.mocked(resolveReplaySeedDraft).mockResolvedValue({
      status: 'seeded',
      seedDraft: 'Replay seed summary',
    } as never);

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: '/tmp/voice-agent-manager',
      createRuntime: () => createReadyHandshakePromptEchoRuntime(),
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Operator supplied context.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      bootstrapMode: 'ready_handshake',
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sess_voice',
        transcriptEpoch: 4,
      },
    } as any);

    expect(resolveReplaySeedDraft).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/voice-agent-manager',
      source: {
        kind: 'voice_session.v1',
        previousSessionId: 'sess_voice',
        transcriptEpoch: 4,
      },
    }));
    expect(manager.get(started.runId)?.voiceAgentConfig).toMatchObject({
      initialContextMode: 'first_turn',
    });
    expect(manager.get(started.runId)?.voiceAgentConfig?.initialContext).toContain('Replay seed summary');
  });

  it('emits a fresh public-state update when a resumable voice_agent run is ensured after stop', async () => {
    const publicStates: Array<Record<string, unknown>> = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptEchoResumeRuntime(),
      sendAcp: async () => {},
      onPublicStateUpdated: (run) => {
        publicStates.push(run as Record<string, unknown>);
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      transcript: { persistenceMode: 'persistent', epoch: 11 },
    });

    await manager.stop(started.runId);
    const beforeEnsureUpdates = publicStates.length;

    const ensured = await manager.ensure(started.runId, { resume: true });

    expect(ensured.ok).toBe(true);
    expect(publicStates.length).toBeGreaterThan(beforeEnsureUpdates);
    expect(publicStates.at(-1)).toMatchObject({
      runId: started.runId,
      intent: 'voice_agent',
      status: 'running',
      transcript: { persistenceMode: 'persistent', epoch: 11 },
    });
  });

  it('waits for exact Voice retirement before provisioning a same-id resume occurrence', async () => {
    let disposalStarted!: () => void;
    let releaseDisposal!: () => void;
    let resumeProvisionStarted!: () => void;
    let releaseResumeProvision!: () => void;
    const disposalStartedPromise = new Promise<void>((resolve) => {
      disposalStarted = resolve;
    });
    const disposalGate = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    const resumeProvisionStartedPromise = new Promise<void>((resolve) => {
      resumeProvisionStarted = resolve;
    });
    const resumeProvisionGate = new Promise<void>((resolve) => {
      releaseResumeProvision = resolve;
    });
    let runtimeCount = 0;
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => {
        runtimeCount += 1;
        const occurrence = runtimeCount;
        return createPromptRuntime(() => {}, {
          resumeSupported: true,
          providerSessionId: 'vendor_voice_retirement',
          async onProvisionRuntime(opts) {
            if (occurrence === 2 && opts?.resumeRuntimeId) {
              resumeProvisionStarted();
              await resumeProvisionGate;
            }
          },
          async onDispose() {
            if (occurrence === 1) {
              disposalStarted();
              await disposalGate;
            }
          },
        });
      },
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    try {
      const started = await manager.start({
        sessionId: 'parent_session_1',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      });

      await expect(manager.stop(started.runId)).resolves.toEqual({ ok: true });
      await disposalStartedPromise;
      const resume = manager.ensure(started.runId, { resume: true });

      const beforeRetirement = await Promise.race([
        resumeProvisionStartedPromise.then(() => 'provisioning' as const),
        new Promise<'retiring'>((resolve) => setImmediate(() => resolve('retiring'))),
      ]);
      expect(beforeRetirement).toBe('retiring');
      expect(runtimeCount).toBe(1);

      releaseDisposal();
      await resumeProvisionStartedPromise;
      releaseResumeProvision();
      await expect(resume).resolves.toEqual({ ok: true });
      expect(runtimeCount).toBe(2);
    } finally {
      releaseDisposal();
      releaseResumeProvision();
      await manager.dispose();
    }
  });

  it('reuses the current voice_agent resume occurrence without provisioning twice', async () => {
    let releaseResumeProvision!: () => void;
    let resumeProvisionStarted!: () => void;
    const resumeProvisionGate = new Promise<void>((resolve) => {
      releaseResumeProvision = resolve;
    });
    const resumeProvisionStartedPromise = new Promise<void>((resolve) => {
      resumeProvisionStarted = resolve;
    });
    let runtimeCount = 0;
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => {
        runtimeCount += 1;
        return createPromptRuntime(() => {}, {
          resumeSupported: true,
          providerSessionId: 'vendor_voice_concurrent_resume',
          onProvisionRuntime: async (opts) => {
            if (!opts?.resumeRuntimeId) return;
            resumeProvisionStarted();
            await resumeProvisionGate;
          },
        });
      },
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    try {
      const started = await manager.start({
        sessionId: 'parent_session_1',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      });
      await manager.stop(started.runId);

      const first = manager.ensure(started.runId, { resume: true });
      await resumeProvisionStartedPromise;
      const second = manager.ensure(started.runId, { resume: true });
      // Provisioning already owns the canonical running controller. A second
      // ensure acknowledges that occurrence rather than claiming a new resume.
      await expect(second).resolves.toEqual({ ok: true });
      expect(runtimeCount).toBe(2);
      releaseResumeProvision();
      await expect(first).resolves.toEqual({ ok: true });
      expect(runtimeCount).toBe(2);
      expect(manager.get(started.runId)?.status).toBe('running');
    } finally {
      releaseResumeProvision();
      await manager.dispose();
    }
  });

  it('does not revive a running voice_agent occurrence stopped while resume provisioning is pending', async () => {
    let releaseResumeProvision!: () => void;
    let resumeProvisionStarted!: () => void;
    const resumeProvisionGate = new Promise<void>((resolve) => {
      releaseResumeProvision = resolve;
    });
    const resumeProvisionStartedPromise = new Promise<void>((resolve) => {
      resumeProvisionStarted = resolve;
    });
    let runtimeCount = 0;
    let resumedRuntimeDisposals = 0;
    const publicStates: Array<Record<string, unknown>> = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => {
        runtimeCount += 1;
        const isResumedRuntime = runtimeCount === 2;
        return createPromptRuntime(() => {}, {
          resumeSupported: true,
          providerSessionId: 'vendor_voice_pending_resume',
          onProvisionRuntime: async (opts) => {
            if (!isResumedRuntime || !opts?.resumeRuntimeId) return;
            resumeProvisionStarted();
            await resumeProvisionGate;
          },
          onDispose: async () => {
            if (isResumedRuntime) resumedRuntimeDisposals += 1;
          },
        });
      },
      sendAcp: async () => {},
      onPublicStateUpdated: (run) => publicStates.push(run as Record<string, unknown>),
      getNowMs: () => 1_700_000_000_000,
    });

    try {
      const started = await manager.start({
        sessionId: 'parent_session_1',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      });
      await manager.stop(started.runId);

      // A daemon-rehydrated running Run has no in-memory controller until ensure resumes it.
      const internalRuns = (manager as unknown as { runs: Map<string, ExecutionRunState> }).runs;
      const stopped = internalRuns.get(started.runId);
      if (!stopped) throw new Error('missing stopped run');
      internalRuns.set(started.runId, {
        ...stopped,
        status: 'running',
        finishedAtMs: undefined,
      });

      const resume = manager.ensure(started.runId, { resume: true });
      await resumeProvisionStartedPromise;
      await expect(manager.stop(started.runId)).resolves.toEqual({ ok: true });
      const updatesAfterStop = publicStates.length;
      releaseResumeProvision();

      await expect(resume).resolves.toMatchObject({
        ok: false,
        errorCode: 'execution_run_not_allowed',
      });
      expect(manager.get(started.runId)?.status).toBe('cancelled');
      expect(publicStates).toHaveLength(updatesAfterStop);
      expect(resumedRuntimeDisposals).toBe(1);
    } finally {
      await manager.dispose();
    }
  });

  it('terminalizes and resumes a public voice_agent run after its nested runtime idles out', async () => {
    let nowMs = 0;
    vi.useFakeTimers();
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptEchoResumeRuntime(),
      sendAcp: async () => {},
      getNowMs: () => nowMs,
    });

    try {
      const started = await manager.start({
        sessionId: 'parent_session_1',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
        chatModelId: 'chat',
        commitModelId: 'commit',
        idleTtlSeconds: 60,
      });

      expect(manager.get(started.runId)?.status).toBe('running');

      nowMs = 60_001;
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(manager.get(started.runId)?.status).toBe('cancelled');
      expect(manager.getPublic(started.runId)).toMatchObject({
        runId: started.runId,
        status: 'cancelled',
      });

      await expect(manager.ensure(started.runId, { resume: true })).resolves.toEqual({ ok: true });
      expect(manager.get(started.runId)?.status).toBe('running');
    } finally {
      await manager.dispose();
      vi.useRealTimers();
    }
  });

  it('prepares the captured target through production RPC construction and admitted Account catalogs', async () => {
    const prompts: string[] = [];
    let markdown = 'RPC_TARGET_PERSONA_OLD';
    const home = await resolveCurrentCliHomeTarget();
    const serverUrl = home.applicationUrl;
    const accountId = 'rpc-voice-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    const bound = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    const entry = (id: string) => ({ id, ref: { kind: 'doc' as const, artifactId: id }, enabled: true,
      required: true, placement: 'system_append' as const });
    commitActivePromptLibraryCatalog({ ...bound, catalog: { status: 'ready', rows: [{ revision: 1,
      record: { key: 'voice', value: { v: 1, scope: { kind: 'voice' }, entries: [entry('rpc-account-doc')] } } }],
      tombstones: [], diagnostics: [] } });
    commitActiveProfileCatalog({ ...bound, catalog: { status: 'ready', authority: 'active', control: null,
      controlRevision: 'absent', referenceGuardRevision: 'absent', diagnostics: [], records: [{ revision: 1,
        record: { v: 1, id: 'rpc-target-profile', enabled: true, secretBindings: {}, skillSeeds: [],
          definition: { kind: 'artifact', artifactId: 'profile-definition' }, promptStack: [entry('rpc-profile-doc')] } }] } });
    const hidden = buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
    // Local daemon control and Account HTTP are genuine external transports;
    // the RPC factory, bridge, Voice manager, catalogs and D2 preparation run.
    const admission = vi.spyOn(daemonControlHttp, 'daemonPost').mockImplementation(async path => {
      if (path !== '/execution-run/admission') throw new Error(`Unexpected daemon effect: ${path}`);
      return { admitted: true };
    });
    const artifactHeader = (id: string) => ({
      id, ownerAccountId: accountId, access: 'owner' as const, encryptionMode: 'plain' as const, publicAudience: 'none' as const,
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Instructions' }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
      seq: 1, createdAt: 1, updatedAt: 1,
    });
    // Selected Artifact headers use the narrow batch read; bodies are still ordinary GETs.
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (new URL(String(url)).pathname !== '/v1/artifacts/read') throw new Error(`Unexpected Account write: ${String(url)}`);
      const input = ArtifactReadHeadersBatchInputV1Schema.parse(body);
      return { status: 200, data: ArtifactReadHeadersBatchResponseV1Schema.parse({ projection: 'headers',
        items: input.artifactIds.map(artifactId => ({ artifactId, ok: true, artifact: artifactHeader(artifactId) })) }) };
    });
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const address = new URL(String(url));
      expect(new URL(normalizeServerHttpBaseUrl(String(url))).origin).toBe(new URL(normalizeServerHttpBaseUrl(serverUrl)).origin);
      const path = address.pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v1/artifacts') return { status: 200, data: ['rpc-account-doc', 'rpc-profile-doc', 'rpc-session-doc'].map(id => artifactHeader(id)) };
      if (path.startsWith('/v2/sessions/')) {
        const id = path.slice('/v2/sessions/'.length);
        const metadata = id === 'rpc-history' ? { ...hidden, profileId: 'misleading-history-profile',
          voiceConversationBindingV1: { v: 1, adapterId: 'local', controlSessionId: 'voice-global',
            transcriptMode: 'synthetic', targetSessionId: 'rpc-target', updatedAt: 1 } }
          : id === 'rpc-target' ? { profileId: 'rpc-target-profile', work: { promptStack: [entry('rpc-session-doc')] } }
            : (() => { throw new Error(`Unexpected target: ${id}`); })();
        return { status: 200, data: { session: { id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
          archivedAt: null, encryptionMode: 'plain', metadataVersion: 0, agentState: null, agentStateVersion: 0,
          pendingCount: 0, pendingVersion: 0, share: null, dataEncryptionKey: null, metadata: JSON.stringify(metadata) } } };
      }
      if (path.startsWith('/v1/artifacts/')) {
        const id = path.slice('/v1/artifacts/'.length);
        const content = id === 'rpc-session-doc' ? markdown : id === 'rpc-account-doc' ? 'RPC_ACCOUNT_PERSONA'
          : id === 'rpc-profile-doc' ? 'RPC_PROFILE_PERSONA' : (() => { throw new Error(`Unexpected Artifact: ${id}`); })();
        return { status: 200, data: { id, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
          header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Instructions' }),
          body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: content, createdAtMs: 1, updatedAtMs: 1 }) }),
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
          seq: 1, createdAt: 1, updatedAt: 1 } };
      }
      throw new Error(`Unexpected Account read: ${path}`);
    });
    const captured: { manager: ExecutionRunManager | null } = { manager: null };
    runtimeFactoryRef.current = () => createPromptRuntime((runtime, _id, prompt) => {
      prompts.push(prompt);
      runtime.emitMessage({ type: 'model-output', fullText: prompt.includes('reply with exactly READY') ? 'READY' : 'hello' });
    });
    try {
      registerExecutionRunRpcHandlers({ registerHandler: () => {} }, {
        resolveRunReportPolicy: async () => ({ preset: 'important' }),
        sessionId: 'rpc-history', cwd: defaultExecutionRunManagerTestCwd, serverId: configuration.activeServerId,
        serverUrl, parentProvider: TEST_PRIMARY_BACKEND_ID,
        sessionInteractionHost: createManagerParentHost('rpc-history'),
        readPromptCredentials: async () => credentials, resolveAccountSettings: () => ({}), sendAcp: async () => {},
        executionRunProfileCatalog: buildExecutionRunProfileCatalog(),
        onManagerCreated: manager => { captured.manager = manager; },
      });
      if (!captured.manager) throw new Error('Production RPC factory did not publish its manager');
      const manager = captured.manager;
      const startResult = await manager.start({ sessionId: 'rpc-history', intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID }, permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        chatModelId: 'chat', commitModelId: 'commit', idleTtlSeconds: 60 })
        .then(started => ({ ok: true as const, started }), error => ({ ok: false as const, error: String(error) }));
      expect(startResult.ok, JSON.stringify({ startResult, reads: http.mock.calls.map(([url]) => String(url)) })).toBe(true);
      if (!startResult.ok) throw new Error(startResult.error);
      const started = startResult.started;
      markdown = 'RPC_TARGET_PERSONA_CURRENT';
      const welcomed = await manager.applyAction(started.runId, { actionId: 'voice_agent.welcome', input: {} });
      expect(welcomed.ok).toBe(true);
      const prompt = prompts.at(-1);
      expect(prompt).toContain('RPC_ACCOUNT_PERSONA');
      expect(prompt).toContain('RPC_PROFILE_PERSONA');
      expect(prompt).toContain('RPC_TARGET_PERSONA_CURRENT');
      expect(prompt).not.toContain('RPC_TARGET_PERSONA_OLD');
      expect(prompt).not.toContain('misleading-history-profile');
    } finally {
      await captured.manager?.dispose();
      clearActiveAccountSettingsSnapshot();
      http.mockRestore();
      admission.mockRestore();
    }
  });

  it('prepares the actual hidden history binding target again before Voice bridge dispatch', async () => {
    const prompts: string[] = [];
    let markdown = 'BRIDGE_STARTUP_PERSONA';
    const hidden = buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
      const id = path.slice('/v2/sessions/'.length);
      const metadata = id === 'history-session' ? { ...hidden, profileId: 'wrong-history-profile', voiceConversationBindingV1: {
        v: 1, adapterId: 'local', controlSessionId: 'voice-global', transcriptMode: 'synthetic', targetSessionId: 'attached-target', updatedAt: 1,
      } } : id === 'attached-target' ? { work: { promptStack: [{ id: 'target-doc', enabled: true,
        ref: { kind: 'doc', artifactId: 'target-doc' }, placement: 'system_append', required: true }] } }
        : (() => { throw new Error(`Unexpected qualified Voice Session: ${path}`); })();
      return { status: 200, data: { session: { id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        archivedAt: null, encryptionMode: 'plain', metadataVersion: 0, agentState: null, agentStateVersion: 0,
        pendingCount: 0, pendingVersion: 0, share: null, dataEncryptionKey: null, metadata: JSON.stringify(metadata) } } };
    });
    const manager = createExecutionRunManager({ parentProvider: TEST_PRIMARY_BACKEND_ID, cwd: process.cwd(),
      sendAcp: async () => {}, createRuntime: () => createPromptRuntime((runtime, _id, prompt) => {
        prompts.push(prompt);
        runtime.emitMessage({ type: 'model-output', fullText: prompt.includes('reply with exactly READY') ? 'READY' : 'hello' });
      }), resolveVoicePromptPreparation: async args => await resolveCliVoicePromptPreparation({ ...args,
        credentials: { token: 'bridge-target-reader', encryption: null }, accountEntries: [], profileEntries: [],
        readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' } }),
        readArtifact: async ref => ({ id: ref.artifactId, header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' },
          revision: { headerVersion: 1, bodyVersion: 1 }, body: JSON.stringify({ v: 1, markdown, createdAtMs: 1, updatedAtMs: 1 }) }),
      }),
    });
    try {
      const started = await manager.start({ sessionId: 'history-session', intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID }, permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        chatModelId: 'chat', commitModelId: 'commit', idleTtlSeconds: 60 });
      markdown = 'BRIDGE_CURRENT_TARGET_PERSONA';
      const welcomed = await manager.applyAction(started.runId, { actionId: 'voice_agent.welcome', input: {} });
      expect(welcomed.ok).toBe(true);
      expect(prompts.at(-1)).toContain('BRIDGE_CURRENT_TARGET_PERSONA');
      expect(prompts.at(-1)).not.toContain('BRIDGE_STARTUP_PERSONA');
    } finally { await manager.dispose(); http.mockRestore(); }
  });

  it('builds voice-agent prompts from resolved account settings instead of local CLI settings', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const seenCalls: Array<{ settings?: unknown; profileId?: string | null; sessionId?: string | null; workingDirectory?: string | null }> = [];

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      executionRunProfileCatalog: buildExecutionRunProfileCatalog(
        [{
          id: 'work',
          intent: 'voice_agent',
          title: 'Work voice agent',
          promptAsset: {
            pluginId: 'happier.test.voice',
            localId: 'work-voice-prompt',
          },
          compatibleAgents: [TEST_PRIMARY_BACKEND_ID],
          defaults: {
            retention: 'resumable',
            runClass: 'longLived',
            io: 'streaming',
          },
        }],
      ),
      createRuntime: () => createPromptEchoRuntime(),
      sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      resolveAccountSettings: async () => ({ promptStacksSource: 'account-settings' }),
      resolveVoicePromptPreparation: async ({ settings, profileId, sessionId, workingDirectory }) => {
        seenCalls.push({ settings, profileId, sessionId, workingDirectory });
        return { systemAppendBlocks: ['Voice stack block'], memoryRecallGuidanceEnabled: false, disabledActionIds: [] };
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'initial context',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      profileId: 'work',
    });

    const streamStart = await manager.startTurnStream(started.runId, { message: 'hello' });
    expect(streamStart.ok).toBe(true);
    const events = await readExecutionRunTurnStreamUntilDone({
      manager,
      runId: started.runId,
      streamId: (streamStart as { streamId: string }).streamId,
      maxEvents: 128,
    });
    expect(JSON.stringify(events)).toContain('Voice stack block');
    expect(seenCalls).toEqual(Array(2).fill({
      settings: { promptStacksSource: 'account-settings' },
      profileId: 'work',
      sessionId: 'parent_session_1',
      workingDirectory: defaultExecutionRunManagerTestCwd,
    }));

    const stopped = await manager.stop(started.runId);
    expect(stopped.ok).toBe(true);
    await manager.waitForTerminal(started.runId);
  });

  it('surfaces turnInFlight in public state for running bounded runs', async () => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createDelayedJsonRuntime('{"ok":true}', 50_000),
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID },
      instructions: 'hello',
      modelSelection: null,
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await vi.waitFor(() => expect(manager.getPublic(started.runId)?.turnInFlight).toBe(true));

    const stopped = await manager.stop(started.runId);
    expect(stopped.ok).toBe(true);
    await manager.waitForTerminal(started.runId);
  });

  it('passes the voice_agent start intent through to the backend factory', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const request = new AbortController();
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (opts: { backendId: string; modelId?: string; permissionMode: string; start?: unknown }) => {
        seen.push(opts as Record<string, unknown>);
        return createPromptEchoRuntime();
      },
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      signal: request.signal,
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID },
      permissionMode: 'read_only',
      modelSelection: null,
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      transcript: { persistenceMode: 'ephemeral', epoch: 1 },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      backendId: TEST_SECONDARY_BACKEND_ID,
      modelId: 'chat',
      permissionMode: 'read-only',
      start: { intent: 'voice_agent' },
    });
    expect(seen[0]?.start).not.toHaveProperty('signal');
    expect(manager.get(started.runId)).not.toHaveProperty('signal');
    expect(manager.get(started.runId)?.launch).not.toHaveProperty('signal');
    request.abort();
    expect(manager.get(started.runId)?.status).toBe('running');
  });

  it('settles a registered Voice start and retires its native bootstrap when the carrier closes RPC custody', async () => {
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_VOICE__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_VOICE_AGENT__ENABLED', '1');
    const sessionId = 'voice-start-cancellation';
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
    let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let entered = false;
    let disposed = false;
    let sequence = 0;
    const externalRuntime: AgentRuntime = { sessions: { async open() { return {
      watch(value) { listener = value; return { dispose() { listener = undefined; } }; },
      async send(request) {
        listener?.({ kind: 'input-accepted', sessionId: 'session-parent', sequence: sequence++, emittedAtMs: 1,
          inputIds: request.inputIds, delivery: request.delivery });
        listener?.({ kind: 'turn-start', sessionId: 'session-parent', sequence: sequence++, emittedAtMs: 1,
          turnId: request.delivery.turnId, startedBy: 'host' });
        entered = true;
        return { status: 'admitted' };
      },
      dispose() { disposed = true; },
    }; } } };
    let native: ExecutionRunHostRuntime | undefined;
    runtimeFactoryRef.current = runtimeOptions => {
      native = createVoiceSessionRuntimeThroughNativeFactory({ runtime: externalRuntime, modelId: 'chat',
        runtimeOptions: { ...runtimeOptions,
          accountSettings: runtimeOptions.accountSettings ? accountSettingsParse(runtimeOptions.accountSettings) : null },
        capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false } });
      return native;
    };
    const admission = vi.spyOn(daemonControlHttp, 'daemonPost').mockResolvedValue({ admitted: true });
    const captured: { manager?: ExecutionRunManager } = {};
    try {
      registerExecutionRunRpcHandlers(rpc, {
        resolveRunReportPolicy: async () => ({ preset: 'important' }),
        sessionId, cwd: defaultExecutionRunManagerTestCwd, parentProvider: 'codex',
        serverId: configuration.activeServerId, serverUrl: configuration.apiServerUrl,
        getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
          execution: { enabled: true, runs: { enabled: true } }, voice: { enabled: true, agent: { enabled: true } },
        } }) }),
        sessionInteractionHost: createManagerParentHost(sessionId),
        readPromptCredentials: async () => defaultVoiceAccountCredentials,
        resolveAccountSettings: async () => accountSettingsParse({}), sendAcp: async () => {},
        executionRunProfileCatalog: buildExecutionRunProfileCatalog(),
        resolveExecutionRunProfileCatalog: async () => ({ profileCatalog: buildExecutionRunProfileCatalog(),
          engineRegistry: defaultExecutionRunManagerEngineRegistry }),
        onManagerCreated: manager => { captured.manager = manager; },
      });
      let result: unknown;
      const pending = rpc.handleRequest({ method: `${sessionId}:execution.run.ensureOrStart`, timeoutMs: null,
        callerAuthority: 'present_user', params: { runId: null, start: {
          intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          permissionMode: 'read_only', modelSelection: null, chatModelId: 'chat', commitModelId: 'chat',
          retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', bootstrapMode: 'ready_handshake',
        } } }).then(value => { result = value; });
      await vi.waitFor(() => expect(entered, JSON.stringify(result)).toBe(true));
      rpc.cancelTransportRequests();
      // Start acknowledges the created Run; the closed carrier settles it as failed.
      await vi.waitFor(() => expect(result).toMatchObject({ ok: true, runId: expect.any(String) }));
      await pending;
      expect(captured.manager?.get((result as { runId: string }).runId))
        .toMatchObject({ status: 'failed', error: { code: 'VOICE_AGENT_START_FAILED' } });
      expect(disposed).toBe(true);
      expect(rpc.getInFlightRequestCount()).toBe(0);
      expect(captured.manager?.listPublicForRequest({}, sessionId)?.some(run => run.status === 'running')).toBe(false);
    } finally {
      await native?.dispose();
      await captured.manager?.dispose();
      admission.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('inherits both Voice roles through the registered parent reader after replacement settles', async () => {
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_VOICE__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_VOICE_AGENT__ENABLED', '1');
    const sessionId = 'voice-applied-parent';
    const backendTarget = { kind: 'builtInAgent', agentId: 'codex' } as const;
    const agentTargetKey = buildBackendTargetKeyV2(readBackendTargetRefV2(backendTarget));
    const applied: ExecutionRunAppliedParentSelection = {
      status: 'applied', backendTarget, modelId: 'applied-parent-model', connectedServices: null,
      modelSelection: { agentTargetKey, modelId: 'applied-parent-model', providerConnectionId: null },
    };
    let parent: ExecutionRunAppliedParentSelection = { status: 'unavailable' };
    const sessionInteractionHost = {
      ...createManagerParentHost(sessionId, applied),
      // Native runtime replacement is the external execution boundary. The RPC
      // registration, host admission and both Voice role decisions remain real.
      readAppliedChildSelection: async () => parent,
    };
    const observed: TestRuntimeFactoryInput[] = [];
    runtimeFactoryRef.current = options => {
      observed.push(options);
      return createPromptEchoRuntime();
    };
    const admission = vi.spyOn(daemonControlHttp, 'daemonPost').mockResolvedValue({ admitted: true });
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
    const captured: { manager?: ExecutionRunManager } = {};
    const settings = accountSettingsParse({ providerDefaultModelSelectionsByAgentTargetKeyV1: {
      [agentTargetKey]: { v: 1, updatedAt: 1, ref: { agentTargetKey, modelId: 'different-account-default', providerConnectionId: null } },
    } });
    try {
      registerExecutionRunRpcHandlers(rpc, {
        resolveRunReportPolicy: async () => ({ preset: 'important' }),
        sessionId, cwd: defaultExecutionRunManagerTestCwd, parentProvider: 'codex',
        serverId: configuration.activeServerId, serverUrl: configuration.apiServerUrl,
        getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
          execution: { enabled: true, runs: { enabled: true } }, voice: { enabled: true, agent: { enabled: true } },
        } }) }),
        sessionInteractionHost, readPromptCredentials: async () => defaultVoiceAccountCredentials,
        resolveAccountSettings: async () => settings, sendAcp: async () => {},
        executionRunProfileCatalog: buildExecutionRunProfileCatalog(),
        onManagerCreated: manager => { captured.manager = manager; },
      });
      if (!captured.manager) throw new Error('Voice RPC registration unavailable');
      const request = { intent: 'voice_agent', backendTarget, permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' };
      const start = () => rpc.handleRequest({ method: `${sessionId}:execution.run.start`,
        callerAuthority: 'present_user', params: request });
      await expect(start()).resolves.toMatchObject({ ok: false,
        errorCode: 'execution_run_parent_selection_unavailable',
        details: { executionRunStart: { runCreation: 'noRunCreated' } } });
      expect(observed).toEqual([]);

      parent = applied;
      const result: unknown = await start();
      expect(result).toMatchObject({ runId: expect.any(String) });
      if (!result || typeof result !== 'object' || !('runId' in result) || typeof result.runId !== 'string') {
        throw new Error('Voice did not create a Run');
      }
      expect(captured.manager.getPublic(result.runId)).toMatchObject({ resolvedSelection: {
        source: 'inherited', modelId: 'applied-parent-model', modelSelection: applied.modelSelection,
      } });
      expect(captured.manager.get(result.runId)?.voiceAgentConfig).toMatchObject({
        chatModelId: 'applied-parent-model', commitModelId: 'applied-parent-model',
        chatModelSelection: applied.modelSelection, commitModelSelection: applied.modelSelection,
      });
      expect(observed[0]).toMatchObject({ modelId: 'applied-parent-model' });
    } finally {
      await captured.manager?.dispose();
      admission.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('keeps an external configured Agent target across voice runtime creation and resume', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const externalTarget = { kind: 'configuredAcpBackend', backendId: 'external-voice-agent' } as const;
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (opts: TestRuntimeFactoryInput) => {
        seen.push(opts as Record<string, unknown>);
        return createPromptEchoResumeRuntime();
      },
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: externalTarget,
      permissionMode: 'read_only',
      modelSelection: null,
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
    });

    expect(seen[0]).toMatchObject({
      backendId: 'external-voice-agent',
      backendTarget: externalTarget,
      start: { intent: 'voice_agent' },
    });
    expect(manager.get(started.runId)?.resumeHandle?.backendTarget).toMatchObject({
      kind: 'backend',
      backendId: 'external-voice-agent',
      configuredBackendId: 'external-voice-agent',
      sourceKind: 'configured',
    });

    await manager.stop(started.runId);
    await expect(manager.ensure(started.runId, { resume: true })).resolves.toEqual({ ok: true });
    expect(seen.at(-1)).toMatchObject({
      backendId: 'external-voice-agent',
      backendTarget: externalTarget,
      start: { intent: 'voice_agent' },
    });
    await manager.dispose();
  });

  it('does not force literal default model ids for voice_agent runs when start params omit them', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (opts: { backendId: string; modelId?: string; permissionMode: string; start?: unknown }) => {
        seen.push(opts as Record<string, unknown>);
        return createPromptEchoRuntime();
      },
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID },
      permissionMode: 'read_only',
      modelSelection: null,
      commitModelId: 'default',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      backendId: TEST_SECONDARY_BACKEND_ID,
      modelId: '',
      permissionMode: 'read-only',
      start: { intent: 'voice_agent' },
    });
  });

  it('streams sidechain output for long-lived runs when ioMode=streaming and avoids emitting a duplicate non-streaming message', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const commits: Array<{
      provider: string;
      body: unknown;
      localId: string;
      meta?: Record<string, unknown>;
    }> = [];

    const runtime = createPromptRuntime((promptRuntime, _sessionId, prompt) => {
      promptRuntime.emitMessage({ type: 'model-output', fullText: `Working: ${prompt}\n` });
      promptRuntime.emitMessage({ type: 'model-output', fullText: `Working: ${prompt}\nDone.\n` });
    });

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      streamedTranscriptSession: {
        enqueueAgentMessageCommitted: async (provider, body, opts) => {
          commits.push({ provider, body, localId: opts.localId, meta: opts.meta });
          return { persisted: true, delivered: false };
        },
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    const sendResult = await manager.send(started.runId, { message: 'hi' });
    expect(sendResult.ok).toBe(true);

    await expect
      .poll(
        () => commits.filter(
          (row) => (row.body as any)?.type === 'message' && (row.body as any)?.sidechainId === started.sidechainId,
        ).length,
        { timeout: 1_000 },
      )
      .toBeGreaterThanOrEqual(1);

    const nonStreaming = sent.filter((m) => (m.body as any)?.type === 'message' && (m.body as any)?.sidechainId === started.sidechainId);
    expect(nonStreaming).toHaveLength(0);

    const sidechainCommits = commits.filter(
      (row) => (row.body as any)?.type === 'message' && (row.body as any)?.sidechainId === started.sidechainId,
    );
    expect(sidechainCommits.length).toBeGreaterThanOrEqual(1);
  });
});

describe('ExecutionRunManager (bounded external send)', () => {
  it('rebuilds bounded interrupt prompts using the intent profile (preserves strict JSON guidance)', async () => {
    const prompts: string[] = [];
    let waitResolve: (() => void) | null = null;
    let currentWait: Promise<void> = new Promise(() => {});

    const runtime = createPromptRuntime(
      (promptRuntime, _sessionId, prompt) => {
        prompts.push(prompt);
        currentWait = new Promise<void>((resolve) => {
          waitResolve = resolve;
        });

        // First prompt intentionally never completes; we will interrupt it.
        if (prompts.length === 1) return;

        // Second prompt completes immediately with strict JSON.
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText: JSON.stringify({ summary: 'ok', deliverables: [{ id: 'd1', title: 'done' }] }),
        });
        waitResolve?.();
      },
      {
        onWaitForTurnCompletion: async () => {
          await currentWait;
        },
      },
    );

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'original instructions',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await expect.poll(() => prompts.length, { timeout: 1_000 }).toBe(1);

    const sendResult = await manager.send(started.runId, {
      message: 'User update: finish immediately.',
      delivery: 'interrupt',
    });
    expect(sendResult.ok).toBe(true);

    await expect.poll(() => prompts.length, { timeout: 1_000 }).toBe(2);
    expect(prompts[1]).toContain('deliverables');
    expect(prompts[1]).toContain('User update: finish immediately.');

    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('succeeded');
  });

});

describe('ExecutionRunManager connected-services exact currentness', () => {
  async function createRunningHarness(params: Readonly<{
    checkConnectedServicesGenerationCurrent?: NonNullable<
      ConstructorParameters<
        typeof ExecutionRunManager
      >[0]['checkConnectedServicesGenerationCurrent']
    >;
  }> = {}) {
    let completeTurn!: () => void;
    let turnCompletion = Promise.resolve();
    const registrationCallbackRef: {
      current:
        | ((registration: typeof CONNECTED_SERVICES_REGISTRATION) => void | Promise<void>)
        | null;
    } = { current: null };
    const runtime = createPromptRuntime(
      () => {
        turnCompletion = new Promise<void>((resolve) => {
          completeTurn = resolve;
        });
      },
      {
        onCancel: () => completeTurn?.(),
        onDispose: () => completeTurn?.(),
        onWaitForTurnCompletion: async () => await turnCompletion,
      },
    );
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (opts) => {
        registrationCallbackRef.current =
          opts.onConnectedServicesRegistration ?? null;
        return runtime;
      },
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
      ...(params.checkConnectedServicesGenerationCurrent
        ? {
            checkConnectedServicesGenerationCurrent:
              params.checkConnectedServicesGenerationCurrent,
          }
        : {}),
    });
    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: {
        kind: 'builtInAgent',
        agentId: TEST_PRIMARY_BACKEND_ID,
      },
      instructions: 'Keep running.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    const onConnectedServicesRegistration =
      registrationCallbackRef.current;
    if (!onConnectedServicesRegistration) {
      throw new Error('expected connected-services registration callback');
    }
    return {
      manager,
      runId: started.runId,
      onConnectedServicesRegistration,
    };
  }

  it('persists the resolved connected-services binding as the immutable resume selection', async () => {
    const harness = await createRunningHarness();
    const registration = {
      ...CONNECTED_SERVICES_REGISTRATION,
      runKey: harness.runId,
      materializationKey: harness.runId,
    };

    await harness.onConnectedServicesRegistration(registration);

    expect(harness.manager.get(harness.runId)?.launch).toMatchObject({
      connectedServicesSelection: registration.connectedServicesBindings,
      connectedServicesRegistration: registration,
    });
    await harness.manager.dispose();
  });

  it.each(['replacement', 'exit'] as const)(
    'fails connected-services authorization when the exact run has a deferred %s',
    async (transition) => {
      let checkerEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        checkerEntered = resolve;
      });
      let releaseChecker!: () => void;
      const checkerGate = new Promise<void>((resolve) => {
        releaseChecker = resolve;
      });
      const harness = await createRunningHarness({
        checkConnectedServicesGenerationCurrent: async () => {
          checkerEntered();
          await checkerGate;
          return { current: true };
        },
      });
      const registration = {
        ...CONNECTED_SERVICES_REGISTRATION,
        runKey: harness.runId,
        materializationKey: harness.runId,
      };
      const internals = harness.manager as unknown as {
        runs: Map<string, NonNullable<ReturnType<ExecutionRunManager['get']>>>;
        authorizeConnectedServicesProviderEffect(
          runId: string,
        ): Promise<{ ok: boolean; errorCode?: string }>;
      };
      const run = internals.runs.get(harness.runId);
      if (!run) throw new Error('expected running execution run');
      const runWithRegistration = {
        ...run,
        launch: {
          ...(run.launch ?? {}),
          connectedServicesRegistration: registration,
        },
      };
      internals.runs.set(harness.runId, runWithRegistration);

      const authorization =
        internals.authorizeConnectedServicesProviderEffect(harness.runId);
      await entered;
      if (transition === 'replacement') {
        internals.runs.set(harness.runId, { ...runWithRegistration });
      } else {
        internals.runs.delete(harness.runId);
      }
      releaseChecker();

      await expect(authorization).resolves.toMatchObject({
        ok: false,
        errorCode:
          'execution_run_connected_service_generation_refresh_required',
      });
      await harness.manager.dispose();
    },
  );

  it.each(['replacement', 'exit'] as const)(
    'rejects a connected-services registration whose required marker await observes a deferred %s',
    async (transition) => {
      const harness = await createRunningHarness();
      let markerEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markerEntered = resolve;
      });
      let releaseMarker!: () => void;
      const markerGate = new Promise<void>((resolve) => {
        releaseMarker = resolve;
      });
      const internals = harness.manager as unknown as {
        runs: Map<string, NonNullable<ReturnType<ExecutionRunManager['get']>>>;
        writeActivityMarker(
          runId: string,
          nowMs: number,
          opts?: Readonly<{ force?: boolean; required?: boolean }>,
        ): Promise<void>;
      };
      internals.writeActivityMarker = vi.fn(async () => {
        markerEntered();
        await markerGate;
      });
      const registration = {
        ...CONNECTED_SERVICES_REGISTRATION,
        runKey: harness.runId,
        materializationKey: harness.runId,
      };

      const registrationWrite =
        harness.onConnectedServicesRegistration(registration);
      await entered;
      const registeredRun = internals.runs.get(harness.runId);
      if (!registeredRun) throw new Error('expected registered execution run');
      if (transition === 'replacement') {
        internals.runs.set(harness.runId, { ...registeredRun });
      } else {
        internals.runs.delete(harness.runId);
      }
      releaseMarker();

      await expect(registrationWrite).rejects.toThrow(
        'registration is no longer current',
      );
      if (transition === 'replacement') {
        expect(internals.runs.get(harness.runId)).not.toBe(registeredRun);
      } else {
        expect(internals.runs.has(harness.runId)).toBe(false);
      }
      await harness.manager.dispose();
    },
  );
});

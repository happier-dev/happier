import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, BUILT_IN_ROLES_V1, resolveRoleSelectionV1, ProviderBoundModelRefSchema } from '@happier-dev/protocol';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentStaticModels } from '@happier-dev/agents';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import {
  createTestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/testkit';
import { executeBoundedBackendRun } from './bounded/loop';
import { startExecutionRun } from './startExecutionRun';
import { stopExecutionRun } from './executionRunStop';
import { sendBackendLongLivedRun } from './send/backendLongLivedPrompt';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { TaskProfile } from '@/agent/executionRuns/profiles/task/TaskProfile';
import { projectRetainedExecutionRunState, projectExecutionRunHostLoss } from './retainedState';
import { projectExecutionRunPublicState } from './publicState';
import { resumeBackendControllerForResumableRun } from './resumeBackendController';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { ScmDiffSummaryProfile } from './kinds/scmDiffSummary/ScmDiffSummaryProfile';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ProfileRecordV1Schema, sealProfileRecordContentV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { reloadConfiguration } from '@/configuration';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import { finishExecutionRun } from './finishExecutionRun';
import axios from 'axios';
import { artifactReadResponse, artifactKindListResponse } from '@/testkit/http/artifactHome';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactReadHeadersBatchInputV1Schema, ArtifactReadHeadersBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { registerExecutionRunRpcHandlers } from '@/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExecutionRunErrorSchema, ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { bindRequesterSessionCredentialScope, readStoredCredentials, writeCredentialsTokenOnly } from '@/persistence';
import { configuration } from '@/configuration';
import * as daemonControlHttp from '@/daemon/controlHttp';
import type { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { prepareSessionMemoryInheritance } from '@/agent/prompting/coding/sessionPromptStack';
import { createExecutionRunAccountSettingsSnapshotResolver } from '@/api/machine/resolveExecutionRunAccountSettingsSnapshot';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { resolveReviewScmScope } from '@/agent/reviews/scope/resolve';
import { createScmBackendRegistry } from '@/scm/registry';

const TEST_BACKEND_ID = `${'summary'}.${'backend'}` as never;

const SUPPORTED_WORKTREE_SCOPE = {
  kind: 'review_scm_scope.v1',
  status: 'supported',
  scmBackendId: 'git',
  scmMode: 'worktree',
  repositoryRoot: '/repo',
  worktreeRoot: '/repo',
  baseRef: { source: 'default_branch', ref: 'main' },
  selectedPaths: [],
  committedPaths: [],
  uncommittedPaths: [],
  changedPaths: [],
  diff: { committedAvailable: true, uncommittedAvailable: true },
  diagnostics: [],
} as const;

const SELECTED_PULL_REQUEST_REVIEW_SCOPE = {
  kind: 'scm_pull_request_review_scope.v1',
  account: {
    service: { pluginId: 'happier.scm-github', localId: 'github' },
    accountId: 'account-7',
  },
  pullRequest: { number: 42 },
  observed: {
    baseSha: '1111111111111111111111111111111111111111',
    headSha: '2222222222222222222222222222222222222222',
    nativeRevision: 'PR_kwDOABCD',
    observedAtMs: 1_700_000_000_000,
  },
} as const;
type StartExecutionRunArgs = Parameters<typeof startExecutionRun>[0];

function readOfferedSummaryModelId(): string {
  const model = getAgentStaticModels('claude', { catalogOnly: true })[0];
  if (!model) throw new Error('The native Claude offered-model catalog is unavailable');
  return model.id;
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

// The native Agent adapter is an external execution boundary; RPC admission,
// host preparation, Context reads and prompt composition remain real.
vi.mock('./createExecutionRunBridgeRuntime', () => ({
  createExecutionRunBridgeRuntime: () => createProvisioningRuntime(),
}));

type AcpCommittedMessage = {
  body: Extract<ACPMessageData, { type: 'message' }>;
  localId: string;
  meta?: Record<string, unknown>;
};

function isAcpCommittedMessage(row: {
  body: ACPMessageData;
  localId: string;
  meta?: Record<string, unknown>;
}): row is AcpCommittedMessage {
  return row.body.type === 'message';
}

function createScmDiffSummaryStreamingRuntime(): TestExecutionRunHostRuntime {
  let runtime: TestExecutionRunHostRuntime;
  const finalJson = JSON.stringify({
    summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
    risks: ['Shared worktree attribution.'],
    testImpact: 'Unit tests.',
  });

  runtime = createTestExecutionRunHostRuntime({
    onSendPrompt: async () => {
      const progress = 'Inspecting checkpoint diff evidence...\n';
      runtime.emitMessage({ type: 'model-output', fullText: progress });
      // Unkeyed fullText is the authoritative whole-turn snapshot, not a delta.
      runtime.emitMessage({ type: 'model-output', fullText: progress + finalJson });
    },
    onWaitForTurnCompletion: async () => {},
  });
  return runtime;
}

function createProvisioningRuntime(): TestExecutionRunHostRuntime {
  return createTestExecutionRunHostRuntime({
    onSendPrompt: async () => {},
    onWaitForTurnCompletion: async () => {},
  });
}

function publishEmptyAccountRoleOverrides(): void {
  setActiveAccountSettingsSnapshot({
    scopeKey: 'start-execution-run-role-fixture', source: 'network',
    settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    promptLibraryCatalog: {
      status: 'ready', tombstones: [], diagnostics: [],
      rows: [{ revision: 1, record: { key: 'role-overrides', value: { v: 1, overrides: {} } } }],
    },
  });
}

describe('startExecutionRun', () => {
  beforeEach(() => {
    vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
    vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    Object.assign(new Error('Native setup refused'), { executionRunErrorCode: 'execution_run_interaction_unavailable' }),
    Object.assign(new Error('Native setup refused'), { rpcErrorCode: 'RPC_FORBIDDEN' }),
    { code: 'agent_startup_failed', message: 'Native setup refused' },
  ])('preserves the typed cause when bounded Plan provisioning fails', async failure => {
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Unused Voice boundary'); } });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const enqueueMarkerWrite: StartExecutionRunArgs['enqueueMarkerWrite'] = (_runId, write) => write();
    const finishRun: StartExecutionRunArgs['finishRun'] = async (runId, next, toolResult, structuredMeta) => {
      await finishExecutionRun({ runId, next, toolResult, structuredMeta, runs, controllers, budgetRegistry: null,
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, enqueueMarkerWrite,
        terminalMarkerWritePromises: new Map() });
    };
    const expectedCode = 'executionRunErrorCode' in failure ? failure.executionRunErrorCode
      : 'rpcErrorCode' in failure ? failure.rpcErrorCode : failure.code;
    try {
      const started = await startExecutionRun({
        params: { sessionId: 'parent-session', intent: 'plan',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID }, instructions: 'Plan the change.',
          permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' },
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
        // Native startup is the external boundary; admission and settlement remain real.
        createRuntime: () => createTestExecutionRunHostRuntime({ onProvisionRuntime: async () => { throw failure; } }),
        getNowMs: () => 1, budgetRegistry: null, runs, controllers,
        enqueueMarkerWrite, writeActivityMarker: async () => {}, finishRun,
        executeBoundedRun: async () => { throw new Error('Provisioning refusal must not dispatch a native turn'); },
        send: async () => ({ ok: true }), voiceAgentManager,
      });
      await controllers.get(started.runId)?.terminalPromise;
      await vi.waitFor(() => expect(runs.get(started.runId)).toMatchObject({
        status: 'failed', error: { code: expectedCode, message: 'Native setup refused' },
        latestToolResult: { error: { code: expectedCode, message: 'Native setup refused' } },
      }));
      expect(ExecutionRunErrorSchema.parse(runs.get(started.runId)?.error)).toEqual({
        code: expectedCode, message: 'Native setup refused',
      });
    } finally { await voiceAgentManager.dispose(); }
  });
  it.each(['ready', 'unavailable', 'retired'] as const)('admits implicit Review roles through the captured owner catalog (%s)', async catalogStatus => {
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    const ownerUrl = 'http://review-owner-home.test';
    const sessionId = `review-parent-${catalogStatus}`;
    const credentials = bindRequesterSessionCredentialScope({
      token: `header.${Buffer.from(JSON.stringify({ sub: 'review-owner' })).toString('base64url')}.signature`, encryption: null,
    }, { serverId: 'review-owner-home', serverHttpBaseUrl: ownerUrl });
    const previous = getActiveAccountSettingsSnapshot();
    publishEmptyAccountRoleOverrides();
    const focused = getActiveAccountSettingsSnapshot();
    let ownerCurrent = true;
    const paths: string[] = [];
    // Home HTTP and native execution are the only replaced boundaries. The real
    // RPC registration, captured Account holder, catalog loader and role resolver compose here.
    const read = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const address = new URL(String(url));
      expect(address.origin).toBe(ownerUrl);
      expect(options?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
      paths.push(address.pathname);
      if (address.pathname === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (address.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (address.pathname === '/v1/account/entity-rows/prompt-library') {
        if (catalogStatus === 'retired') ownerCurrent = false;
        return catalogStatus === 'unavailable' ? { status: 503, data: {} } : { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
          key, revision: 1, content: { t: 'plain', v: key === 'role-overrides'
            ? { key, value: { v: 1, overrides: { reviewer: { roleId: 'reviewer', instructionsOverride: 'OWNER_REVIEW_INSTRUCTIONS' } } } }
            : emptyPromptLibraryRecordV1(key) },
        })) } };
      }
      if (address.pathname === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (address.pathname === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected Review owner boundary: ${address.pathname}`);
    });
    const admission = vi.spyOn(daemonControlHttp, 'daemonPost').mockResolvedValue({ admitted: true });
    const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'review-machine', serverHttpBaseUrl: ownerUrl,
      readCredentials: async () => ownerCurrent ? credentials : null, isOwnerCurrent: () => ownerCurrent, onSettings: () => {} });
    const handlers = new Map<string, (request: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
    const captured: { manager?: ExecutionRunHostBridge } = {};
    try {
      registerExecutionRunRpcHandlers({ registerHandler: (method, handler) => {
        rpc.registerHandler(method, handler);
        handlers.set(method, (request, context) => rpc.invokeLocal(method, request, context));
      } }, {
        sessionId, cwd: tmpdir(), parentProvider: TEST_BACKEND_ID,
        resolveRunReportPolicy: async () => ({ preset: 'important' }),
        serverId: 'review-owner-home', serverUrl: ownerUrl, sendAcp: async () => {},
        resolveAccountSettings: async () => (await resolver()).settings, resolveAccountSettingsSnapshot: resolver,
        readPromptCredentials: async () => credentials, executionRunProfileCatalog: buildExecutionRunProfileCatalog([], {
          resolveReviewScmScope: input => resolveReviewScmScope({ ...input, registry: createScmBackendRegistry([]) }),
        }),
        onManagerCreated: manager => { captured.manager = manager; },
      });
      const start = handlers.get(SESSION_RPC_METHODS.EXECUTION_RUN_START);
      if (!start || !captured.manager) throw new Error('Missing Review Run registration');
      await captured.manager.recoverRetainedRuns();
      const retainedRunIds = captured.manager.listPublic().map(run => run.runId);
      const response = await start({ intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review the provided design.', modelId: readOfferedSummaryModelId(), modelSelection: null,
        permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' },
        { signal: new AbortController().signal, callerAuthority: 'present_user' });
      if (catalogStatus === 'ready') {
        expect(response).toMatchObject({ runId: expect.any(String) });
        const result = ExecutionRunStartResponseSchema.parse(response);
        expect(captured.manager.get(result.runId)?.instructions).toContain('OWNER_REVIEW_INSTRUCTIONS');
      } else {
        expect(response).toMatchObject({ ok: false, error: 'account_role_overrides_unavailable',
          details: { executionRunStart: { runCreation: 'noRunCreated' } } });
        expect(captured.manager.listPublic().map(run => run.runId)).toEqual(retainedRunIds);
      }
      expect(paths).toContain('/v1/account/entity-rows/prompt-library');
      expect(getActiveAccountSettingsSnapshot()).toBe(focused);
    } finally {
      await captured.manager?.dispose(); await resolver.dispose();
      read.mockRestore(); admission.mockRestore();
      if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
    }
  });
  it.each(['delegate', 'voice_agent'] as const)('prepares the Account Launch Profile for a no-role %s run', async intent => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const nativePrompts: string[] = [];
    let runtime: TestExecutionRunHostRuntime;
    runtime = createTestExecutionRunHostRuntime({ onSendPrompt: async (_runtimeId, prompt) => {
      nativePrompts.push(prompt);
      runtime.emitMessage({ type: 'model-output', fullText: 'READY' });
    }, onWaitForTurnCompletion: async () => {} });
    const createRuntime = () => runtime;
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    const previousSnapshot = getActiveAccountSettingsSnapshot();
    const credentials = bindRequesterSessionCredentialScope({
      token: `header.${Buffer.from(JSON.stringify({ sub: 'persona-owner' })).toString('base64url')}.signature`, encryption: null,
    }, { serverId: configuration.activeServerId, serverHttpBaseUrl: configuration.apiServerUrl });
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'focused', enabled: true, secretBindings: {},
      definition: { kind: 'inline', profile: { v: 2, id: 'focused', name: 'Focused', createdAt: 1, updatedAt: 1 } },
      promptStack: [{ id: 'persona', enabled: true, placement: 'system_append', ref: { kind: 'doc', artifactId: 'persona-doc' } }] });
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    const document = { id: 'persona-doc', ownerAccountId: 'persona-owner', access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Persona' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'PERSONA_INSTRUCTIONS', createdAtMs: 1, updatedAtMs: 1 }) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    // Only Account HTTP and native Agent execution are synthetic; catalog admission,
    // Profile/Artifact opening, prompt composition and Voice preparation remain real.
    const readHeader = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) =>
      artifactReadResponse(body, artifactId => artifactId === document.id ? document : null));
    const read = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path.endsWith('/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path.endsWith('/entity-rows/profiles')) return { status: 200, data: { status: 'listed',
        rows: [{ id: record.id, revision: 1, content: sealProfileRecordContentV1({ mode: 'plain', material: null, record }) }],
        nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } } };
      if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 1 } };
      if (path.endsWith('/transfer')) return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (path === '/v1/artifacts') return { status: 200, data: artifactKindListResponse([]) };
      if (path === '/v1/artifacts/persona-doc') return { status: 200, data: document };
      throw new Error(`Unexpected Launch Profile read: ${path}`);
    });
    try {
      const started = await startExecutionRun({
        params: { sessionId: 'parent_session_1', intent, launchProfileId: 'focused',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, instructions: 'PERSONA_RUN_TASK',
          accountSettings: {}, promptCredentials: credentials,
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
          ioMode: intent === 'voice_agent' ? 'streaming' : 'request_response',
          ...(intent === 'voice_agent' ? { bootstrapMode: 'ready_handshake' as const } : {}),
        },
        parentProvider: 'codex', sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime, getNowMs: () => 1, budgetRegistry: null, runs, controllers,
        enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {}, finishRun: async () => {},
        executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      });
      const run = runs.get(started.runId);
      expect(run?.launchProfileId).toBe('focused');
      expect(run?.instructions).toContain('PERSONA_INSTRUCTIONS');
      expect(run?.instructions).toContain('PERSONA_RUN_TASK');
      expect(run?.profileSourceCustody).toBeUndefined();
      if (intent === 'voice_agent') {
        expect(nativePrompts.join('\n')).toContain('PERSONA_INSTRUCTIONS');
        expect(nativePrompts.join('\n')).toContain('PERSONA_RUN_TASK');
      }
    } finally {
      read.mockRestore(); readHeader.mockRestore();
      if (previousSnapshot) setActiveAccountSettingsSnapshot(previousSnapshot);
      else clearActiveAccountSettingsSnapshot();
      await Promise.all([...controllers.values()].flatMap(controller => controller.kind === 'backend' ? [controller.backend.dispose()] : []));
      await voiceAgentManager.dispose();
    }
  });
  it.each(['builder'])('inherits Session memory for a delegate with role %s without copying lead instructions', async roleId => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const createRuntime = () => createProvisioningRuntime();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    const selection = roleId ? resolveRoleSelectionV1({ roleId, defaultEngine: { agentTargetKey: 'agent:happier.agent.codex/codex' } }) : null;
    if (selection && !selection.ok) throw new Error('Fixture role must resolve');
    const readHeader = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe('/v1/artifacts/read');
      expect(ArtifactReadHeadersBatchInputV1Schema.parse(body)).toEqual({ artifactIds: ['lead-memory'], projection: 'headers' });
      return { status: 200, data: ArtifactReadHeadersBatchResponseV1Schema.parse({ projection: 'headers', items: [{
        artifactId: 'lead-memory', ok: true, artifact: { id: 'lead-memory', ownerAccountId: 'context-owner', access: 'owner',
          encryptionMode: 'plain', header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }),
          publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 },
      }] }) };
    });
    const read = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (String(url).endsWith('/v1/artifacts/lead-memory')) return { status: 200, data: {
        id: 'lead-memory', ownerAccountId: 'context-owner', access: 'owner', encryptionMode: 'plain', header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, index: [{ id: 'fact', text: 'Use the canonical Context owner.', createdAtMs: 1, sourceSessionRef: null }], topics: [] }) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      } };
      throw new Error(`Unexpected delegate Context read: ${url}`);
    });
    try {
      const started = await startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'delegate',
          ...(roleId && selection?.ok ? { roleId, resolvedRole: selection.selection } : {}),
          promptCredentials: bindRequesterSessionCredentialScope({
            token: `header.${Buffer.from(JSON.stringify({ sub: 'context-owner' })).toString('base64url')}.signature`, encryption: null,
          }, { serverId: configuration.activeServerId, serverHttpBaseUrl: configuration.apiServerUrl }),
          roleSessionMetadata: { work: { memoryEnabled: true, promptStack: [
            { id: 'session.instructions', ref: { kind: 'doc', artifactId: 'lead-instructions' }, enabled: true, placement: 'system_append' },
            { id: 'session.memory', ref: { kind: 'doc', artifactId: 'lead-memory' }, enabled: true, placement: 'system_append' },
          ] } },
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID }, instructions: 'Implement the requested change.',
          accountSettings: {}, permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' },
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime, getNowMs: () => 1, budgetRegistry: null, runs, controllers,
        enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {}, finishRun: async () => {},
        executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      });
      expect(runs.get(started.runId)?.instructions).toContain('Use the canonical Context owner.');
      expect(runs.get(started.runId)?.instructions).not.toContain('lead-instructions');
    } finally {
      read.mockRestore(); readHeader.mockRestore();
      await Promise.all([...controllers.values()].flatMap(controller => controller.kind === 'backend' ? [controller.backend.dispose()] : []));
      await voiceAgentManager.dispose();
    }
  });
  it.each(['absent', 'different', 'unqualified_owner', 'owner_unavailable', 'reader_unavailable', 'home_unavailable'] as const)(
    'binds no-role delegate Context to the Session owner through registered RPC (%s ambient/owner)', async scenario => {
      const taskHome = await mkdtemp(join(tmpdir(), 'happier-delegate-context-'));
      vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
      vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
      reloadConfiguration();
      const tokenFor = (accountId: string) => `header.${Buffer.from(JSON.stringify({ sub: accountId, session: 'context-terminal' })).toString('base64url')}.signature`;
      const ownerUnavailable = scenario === 'owner_unavailable' || scenario === 'reader_unavailable' || scenario === 'home_unavailable';
      const ownerToken = tokenFor('context-owner');
      const ownerHome = ownerUnavailable ? configuration.activeServerId : 'captured-session-home';
      const ownerUrl = ownerUnavailable ? normalizeServerHttpBaseUrl(configuration.apiServerUrl) : 'http://captured-session-home.test';
      const credentials = scenario === 'unqualified_owner' || scenario === 'home_unavailable' ? { token: ownerToken, encryption: null }
        : bindRequesterSessionCredentialScope({ token: ownerToken, encryption: null }, {
          serverId: ownerHome, serverHttpBaseUrl: ownerUrl,
        });
      if (scenario !== 'absent') await writeCredentialsTokenOnly({ token: scenario === 'different' ? tokenFor('ambient-account') : ownerToken });
      expect((await readStoredCredentials())?.token ?? null).toBe(scenario === 'absent' ? null : scenario === 'different' ? tokenFor('ambient-account') : ownerToken);
      const memoryEntry = { id: 'session.memory', ref: { kind: 'doc' as const, artifactId: 'lead-memory', serverId: ownerHome },
        enabled: true, placement: 'system_append' as const };
      const metadata = createTestMetadata({ work: { memoryEnabled: true, promptStack: [
        { ...memoryEntry, id: 'session.instructions', ref: { kind: 'doc', artifactId: 'lead-instructions', serverId: ownerHome } },
        memoryEntry,
      ] } });
      const captured: { manager?: ExecutionRunHostBridge } = {};
      const handlers = new Map<string, (request: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
      const rpc = new RpcHandlerManager({ scopePrefix: 'parent_session_1', encryptionMode: 'plain' });
      const admission = vi.spyOn(daemonControlHttp, 'daemonPost').mockImplementation(async path => {
        if (path !== '/execution-run/admission') throw new Error(`Unexpected daemon effect: ${path}`);
        return { admitted: true };
      });
      const document = (id: string, kind: string, body: string | null) => ({ id, ownerAccountId: 'context-owner', access: 'owner',
        encryptionMode: 'plain', header: encodePlainArtifactStoredContent({ v: 1, kind, title: id }), body,
        publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      const readHeader = vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
        const address = new URL(String(url));
        expect(address.origin).toBe(new URL(ownerUrl).origin);
        expect(address.pathname).toBe('/v1/artifacts/read');
        expect(options?.headers?.Authorization).toBe(`Bearer ${ownerToken}`);
        expect(ArtifactReadHeadersBatchInputV1Schema.parse(body)).toEqual({ artifactIds: ['lead-memory'], projection: 'headers' });
        const { body: _body, ...header } = document('lead-memory', 'memory_doc.v1', null);
        return { status: 200, data: ArtifactReadHeadersBatchResponseV1Schema.parse({
          projection: 'headers', items: [{ artifactId: header.id, ok: true, artifact: header }],
        }) };
      });
      const read = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        const address = new URL(String(url));
        expect(address.origin).toBe(new URL(ownerUrl).origin);
        expect(options?.headers?.Authorization).toBe(`Bearer ${ownerToken}`);
        if (address.pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (address.pathname === '/v1/artifacts/lead-memory') return { status: 200, data: document('lead-memory', 'memory_doc.v1',
          encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, index: [
            { id: 'fact', text: 'Use the canonical Context owner.', createdAtMs: 1, sourceSessionRef: null },
          ], topics: [] }) })) };
        throw new Error(`Unexpected delegate Context read: ${address.pathname}`);
      });
      try {
        registerExecutionRunRpcHandlers({ registerHandler: (method, handler) => {
          rpc.registerHandler(method, handler);
          handlers.set(method, (request, context) => rpc.invokeLocal(method, request, context));
        } }, {
          sessionId: 'parent_session_1', cwd: taskHome, parentProvider: TEST_BACKEND_ID,
          resolveRunReportPolicy: async () => ({ preset: 'important' }),
          ...(scenario === 'home_unavailable' ? {} : { serverId: ownerHome, serverUrl: ownerUrl }),
          resolveAccountSettings: () => ({}), sendAcp: async () => {},
          ...(scenario === 'reader_unavailable' ? {} : { readPromptCredentials: async () => scenario === 'owner_unavailable' ? null : credentials }),
          executionRunProfileCatalog: buildExecutionRunProfileCatalog(), onManagerCreated: manager => { captured.manager = manager; },
          sessionInteractionHost: { session: {
            sessionId: 'parent_session_1', getMetadataSnapshot: () => metadata, updateMetadata: async () => {}, updateAgentState: async () => {},
            enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: false }),
          }, machineId: 'context-machine', permissionHandler: { handleToolCall: async () => { throw new Error('Unexpected tool permission request'); } } },
        });
        const start = handlers.get(SESSION_RPC_METHODS.EXECUTION_RUN_START);
        if (!start || !captured.manager) throw new Error('Execution Run RPC was not registered');
        const response = await start({ intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID }, instructions: 'Implement the requested change.',
          modelId: 'context-model', modelSelection: null,
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' },
          { signal: new AbortController().signal, callerAuthority: 'present_user' });
        if (ownerUnavailable) {
          expect(read.mock.calls).toEqual([]);
          expect(readHeader.mock.calls).toEqual([]);
          expect(response).toMatchObject({ ok: false, error: 'context_source_unavailable', details: { executionRunStart: { runCreation: 'noRunCreated' } } });
          expect(captured.manager.listPublic()).toEqual([]);
          await expect(prepareSessionMemoryInheritance({ metadata })).rejects.toMatchObject({ code: 'context_source_unavailable' });
        } else {
          expect(response).toMatchObject({ runId: expect.any(String) });
          const result = ExecutionRunStartResponseSchema.parse(response);
          const run = captured.manager.get(result.runId);
          expect(run?.instructions).toContain('Use the canonical Context owner.');
          expect(run?.instructions).not.toContain('lead-instructions');
          expect(read.mock.calls.some(([url]) => new URL(String(url)).pathname === '/v1/artifacts/lead-memory')).toBe(true);
        }
        // Birth preparation still returns references only; owner material is
        // unnecessary when there are no candidate inherited documents.
        await expect(prepareSessionMemoryInheritance({ metadata: { work: { memoryEnabled: false, promptStack: [
          { ...memoryEntry, id: 'session.instructions' },
        ] } } }))
          .resolves.toEqual({ memoryEnabled: false, promptStack: [] });
      } finally {
        await captured.manager?.dispose();
        read.mockRestore(); readHeader.mockRestore(); admission.mockRestore();
        vi.unstubAllEnvs(); reloadConfiguration();
        await removeTempDir(taskHome);
      }
    },
  );
  it('keeps the connected account action-required reason across the Voice Run runtime factory', async () => {
    const { ConnectedServiceSpawnProfileActionRequiredError } = await import('@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn');
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const createRuntime = () => { throw new ConnectedServiceSpawnProfileActionRequiredError({
      serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', status: 'needs_reauth',
    }); };
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    const selection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'voice-chat' };
    let terminalError: ExecutionRunState['error'];
    try {
      await startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          modelSelection: selection, connectedServices: null, intentInput: { commitModelSelection: selection },
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', bootstrapMode: 'none' },
        parentProvider: 'codex', sendAcp: async () => {}, streamedTranscriptSession: null, createRuntime,
        getNowMs: () => 1, budgetRegistry: null, runs, controllers, enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {}, finishRun: async (_id, patch) => { terminalError = patch.error; },
        executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      }).catch(() => undefined);
      await vi.waitFor(() => expect(terminalError).toMatchObject({ code: 'connected_service_credential_reconnect_required', uxDiagnostic: {
        serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', retryable: false,
      } }));
    } finally { await voiceAgentManager.dispose(); }
  });

  it.each([true, false])('joins parent startup only for an omitted Voice role (explicit commit: %s)', async explicitCommit => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const createRuntime = () => createProvisioningRuntime();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    const backendTarget = { kind: 'builtInAgent', agentId: 'codex' } as const;
    const chatSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'voice-chat' };
    const commitSelection = { ...chatSelection, modelId: 'voice-commit' };
    let releaseInstallation!: () => void;
    const installation = new Promise<void>(resolve => { releaseInstallation = resolve; });
    const startupWaits: boolean[] = [];
    const starting = startExecutionRun({
      params: { sessionId: 'parent_session_1', intent: 'voice_agent', backendTarget,
        modelSelection: chatSelection, ...(explicitCommit ? { intentInput: { commitModelSelection: commitSelection } } : {}),
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        bootstrapMode: 'none' },
      childSelectionContext: { lifecycle: 'attached', readAppliedParentSelection: async options => {
        startupWaits.push(options?.waitForReady === true);
        if (explicitCommit) throw new Error('Complete explicit Voice choices must never read parent startup');
        if (!options?.waitForReady) return { status: 'unavailable' };
        // Applied native parent configuration is an external runtime fact.
        await installation;
        return { status: 'applied', backendTarget, modelId: 'parent-model', connectedServices: null };
      } },
      parentProvider: 'codex', sendAcp: async () => {}, streamedTranscriptSession: null, createRuntime,
      getNowMs: () => 1, budgetRegistry: null, runs, controllers, enqueueMarkerWrite: async () => {},
      writeActivityMarker: async () => {}, finishRun: async () => {}, executeBoundedRun: async () => {},
      send: async () => ({ ok: true }), voiceAgentManager,
    });
    try {
      if (!explicitCommit) {
        await vi.waitFor(() => expect(startupWaits).toEqual([true]));
        expect(runs.size).toBe(0);
        releaseInstallation();
      }
      const started = await starting;
      expect(startupWaits).toEqual(explicitCommit ? [] : [true]);
      expect(runs.get(started.runId)?.voiceAgentConfig).toMatchObject({
        chatModelId: 'voice-chat', commitModelId: explicitCommit ? 'voice-commit' : 'parent-model',
      });
    } finally {
      releaseInstallation();
      await starting.catch(() => undefined);
      await voiceAgentManager.dispose();
    }
  });

  it('refuses unsupported inherited Team Voice custody before publishing a Run', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const createRuntime = () => createProvisioningRuntime();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    try {
      await expect(startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' },
        childSelectionContext: { lifecycle: 'attached', readAppliedParentSelection: () => ({
          status: 'applied', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, modelId: 'team-model', connectedServices: null,
          teamCredentialModel: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
            expectedResourceRevision: 2, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model', deliveryMode: 'brokered' },
        }) },
        parentProvider: 'codex', sendAcp: async () => {}, streamedTranscriptSession: null, createRuntime,
        getNowMs: () => 1, budgetRegistry: null, runs, controllers, enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {}, finishRun: async () => {}, executeBoundedRun: async () => {},
        send: async () => ({ ok: true }), voiceAgentManager,
      })).rejects.toMatchObject({ code: 'execution_run_child_choice_required' });
      expect(runs.size).toBe(0);
    } finally { await voiceAgentManager.dispose(); }
  });
  it('admits an attached child from applied parent route and retains it independently of later parent changes', async () => {
    const markerDirectory = await mkdtemp(join(tmpdir(), 'happier-child-summary-'));
    vi.stubEnv('HAPPIER_HOME_DIR', markerDirectory);
    reloadConfiguration();
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const createRuntime = () => createProvisioningRuntime();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    const applied = {
      status: 'applied' as const,
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
      modelId: 'parent-model',
      modelSelection: ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'parent-provider', modelId: 'parent-model' }),
      connectedServices: null,
    };
    try {
      const started = await startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'delegate', backendTarget: applied.backendTarget,
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' },
        childSelectionContext: { lifecycle: 'attached', readAppliedParentSelection: () => applied },
        parentProvider: 'claude', sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime, getNowMs: () => 1, budgetRegistry: null, runs, controllers,
        enqueueMarkerWrite: async (_runId, write) => write(), writeActivityMarker: async () => {}, finishRun: async () => {},
        executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      });
      const retained = projectRetainedExecutionRunState(runs.get(started.runId)!);
      applied.modelId = 'later-parent-model';
      applied.modelSelection = ProviderBoundModelRefSchema.parse({ ...applied.modelSelection, providerConnectionId: 'later-parent-provider', modelId: 'later-parent-model' });
      expect(retained.launch).toMatchObject({
        modelId: 'parent-model', selectionSource: 'inherited', connectedServicesSelection: null,
        modelSelection: { providerConnectionId: 'parent-provider', modelId: 'parent-model' },
      });
      expect(projectExecutionRunPublicState(runs.get(started.runId)!)).toMatchObject({
        resolvedSelection: { source: 'inherited', modelId: 'parent-model', modelSelection: { providerConnectionId: 'parent-provider' } },
      });
      const resolvedSelection = projectExecutionRunPublicState(runs.get(started.runId)!).resolvedSelection;
      expect.soft((await listExecutionRunMarkers()).find((marker) => marker.runId === started.runId))
        .toHaveProperty('resolvedSelection', resolvedSelection);
      await finishExecutionRun({ runId: started.runId, next: { status: 'succeeded', finishedAtMs: 2 },
        toolResult: { output: 'complete' }, runs, controllers, budgetRegistry: null, parentProvider: 'claude',
        sendAcp: async () => {}, enqueueMarkerWrite: async (_runId, write) => write(), terminalMarkerWritePromises: new Map() });
      expect((await listExecutionRunMarkers()).find((marker) => marker.runId === started.runId))
        .toMatchObject({ status: 'succeeded', resolvedSelection });
    } finally {
      await Promise.all([...controllers.values()].flatMap((controller) => controller.kind === 'backend' ? [controller.backend.dispose()] : []));
      await voiceAgentManager.dispose();
      vi.unstubAllEnvs();
      reloadConfiguration();
      await removeTempDir(markerDirectory);
    }
  });

  it('refuses attached omission when applied parent state is unavailable before creating or materializing a run', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('unused'); } });
    try {
      await expect(startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' },
        childSelectionContext: { lifecycle: 'attached', readAppliedParentSelection: () => ({ status: 'unavailable' }) },
        parentProvider: 'claude', sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: () => { throw new Error('Materialization reached'); }, getNowMs: () => 1, budgetRegistry: null,
        runs, controllers: new Map(), enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {},
        finishRun: async () => {}, executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      })).rejects.toMatchObject({ code: 'execution_run_parent_selection_unavailable' });
      expect(runs.size).toBe(0);
    } finally { await voiceAgentManager.dispose(); }
  });
  it.each(['ephemeral', 'resumable'] as const)('publishes provisioning, idle, active and resumed work for a %s backend handle', async (retentionPolicy) => {
    let releaseProvision!: () => void;
    let releaseTurn!: () => void;
    const provisionGate = new Promise<void>((resolve) => { releaseProvision = resolve; });
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const publicStates: Array<Readonly<{ status: string; turnInFlight?: boolean }>> = [];
    const runtimes: TestExecutionRunHostRuntime[] = [];
    const createRuntime = () => {
      const runtime = createTestExecutionRunHostRuntime({
        replayResumeSupported: true, providerSessionId: 'retained-vendor-session',
        onProvisionRuntime: async (options) => { if (!options?.resumeRuntimeId) await provisionGate; },
        onWaitForTurnCompletion: async () => { await turnGate; },
      });
      runtimes.push(runtime);
      return runtime;
    };
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    const common = {
      parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
      createRuntime, getNowMs: () => 1, budgetRegistry: null, runs, controllers,
      writeActivityMarker: async () => {},
      onPublicStateUpdated: (id: string) => publicStates.push(projectExecutionRunPublicState(runs.get(id)!, controllers.get(id) ?? null)),
    };
    try {
      const started = await startExecutionRun({ ...common,
        params: { sessionId: 'parent_session_1', intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          permissionMode: 'read_only', retentionPolicy, runClass: 'long_lived', ioMode: 'streaming' },
        enqueueMarkerWrite: async () => {}, finishRun: async () => {}, executeBoundedRun: async () => {},
        send: async () => ({ ok: true }), voiceAgentManager,
      });
      expect.soft(projectExecutionRunPublicState(runs.get(started.runId)!, controllers.get(started.runId))).not.toHaveProperty('turnInFlight');
      releaseProvision();
      const controller = controllers.get(started.runId);
      if (controller?.kind !== 'backend') throw new Error('Expected backend controller');
      await controller.provisioningPromise;
      expect(publicStates.at(-1)).toMatchObject({ status: 'running', turnInFlight: false });
      expect(await sendBackendLongLivedRun({ ...common, runId: started.runId, params: { message: 'continue' },
        maxTurns: null, finishRun: async () => {} })).toEqual({ ok: true });
      expect.soft(publicStates.at(-1)).toMatchObject({ status: 'running', turnInFlight: true });
      releaseTurn();
      await vi.waitFor(() => expect(publicStates.at(-1)).toMatchObject({ status: 'running', turnInFlight: false }));
      expect(runs.get(started.runId)?.status).toBe('running');
      expect(await stopExecutionRun({ runId: started.runId, runs, controllers, getNowMs: common.getNowMs, voiceAgentManager,
        finishRun: async (id, next) => { runs.set(id, { ...runs.get(id)!, ...next }); },
        onPublicStateUpdated: common.onPublicStateUpdated })).toEqual({ ok: true });
      expect(publicStates.at(-1)?.status).toBe('cancelled');
      if (retentionPolicy === 'resumable') {
        expect(await resumeBackendControllerForResumableRun({ ...common, runId: started.runId,
          run: runs.get(started.runId)!, requireReplayCapture: true })).toEqual({ ok: true });
        expect(publicStates.at(-1)).toMatchObject({ status: 'running', turnInFlight: false });
      }
    } finally {
      releaseProvision(); releaseTurn(); await Promise.all(runtimes.map((runtime) => runtime.dispose())); await voiceAgentManager.dispose();
    }
  });

  it('retains an admitted Workflow origin through host loss and public terminal observation', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const workflowScope = { actionRequestId: 'origin-workflow/invocation-1/0', invocationId: 'invocation-1',
      sessions: [{ serverId: 'home', sessionId: 'parent_session_1' }] };
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('unused'); } });
    try {
      const started = await startExecutionRun({
        params: { sessionId: 'parent_session_1', workflowRunId: 'origin-workflow', workflowScope, intent: 'task',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID }, instructions: 'Continue.',
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' },
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: () => createProvisioningRuntime(), getNowMs: () => 1, budgetRegistry: null,
        runs, controllers, enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {},
        finishRun: async () => {}, executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      });
      const retained = projectRetainedExecutionRunState(runs.get(started.runId)!);
      expect(controllers.get(started.runId)).toMatchObject({ workflowRunId: 'origin-workflow', workflowScope });
      expect(retained).not.toHaveProperty('workflowScope');
      const terminal = projectExecutionRunHostLoss({ ownerPid: 1, state: retained }, 2);
      expect(projectExecutionRunPublicState(terminal.state)).toMatchObject({
        runId: started.runId, status: 'failed', originWorkflowRunId: 'origin-workflow',
      });
      expect(projectExecutionRunPublicState(terminal.state)).not.toHaveProperty('workflowScope');
    } finally { await voiceAgentManager.dispose(); }
  });
  it.each(['unavailable', 'ready'] as const)('refuses a role start without an admitted snapshot before creating a run (Account %s)', async accountAuthority => {
    const previous = getActiveAccountSettingsSnapshot();
    clearActiveAccountSettingsSnapshot();
    if (accountAuthority === 'ready') publishEmptyAccountRoleOverrides();
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('unused'); } });
    try {
      await expect(startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'task', roleId: 'second_opinion',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID }, instructions: 'Assess this change.',
          accountSettings: {}, permissionMode: 'yolo', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' },
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: () => { throw new Error('Runtime must not be reached before admission'); },
        getNowMs: () => 1, budgetRegistry: null, runs, controllers: new Map(),
        enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {}, finishRun: async () => {},
        executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      })).rejects.toMatchObject({ code: accountAuthority === 'ready' ? 'target_unavailable' : 'account_role_overrides_unavailable',
        details: { executionRunStart: { runCreation: 'noRunCreated', ...(accountAuthority === 'ready' ? { refusal: {
          code: 'agent_start_context_unavailable', phase: 'agent_start_context',
        } } : {}) } } });
      expect(runs.size).toBe(0);
    } finally {
      await voiceAgentManager.dispose();
      if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
    }
  });

  it('starts Second opinion with its canonical role plan, read-only ceiling and strict verdict contract', async () => {
    const role = resolveRoleSelectionV1({ roleId: 'second_opinion', defaultEngine: { agentTargetKey: 'agent:happier.agent.codex/codex' } });
    if (!role.ok) throw new Error('Fixture role must resolve');
    const runs = new Map<string, ExecutionRunState>();
    const createRuntime = vi.fn<StartExecutionRunArgs['createRuntime']>(() => createProvisioningRuntime());
    const executeBoundedRun = vi.fn<StartExecutionRunArgs['executeBoundedRun']>(async () => {});
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('unused'); } });
    try {
      const started = await startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'task', roleId: 'second_opinion', resolvedRole: role.selection,
          promptCredentials: { token: 'synthetic-account-token', encryption: null },
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID }, instructions: 'Assess this change.',
          cwd: tmpdir(), accountSettings: {}, permissionMode: 'yolo', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' },
        resolveAccountSettingsSnapshot: async () => { throw new Error('An accepted Role must not demand later Account authority'); },
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime, getNowMs: () => 1, budgetRegistry: null, runs, controllers: new Map(),
        enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {}, finishRun: async () => {}, executeBoundedRun,
        send: async () => ({ ok: true }), voiceAgentManager,
      });
      const run = runs.get(started.runId)!;
      expect(run.instructions).toContain(BUILT_IN_ROLES_V1.second_opinion.instructions);
      expect(run.instructions).toContain('<happier_role');
      expect(run.instructions.match(/<happier_role\b/g)).toHaveLength(1);
      expect(run.instructions).toContain('Assess this change.');
      expect(run.intentInput).toMatchObject({ input: { question: 'Assess this change.', changeFingerprint: null,
        diff: null, diffUnavailable: 'scm_unavailable', transcriptPointer: { sessionId: 'parent_session_1' } } });
      await vi.waitFor(() => expect(createRuntime.mock.calls[0]?.[0]).toMatchObject({ workspaceWrites: 'deny' }));
      expect(createRuntime.mock.calls[0]?.[0].start).not.toHaveProperty('promptCredentials');
      expect(createRuntime.mock.calls[0]?.[0].start).not.toHaveProperty('resolvedRole');
      await vi.waitFor(() => expect(executeBoundedRun.mock.calls[0]?.[0].params).toBeDefined());
      expect(executeBoundedRun.mock.calls[0]?.[0].params).not.toHaveProperty('promptCredentials');
      const start = { ...run, instructions: run.instructions, backendTarget: run.backendTarget, startedAtMs: 1 };
      const verdict = { verdict: 'uncertain', confidence: 0.6, risks: [{ title: 'Untested path', severity: 'high', evidence: 'Missing integration check' }], missingEvidence: ['Runtime check'], nextStep: 'Validate' };
      expect(TaskProfile.onBoundedComplete({ start, rawText: JSON.stringify(verdict), finishedAtMs: 2 }))
        .toMatchObject({ status: 'succeeded', toolResultOutput: verdict });
      expect(TaskProfile.onBoundedComplete({ start, rawText: '{"verdict":"agree"}', finishedAtMs: 2 }))
        .toMatchObject({ status: 'failed' });
    } finally { await voiceAgentManager.dispose(); }
  });

  it.each([
    ['review', 'bounded', undefined, true],
    ['plan', 'bounded', undefined, true],
    ['delegate', 'bounded', undefined, true],
    ['agent', 'long_lived', undefined, false],
    ['delegate', 'long_lived', undefined, false],
    ['review', 'bounded', false, false],
    ['agent', 'long_lived', true, true],
  ] as const)('resolves report defaults for %s/%s with override %s', async (intent, runClass, notifyParentOnCompletion, expected) => {
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => { throw new Error('voice runtime is unused'); },
    });
    if (intent === 'review') publishEmptyAccountRoleOverrides();
    try {
      const result = await startExecutionRun({
        params: {
          sessionId: 'parent_session_1', intent, runClass, notifyParentOnCompletion,
          backendTarget: { kind: 'builtInAgent', agentId: intent === 'review' ? 'claude' : TEST_BACKEND_ID },
          ...(intent === 'review' ? { modelId: readOfferedSummaryModelId(), modelSelection: null } : {}),
          instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', ioMode: 'request_response',
          accountSettings: { executionRunsNotifyParentOnCompletionDefault: false },
        },
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: createProvisioningRuntime, getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null, runs, controllers: new Map(), enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {}, finishRun: async () => {}, executeBoundedRun: async () => {},
        send: async () => ({ ok: true }), voiceAgentManager,
      });
      expect(runs.get(result.runId)?.notifyParentOnCompletion).toBe(expected);
    } finally {
      await voiceAgentManager.dispose();
      if (intent === 'review') clearActiveAccountSettingsSnapshot();
    }
  });

  it('keeps admitted absolute depth and never derives depth from caller-supplied parent refs', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => { throw new Error('voice runtime is unused'); },
    });
    const args = {
      params: {
        sessionId: null,
        intent: 'agent' as const,
        backendTarget: { kind: 'builtInAgent' as const, agentId: TEST_BACKEND_ID },
        instructions: '',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable' as const,
        runClass: 'long_lived' as const,
        ioMode: 'request_response' as const,
        workDepth: 4,
      },
      parentProvider: TEST_BACKEND_ID,
      sendAcp: async () => {},
      streamedTranscriptSession: null,
      createRuntime: () => createProvisioningRuntime(),
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry: null,
      runs,
      controllers,
      enqueueMarkerWrite: async () => {},
      writeActivityMarker: async () => {},
      finishRun: async () => { throw new Error('empty initial input does not settle the run'); },
      executeBoundedRun: async () => { throw new Error('long-lived creation does not execute a bounded run'); },
      send: async () => { throw new Error('empty initial input does not send a prompt'); },
      voiceAgentManager,
    } satisfies StartExecutionRunArgs;
    try {
      const admitted = await startExecutionRun(args);
      expect(runs.get(admitted.runId)?.depth).toBe(4);
      const human = await startExecutionRun({
        ...args,
        params: { ...args.params, workDepth: undefined, parentRunId: admitted.runId, parentCallId: admitted.callId },
      });
      expect(runs.get(human.runId)?.depth).toBe(0);
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it.each([
    SESSION_RPC_METHODS.EXECUTION_RUN_START,
    SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
  ])('ignores caller retry identity through the registered %s Action/RPC path', async method => {
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    const sessionId = `public-run-identity-${method}`;
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
    const captured: { manager?: ExecutionRunHostBridge } = {};
    // Only daemon admission and native Agent execution are replaced. Registration,
    // both public schemas, the Action executor and Run allocation remain real.
    const admission = vi.spyOn(daemonControlHttp, 'daemonPost').mockResolvedValue({ admitted: true });
    const registration = registerExecutionRunRpcHandlers(rpc, {
      sessionId, cwd: tmpdir(), parentProvider: TEST_BACKEND_ID, sendAcp: async () => {},
      resolveRunReportPolicy: async () => ({ preset: 'important' }),
      resolveAccountSettings: async () => ({}),
      executionRunProfileCatalog: buildExecutionRunProfileCatalog(),
      onManagerCreated: manager => { captured.manager = manager; },
    });
    const start = async (instructions: string, actionRequestId: string) => {
      const input = {
        intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions, modelSelection: null, permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
        actionRequestId: 'caller-selected-host-key',
      };
      const response = await rpc.invokeLocal(method,
        method === SESSION_RPC_METHODS.EXECUTION_RUN_START ? input : { start: input }, {
          signal: new AbortController().signal,
          localActionContext: { authority: 'present_user', actionRequestId },
        });
      return ExecutionRunStartResponseSchema.parse(response);
    };
    try {
      const first = await start('First execution.', 'public-action-1');
      const second = await start('Second execution.', 'public-action-2');
      expect(second.runId).not.toBe(first.runId);
      expect(second.callId).not.toBe(first.callId);
      expect(captured.manager?.get(first.runId)?.instructions).toBe('First execution.');
      expect(captured.manager?.get(second.runId)?.instructions).toBe('Second execution.');
    } finally {
      registration.dispose();
      await captured.manager?.dispose();
      admission.mockRestore();
    }
  });

  it.each(['sequential', 'overlapping'] as const)('rejoins %s starts for one host-stamped Action request without repeating start effects', async timing => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const runtime = createProvisioningRuntime();
    const createRuntime = vi.fn<StartExecutionRunArgs['createRuntime']>(() => runtime);
    const enqueueMarkerWrite = vi.fn(async () => {});
    const sendAcp = vi.fn(async () => {});
    const send = vi.fn(async () => ({ ok: true as const }));
    const occurrences: ExecutionRunController[] = [];
    let admissionCalls = 0;
    let releaseFinalAdmission!: () => void;
    const finalAdmission = new Promise<void>(resolve => { releaseFinalAdmission = resolve; });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by agent runs');
      },
    });
    const args = {
      params: {
        sessionId: null,
        actionRequestId: 'workflow-input-v2:stable:execution-run-start',
        allowedTools: ['mcp__wilson-brief__*'],
        unlistedTools: 'deny' as const,
        intent: 'agent' as const,
        backendTarget: { kind: 'builtInAgent' as const, agentId: TEST_BACKEND_ID },
        instructions: 'Implement once.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable' as const,
        runClass: 'long_lived' as const,
        ioMode: 'request_response' as const,
      },
      parentProvider: TEST_BACKEND_ID,
      sendAcp,
      streamedTranscriptSession: null,
      createRuntime,
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry: null,
      runs,
      controllers,
      enqueueMarkerWrite,
      writeActivityMarker: async () => {},
      finishRun: async () => {},
      executeBoundedRun: async () => {},
      send,
      voiceAgentManager,
      registerRunOccurrence: ({ controller }) => { occurrences.push(controller); return () => {}; },
      admitStart: async () => {
        if (timing !== 'overlapping') return;
        admissionCalls += 1;
        if (admissionCalls < 3) return;
        if (admissionCalls === 4) releaseFinalAdmission();
        await finalAdmission;
      },
    } satisfies StartExecutionRunArgs;

    try {
      const [first, second] = timing === 'overlapping'
        ? await Promise.all([startExecutionRun(args), startExecutionRun(args)])
        : [await startExecutionRun(args), await startExecutionRun(args)];
      await Promise.all(occurrences.map(controller => controller.kind === 'backend' ? controller.provisioningPromise : undefined));

      expect(second).toEqual(first);
      expect(first.runId).toMatch(/^run_request_/);
      expect(runs.size).toBe(1);
      expect(controllers.size).toBe(1);
      expect(occurrences).toHaveLength(1);
      expect(runs.get(first.runId)).toMatchObject({ callId: first.callId, sidechainId: first.sidechainId });
      expect(projectRetainedExecutionRunState(runs.get(first.runId)!).launch)
        .toMatchObject({ allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny' });
      expect(createRuntime.mock.calls[0]?.[0]).toMatchObject({ start: {
        allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny',
      } });
      expect(createRuntime).toHaveBeenCalledTimes(1);
      expect(enqueueMarkerWrite).toHaveBeenCalledTimes(1);
      expect(sendAcp).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      releaseFinalAdmission();
      await runtime.dispose();
      await voiceAgentManager.dispose();
    }
  });

  it('rejects failed Saved Secret admission before every Run creation effect', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const enqueueMarkerWrite = vi.fn(async () => {});
    const sendAcp = vi.fn(async () => {});
    const createRuntime = vi.fn(() => createProvisioningRuntime());
    const onPublicStateUpdated = vi.fn();
    const finishRun = vi.fn(async () => {});
    const budgetRegistry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null });
    let preparing!: () => void;
    let releasePreparation!: () => void;
    const enteredPreparation = new Promise<void>(resolve => { preparing = resolve; });
    const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by delegate runs');
      },
    });

    try {
      const rejected = expect(startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          instructions: 'Use the selected shared credential.',
          secretReferenceOverlay: {
            v: 1,
            bindings: {
              ANTHROPIC_API_KEY: {
                ref: 'happier:shared-secret:v1:shared-key',
                revision: 6,
              },
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp,
        streamedTranscriptSession: null,
        createRuntime,
        admitSecretReferenceOverlay: async () => {
          // The Saved Secret service is the credential/network boundary; all
          // admission and budget custody beneath it remains the real owner.
          preparing();
          await preparation;
          throw Object.assign(new Error('Saved Secret reference changed'), {
            code: 'provider_binding_changed',
          });
        },
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry,
        runs,
        controllers,
        enqueueMarkerWrite,
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
        onPublicStateUpdated,
      })).rejects.toMatchObject({
        code: 'provider_binding_changed',
        details: {
          executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        },
      });

      await enteredPreparation;
      expect(runs.size).toBe(0);
      expect(budgetRegistry.getLiveWorkProducer().read()).toMatchObject({ items: [{ category: 'execution_run', state: 'active' }] });
      expect(budgetRegistry.getInFlightSnapshot()).toEqual({ executionRuns: 0, oneShotTasks: 0 });
      releasePreparation();
      await rejected;
      expect(budgetRegistry.getLiveWorkProducer().read()).toEqual({ coverage: 'complete', items: [] });

      expect(runs.size).toBe(0);
      expect(controllers.size).toBe(0);
      expect(enqueueMarkerWrite).not.toHaveBeenCalled();
      expect(sendAcp).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(onPublicStateUpdated).not.toHaveBeenCalled();
      expect(finishRun).not.toHaveBeenCalled();
    } finally {
      releasePreparation();
      await voiceAgentManager.dispose();
    }
  });

  it('preserves canonical Voice lifecycle fields when Voice supplies its runtime-specific start override', async () => {
    const runtime = createProvisioningRuntime();
    const createRuntime = vi.fn(() => runtime);
    const voiceAgentManager = {
      async start(params: { voiceAgentId: string }, options: { createRuntime: (input: Record<string, unknown>) => unknown }) {
        options.createRuntime({
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          backendId: 'claude',
          modelId: 'default',
          permissionIntent: 'default',
          start: { intent: 'voice_agent' },
        });
        return { voiceAgentId: params.voiceAgentId };
      },
      getResumeHandle() { return null; },
    } as unknown as VoiceAgentManager;

    await startExecutionRun({
      params: {
        sessionId: 'session_voice',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'default',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      },
      parentProvider: TEST_BACKEND_ID,
      sendAcp: async () => {},
      streamedTranscriptSession: null,
      createRuntime,
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry: null,
      runs: new Map(),
      controllers: new Map(),
      enqueueMarkerWrite: async () => {},
      writeActivityMarker: async () => {},
      finishRun: async () => {},
      executeBoundedRun: async () => {},
      send: async () => ({ ok: true }),
      voiceAgentManager,
    });

    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      start: expect.objectContaining({
        intent: 'voice_agent',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      }),
    }));
  });

  it('rejects unsupported review SCM scope before materializing a SubAgentRun tool call', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by review runs');
      },
    });

    try {
      const createRuntime = vi.fn(() => createProvisioningRuntime());
      const finishRun = vi.fn();
      await expect(startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: '',
          intentInput: {
            scmReviewScope: {
              kind: 'review_scm_scope.v1',
              status: 'unsupported',
              scmBackendId: null,
              scmMode: null,
              repositoryRoot: null,
              worktreeRoot: null,
              baseRef: { source: 'unavailable', ref: null },
              selectedPaths: [],
              committedPaths: [],
              uncommittedPaths: [],
              changedPaths: [],
              diff: { committedAvailable: false, uncommittedAvailable: false },
              diagnostics: [
                {
                  code: 'not_repository',
                  severity: 'error',
                  message: 'Review scope requires a source-control repository in the current session directory.',
                },
              ],
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
          sent.push({ provider, body, meta: opts?.meta });
        },
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      })).rejects.toMatchObject({
        code: 'execution_run_not_allowed',
      });

      expect(sent.some((message) => (message.body as any)?.type === 'tool-call')).toBe(false);
      expect(createRuntime).not.toHaveBeenCalled();
      expect(finishRun).not.toHaveBeenCalled();
      expect(runs.size).toBe(0);
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('refuses a selected pull request review whose own scope is unreadable, never falling back to the worktree scope beside it', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by review runs');
      },
    });

    try {
      const createRuntime = vi.fn(() => createProvisioningRuntime());
      const finishRun = vi.fn();
      await expect(startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          // A usable worktree scope and real instructions: everything the
          // incumbent admission looks at says this run is fine.
          instructions: 'Review the selected pull request.',
          intentInput: {
            scmReviewScope: SUPPORTED_WORKTREE_SCOPE,
            scmPullRequestReviewScope: {
              ...SELECTED_PULL_REQUEST_REVIEW_SCOPE,
              observed: {
                baseSha: SELECTED_PULL_REQUEST_REVIEW_SCOPE.observed.baseSha,
                headSha: SELECTED_PULL_REQUEST_REVIEW_SCOPE.observed.headSha,
              },
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      })).rejects.toMatchObject({
        code: 'execution_run_not_allowed',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
      });

      expect(createRuntime).not.toHaveBeenCalled();
      expect(finishRun).not.toHaveBeenCalled();
      expect(runs.size).toBe(0);
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('starts a review scoped to the selected pull request, and one scoped only to the worktree', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by review runs');
      },
    });
    publishEmptyAccountRoleOverrides();

    try {
      const createRuntime = vi.fn(() => createProvisioningRuntime());
      const startWith = async (intentInput: Record<string, unknown>) => await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          modelId: readOfferedSummaryModelId(),
          modelSelection: null,
          instructions: 'Review the selected pull request.',
          intentInput,
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: async () => {},
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await startWith({
        scmReviewScope: SUPPORTED_WORKTREE_SCOPE,
        scmPullRequestReviewScope: SELECTED_PULL_REQUEST_REVIEW_SCOPE,
      });
      await startWith({ scmReviewScope: SUPPORTED_WORKTREE_SCOPE });

      expect(createRuntime).toHaveBeenCalledTimes(2);
      expect(runs.size).toBe(2);
    } finally {
      await voiceAgentManager.dispose();
      clearActiveAccountSettingsSnapshot();
    }
  });

  it('rejects a Session-required profile before creating a detached run or transcript fact', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const sendAcp = vi.fn(async () => {});
    const enqueueMarkerWrite = vi.fn(async () => {});
    const createRuntime = vi.fn(() => createProvisioningRuntime());
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by review runs');
      },
    });

    try {
      await expect(startExecutionRun({
        params: {
          sessionId: null,
          intent: 'memory_hints',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Explain this captured change.',
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp,
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite,
        writeActivityMarker: async () => {},
        finishRun: async () => {},
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      })).rejects.toMatchObject({
        code: 'execution_run_not_allowed',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
      });

      expect(runs.size).toBe(0);
      expect(controllers.size).toBe(0);
      expect(createRuntime).not.toHaveBeenCalled();
      expect(sendAcp).not.toHaveBeenCalled();
      expect(enqueueMarkerWrite).not.toHaveBeenCalled();
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('prepares a workspace-native saved comparison through the real detached diff-summary Run profile', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-detached-summary-start-' });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const runtime = createProvisioningRuntime();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });
    try {
      const request = {
        sessionId: null, cwd: fixture.rootPath, intent: 'scm_diff_summary',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: readOfferedSummaryModelId(),
        instructions: 'Explain the captured workspace.', intentInput: { cwd: fixture.rootPath,
          source: { kind: 'workingTree' }, outputs: ['summary'] },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      } satisfies StartExecutionRunArgs['params'];
      // HostBridge prepares the profile before invoking the shared Run start owner.
      const preparation = await ScmDiffSummaryProfile.prepareStartParams!({
        request, cwd: fixture.rootPath, sessionId: null,
      });
      const result = await startExecutionRun({
        params: { ...request, ...preparation },
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
        // Only the native Agent process is replaced by the incumbent runtime testkit.
        createRuntime: () => runtime, getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null, runs, controllers, enqueueMarkerWrite: async (_runId, write) => await write(),
        writeActivityMarker: async () => {}, finishRun: async () => {}, executeBoundedRun: async () => {},
        send: async () => ({ ok: true }), voiceAgentManager,
      });
      const prepared = runs.get(result.runId)!;
      expect(prepared.sessionId).toBeNull();
      const intentInput = prepared.intentInput as { resultId: string; comparison: { id: string } };
      expect(await scmDiffSummaryResultStore.readStoredScope({ cwd: fixture.rootPath, resultId: intentInput.resultId }))
        .toEqual({ cwd: fixture.rootPath });
      expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, resultId: intentInput.resultId }))
        .toMatchObject({ success: true, result: { output: { comparison: { id: intentInput.comparison.id } } } });
    } finally {
      await runtime.dispose();
      await voiceAgentManager.dispose();
      await removeTempDir(fixture.rootPath);
    }
  });

  it('finishes cached SCM diff-summary runs without creating a backend runtime', async () => {
    const comparison = ScmComparisonSchema.parse({
      id: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
      source: { kind: 'turnCheckpoint' },
      repository: { rootPath: tmpdir() },
      endpoints: {},
      inventory: { state: 'complete', reasons: [], files: [] },
    });
    const metadata = {
      source: comparison.source,
      sourceKey: comparison.id,
      checkpointReceiptId: 'checkpoint.diff_computed',
    };
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    let resolveFinishAdmission!: () => void;
    const finishAdmission = new Promise<void>((resolve) => {
      resolveFinishAdmission = resolve;
    });
    const finishRun = vi.fn(async (runId: string, next, toolResult, structuredMeta?: ExecutionRunStructuredMeta) => {
      await finishAdmission;
      const current = runs.get(runId);
      if (!current) return;
      runs.set(runId, {
        ...current,
        ...next,
        latestToolResult: toolResult.output,
        ...(structuredMeta ? { structuredMeta } : {}),
      });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by scm_diff_summary runs');
      },
    });

    try {
      const createRuntime = vi.fn(() => createProvisioningRuntime());
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'scm_diff_summary',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'SCM diff summary cache hit; no generation required.',
          modelId: readOfferedSummaryModelId(),
          intentInput: {
            comparison,
            metadata,
            outputs: ['summary'],
            cachedOutput: {
              success: true,
              summaryMarkdown: '## Summary\n\nCached checkpoint.',
              sourceKey: comparison.id,
              checkpointReceiptId: 'checkpoint.diff_computed',
              comparison,
              metadata,
              requestedOutputs: ['summary'],
              outputs: { summary: { state: 'complete', value: { summaryMarkdown: '## Summary\n\nCached checkpoint.' } } },
              analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'streaming',
        },
        finalizeStartParamsForRuntime: async params => {
          const patch = await ScmDiffSummaryProfile.finalizeStartParams?.({ sessionId: params.sessionId,
            request: params as unknown as Parameters<NonNullable<typeof ScmDiffSummaryProfile.finalizeStartParams>>[0]['request'],
            cwd: tmpdir() });
          return { ...params, ...patch };
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {
          throw new Error('cached diff summary should not execute bounded generation');
        },
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      let startSettled = false;
      void startPromise.then(() => {
        startSettled = true;
      });
      await vi.waitFor(() => {
        expect(createRuntime).not.toHaveBeenCalled();
        expect(finishRun).toHaveBeenCalledOnce();
      });
      expect(startSettled).toBe(false);

      resolveFinishAdmission();
      const started = await startPromise;

      expect(createRuntime).not.toHaveBeenCalled();
      expect(finishRun).toHaveBeenCalledTimes(1);
      expect(runs.get(started.runId)).toMatchObject({
        status: 'succeeded',
        latestToolResult: {
          success: true,
          summaryMarkdown: '## Summary\n\nCached checkpoint.',
        },
        structuredMeta: {
          kind: 'scm_diff_summary.v1',
          payload: {
            success: true,
            summaryMarkdown: '## Summary\n\nCached checkpoint.',
          },
        },
      });
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('starts fresh SCM diff-summary generation when cache bypass is requested', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by scm_diff_summary runs');
      },
    });

    try {
      const createRuntime = vi.fn(() => createProvisioningRuntime());
      const executeBoundedRun = vi.fn<StartExecutionRunArgs['executeBoundedRun']>(async () => {});
      await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'scm_diff_summary',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Regenerate the checkpoint summary.',
          modelId: readOfferedSummaryModelId(),
          intentInput: {
            cachePolicy: { mode: 'bypass' },
            cachedOutput: {
              success: true,
              summaryMarkdown: '## Summary\n\nStale cached checkpoint.',
              sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
              checkpointReceiptId: 'checkpoint.diff_computed',
              metadata: {
                source: { kind: 'turnCheckpoint' },
                sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
                checkpointReceiptId: 'checkpoint.diff_computed',
              },
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'streaming',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: async () => {},
        executeBoundedRun,
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      expect(createRuntime).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(executeBoundedRun).toHaveBeenCalledTimes(1);
      });
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('uses the applied per-start contribution snapshot for structured output recovery instead of the stale manifest singleton', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by plan runs');
      },
    });

    try {
      const executeBoundedRun = vi.fn<StartExecutionRunArgs['executeBoundedRun']>(async () => {});
      await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'plan',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          instructions: 'Plan the implementation.',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        contributions: {
          agentDefinitionsById: new Map(),
        },
        createRuntime: () => createProvisioningRuntime(),
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: async () => {},
        executeBoundedRun,
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await vi.waitFor(() => {
        expect(executeBoundedRun).toHaveBeenCalledTimes(1);
      });
      expect(executeBoundedRun.mock.calls[0]?.[0].params).not.toHaveProperty('structuredOutputRecovery');
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('does not retain structured output recovery after the applied generation disables or uninstalls the Agent', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by plan runs');
      },
    });

    try {
      const executeBoundedRun = vi.fn<StartExecutionRunArgs['executeBoundedRun']>(async () => {});
      await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'plan',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          instructions: 'Plan the implementation.',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        contributions: {
          agentDefinitionsById: new Map(),
                  },
        createRuntime: () => createProvisioningRuntime(),
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: async () => {},
        executeBoundedRun,
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await vi.waitFor(() => {
        expect(executeBoundedRun).toHaveBeenCalledTimes(1);
      });
      expect(executeBoundedRun.mock.calls[0]?.[0].params).not.toHaveProperty(
        'structuredOutputRecovery',
      );
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('charges scm_commit_message execution runs to the shared one-shot budget', async () => {
    const budgetRegistry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: null,
      maxConcurrentOneShotTasks: 1,
    });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by scm_commit_message runs');
      },
    });

    const startArgs = {
      params: {
        sessionId: 'parent_session_1',
        intent: 'scm_commit_message',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        permissionMode: 'no_tools',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      parentProvider: TEST_BACKEND_ID,
      sendAcp: async () => {},
      streamedTranscriptSession: null,
      createRuntime: () => createProvisioningRuntime(),
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry,
      runs,
      controllers,
      enqueueMarkerWrite: async () => {},
      writeActivityMarker: async () => {},
      finishRun: async () => {},
      executeBoundedRun: async () => {},
      send: async () => ({ ok: true }),
      voiceAgentManager,
    } as const;

    try {
      const first = await startExecutionRun(startArgs);
      expect(first.runId).toMatch(/^run_/);
      expect(budgetRegistry.getInFlightSnapshot()).toEqual({
        executionRuns: 0,
        oneShotTasks: 1,
      });

      await expect(startExecutionRun(startArgs)).rejects.toMatchObject({
        code: 'execution_run_budget_exceeded',
      });
    } finally {
      for (const runId of runs.keys()) {
        budgetRegistry.releaseExecutionRun(runId);
      }
      await voiceAgentManager.dispose();
    }
  });

  it('releases the acquired execution budget when runtime creation fails before controller registration', async () => {
    const budgetRegistry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 1,
      maxConcurrentOneShotTasks: null,
    });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by delegate runs');
      },
    });

    try {
      const started = await startExecutionRun({
        params: {
          sessionId: 'parent_session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'long_lived',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => {
          throw new Error('runtime creation failed');
        },
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: async (runId, next) => {
          const current = runs.get(runId);
          if (current) runs.set(runId, { ...current, ...next });
        },
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });
      expect(runs.get(started.runId)).toMatchObject({
        runId: started.runId, callId: started.callId, sidechainId: started.sidechainId, status: 'failed',
      });

      expect(budgetRegistry.getInFlightSnapshot()).toEqual({
        executionRuns: 0,
        oneShotTasks: 0,
      });
      expect(controllers.size).toBe(0);
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('returns the accepted handle, then releases capacity when asynchronous resume support inspection fails', async () => {
    const budgetRegistry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 1,
      maxConcurrentOneShotTasks: null,
    });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
      budgetRegistry.releaseExecutionRun(runId);
    });
    const runtime = {
      ...createProvisioningRuntime(),
      readResumeSupport: async () => {
        throw new Error('resume support inspection failed');
      },
    } satisfies TestExecutionRunHostRuntime;
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by delegate runs');
      },
    });

    try {
      const started = await startExecutionRun({
        params: {
          sessionId: 'parent_session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'long_lived',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await vi.waitFor(() => expect(finishRun).toHaveBeenCalledOnce());

      expect(budgetRegistry.getInFlightSnapshot()).toEqual({
        executionRuns: 0,
        oneShotTasks: 0,
      });
      expect(runs.get(started.runId)).toMatchObject({
        status: 'failed',
        error: { code: 'execution_run_failed', message: 'resume support inspection failed' },
      });
      // Host terminal truth precedes detached provider cleanup. Observe the
      // fixture's real disposal lifetime instead of its scheduling turn.
      await vi.waitFor(() => {
        expect(controllers.size).toBe(0);
        expect(runtime.getRuntimeLifetimeSignal().aborted).toBe(true);
      });
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('streams scm_diff_summary progress while keeping summaryMarkdown buffered as final output', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const sent: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const commits: Array<{ body: ACPMessageData; localId: string; meta?: Record<string, unknown> }> = [];
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by scm_diff_summary runs');
      },
    });
    let finishResolve!: () => void;
    const finished = new Promise<void>((resolve) => {
      finishResolve = resolve;
    });

    try {
      const started = await startExecutionRun({
        params: {
          sessionId: 'parent_session_1',
          intent: 'scm_diff_summary',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          modelId: readOfferedSummaryModelId(),
          instructions: 'Summarize the checkpoint.',
          intentInput: {
            cwd: '/repo',
            source: { kind: 'turnCheckpoint' },
            sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
            checkpointReceiptId: 'checkpoint.diff_computed',
            metadata: {
              source: { kind: 'turnCheckpoint' },
              sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
              turnId: 'turn_1',
              checkpointReceiptId: 'checkpoint.diff_computed',
              contentConfidence: 'exact',
              attributionScope: 'shared_worktree',
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'streaming',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async (_provider, body, opts) => {
          sent.push({ body, meta: opts?.meta });
        },
        streamedTranscriptSession: {
          enqueueAgentMessageCommitted: async (_provider, body, opts) => {
            commits.push({ body, localId: opts.localId, meta: opts.meta });
            return { persisted: true, delivered: false };
          },
        },
        createRuntime: () => createScmDiffSummaryStreamingRuntime(),
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: async (runId, next, toolResult, structuredMeta?: ExecutionRunStructuredMeta) => {
          const current = runs.get(runId);
          if (current) {
            runs.set(runId, {
              ...current,
              ...next,
              latestToolResult: toolResult.output,
              ...(structuredMeta ? { structuredMeta } : {}),
            });
          }
          finishResolve();
        },
        executeBoundedRun: (args) =>
          executeBoundedBackendRun({
            ...args,
            controllers,
            sendAcp: async (_provider, body, opts) => {
              sent.push({ body, meta: opts?.meta });
            },
            parentProvider: TEST_BACKEND_ID,
            getNowMs: () => 1_700_000_000_001,
            boundedTimeoutMs: null,
            finishRun: async (runId, next, toolResult, structuredMeta) => {
              const current = runs.get(runId);
              if (current) {
                runs.set(runId, {
                  ...current,
                  ...next,
                  latestToolResult: toolResult.output,
                  ...(structuredMeta ? { structuredMeta } : {}),
                });
              }
              finishResolve();
            },
          }),
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await finished;

      const finalRun = runs.get(started.runId);
      expect(finalRun?.status).toBe('succeeded');
      expect(finalRun?.latestToolResult).toMatchObject({
        success: true,
        summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
      });

      const sidechainCommits = commits.filter(
        (row): row is AcpCommittedMessage => isAcpCommittedMessage(row) && row.body.sidechainId === started.sidechainId,
      );
      expect(sidechainCommits.length).toBeGreaterThanOrEqual(1);
      const streamedText = sidechainCommits
        .map((row) => row.body.message)
        .join('');
      expect(streamedText).toContain('Inspecting checkpoint diff evidence');
      expect(streamedText).not.toContain('## Summary');
      expect(sidechainCommits.at(-1)?.body.message).toBe('Inspecting checkpoint diff evidence...');
      expect(sidechainCommits[0]?.meta?.happierStreamSegmentV1).toMatchObject({ segmentState: 'streaming' });
      expect(sidechainCommits.at(-1)?.meta?.happierStreamSegmentV1).toMatchObject({ segmentState: 'complete' });

      const nonStreamingMessages = sent.filter(
        (row) => row.body.type === 'message' && row.body.sidechainId === started.sidechainId,
      );
      expect(nonStreamingMessages).toHaveLength(0);
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('returns a long-lived run handle before lazy resume-capability discovery without imposing an environment deadline', async () => {
    const previousTimeout = process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS;
    process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS = '10';
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (!current) return;
      runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by delegate runs');
      },
    });

    try {
      let resolveResumeSupport!: () => void;
      const resumeSupportReady = new Promise<void>((resolve) => {
        resolveResumeSupport = resolve;
      });
      const baseRuntime = createTestExecutionRunHostRuntime({
        onSendPrompt: async () => {},
        onWaitForTurnCompletion: async () => {},
      });
      const delayedRuntime = Object.freeze({
        ...baseRuntime,
        async readResumeSupport() {
          await resumeSupportReady;
          return true;
        },
      });
      const createRuntime = vi.fn(() => delayedRuntime);

      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Long-lived run with a hanging backend.',
          permissionMode: 'workspace_write',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      const startOutcome = await Promise.race([
        startPromise.then((started) => ({ kind: 'started' as const, started })),
        new Promise<{ kind: 'still_waiting' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'still_waiting' }), 30);
        }),
      ]);
      resolveResumeSupport();
      expect(startOutcome).toMatchObject({ kind: 'started' });
      expect(controllers.size).toBe(1);
      expect(finishRun).not.toHaveBeenCalled();
      if (startOutcome.kind === 'started') {
        const controller = controllers.get(startOutcome.started.runId);
        if (controller?.kind === 'backend') {
          await (controller as typeof controller & { provisioningPromise?: Promise<void> }).provisioningPromise;
        }
      }
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS = previousTimeout;
      }
      await voiceAgentManager.dispose();
    }
  });

  it('keeps initial detached work busy after provisioning and orders a follow-up after completion', async () => {
    let releaseProvision!: () => void;
    let markProvisionStarted!: () => void;
    let releaseInitialTurn!: () => void;
    const initialTurnGate = new Promise<void>((resolve) => {
      releaseInitialTurn = resolve;
    });
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const provisionStarted = new Promise<void>((resolve) => {
      markProvisionStarted = resolve;
    });
    const prompts: string[] = [];
    const runtime = createTestExecutionRunHostRuntime({
      runtimeId: 'provider-session-1',
      resumeSupported: true,
      onProvisionRuntime: async () => {
        markProvisionStarted();
        await provisionGate;
      },
      onSendPrompt: async (_sessionId, prompt) => {
        prompts.push(prompt);
      },
      onWaitForTurnCompletion: async () => {
        if (prompts.length === 1) await initialTurnGate;
      },
    });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const send = async (
      runId: string,
      params: Parameters<typeof sendBackendLongLivedRun>[0]['params'],
    ) => await sendBackendLongLivedRun({
      runId,
      params,
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 1_700_000_000_001,
      finishRun,
      sendAcp: async () => {},
      parentProvider: TEST_BACKEND_ID,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => {},
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by detached agent runs');
      },
    });
    const startPromise = startExecutionRun({
      params: {
        sessionId: null,
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Initial work.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      },
      parentProvider: TEST_BACKEND_ID,
      sendAcp: async () => {},
      streamedTranscriptSession: null,
      createRuntime: () => runtime,
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry: null,
      runs,
      controllers,
      enqueueMarkerWrite: async () => {},
      writeActivityMarker: async () => {},
      finishRun,
      executeBoundedRun: async () => {},
      send,
      voiceAgentManager,
    });

    try {
      await provisionStarted;
      const startOutcome = await Promise.race([
        startPromise.then((started) => ({ kind: 'started' as const, started })),
        new Promise<{ kind: 'still_waiting' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'still_waiting' }), 30);
        }),
      ]);
      const followUp = startOutcome.kind === 'started'
        ? send(startOutcome.started.runId, { message: 'Follow-up work.' })
        : Promise.resolve({ ok: false });
      expect(prompts).toEqual([]);

      releaseProvision();
      const started = await startPromise;
      await expect(followUp).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(startOutcome).toMatchObject({ kind: 'started', started: { runId: started.runId } });
      expect(prompts).toHaveLength(1);
      releaseInitialTurn();
      await vi.waitFor(() => {
        const controller = controllers.get(started.runId);
        expect(controller?.kind).toBe('backend');
        if (controller?.kind === 'backend') expect(controller.turnInFlight).toBe(false);
      });
      await expect(send(started.runId, { message: 'Follow-up work.' })).resolves.toEqual({ ok: true });
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(prompts[0]).toContain('Initial work.');
      expect(prompts[1]).toBe('Follow-up work.');
      await stopExecutionRun({
        runId: started.runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_002,
        finishRun,
      });
    } finally {
      releaseProvision();
      releaseInitialTurn();
      await voiceAgentManager.dispose();
    }
  });

  it('does not let a rejected bounded controller occurrence dispose or delete its successor', async () => {
    let rejectProvision!: (error: Error) => void;
    let markProvisionStarted!: () => void;
    const provisionStarted = new Promise<void>((resolve) => {
      markProvisionStarted = resolve;
    });
    const provisioning = new Promise<never>((_resolve, reject) => {
      rejectProvision = reject;
    });
    const oldRuntime = createTestExecutionRunHostRuntime({
      onProvisionRuntime: async () => {
        markProvisionStarted();
        await provisioning;
      },
      onSendPrompt: async () => {},
      onWaitForTurnCompletion: async () => {},
    });
    const successorDispose = vi.fn();
    const successorRuntime = createTestExecutionRunHostRuntime({
      onSendPrompt: async () => {},
      onWaitForTurnCompletion: async () => {},
      onDispose: successorDispose,
    });
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by bounded delegate runs');
      },
    });

    try {
      const started = await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'workspace_write',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => oldRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });
      const oldController = controllers.get(started.runId);
      if (!oldController || oldController.kind !== 'backend') {
        throw new Error('expected old backend controller occurrence');
      }
      await provisionStarted;
      const successorResolveTerminal = vi.fn();
      const successor = {
        ...oldController,
        backend: successorRuntime,
        resolveTerminal: successorResolveTerminal,
      } satisfies typeof oldController;
      controllers.set(started.runId, successor);

      rejectProvision(new Error('old provisioning rejected'));
      await vi.waitFor(() => expect(finishRun).toHaveBeenCalledOnce());

      expect(controllers.get(started.runId)).toBe(successor);
      expect(successorDispose).not.toHaveBeenCalled();
      expect(successorResolveTerminal).not.toHaveBeenCalled();
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('cancels a bounded child that finishes provisioning after the run was stopped', async () => {
    let resolveProvision!: () => void;
    let markProvisionStarted!: () => void;
    const provisionStarted = new Promise<void>((resolve) => {
      markProvisionStarted = resolve;
    });
    const provisioning = new Promise<void>((resolve) => {
      resolveProvision = resolve;
    });
    const cancel = vi.fn();
    const dispose = vi.fn();
    const executeBoundedRun = vi.fn();
    const runtime = createTestExecutionRunHostRuntime({
      runtimeId: 'late_child_session',
      onProvisionRuntime: async () => {
        markProvisionStarted();
        await provisioning;
      },
      onCancel: cancel,
      onDispose: dispose,
    });
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by bounded delegate runs');
      },
    });

    try {
      const started = await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'workspace_write',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun,
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await provisionStarted;
      await expect(stopExecutionRun({
        runId: started.runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_001,
        finishRun,
      })).resolves.toEqual({ ok: true });
      resolveProvision();

      await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('late_child_session'));
      expect(executeBoundedRun).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalled();
      expect(runs.get(started.runId)?.status).toBe('cancelled');
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('registers Voice control before provisioning so stop retires the provisional runtime immediately', async () => {
    let releaseProvision!: () => void;
    let provisionStarted!: () => void;
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const provisionStartedPromise = new Promise<void>((resolve) => {
      provisionStarted = resolve;
    });
    const dispose = vi.fn(async () => {});
    const runtime = createTestExecutionRunHostRuntime({
      runtimeId: 'voice-provisioning',
      onProvisionRuntime: async () => {
        provisionStarted();
        await provisionGate;
      },
      onDispose: dispose,
    });
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });

    try {
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'voice_agent',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await provisionStartedPromise;
      const runId = [...runs.keys()][0]!;
      expect(controllers.get(runId)).toMatchObject({ kind: 'voice_agent', voiceAgentId: runId });

      await expect(stopExecutionRun({
        runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_001,
        finishRun,
      })).resolves.toEqual({ ok: true });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
      expect(runs.get(runId)?.status).toBe('cancelled');

      releaseProvision();
      await expect(startPromise).resolves.toMatchObject({ runId });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(finishRun).toHaveBeenCalledTimes(1);
    } finally {
      releaseProvision();
      await voiceAgentManager.dispose();
    }
  });

  it('registers Voice control before READY so stop retires the provisional runtime without waiting for READY', async () => {
    let releaseReady!: () => void;
    let readyWaitStarted!: () => void;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const readyWaitStartedPromise = new Promise<void>((resolve) => {
      readyWaitStarted = resolve;
    });
    const dispose = vi.fn(async () => {});
    let runtime: TestExecutionRunHostRuntime;
    runtime = createTestExecutionRunHostRuntime({
      runtimeId: 'voice-ready',
      onSendPrompt: async () => {
        runtime.emitMessage({ type: 'model-output', fullText: 'READY' });
      },
      onWaitForTurnCompletion: async () => {
        readyWaitStarted();
        await readyGate;
      },
      onDispose: dispose,
    });
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });

    try {
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'voice_agent',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
          bootstrapMode: 'ready_handshake',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await readyWaitStartedPromise;
      const runId = [...runs.keys()][0]!;
      expect(controllers.get(runId)).toMatchObject({ kind: 'voice_agent', voiceAgentId: runId });

      await expect(stopExecutionRun({
        runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_001,
        finishRun,
      })).resolves.toEqual({ ok: true });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
      expect(runs.get(runId)?.status).toBe('cancelled');

      releaseReady();
      await expect(startPromise).resolves.toMatchObject({ runId });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(finishRun).toHaveBeenCalledTimes(1);
    } finally {
      releaseReady();
      await voiceAgentManager.dispose();
    }
  });

  it('cancels a long-lived child that finishes provisioning after the run was stopped', async () => {
    let resolveProvision!: () => void;
    const provisioning = new Promise<void>((resolve) => {
      resolveProvision = resolve;
    });
    const cancel = vi.fn();
    const dispose = vi.fn();
    const send = vi.fn(async () => ({ ok: true }));
    const runtime = createTestExecutionRunHostRuntime({
      runtimeId: 'late_long_lived_child_session',
      onProvisionRuntime: async () => await provisioning,
      onCancel: cancel,
      onDispose: dispose,
    });
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by long-lived delegate runs');
      },
    });

    try {
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Do not dispatch this after cancellation.',
          permissionMode: 'workspace_write',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send,
        voiceAgentManager,
      });

      await vi.waitFor(() => expect(controllers.size).toBe(1));
      const runId = [...runs.keys()][0]!;
      await expect(stopExecutionRun({
        runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_001,
        finishRun,
      })).resolves.toEqual({ ok: true });
      resolveProvision();

      await expect(startPromise).resolves.toMatchObject({ runId });
      expect(cancel).toHaveBeenCalledWith('late_long_lived_child_session');
      expect(dispose).toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(runs.get(runId)?.status).toBe('cancelled');
      expect(runs.get(runId)?.resumeHandle).toBeNull();
    } finally {
      resolveProvision();
      await voiceAgentManager.dispose();
    }
  });

  it('stops an accepted bounded run while backend resume support is still loading', async () => {
    let resolveResumeSupport!: () => void;
    let resolveResumeSupportStarted!: () => void;
    const resumeSupport = new Promise<void>((resolve) => {
      resolveResumeSupport = resolve;
    });
    const resumeSupportStarted = new Promise<void>((resolve) => {
      resolveResumeSupportStarted = resolve;
    });
    const dispose = vi.fn();
    const executeBoundedRun = vi.fn();
    const baseRuntime = createTestExecutionRunHostRuntime({ onDispose: dispose });
    const runtime = {
      ...baseRuntime,
      async readResumeSupport() {
        resolveResumeSupportStarted();
        await resumeSupport;
        return false;
      },
    } satisfies TestExecutionRunHostRuntime;
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by bounded delegate runs');
      },
    });

    try {
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'workspace_write',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun,
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await resumeSupportStarted;
      const runId = [...runs.keys()][0]!;
      const stopResult = await stopExecutionRun({
        runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_001,
        finishRun,
      });
      resolveResumeSupport();
      await startPromise;

      expect(stopResult).toEqual({ ok: true });
      expect(executeBoundedRun).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalled();
      expect(runs.get(runId)?.status).toBe('cancelled');
    } finally {
      resolveResumeSupport();
      await voiceAgentManager.dispose();
    }
  });

  it('stops an accepted bounded run while its transcript start is still publishing', async () => {
    let resolveTranscript!: () => void;
    let resolveTranscriptStarted!: () => void;
    const transcript = new Promise<void>((resolve) => {
      resolveTranscript = resolve;
    });
    const transcriptStarted = new Promise<void>((resolve) => {
      resolveTranscriptStarted = resolve;
    });
    const createRuntime = vi.fn(() => createTestExecutionRunHostRuntime());
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by bounded delegate runs');
      },
    });

    try {
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'workspace_write',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {
          resolveTranscriptStarted();
          await transcript;
        },
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await transcriptStarted;
      const runId = [...runs.keys()][0]!;
      const stopResult = await stopExecutionRun({
        runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_001,
        finishRun,
      });
      resolveTranscript();
      await startPromise;

      expect(stopResult).toEqual({ ok: true });
      expect(createRuntime).not.toHaveBeenCalled();
      expect(runs.get(runId)?.status).toBe('cancelled');
    } finally {
      resolveTranscript();
      await voiceAgentManager.dispose();
    }
  });
});

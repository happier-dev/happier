import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentStaticModels } from '@happier-dev/agents';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';

import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { createTestExecutionRunHostRuntime } from './testkit';
import { startExecutionRun } from './startExecutionRun';
import type { ExecutionRunState } from './executionRunTypes';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { isDeepStrictEqual } from 'node:util';
import { createExecutionRunRuntime } from './runtime/create';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { accountSettingsParse, AgentSessionProviderBindingV1Schema } from '@happier-dev/protocol';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

// The publication policy imports node:fs; load it before installing that boundary.
const { createBundledPluginPublicationFsFixture } = await vi.hoisted(async () => (
  await import('@/plugins/projection/registry/builtIn/locators.testkit')
));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return createBundledPluginPublicationFsFixture(actual);
});

describe('structured analysis Run admission', () => {
  it.each(['supported', 'unknown'] as const)('uses the once-prepared Provider binding for JSON admission (%s)', async structuredOutput => {
    const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    const registry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
    const resolution = await registry.resolveForBackendId('codex');
    if (!resolution) throw new Error('Missing Codex fixture contribution');
    const binding = AgentSessionProviderBindingV1Schema.parse({
      connectionId: 'pc_test', model: { id: 'provider-model', name: 'Provider model', capabilities: { structuredOutput } },
      upstream: { protocol: 'openai-responses', normalizedUrl: 'https://provider.example/v1', credential: 'apiKey' },
      materialization: { v: 1, kind: 'engineConfig', engineConfig: {} },
    });
    let preparations = 0;
    let opened = false;
    let cleaned = false;
    let terminal: unknown;
    const runs = new Map<string, ExecutionRunState>();
    const controllers: Parameters<typeof startExecutionRun>[0]['controllers'] = new Map();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Unused Voice boundary'); } });
    const nativeRuntime = createTestExecutionRunHostRuntime();
    // Replace only the plugin's native runtime boundary; selection, Provider
    // preparation, admission, and lazy runtime lifecycle remain real.
    const engine = { ...resolution, engineAdapter: { ...resolution.engineAdapter, runtimeCore: {
      ...resolution.engineAdapter.runtimeCore,
      createExecutionRunBackend: (input: import('@/agent/runtime/registry/engineRegistryTypes').CreateCliExecutionRunBackendParams) => {
        expect(input.providerBinding).toBe(binding);
        opened = true;
        return nativeRuntime;
      },
    } } };
    try {
      const result = await startExecutionRun({
        params: { sessionId: null, intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          modelId: binding.model.id,
          modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_test', modelId: binding.model.id },
          connectedServices: null, instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'long_lived', ioMode: 'request_response' },
        parentProvider: 'codex', sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: input => createExecutionRunRuntime({ ...input, cwd: '/repo', scope: 'detached',
          engineRegistry: { ...registry, resolveForBackendId: async () => engine, resolveForAgentTarget: async () => engine },
          resolveAccountSettingsSnapshot: async () => ({ source: 'cache', settings: accountSettingsParse({}),
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'account:test' }),
          // The pinned daemon launch service is the Provider process boundary.
          providerLaunch: { prepareLaunch: async () => {
            preparations++;
            return { environment: {}, unsetEnvKeys: [], providerBinding: binding, additionalRedactionValues: [],
              sanitizeDiagnosticText: value => value, revalidateBeforeCommit: async () => ({ ok: true }),
              cleanupOnExit: async () => { cleaned = true; } };
          } },
        }), getNowMs: () => 1, budgetRegistry: null, runs, controllers,
        enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {}, finishRun: async (_runId, result) => { terminal = result; },
        executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      });
      const controller = controllers.get(result.runId);
      if (controller?.kind !== 'backend') throw new Error('Missing backend controller');
      await controller.provisioningPromise;
      expect(preparations).toBe(1);
      expect(opened).toBe(structuredOutput === 'supported');
      if (structuredOutput === 'unknown') {
        expect(terminal).toMatchObject({ status: 'failed', error: { code: 'model_structured_output_unsupported' } });
        expect(cleaned).toBe(true);
      }
    } finally {
      await Promise.all([...controllers.values()].flatMap(controller => controller.kind === 'backend' ? [controller.backend.dispose()] : []));
      await voiceAgentManager.dispose();
      await fixture.dispose();
    }
  });
  beforeEach(() => {
    vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
    vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(['review', 'scm_diff_summary'] as const)('admits %s using the selected Connected Services catalog', async intent => {
    const connectedServices = { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'connected-account' },
    } } as const;
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Unused Voice boundary'); } });
    try {
      const reviewer = resolveRoleSelectionV1({ roleId: 'reviewer' });
      if (!reviewer.ok) throw new Error('Missing canonical Reviewer role');
      const result = await startExecutionRun({
        params: { sessionId: 'parent-session', intent, backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          ...(intent === 'review' ? { resolvedRole: reviewer.selection } : {}),
          modelId: 'selected-account-model', connectedServices,
          modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'selected-account-model' },
          // Native catalog transport is the boundary: only the selected launch
          // environment offers this model; the ordinary native catalog does not.
          readNativeOfferedModel: async request => isDeepStrictEqual(Reflect.get(request, 'connectedServices'), connectedServices)
            ? { id: request.modelId, name: 'Selected model', capabilities: { structuredOutput: 'supported' } } : undefined,
          instructions: 'Review the selected scope.', permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'long_lived', ioMode: 'request_response' },
        parentProvider: 'codex', sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: () => createTestExecutionRunHostRuntime(), getNowMs: () => 1,
        budgetRegistry: null, runs, controllers: new Map(), enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {},
        finishRun: async () => {}, executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      });
      expect(runs.get(result.runId)).toMatchObject({ intent, status: 'running' });
    } finally { await voiceAgentManager.dispose(); }
  });
  it('refuses a drained start before publishing a Run or constructing its native runtime', async () => {
    const drain = createDaemonAdmissionDrain();
    drain.beginTemporaryDrain();
    const modelId = getAgentStaticModels('claude', { catalogOnly: true })[0]?.id;
    if (!modelId) throw new Error('The native Claude offered-model catalog is unavailable');
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Unused Voice boundary'); } });
    let runtimeCreated = false;
    try {
      await expect(startExecutionRun({
        params: { sessionId: 'parent-session', intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId,
          instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response' },
        parentProvider: 'claude', sendAcp: async () => {}, streamedTranscriptSession: null,
        admitStart: async () => { if (drain.isQuiescing()) throw Object.assign(new Error('draining'), { code: 'daemon_draining' }); },
        createRuntime: () => { runtimeCreated = true; return createTestExecutionRunHostRuntime(); }, getNowMs: () => 1,
        budgetRegistry: null, runs, controllers: new Map(), enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {},
        finishRun: async () => {}, executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      })).rejects.toMatchObject({ code: 'daemon_draining', details: { executionRunStart: { runCreation: 'noRunCreated' } } });
      expect(runs.size).toBe(0);
      expect(runtimeCreated).toBe(false);
    } finally { await voiceAgentManager.dispose(); }
  });
  it('preserves a failed native catalog read when admitting a structured diff summary', async () => {
    const intent = 'scm_diff_summary' as const;
    const runs = new Map<string, ExecutionRunState>();
    let runtimeCreated = false;
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Unused Voice boundary'); } });
    try {
      await expect(startExecutionRun({
        params: { sessionId: 'parent-session', intent, backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          modelId: 'gpt-6-luna',
          // The runner-to-daemon catalog transport failed before a model was read.
          readNativeOfferedModel: async () => { throw Object.assign(new Error('Snapshot read unavailable'),
            { code: 'execution_run_contribution_snapshot_unavailable' }); },
          instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'long_lived', ioMode: 'request_response' },
        parentProvider: 'codex', sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: () => { runtimeCreated = true; return createTestExecutionRunHostRuntime(); }, getNowMs: () => 1,
        budgetRegistry: null, runs, controllers: new Map(), enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {},
        finishRun: async () => {}, executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      })).rejects.toMatchObject({ code: 'execution_run_contribution_snapshot_unavailable',
        details: { executionRunStart: { runCreation: 'noRunCreated' } } });
      expect(runs.size).toBe(0);
      expect(runtimeCreated).toBe(false);
    } finally { await voiceAgentManager.dispose(); }
  });
  it('joins an already accepted request while new Run admission is drained', async () => {
    const drain = createDaemonAdmissionDrain();
    const modelId = getAgentStaticModels('claude', { catalogOnly: true })[0]?.id;
    if (!modelId) throw new Error('The native Claude offered-model catalog is unavailable');
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Unused Voice boundary'); } });
    const args = {
      params: { actionRequestId: 'accepted-drain-request', sessionId: 'parent-session', intent: 'scm_diff_summary',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId, instructions: '', permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response' },
      parentProvider: 'claude', sendAcp: async () => {}, streamedTranscriptSession: null,
      admitStart: async () => { if (drain.isQuiescing()) throw Object.assign(new Error('draining'), { code: 'daemon_draining' }); },
      createRuntime: () => createTestExecutionRunHostRuntime(), getNowMs: () => 1,
      budgetRegistry: null, runs, controllers: new Map(), enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {},
      finishRun: async () => {}, executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
    } satisfies Parameters<typeof startExecutionRun>[0];
    try {
      const accepted = await startExecutionRun(args);
      drain.beginTemporaryDrain();
      await expect(startExecutionRun(args)).resolves.toEqual(accepted);
      expect(runs.size).toBe(1);
    } finally { await voiceAgentManager.dispose(); }
  });
  it.each([
    ['scm_diff_summary', 'freeform-not-in-native-catalog', false, false],
    ['scm_diff_summary', 'offered-native-model', true, false],
    ['review', 'freeform-not-in-native-catalog', false, true],
    ['review', 'freeform-not-in-native-catalog', false, false],
    ['review', 'offered-native-model', true, false],
  ] as const)('admits %s model %s with review repair fallback (native JSON: %s; walkthrough: %s)', async (intent, modelId, allowed, walkthrough) => {
    const selectedModelId = allowed ? getAgentStaticModels('claude', { catalogOnly: true })[0]?.id : modelId;
    if (allowed && !selectedModelId) throw new Error('The native Claude offered-model catalog is unavailable');
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Unused Voice boundary'); } });
    let dispatched = false;
    try {
      const reviewer = intent === 'review' ? resolveRoleSelectionV1({ roleId: 'reviewer' }) : null;
      if (reviewer && !reviewer.ok) throw new Error('The canonical reviewer role is unavailable');
      const result = startExecutionRun({
        params: {
          sessionId: 'parent-session', intent,
          ...(walkthrough ? { intentInput: { outputs: ['walkthrough'] } } : {}),
          ...(reviewer?.ok ? { resolvedRole: reviewer.selection } : {}),
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          modelId: selectedModelId,
          instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'long_lived', ioMode: 'request_response',
        },
        parentProvider: 'claude', sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: () => createTestExecutionRunHostRuntime(), getNowMs: () => 1,
        budgetRegistry: null, runs, controllers: new Map(),
        enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {}, finishRun: async () => {},
        executeBoundedRun: async () => {}, send: async () => { dispatched = true; return { ok: true }; },
        voiceAgentManager,
      });
      if (allowed || intent === 'review') {
        await expect(result).resolves.toMatchObject({ runId: expect.any(String) });
        expect(runs.size).toBe(1);
      } else {
        await expect(result).rejects.toMatchObject({ code: 'model_structured_output_unsupported' });
        expect(runs.size).toBe(0);
        expect(dispatched).toBe(false);
      }
    } finally {
      await voiceAgentManager.dispose();
    }
  });
});

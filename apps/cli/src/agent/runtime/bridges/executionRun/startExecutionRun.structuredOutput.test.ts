import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentStaticModels } from '@happier-dev/agents';

import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { createTestExecutionRunHostRuntime } from './testkit';
import { startExecutionRun } from './startExecutionRun';
import type { ExecutionRunState } from './executionRunTypes';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

describe('structured analysis Run admission', () => {
  beforeEach(() => {
    vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
    vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ['scm_diff_summary', 'freeform-not-in-native-catalog', false],
    ['scm_diff_summary', 'offered-native-model', true],
    ['review', 'freeform-not-in-native-catalog', false],
  ] as const)('admits %s model %s only when the native catalog establishes JSON support (%s)', async (intent, modelId, allowed) => {
    const selectedModelId = allowed ? getAgentStaticModels('claude', { catalogOnly: true })[0]?.id : modelId;
    if (allowed && !selectedModelId) throw new Error('The native Claude offered-model catalog is unavailable');
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Unused Voice boundary'); } });
    let dispatched = false;
    try {
      const result = startExecutionRun({
        params: {
          sessionId: 'parent-session', intent,
          ...(intent === 'review' ? { intentInput: { outputs: ['walkthrough'] } } : {}),
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
      if (allowed) {
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

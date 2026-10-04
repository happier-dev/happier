import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readBackendTargetRefV2 } from '@happier-dev/protocol';

import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { buildReviewFindingsV2Payload } from '@/agent/reviews/normalize/buildReviewFindingsV2Payload';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { applyReviewWalkthroughAction } from './reviewNarrationAction';
import { ensureExecutionRun } from './ensureExecutionRun';
import { startExecutionRun } from './startExecutionRun';
import type { ExecutionRunState } from './executionRunTypes';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

beforeEach(() => {
  vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
  vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  ['retained reviewer', undefined],
  ['seeded narrator', 'different-unoffered-model'],
] as const)('rejects an unsupported %s before native startup or changing narration state', async (_path, narratorModelId) => {
  // Git/disk and native runtime startup are system boundaries; admission/catalog/recovery remain real.
  const cwd = mkdtempSync(join(tmpdir(), 'happier-review-model-admission-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  writeFileSync(join(cwd, 'change.ts'), 'change\n');
  const sessionId = 'review-model-admission-session';
  const captured = await captureScmComparison({ cwd, sessionId, source: { kind: 'workingTree' } });
  const backendTarget = { kind: 'builtInAgent', agentId: 'claude' } as const;
  const run: ExecutionRunState = {
    runId: 'review-model-admission-run', callId: 'review-model-admission-call', sidechainId: 'review-model-admission-sidechain',
    sessionId, depth: 0, intent: 'review', backendId: 'claude', backendTarget, instructions: '',
    permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
    status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
    resumeHandle: { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2(backendTarget), providerSessionId: 'saved-reviewer' },
    launch: { cwd, modelId: 'freeform-not-in-native-catalog' },
    intentInput: { cwd, comparisonId: captured.comparison.id },
    structuredMeta: { kind: 'review_findings.v2', payload: buildReviewFindingsV2Payload({
      runId: 'review-model-admission-run', callId: 'review-model-admission-call', backendId: 'claude',
      summary: 'No findings', findings: [], generatedAtMs: 2,
    }) },
  };
  const runs = new Map([[run.runId, run]]);
  const controllers = new Map<string, ExecutionRunController>();
  let nativeStartup = false;
  const createRuntime = () => { nativeStartup = true; throw new Error('Native runtime unavailable'); };
  const voiceAgentManager = new VoiceAgentManager({ createRuntime });
  const shared = {
    runs, controllers, createRuntime, voiceAgentManager,
    parentProvider: 'claude' as const, sendAcp: async () => {}, streamedTranscriptSession: null,
    getNowMs: () => 3, budgetRegistry: null, writeActivityMarker: async () => {},
  };
  try {
    const result = await applyReviewWalkthroughAction({
      runId: run.runId, cwd, runs, controllers,
      input: { reviewRunIds: [run.runId], comparisonId: captured.comparison.id,
        ...(narratorModelId ? { narrator: { engineId: 'claude', modelId: narratorModelId } } : {}) },
      ensureRun: async runId => ensureExecutionRun({ ...shared, runId, params: { resume: true } }),
      startRun: async params => startExecutionRun({ ...shared, params, enqueueMarkerWrite: async () => {},
        finishRun: async () => {}, executeBoundedRun: async () => {}, send: async () => ({ ok: true }) }),
      waitForTerminal: async () => {},
      // This is the Session transport boundary; an unsupported model must never reach it.
      enqueueInput: async input => ({ status: 'accepted', localId: input.localId }),
      onStateUpdated: () => {}, failNarration: async () => {},
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'model_structured_output_unsupported' });
    expect(nativeStartup).toBe(false);
    expect(runs.get(run.runId)).toEqual(run);
  } finally {
    await voiceAgentManager.dispose();
  }
});

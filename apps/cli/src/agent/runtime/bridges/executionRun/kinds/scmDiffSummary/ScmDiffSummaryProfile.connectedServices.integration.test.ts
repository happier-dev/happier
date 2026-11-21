import { runWithScmAccountScope } from '@/scm/accountScope';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { ScmDiffSummaryResultResponseSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/selection/v1';

import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { prepareReviewWalkthroughTurn } from '@/agent/executionRuns/profiles/review/reviewWalkthroughTurn';
import { buildExecutionRunProfileStartParams } from '@/agent/runtime/bridges/executionRun/profileStart';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { publishExecutionRunTurn } from '@/agent/runtime/bridges/executionRun/publishExecutionRunTurn';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { withTempDir } from '@/testkit/fs/tempDir';

import { ScmDiffSummaryProfile } from './ScmDiffSummaryProfile';

const connectedRoute: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: {
  'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'admitted-profile' },
} };

describe('saved SCM generator credential routing', () => {
  it('persists a late-resolved route through the live Run publisher', async () => {
    return runWithScmAccountScope('account', async () => {
    await withTempDir('happier-scm-live-route-', async cwd => {
      execFileSync('git', ['init', '-q'], { cwd });
      const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
      const request = {
        backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' }, intent: 'scm_diff_summary' as const,
        permissionMode: 'read_only', retentionPolicy: 'resumable' as const, runClass: 'long_lived' as const, ioMode: 'streaming' as const,
        intentInput: { cwd, source: captured.comparison.source, comparisonId: captured.comparison.id, outputs: ['summary'] },
      };
      const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: null, request });
      const run: ExecutionRunState = {
        ...request, sessionId: null, runId: 'late-route-run', callId: 'call', sidechainId: 'sidechain', depth: 0,
        backendId: 'claude', instructions: String(prepared?.instructions ?? ''), intentInput: prepared?.intentInput,
        startedAtMs: 1, status: 'running', launch: { connectedServicesSelection: connectedRoute },
      };
      // Only native controller identity and transcript transport are external boundaries.
      const controller = { kind: 'backend', cancelled: false } as ExecutionRunBackendController;
      const runs = new Map([[run.runId, run]]);
      await publishExecutionRunTurn({ runId: run.runId, turnId: '', rawText: '', started: true, finishedAtMs: 1,
        controller, controllers: new Map([[run.runId, controller]]), runs, parentProvider: 'claude', sendAcp: async () => {} });
      const output = ScmDiffSummaryGenerateOutputSchema.parse(runs.get(run.runId)?.latestToolResult);
      const saved = ScmDiffSummaryResultResponseSchema.parse(await scmDiffSummaryResultStore.read({ cwd, resultId: output.resultId! }));
      expect(saved).toMatchObject({ success: true, result: { generator: { connectedServices: connectedRoute } } });
    });
    });
  });
  it.each([connectedRoute, null])('persists the admitted route through profile preparation and the saved-result reader (%j)', async connectedServices => {
    return runWithScmAccountScope('account', async () => {
    await withTempDir('happier-scm-route-', async cwd => {
      execFileSync('git', ['init', '-q'], { cwd });
      const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
      const sessionConfigOptionOverrides = { v: 1 as const, updatedAt: 1,
        overrides: { reasoning_effort: { updatedAt: 1, value: 'minimal' } } };
      const request = {
        backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' }, intent: 'scm_diff_summary' as const,
        permissionMode: 'read_only', retentionPolicy: 'resumable' as const, runClass: 'long_lived' as const, ioMode: 'streaming' as const,
        modelId: 'admitted-model', connectedServices, sessionConfigOptionOverrides,
        intentInput: { cwd, source: captured.comparison.source, comparisonId: captured.comparison.id, outputs: ['summary'] },
      };
      const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: null, request });
      const initial = await ScmDiffSummaryProfile.onStarted!({ start: {
        sessionId: null, runId: 'admitted-run', callId: 'call', sidechainId: 'sidechain',
        intent: request.intent, backendId: 'claude', backendTarget: request.backendTarget,
        instructions: String(prepared?.instructions ?? ''), intentInput: prepared?.intentInput,
        permissionMode: request.permissionMode, retentionPolicy: request.retentionPolicy, runClass: request.runClass,
        ioMode: request.ioMode, startedAtMs: 1,
      }, rawText: '', finishedAtMs: 1 });
      const output = ScmDiffSummaryGenerateOutputSchema.parse(initial?.toolResultOutput);
      const saved = ScmDiffSummaryResultResponseSchema.parse(await scmDiffSummaryResultStore.read({ cwd, resultId: output.resultId! }));
      expect(saved).toMatchObject({ success: true, result: { generator: { connectedServices, sessionConfigOptionOverrides } } });
    });
    });
  });
  it.each([connectedRoute, null])('retains the captured route on the first Review continuation (%j)', async connectedServices => {
    return runWithScmAccountScope('account', async () => {
    await withTempDir('happier-review-route-', async cwd => {
      execFileSync('git', ['init', '-q'], { cwd });
      const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
      const modelSelection = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:happier.agent.claude/claude',
        providerConnectionId: null, modelId: 'review-model' });
      const run: ExecutionRunState = {
        sessionId: null, runId: 'review-run', callId: 'review-call', sidechainId: 'review-sidechain', depth: 0,
        intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review the captured changes', intentInput: { cwd, comparisonId: captured.comparison.id },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        status: 'succeeded', startedAtMs: 1,
        launch: { modelId: modelSelection.modelId, modelSelection, connectedServicesSelection: connectedServices },
      };
      const prepared = await prepareReviewWalkthroughTurn({ start: buildExecutionRunProfileStartParams(run),
        comparisonId: captured.comparison.id, findingsContext: 'Explain the published findings',
        provenance: { reviewedRuns: [{ runId: run.runId, callId: run.callId, backendId: run.backendId,
          status: run.status, hasOutput: true, reviewOutcome: 'complete', comparisonId: captured.comparison.id }],
        narrationMode: 'continued_review', comparisonFreshness: 'unchanged' },
      });
      const saved = ScmDiffSummaryResultResponseSchema.parse(await scmDiffSummaryResultStore.read({ cwd,
        resultId: prepared.intentInput.resultId }));
      expect(saved).toMatchObject({ success: true, result: { generator: {
        modelId: modelSelection.modelId, modelSelection, connectedServices,
      }, output: { runId: run.runId } } });
    });
    });
  });
});

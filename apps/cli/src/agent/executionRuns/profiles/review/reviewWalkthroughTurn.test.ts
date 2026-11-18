import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/selection/v1';

import { runWithScmAccountScope } from '@/scm/accountScope';
import { captureScmComparison, deleteCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { buildExecutionRunProfileStartParams } from '@/agent/runtime/bridges/executionRun/profileStart';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { prepareReviewWalkthroughTurn } from './reviewWalkthroughTurn';

describe('prepareReviewWalkthroughTurn', () => {
  it('preserves the admitted subset when reloading a captured comparison for continued review', async () => runWithScmAccountScope('review-continuation-scope', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'review-continuation-scope-' });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.rootPath, encoding: 'utf8' }).trim();
    let comparisonId: string | undefined;
    try {
      await writeFile(join(fixture.rootPath, 'selected.ts'), 'selectedIssue();\n');
      await writeFile(join(fixture.rootPath, 'outside.ts'), 'outsideIssue();\n');
      git('add', 'selected.ts', 'outside.ts');
      git('commit', '-m', 'Selected comparison');
      const captured = await captureScmComparison({ cwd: fixture.rootPath, source: {
        kind: 'revisionRange', baseOid: fixture.headCommit, headOid: git('rev-parse', 'HEAD'),
      } });
      comparisonId = captured.comparison.id;
      expect(captured.comparison.inventory.files.map(file => file.path).sort()).toEqual(['outside.ts', 'selected.ts']);
      const admitted = { ...captured.comparison, inventory: { ...captured.comparison.inventory,
        files: captured.comparison.inventory.files.filter(file => file.path === 'selected.ts') } };
      const modelSelection = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:happier.agent.claude/claude',
        providerConnectionId: null, modelId: 'review-model' });
      const run: ExecutionRunState = {
        sessionId: null, runId: 'selected-review', callId: 'selected-call', sidechainId: 'selected-sidechain', depth: 0,
        intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review the selected file.', intentInput: { cwd: fixture.rootPath, comparisonId, comparison: admitted },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        status: 'succeeded', startedAtMs: 1, launch: { modelId: modelSelection.modelId, modelSelection, connectedServicesSelection: null },
      };
      const prepared = await prepareReviewWalkthroughTurn({ start: buildExecutionRunProfileStartParams(run),
        comparisonId, findingsContext: 'Explain the selected review findings.', provenance: {
          reviewedRuns: [{ runId: run.runId, callId: run.callId, backendId: run.backendId, status: run.status,
            hasOutput: true, reviewOutcome: 'complete', comparisonId }],
          narrationMode: 'continued_review', comparisonFreshness: 'unchanged',
        } });
      expect(prepared.intentInput.comparison).toEqual(admitted);
    } finally {
      if (comparisonId) await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId });
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  }));
});

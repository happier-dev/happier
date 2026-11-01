import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CLAUDE_AGENT_MODEL_CONFIG } from '../../../../../../../../../packages/plugins/claude/src/agent/models';
import { ANTHROPIC_STATIC_MODELS } from '../../../../../../../../../packages/plugins/claude/src/provider/catalog';
import type { ExecutionRunProfileStartParams } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { projectNativeCatalogModels } from '@/capabilities/probes/nativeCatalogModels';
import { captureScmComparison, deleteCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { withTempDir } from '@/testkit/fs/tempDir';
import { advanceDiffSummaryAnalysis, planDiffSummaryAnalysis } from './advanceDiffSummaryAnalysis';
import { buildDiffSummaryPrompt } from './buildDiffSummaryPrompt';

it('completes all 215 files in same-run parts sized by the selected native model, with fewer parts for a larger window', async () => {
  await withTempDir('happier-scm-model-context-', async cwd => {
    execFileSync('git', ['init', '-q'], { cwd });
    for (let file = 0; file < 215; file++) writeFileSync(join(cwd, `fixture-${file}.js`),
      Array.from({ length: 60 }, (_, line) => `export const value${line} = '${'x'.repeat(80)}';`).join('\n') + '\n');
    const captured = await captureScmComparison({ cwd, sessionId: 'sess-1', source: { kind: 'workingTree' } });
    const models = projectNativeCatalogModels(ANTHROPIC_STATIC_MODELS, CLAUDE_AGENT_MODEL_CONFIG);
    const partCounts: number[] = [];
    for (const modelId of ['claude-sonnet-4-6', 'claude-opus-5']) {
      const contextWindowTokens = models.find(model => model.id === modelId)?.contextWindowTokens;
      const userInstructions = 'Explain the changes';
      const prompt = buildDiffSummaryPrompt({ comparison: captured.comparison, metadata: captured.metadata,
        files: captured.files, outputs: ['walkthrough'], instructions: userInstructions });
      const planned = planDiffSummaryAnalysis({ comparison: captured.comparison, metadata: captured.metadata,
        outputs: ['walkthrough'], instructions: userInstructions,
        prompt, contextWindowTokens });
      // Missing capacity previously left this entire million-character prompt unsplit.
      expect(planned).not.toBeNull();
      expect(contextWindowTokens).toBe(modelId === 'claude-sonnet-4-6' ? 200_000 : 1_000_000);
      let intentInput: unknown = { comparison: captured.comparison, metadata: captured.metadata,
        sourceKey: captured.metadata.sourceKey, outputs: ['walkthrough'], scmContextWindowTokens: contextWindowTokens,
        scmAnalysis: planned!.state };
      let instructions = planned!.instructions;
      let localId: string | undefined;
      let evidenceParts = 0;
      let completion;
      do {
        expect(new TextEncoder().encode(instructions).byteLength).toBeLessThanOrEqual(contextWindowTokens!);
        const state = (intentInput as { scmAnalysis: { phase: string; current: string[] } }).scmAnalysis;
        if (state.phase === 'evidence') evidenceParts++;
        const refs = state.phase === 'evidence' ? state.current
          : captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id));
        const aliases = captured.comparison.inventory.files.flatMap(file => file.occurrences)
          .filter(change => refs.includes(change.id)).map(change => change.alias);
        const start: ExecutionRunProfileStartParams = { instructions, intentInput, modelId,
          sessionId: 'sess-1', runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', backendId: 'claude',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, startedAtMs: 1,
          intent: 'scm_diff_summary', permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'long_lived', ioMode: 'streaming' };
        completion = advanceDiffSummaryAnalysis({ start, turnId: `part-${evidenceParts}-${state.phase}`,
          ...(localId ? { inputIds: [localId] } : {}), finishedAtMs: 2,
          rawText: JSON.stringify({ walkthrough: { title: 'Reading', intro: '', stops: [], otherChangeRefs: aliases } }) });
        if (!completion?.nextInput) break;
        ({ instructions, intentInput, localId } = completion.nextInput);
      } while (completion.nextInput);
      expect(completion?.toolResultOutput).toMatchObject({ runId: 'run-1',
        outputs: { walkthrough: { state: 'complete' } }, analysis: { remainingChangeRefs: [] } });
      partCounts.push(evidenceParts);
    }
    expect(partCounts[0]).toBeGreaterThan(partCounts[1]!);
    expect(partCounts[1]).toBeGreaterThan(1);
    await deleteCapturedScmComparison({ cwd, sessionId: 'sess-1', comparisonId: captured.comparison.id });
  });
});

import { createFiniteExecutionRunHostRuntime, type AgentExecutionRunRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ReviewFindingsV2, ReviewStartInput } from '@happier-dev/plugin-sdk/reviews';
import { readReviewEngineOptionsV1 } from '@happier-dev/plugin-sdk/reviews';
import { RoborevReviewError } from './document.js';
import { runRoborevReview } from './run.js';
import type { RoborevReviewOptions } from './profile.js';
import { roborevRunnerAccess } from './access.js';
import { buildAgentTargetKeyV2 } from '@happier-dev/plugin-sdk/agents';

export function createRoborevExecutionRunFactory(): AgentExecutionRunRuntimeFactory {
  return Object.freeze({
    open(request, context) {
      if (request.kind !== 'create') throw new Error('roborev supports create only');
      return createFiniteExecutionRunHostRuntime({
        request, signal: context.signal,
        unsupportedSendDiagnostic: { code: 'roborev_follow_up_unsupported', severity: 'error', message: 'Start a new review round to review again.' },
        mapFailure(error) {
          return { code: error instanceof RoborevReviewError ? error.code : 'roborev_review_failed', severity: 'error',
            message: 'roborev could not finish. Check the native review installation and repository configuration.' };
        },
        async execute({ signal, emit }) {
          // ReviewProfile owns input, scope and profile-options admission. This
          // adapter translates the admitted value; it does not re-parse it.
          const input = request.input.structuredInput as ReviewStartInput;
          const options = readReviewEngineOptionsV1(input, context.agent.id) as RoborevReviewOptions | undefined;
          const scope = input.scmReviewScope;
          const comparison = scope?.comparison;
          const range = scope?.revisionRange;
          if (input.scope === 'repository') return { status: 'failed', diagnostic: {
            code: 'roborev_scope_unsupported', severity: 'error', message: 'The native reviewer supports changes rather than repository-wide reviews.',
          } };
          if ([input.selectedPaths, input.selectedFiles].some(paths => Array.isArray(paths) && paths.length > 0)) return { status: 'failed', diagnostic: {
            code: 'roborev_scope_unsupported', severity: 'error', message: 'The native reviewer cannot restrict a review to selected files. Choose another reviewer for this selection.',
          } };
          // Capture produces trees for working-tree and session snapshots.
          // Native --sha ranges use git log and require commit endpoints.
          if (comparison?.source.kind === 'workingTree' || comparison?.source.kind === 'session') return { status: 'failed', diagnostic: {
            code: 'roborev_scope_unsupported', severity: 'error', message: 'The native reviewer cannot consume captured working-tree or session snapshots. Choose another reviewer for this comparison.',
          } };
          let scopeArgs: string[];
          if (range) scopeArgs = ['--sha', `${range.baseOid}..${range.headOid}`];
          else if (comparison?.source.kind === 'commit' && !comparison.source.parent && comparison.endpoints.after) {
            // Native single-commit review also handles a root commit, whose
            // captured before endpoint is the empty tree rather than a commit.
            scopeArgs = ['--sha', comparison.endpoints.after];
          }
          else if (comparison?.endpoints.before && comparison.endpoints.after) {
            scopeArgs = ['--sha', `${comparison.endpoints.before}..${comparison.endpoints.after}`];
          } else if (comparison) {
            // Native review cannot consume an absent captured endpoint or a
            // checkpoint body. Never substitute the currently checked-out HEAD.
            return { status: 'failed', diagnostic: { code: 'roborev_scope_unsupported', severity: 'error', message: 'The native reviewer requires committed endpoints or uncommitted working-tree changes.' } };
          } else if (input.changeType === 'uncommitted') scopeArgs = ['--dirty'];
          else if (input.changeType === 'committed' && scope?.baseRef.ref) scopeArgs = ['--sha', `${scope.baseRef.ref}..HEAD`];
          else return { status: 'failed', diagnostic: { code: 'roborev_scope_unsupported', severity: 'error', message: 'Select uncommitted changes or an admitted committed comparison.' } };
          const runnerKey = request.runnerAgentTarget ? buildAgentTargetKeyV2(request.runnerAgentTarget) : null;
          const agent = runnerKey === null ? options?.agent : new Map([
            [buildAgentTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }), 'codex'],
            [buildAgentTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }), 'claude-code'],
          ]).get(runnerKey);
          if (runnerKey !== null && !agent) return { status: 'failed', diagnostic: {
            code: 'roborev_runner_unsupported', severity: 'error', message: 'The selected runner is not supported by roborev.',
          } };
          const access = roborevRunnerAccess(request, agent ?? 'codex', options?.panel ?? 'none');
          if (access.status === 'unsupported') return { status: 'failed', diagnostic: { code: access.code, severity: 'error', message: access.message } };
          const result = await runRoborevReview(context.services, {
            runId: request.runId, cwd: request.cwd, executable: { kind: 'managedDependency', id: 'review-executable' }, signal,
            instructions: input.instructions,
            env: access.env, configuration: access.config,
            reviewArgs: [...scopeArgs, '--panel', options?.panel ?? 'none', '--type', options?.reviewType ?? 'exhaustive',
              ...(agent ? ['--agent', agent] : []), ...(options?.reasoning ? ['--reasoning', options.reasoning] : []),
              ...(access.model ? ['--model', access.model] : [])],
            onProgress: () => emit({ kind: 'run-progress' }),
            onCleanupFailure: phase => emit({ kind: 'output-delta', channel: 'reasoning',
              text: `Native reviewer cleanup failed while ${phase === 'cancel' ? 'cancelling the job' : 'stopping the daemon'}.\n` }),
          });
          const output: ReviewFindingsV2 = {
            runRef: { runId: request.runId, callId: `roborev:${request.runId}`, backendId: 'roborev' },
            ...(comparison ? { comparisonId: comparison.id } : {}), reviewOutcome: result.outcome,
            summary: result.summary,
            // Prose only: the verdict and each member's state stay structured (the finding extension) for the page to present.
            overviewMarkdown: result.summary,
            findings: result.findings.map((finding, index) => {
              const evidence = result.findingEvidence[index]!;
              return { ...finding, extensions: { 'happier.review.roborev': {
                verdict: result.verdict, kind: evidence.kind, topic: evidence.topic,
                sources: [...evidence.sources], sourceLabels: [...evidence.sourceLabels], members: result.members.map(member => ({ ...member })),
              } } };
            }),
            questions: [], assumptions: [], generatedAtMs: Date.now(),
          };
          emit({ kind: 'output-delta', channel: 'assistant', text: JSON.stringify(output) });
          // A valid document completes transport even when inspection was
          // partial or failed. The host profile owns reviewOutcome and must
          // receive the document to preserve supported findings.
          return { status: 'complete' };
        },
      });
    },
  } satisfies AgentExecutionRunRuntimeFactory);
}

import { createFiniteExecutionRunHostRuntime, type AgentExecutionRunRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ReviewFindingsV2, ReviewStartInput } from '@happier-dev/plugin-sdk/reviews';
import { PanelReviewError, type PanelReviewResult } from './document.js';
import { runPanelReview } from './run.js';
import type { PanelReviewOptions } from './profile.js';

export function createPanelExecutionRunFactory(): AgentExecutionRunRuntimeFactory {
  return Object.freeze({
    open(request, context) {
      if (request.kind !== 'create') throw new Error('Panel reviews support create only');
      return createFiniteExecutionRunHostRuntime({
        request, signal: context.signal,
        unsupportedSendDiagnostic: { code: 'panel_follow_up_unsupported', severity: 'error', message: 'Start a new review round to review again.' },
        mapFailure(error) {
          return { code: error instanceof PanelReviewError ? error.code : 'panel_review_failed', severity: 'error',
            message: 'Panel review could not finish. Check the native review installation and repository configuration.' };
        },
        async execute({ signal, emit }) {
          // ReviewProfile owns input, scope and profile-options admission. This
          // adapter translates the admitted value; it does not re-parse it.
          const input = request.input.structuredInput as ReviewStartInput;
          const options = input.engines[context.agent.id] as PanelReviewOptions | undefined;
          const scope = input.scmReviewScope;
          const comparison = scope?.comparison;
          const range = scope?.revisionRange;
          if (input.scope === 'repository') return { status: 'failed', diagnostic: {
            code: 'panel_scope_unsupported', severity: 'error', message: 'The native reviewer supports changes rather than repository-wide reviews.',
          } };
          if ([input.selectedPaths, input.selectedFiles].some(paths => Array.isArray(paths) && paths.length > 0)) return { status: 'failed', diagnostic: {
            code: 'panel_scope_unsupported', severity: 'error', message: 'The native reviewer cannot restrict a review to selected files. Choose another reviewer for this selection.',
          } };
          // Capture produces trees for working-tree and session snapshots.
          // Native --sha ranges use git log and require commit endpoints.
          if (comparison?.source.kind === 'workingTree' || comparison?.source.kind === 'session') return { status: 'failed', diagnostic: {
            code: 'panel_scope_unsupported', severity: 'error', message: 'The native reviewer cannot consume captured working-tree or session snapshots. Choose another reviewer for this comparison.',
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
            return { status: 'failed', diagnostic: { code: 'panel_scope_unsupported', severity: 'error', message: 'The native reviewer requires committed endpoints or uncommitted working-tree changes.' } };
          } else if (input.changeType === 'uncommitted') scopeArgs = ['--dirty'];
          else if (input.changeType === 'committed' && scope?.baseRef.ref) scopeArgs = ['--sha', `${scope.baseRef.ref}..HEAD`];
          else return { status: 'failed', diagnostic: { code: 'panel_scope_unsupported', severity: 'error', message: 'Select uncommitted changes or an admitted committed comparison.' } };
          if (request.providerBinding || request.modelSelection?.providerConnectionId) {
            return { status: 'failed', diagnostic: { code: 'panel_provider_binding_unsupported', severity: 'error', message: 'Configure model access in the native reviewer on this Machine.' } };
          }
          let result: PanelReviewResult;
          try { result = await runPanelReview(context.services, {
            runId: request.runId, cwd: request.cwd, executable: { kind: 'managedDependency', id: 'review-executable' }, signal,
            instructions: input.instructions,
            env: { ...request.launchEnvironment?.values, ...Object.fromEntries((request.launchEnvironment?.unset ?? []).map(key => [key, ''])) },
            reviewArgs: [...scopeArgs, '--panel', options?.panel ?? 'none', '--type', options?.reviewType ?? 'exhaustive',
              ...(options?.agent ? ['--agent', options.agent] : []), ...(options?.reasoning ? ['--reasoning', options.reasoning] : []),
              ...(request.modelSelection ? ['--model', request.modelSelection.modelId] : [])],
            onProgress: () => emit({ kind: 'run-progress' }),
          }); } catch (error) {
            if (signal.aborted && error instanceof AggregateError) return { status: 'cancelled', diagnostic: {
              code: 'panel_cleanup_failed', severity: 'error', message: 'Stop was requested, but the native reviewer could not finish cleanup.',
            } };
            throw error;
          }
          const output: ReviewFindingsV2 = {
            runRef: { runId: request.runId, callId: `panels:${request.runId}`, backendId: 'panels' },
            ...(comparison ? { comparisonId: comparison.id } : {}), reviewOutcome: result.outcome,
            summary: result.summary,
            overviewMarkdown: `${result.summary}\n\nNative verdict: ${result.verdict ?? 'unavailable'}.${result.members.length ? `\n\n${result.members.map(member => `${member.name}: ${member.status} (${member.verdict ?? 'unavailable'})`).join('\n')}` : ''}`,
            findings: result.findings.map((finding, index) => {
              const evidence = result.findingEvidence[index]!;
              return { ...finding, extensions: { 'happier.review.panels': {
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

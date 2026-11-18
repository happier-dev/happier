import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/plugin-sdk';
import { createFiniteExecutionRunHostRuntime, type AgentExecutionRunRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ReviewFindingsV2, ReviewStartInput } from '@happier-dev/plugin-sdk/reviews';
import { runSliceReview, type RunSliceReviewInput } from './run.js';

export type SliceReviewOptions = Pick<RunSliceReviewInput, 'provider' | 'model' | 'featureIds'>;

/** The host admits scope and validates the profile's options once. This leaf
 * translates that admitted input into the native repository-only contract. */
export function createSliceExecutionRunFactory(): AgentExecutionRunRuntimeFactory {
  return Object.freeze({
    open(request, context) {
      if (request.kind !== 'create') throw new Error('Slice reviews support create only');
      return createFiniteExecutionRunHostRuntime({
        request, signal: context.signal,
        unsupportedSendDiagnostic: { code: 'slices_follow_up_unsupported', severity: 'error', message: 'Start a new slice review round for another run.' },
        mapFailure: () => ({ code: 'slices_review_failed', severity: 'error', message: 'Slice review could not finish. Check the native installation and selected model access.' }),
        async execute({ signal, emit }) {
          const review = request.input.structuredInput as ReviewStartInput;
          const scope = review.scmReviewScope;
          if (review.scope !== 'repository' || scope?.scope !== 'repository' || scope.status !== 'supported' || !scope.worktreeRoot) {
            return { status: 'failed', diagnostic: { code: 'slices_scope_unsupported', severity: 'error', message: 'Slice reviews require an admitted repository scope.' } };
          }
          // Options have already crossed the host profile-schema boundary.
          const options = (review.engines.slices ?? {}) as SliceReviewOptions;
          if (request.providerBinding || request.modelSelection?.providerConnectionId) {
            return { status: 'failed', diagnostic: { code: 'slices_provider_binding_unsupported', severity: 'error', message: 'The native slice reviewer cannot translate this Provider binding. Select its configured native model access.' } };
          }
          const result = await runSliceReview({ exec: context.services.exec, fs: context.services.fs,
            cwd: scope.worktreeRoot,
            // This plugin owns the native state identity; the SDK owns its storage root.
            stateRelativePath: `repositories/${computeCanonicalDomainSeparatedDigest('review-slices.repository.v1', [scope.worktreeRoot])}`,
            ...options, model: request.modelSelection?.modelId ?? options.model,
            instructions: review.instructions, signal,
            environment: { ...request.launchEnvironment?.values,
              ...Object.fromEntries((request.launchEnvironment?.unset ?? []).map(key => [key, ''])) },
            onProgress: progress => {
              emit({ kind: 'run-progress' });
              if (progress) emit({ kind: 'output-delta', channel: 'reasoning',
                text: `${progress.phase === 'start' ? 'Started' : 'Finished'} slice ${progress.featureId} (${progress.index}/${progress.total}).\n` });
            },
          });
          const output: ReviewFindingsV2 = {
            runRef: { runId: request.runId, callId: request.runId, backendId: 'slices' },
            reviewOutcome: result.status === 'completed' ? 'complete' : result.status,
            summary: `${result.findings.length} slice review findings (${result.status})`,
            overviewMarkdown: result.errors.length ? 'Some native slice work could not finish.' : 'Native repository slice review.',
            findings: result.findings.map((finding, index) => {
              const evidence = result.findingEvidence[index]!;
              return { ...finding, extensions: { 'happier.review.slices': {
                ...evidence, locations: evidence.locations.map(location => ({ ...location })),
              } } };
            }),
            questions: [], assumptions: [], generatedAtMs: Date.now(),
          };
          emit({ kind: 'output-delta', channel: 'assistant', text: JSON.stringify(output) });
          // A valid document must reach host normalization/materialization even
          // when reviewOutcome is failed. Runtime failure skips that host path.
          return { status: 'complete' };
        },
      });
    },
  } satisfies AgentExecutionRunRuntimeFactory);
}

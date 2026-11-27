import { computeCanonicalDomainSeparatedDigest, type JsonValue } from '@happier-dev/plugin-sdk';
import { createFiniteExecutionRunHostRuntime, type AgentExecutionRunRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ReviewFindingsV2, ReviewStartInput } from '@happier-dev/plugin-sdk/reviews';
import { readReviewEngineOptionsV1 } from '@happier-dev/plugin-sdk/reviews';
import { buildAgentTargetKeyV2 } from '@happier-dev/plugin-sdk/agents';
import { runClawpatchReview, type RunClawpatchReviewInput } from './run.js';

export type ClawpatchReviewOptions = Pick<RunClawpatchReviewInput, 'provider' | 'model' | 'featureIds'>;

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** Native 0.8.4 accepts scalar dotted Codex overrides in an explicit config. */
function flattenCodexConfig(config: Readonly<Record<string, JsonValue>>, prefix = ''): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(config).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isJsonArray(value)) throw new Error('clawpatch cannot represent an array in Codex configuration');
    return value !== null && typeof value === 'object'
      ? Object.entries(flattenCodexConfig(value, path)) : [[path, value]];
  }));
}

/** The host admits scope and validates the profile's options once. This leaf
 * translates that admitted input into the native repository-only contract. */
export function createClawpatchExecutionRunFactory(): AgentExecutionRunRuntimeFactory {
  return Object.freeze({
    open(request, context) {
      if (request.kind !== 'create') throw new Error('clawpatch supports create only');
      return createFiniteExecutionRunHostRuntime({
        request, signal: context.signal,
        unsupportedSendDiagnostic: { code: 'clawpatch_follow_up_unsupported', severity: 'error', message: 'Start a new clawpatch round for another run.' },
        mapFailure: () => ({ code: 'clawpatch_review_failed', severity: 'error', message: 'clawpatch could not finish. Check the native installation and selected model access.' }),
        async execute({ signal, emit }) {
          const review = request.input.structuredInput as ReviewStartInput;
          const scope = review.scmReviewScope;
          if (review.scope !== 'repository' || scope?.scope !== 'repository' || scope.status !== 'supported' || !scope.worktreeRoot) {
            return { status: 'failed', diagnostic: { code: 'clawpatch_scope_unsupported', severity: 'error', message: 'clawpatch requires an admitted repository scope.' } };
          }
          // Options have already crossed the host profile-schema boundary.
          const options = (readReviewEngineOptionsV1(review, context.agent.id) ?? {}) as ClawpatchReviewOptions;
          const runnerKey = request.runnerAgentTarget ? buildAgentTargetKeyV2(request.runnerAgentTarget) : null;
          const provider = runnerKey === null ? options.provider : new Map([
            [buildAgentTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }), 'codex'],
            [buildAgentTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }), 'claude'],
          ]).get(runnerKey);
          if (runnerKey !== null && !provider) return { status: 'failed', diagnostic: {
            code: 'clawpatch_runner_unsupported', severity: 'error', message: 'The selected runner is not supported by clawpatch.',
          } };
          const materialization = request.providerBinding?.materialization ?? request.runnerConnectedAccountMaterialization;
          if (request.runnerConnectedAccountPurposes?.length && !materialization) return { status: 'failed', diagnostic: {
            code: 'clawpatch_runner_account_unsupported', severity: 'error', message: 'clawpatch cannot preserve the selected runner account. Choose another model access route.',
          } };
          const codexConfig = materialization?.kind === 'engineConfig'
            ? flattenCodexConfig({ model_provider: materialization.engineConfig.modelProvider!,
              ...materialization.engineConfig.config as Readonly<Record<string, JsonValue>> }) : undefined;
          const result = await runClawpatchReview({ exec: context.services.exec, fs: context.services.fs,
            cwd: scope.worktreeRoot,
            // This plugin owns the native state identity; the SDK owns its storage root.
            stateRelativePath: `repositories/${computeCanonicalDomainSeparatedDigest('review-clawpatch.repository.v1', [scope.worktreeRoot])}`,
            ...options, provider, model: request.providerBinding?.model.id ?? request.modelSelection?.modelId ?? options.model,
            codexConfig,
            instructions: review.instructions, signal,
            onCleanupFailure: () => emit({ kind: 'output-delta', channel: 'reasoning',
              text: 'clawpatch cleanup failed. The original review result is preserved.\n' }),
            environment: { ...request.launchEnvironment?.values,
              ...Object.fromEntries((request.launchEnvironment?.unset ?? []).map(key => [key, ''])),
              // Native clawpatch enforces Claude >=2.1.169 for --safe-mode.
              // Host mode preserves the admitted home and subscription token.
              ...(provider === 'claude' ? { CLAWPATCH_CLAUDE_AUTH_CONTEXT: 'host' } : {}),
              // Native 0.8.4 map/review use read-only provider modes. Bind its
              // supported Codex override to the host's already-admitted Role.
              ...(request.configuration?.workspaceWrites === 'deny' ? { CLAWPATCH_CODEX_SANDBOX: 'read-only' } : {}) },
            onProgress: progress => {
              emit({ kind: 'run-progress' });
              if (progress) emit({ kind: 'output-delta', channel: 'reasoning',
                text: `${progress.phase === 'start' ? 'Started' : 'Finished'} slice ${progress.featureId} (${progress.index}/${progress.total}).\n` });
            },
          });
          const output: ReviewFindingsV2 = {
            runRef: { runId: request.runId, callId: request.runId, backendId: 'clawpatch' },
            reviewOutcome: result.status === 'completed' ? 'complete' : result.status,
            summary: `${result.findings.length} clawpatch findings (${result.status})`,
            overviewMarkdown: result.errors.length ? 'Some native clawpatch work could not finish.' : 'Native clawpatch repository review.',
            findings: result.findings.map((finding, index) => {
              const evidence = result.findingEvidence[index]!;
              return { ...finding, extensions: { 'happier.review.clawpatch': {
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

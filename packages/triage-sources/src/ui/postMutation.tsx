import * as React from 'react';
import type { PluginActionExecution } from '@happier-dev/plugin-ui';

/**
 * The child-to-target half of Triage's post-mutation completion seam.
 *
 * A source detail owns its provider-specific controls and knows only that an Action which may have
 * changed provider state has settled. It must not update a private copy of the entry. The aggregate
 * parent owns the exact source `get`, qualification, canonical fold, and the one observation then
 * supplied to both its common header and the mounted source detail.
 *
 * The callback carries no provider result or observation on purpose: accepting either would let a
 * source renderer become an alternate aggregate owner. The already-mounted target knows the exact
 * entry and configured instance to re-read.
 */
export type TriagePostMutationCompletionV1 = () => Promise<void>;

/**
 * A source's published result vocabulary decides whether an otherwise-settled Action may have
 * changed its provider. This stays provider-owned: the shared lifecycle cannot infer whether a
 * provider's `rejected`, `unreadable`, or equivalent result followed a dispatch.
 */
export type TriagePostMutationProviderStateClassifierV1 = (
  execution: PluginActionExecution<unknown>,
) => boolean;

/**
 * The one source-side gate before asking the Triage target to re-observe.
 *
 * `outcomeUnknown` is the host's universal evidence that dispatch may already have reached the
 * provider. Other settled outcomes are not universally evidence of a remote effect, so their
 * provider's published semantics decide. The target callback remains the sole owner of the exact
 * re-read and canonical fold.
 */
export function shouldCompleteTriagePostMutation(
  execution: PluginActionExecution<unknown>,
  providerMayHaveChanged: TriagePostMutationProviderStateClassifierV1,
): boolean {
  if (execution.status === 'idle' || execution.status === 'pending') return false;
  if (execution.status === 'outcomeUnknown') return true;
  return providerMayHaveChanged(execution);
}

/** Invoke the target-owned completion once when the settled Action may have changed provider state. */
export async function completeTriagePostMutationIfNeeded(
  complete: TriagePostMutationCompletionV1,
  execution: PluginActionExecution<unknown>,
  providerMayHaveChanged: TriagePostMutationProviderStateClassifierV1,
): Promise<void> {
  if (shouldCompleteTriagePostMutation(execution, providerMayHaveChanged)) await complete();
}

const NO_AGGREGATE_COMPLETION: TriagePostMutationCompletionV1 = async () => undefined;

const TriagePostMutationCompletionContext = React.createContext<TriagePostMutationCompletionV1>(
  NO_AGGREGATE_COMPLETION,
);

export function TriagePostMutationCompletionProvider(props: Readonly<{
  onComplete: TriagePostMutationCompletionV1;
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <TriagePostMutationCompletionContext.Provider value={props.onComplete}>
      {props.children}
    </TriagePostMutationCompletionContext.Provider>
  );
}

/** Called once after any source Action outcome which may have changed provider state settles. */
export function useTriagePostMutationCompletion(): TriagePostMutationCompletionV1 {
  return React.useContext(TriagePostMutationCompletionContext);
}

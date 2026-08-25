import * as React from 'react';

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

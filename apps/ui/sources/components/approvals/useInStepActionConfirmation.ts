import * as React from 'react';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

import { readApprovalPreviewSummary } from './actionApprovalPresentation';
import type { ActionConfirmationReviewInput } from './ActionConfirmationReview';

type PresentUserActionConfirmation = NonNullable<
  ActionExecutorDeps['presentUserActionConfirmation']
>;

/** The receiving executor's carried review, waiting on the step's own primary press. */
export type InStepActionConfirmation = ActionConfirmationReviewInput & Readonly<{
  /** The review's consequence sentence, when it carries one; the step shows it in place of its own description. */
  summary: string | null;
}>;

/**
 * An in-flow step that already is the person's review (Install updates, Create) is also the executor's confirmation
 * host: when the receiving executor carries its review back, the step shows it and its own primary press answers,
 * so no dialog follows. Pass `confirm` as the dispatch's `presentUserActionConfirmation`; `answer` settles it.
 */
export function useInStepActionConfirmation() {
  const [pending, setPending] = React.useState<InStepActionConfirmation | null>(
    null,
  );
  const resolver = React.useRef<((confirmed: boolean) => void) | null>(null);
  const answer = React.useCallback((confirmed: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(confirmed);
  }, []);
  const confirm = React.useCallback<PresentUserActionConfirmation>(
    ({ actionId, input, preview, context }) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        context.signal?.addEventListener(
          'abort',
          () => {
            if (resolver.current === resolve) answer(false);
          },
          { once: true },
        );
        setPending({
          actionId,
          actionArgs: input,
          preview,
          summary: readApprovalPreviewSummary(preview, {
            actionId,
            actionArgs: input,
          }),
        });
      }),
    [answer],
  );
  // A step that leaves never confirms.
  React.useEffect(
    () => () => {
      const resolve = resolver.current;
      resolver.current = null;
      resolve?.(false);
    },
    [],
  );
  return { pending, confirm, answer };
}

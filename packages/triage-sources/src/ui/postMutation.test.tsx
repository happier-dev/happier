import { describe, expect, it, vi } from 'vitest';

import {
  completeTriagePostMutationIfNeeded,
  shouldCompleteTriagePostMutation,
} from './postMutation.js';

describe('post-mutation completion policy', () => {
  it('treats a host outcome-unknown as potentially changing state without consulting a provider classifier', async () => {
    const complete = vi.fn(async () => undefined);
    const providerMayHaveChanged = vi.fn(() => false);

    await completeTriagePostMutationIfNeeded(
      complete,
      { status: 'outcomeUnknown', code: 'timeout', message: 'Timed out after dispatch.' },
      providerMayHaveChanged,
    );

    expect(providerMayHaveChanged).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('keeps a host error non-reconciling unless its provider semantics establish a possible change', () => {
    const error = {
      status: 'error' as const,
      code: 'provider_transport_failed',
      message: 'The action failed before its result was available.',
      retryable: true,
    };

    expect(shouldCompleteTriagePostMutation(error, () => false)).toBe(false);
    expect(shouldCompleteTriagePostMutation(error, () => true)).toBe(true);
  });
});

// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  completeTriagePostMutationIfNeeded,
  shouldCompleteTriagePostMutation,
  TriagePostMutationCompletionProvider,
  useTriagePostMutationCompletion,
} from './postMutation.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

function Consumer(): React.ReactElement {
  const complete = useTriagePostMutationCompletion();
  return <button onClick={() => { void complete(); }}>settled</button>;
}

describe('TriagePostMutationCompletionProvider', () => {
  it('routes a settled source action to the one target-owned completion callback', async () => {
    const onComplete = vi.fn(async () => undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <TriagePostMutationCompletionProvider onComplete={onComplete}>
          <Consumer />
        </TriagePostMutationCompletionProvider>,
      );
    });
    await act(async () => { container?.querySelector('button')?.click(); });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('is safe when a source detail is mounted outside the Triage aggregate', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => { root?.render(<Consumer />); });
    await expect(async () => {
      await act(async () => { container?.querySelector('button')?.click(); });
    }).not.toThrow();
  });
});

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

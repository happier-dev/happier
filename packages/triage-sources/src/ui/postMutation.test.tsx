// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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

// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTriageListWindowViewDemand } from './useTriageListWindowViewDemand.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

type Props = Readonly<{
  active: boolean;
  demand: () => Promise<void>;
}>;

function render(initial: Props): Readonly<{
  update(next: Props): Promise<void>;
}> {
  function Probe(props: Props): null {
    useTriageListWindowViewDemand(props.active, props.demand);
    return null;
  }

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => { root?.render(<Probe {...initial} />); });

  return Object.freeze({
    async update(next) {
      await act(async () => { root?.render(<Probe {...next} />); });
    },
  });
}

describe('the mounted Triage list view-demand producer', () => {
  it('does not demand while first mounted or retained inactive, including callback replacement', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const harness = render({ active: false, demand: first });

    expect(first).not.toHaveBeenCalled();

    await harness.update({ active: false, demand: second });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    await harness.update({ active: true, demand: second });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('emits one mount demand plus each later host-active regain, leaving burst coalescing to the existing window owner', async () => {
    const demand = vi.fn(async () => {});
    const harness = render({ active: true, demand });

    expect(demand).toHaveBeenCalledTimes(1);

    // The host supplies this one public active fact. Each regain is a named
    // producer, but this adapter owns no timer, scheduler or provider call:
    // its three `view` demands are coalesced by the mounted window's existing
    // owner.
    await harness.update({ active: false, demand });
    await harness.update({ active: true, demand });
    await harness.update({ active: false, demand });
    await harness.update({ active: true, demand });

    expect(demand).toHaveBeenCalledTimes(3);
  });

  it('starts a fresh mounted window even when the host is already active', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const harness = render({ active: true, demand: first });

    await harness.update({ active: true, demand: second });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

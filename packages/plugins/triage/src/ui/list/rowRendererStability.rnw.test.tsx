// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import {
  readTriageListSectionItemKey,
  useTriageListRowRenderer,
  type TriageListContinuationCopyV1,
  type TriageRowPinHandlersV1,
} from './rows.js';

/**
 * Focus movement must stay local to the rows it moves between.
 *
 * The shared `List` memoizes its flattened traversal order, its key index, its
 * roving-entry array and every mounted cell on the identity of the two
 * callbacks the surface hands it. A focus move re-renders the surface, so if
 * either identity is rebuilt per render the whole window — two thousand rows —
 * is reprojected to move a cursor one row.
 *
 * These cases own the renderer half: it fails if the renderer becomes an inline
 * lambda again, and it fails the other way if a renderer is frozen so hard it
 * stops following the handlers a row's controls actually need. The key half is
 * a module constant, so its stability is structural rather than observable
 * here; what IS observable is that the one reader answers for both item kinds,
 * which the obvious wrong reader — `(item) => item.row.key` — does not.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pinHandlers(overrides: Partial<TriageRowPinHandlersV1> = {}): TriageRowPinHandlersV1 {
  return {
    busyKey: null,
    unavailableReason: null,
    onSetPinned: (_row: TriageListDisplayRowV1) => undefined,
    ...overrides,
  };
}

const CONTINUATION_COPY: TriageListContinuationCopyV1 = {
  title: 'More entries may exist',
  description: 'This window is bounded.',
};

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function renderRendererProbe(): Readonly<{
  observed: ReadonlyArray<unknown>;
  update: (handlers: TriageRowPinHandlersV1) => void;
}> {
  const observed: unknown[] = [];
  const continuationCopy = () => CONTINUATION_COPY;

  function Probe(props: Readonly<{ handlers: TriageRowPinHandlersV1 }>): null {
    observed.push(useTriageListRowRenderer({ continuationCopy, handlers: props.handlers }));
    return null;
  }

  container = document.createElement('div');
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  return {
    observed,
    update: (handlers) => {
      act(() => {
        mounted.render(<Probe handlers={handlers} />);
      });
    },
  };
}

describe('the identities the shared List memoizes on', () => {
  it('addresses both section item kinds through the one key reader', () => {
    // A continuation row has no `row`, and its key is the section's own
    // continuation identity rather than any entry key, so a reader that reached
    // through `item.row` would leave the list with one undefined key.
    const entryKey = 'happier.forge/items|pull-request|origin|31';
    expect(readTriageListSectionItemKey({
      kind: 'entry',
      key: entryKey,
      row: { key: 'not-the-list-key' } as never,
    })).toBe(entryKey);
    expect(readTriageListSectionItemKey({
      kind: 'continuation',
      key: 'continuation:open',
    })).toBe('continuation:open');
  });

  it('keeps one row renderer across renders that only moved focus', () => {
    const handlers = pinHandlers();
    const probe = renderRendererProbe();

    // Three renders with the surface's Pin/Unpin facts unchanged — exactly what
    // a `rowFocused` dispatch produces.
    probe.update(handlers);
    probe.update(handlers);
    probe.update(handlers);

    expect(probe.observed).toHaveLength(3);
    expect(probe.observed[1]).toBe(probe.observed[0]);
    expect(probe.observed[2]).toBe(probe.observed[0]);
  });

  it('still follows the handlers when a Pin write actually changes them', () => {
    const probe = renderRendererProbe();

    probe.update(pinHandlers());
    probe.update(pinHandlers({ busyKey: 'happier.forge/items|pull-request|origin|31' }));

    expect(probe.observed[1]).not.toBe(probe.observed[0]);
  });
});

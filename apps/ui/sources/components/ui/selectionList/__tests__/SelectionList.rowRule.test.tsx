import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SelectionList } from '../SelectionList';
import type {
  SelectionListOption,
  SelectionListOptionPresentation,
  SelectionListStep,
} from '../_types';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('@legendapp/list/react-native', async () => {
  const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
  return await createLegendListModuleMock({ renderItems: true, renderItemLimit: 20 });
});

const IDS = ['a', 'b', 'c', 'd'] as const;

function step(lines: 1 | 2, virtualization: 'force' | 'never' = 'never'): SelectionListStep {
  const options: SelectionListOption[] = IDS.map((id) => ({
    id,
    label: `Session ${id}`,
    ...(lines === 2 ? { subtitle: `~/code/${id}` } : {}),
  }));
  return {
    id: 'root',
    sections: [{ kind: 'static', id: 'sessions', options, virtualization }],
  };
}

/** The options under which the list draws the one list-row rule. */
function ruled(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
  return IDS.filter((id) => {
    const wrapper = screen.findByTestId(`sl:root:option-wrapper:${id}`);
    return (
      (wrapper?.findAll(
        (node) => node.props?.testID === 'happier-list-row-rule',
      ).length ?? 0) > 0
    );
  });
}

async function render(
  lines: 1 | 2,
  presentation: SelectionListOptionPresentation,
  selectedIds?: ReadonlySet<string>,
  virtualization: 'force' | 'never' = 'never',
) {
  return renderScreen(
    <SelectionList
      rootStep={step(lines, virtualization)}
      optionPresentation={presentation}
      {...(selectedIds
        ? {
            selection: { kind: 'multiple' as const, selectedIds },
            selectionMark: 'none' as const,
          }
        : {})}
      onSelect={vi.fn()}
      onRequestClose={vi.fn()}
      disableTransitions
      testID="sl"
    />,
  );
}

describe('the one list-row rule in a selection list (owner 2026-11-17 23:52Z, DESIGN.md 2026-11-15)', () => {
  it.each(['row', 'menu'] as const)(
    'parts two-line %s rows by a rule under every row another follows',
    async (presentation) => {
      const screen = await render(2, presentation);
      const drawn = ruled(screen);
      // Never after the last row, and never under a filled (focused) row nor the row above it.
      expect(drawn).not.toContain('d');
      expect(drawn.length).toBeGreaterThanOrEqual(2);
    },
  );

  it.each(['row', 'menu'] as const)(
    'draws no rule between one-line %s rows',
    async (presentation) => {
      const screen = await render(1, presentation);
      expect(ruled(screen)).toEqual([]);
    },
  );

  it('keeps the rule under chosen rows of a multiple-choice list, which mark their choice with the check alone', async () => {
    // The list's one highlight lands on the first choice (b); the second choice (c) is checked but not filled.
    const screen = await render(2, 'row', new Set(['b', 'c']));
    expect(ruled(screen)).toEqual(['c']);
  });

  it('states the same order on the virtualized path', async () => {
    const screen = await render(2, 'row', new Set(['b', 'c']), 'force');
    expect(ruled(screen)).toEqual(['c']);
  });
});

import { describe, expect, it } from 'vitest';

import { HappierCollectionRowContent } from './CollectionRowContent.js';
import {
  HappierListRowFollowedContext,
  HappierListRowPrecedesSelectedContext,
} from './CollectionList.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';

const FILLS = Object.freeze({ selected: '#e0e0e0', hover: '#f0f0f0' });
const SEPARATOR = Object.freeze({ color: '#d0d0d0' });

function row(
  input: Readonly<{
    followed: boolean | null;
    lines?: 1 | 2;
    selected?: boolean;
    hovered?: boolean;
    precedesSelected?: boolean;
  }>,
) {
  const content = (
    <HappierCollectionRowContent
      density="compact"
      fills={FILLS}
      separator={SEPARATOR}
      selected={input.selected === true}
      hovered={input.hovered === true}
      identity={<span>mark</span>}
      title={<span>Session title</span>}
    >
      {input.lines === 1 ? null : <span>Working · 2m</span>}
    </HappierCollectionRowContent>
  );
  return (
    <HappierListRowFollowedContext.Provider value={input.followed}>
      <HappierListRowPrecedesSelectedContext.Provider
        value={input.precedesSelected === true}
      >
        {content}
      </HappierListRowPrecedesSelectedContext.Provider>
    </HappierListRowFollowedContext.Provider>
  );
}

function rule(
  view: ReturnType<typeof mountThroughReactNativeWeb>,
): HTMLElement | null {
  return view.container.querySelector<HTMLElement>(
    '[data-testid="happier-list-row-rule"]',
  );
}

describe('the list-row rule on the shared work row (owner 2026-11-15: inset hairlines in every list)', () => {
  it('runs under a row another row follows, from its text column rather than the row edge', () => {
    const view = mountThroughReactNativeWeb(row({ followed: true }));
    try {
      const line = rule(view);
      expect(line).not.toBeNull();
      expect(
        Number.parseFloat(
          getComputedStyle(line!).left || line!.style.left || '0',
        ),
      ).toBeGreaterThan(0);
    } finally {
      view.unmount();
    }
  });

  it("draws nothing after a section's last row, or where no list states the order", async () => {
    const view = mountThroughReactNativeWeb(row({ followed: false }));
    try {
      expect(rule(view)).toBeNull();
      await view.render(row({ followed: null }));
      expect(rule(view)).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('steps aside for a filled row: selected, hovered, or the one above the selected row', async () => {
    const view = mountThroughReactNativeWeb(
      row({ followed: true, selected: true }),
    );
    try {
      expect(rule(view)).toBeNull();
      await view.render(row({ followed: true, hovered: true }));
      expect(rule(view)).toBeNull();
      await view.render(row({ followed: true, precedesSelected: true }));
      expect(rule(view)).toBeNull();
      await view.render(row({ followed: true }));
      expect(rule(view)).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
  it('parts one-line rows by spacing alone (owner 2026-11-15 ~20:40Z)', () => {
    const view = mountThroughReactNativeWeb(row({ followed: true, lines: 1 }));
    try {
      expect(rule(view)).toBeNull();
    } finally {
      view.unmount();
    }
  });
});

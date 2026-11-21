import * as React from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { View } from 'react-native';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '@happier-dev/plugin-sdk/testing';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierPageSectionContext } from '../layout/PageSection.js';
import {
  HappierCollectionListRowScope,
  HappierCollectionTableRowContext,
} from './CollectionList.js';
import { HappierListItem, HappierRowActionsReveal } from './List.js';

// A collection's rows on a page sheet and in a navigation column hide their "…" from a mouse until the row is the
// pointer's, as a collection table's rows do (U8 A3: 24 menus on screen at rest on the Reviews page and column).
it.each([
  [
    'a page sheet',
    (row: React.ReactElement) => (
      <HappierPageSectionContext.Provider
        value={{ rowDividerColor: '#ddd', rowInsetPx: 16 }}
      >
        <HappierCollectionTableRowContext.Provider value={{ hairline: true }}>
          {row}
        </HappierCollectionTableRowContext.Provider>
      </HappierPageSectionContext.Provider>
    ),
  ],
  [
    'a navigation column',
    (row: React.ReactElement) => (
      <HappierCollectionListRowScope>
        <HappierCollectionTableRowContext.Provider value={{ hairline: true }}>
          {row}
        </HappierCollectionTableRowContext.Provider>
      </HappierCollectionListRowScope>
    ),
  ],
])(
  'a collection row on %s reveals its actions only under a precise pointer',
  (_where, wrap) => {
    const previousMatchMedia = globalThis.matchMedia;
    // Browser input capability is the boundary; the row owner stays real.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: fine)' || query === '(hover: hover)',
    }));
    const view = mountThroughReactNativeWeb(
      wrap(
        <HappierListItem
          theme={SURFACE_CONTEXT_THEME_FIXTURE}
          title="Fix settings modal remount"
          testID="row"
          onPress={() => {}}
          hasSecondaryActions
          accessoryOutsidePressable
          accessoryIsRowActions
          accessory={
            <HappierRowActionsReveal>
              <View testID="action" />
            </HappierRowActionsReveal>
          }
        />,
      ),
    );
    try {
      const row = view.container.querySelector<HTMLElement>(
        '[data-testid="row"]',
      )!;
      const action = view.container.querySelector<HTMLElement>(
        '[data-testid="action"]',
      )!;
      const opacity = () => {
        for (
          let node: HTMLElement | null = action;
          node && node !== view.container;
          node = node.parentElement
        )
          if (getComputedStyle(node).opacity === '0') return '0';
        return '1';
      };
      expect(opacity()).toBe('0');
      act(() =>
        row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
      );
      expect(opacity()).toBe('1');
      act(() =>
        row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })),
      );
      expect(opacity()).toBe('0');
    } finally {
      view.unmount();
      vi.stubGlobal('matchMedia', previousMatchMedia);
    }
  },
);

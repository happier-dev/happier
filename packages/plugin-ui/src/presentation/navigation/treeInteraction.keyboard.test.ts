import * as React from 'react';
import renderer from 'react-test-renderer';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import {
  useHappierTreeInteraction,
  type HappierTreeNode,
} from './treeInteraction.js';

// Its own file: the page-level press and key trackers install once per module, so this page must be the first
// one the module sees for its listeners to be the ones a key press reaches.
describe('shared tree interaction, keyboard', () => {
  it('lets Tab carry focus out of a web tree row instead of pulling it back (no keyboard trap)', async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const listeners = new Map<string, (event: { key?: string }) => void>();
    const body = { kind: 'body' };
    // In a browser the row's blur runs while focus sits on the page itself, before the next control takes it.
    (globalThis as { document?: unknown }).document = {
      body,
      activeElement: body,
      addEventListener: (
        type: string,
        listener: (event: { key?: string }) => void,
      ) => {
        listeners.set(type, listener);
      },
    };
    try {
      const rows: HappierTreeNode[] = [
        {
          key: 'row-0',
          parentKey: null,
          depth: 0,
          kind: 'leaf',
          expanded: false,
        },
      ];
      const focused: string[] = [];
      let tree: ReturnType<typeof useHappierTreeInteraction> | null = null;
      function Probe() {
        const [focusedKey, setFocusedKey] = React.useState<string | null>(
          'row-0',
        );
        tree = useHappierTreeInteraction({
          visibleNodes: rows,
          focusedKey,
          onFocus: setFocusedKey,
          onExpandedChange: () => {},
          onActivate: () => {},
        });
        return null;
      }
      act(() => {
        renderer.create(React.createElement(Probe));
      });
      act(() => {
        tree!.bindFocusTarget('row-0', {
          focus: () => {
            focused.push('row-0');
          },
        });
      });
      const blurRow = async () => {
        act(() => {
          tree!.onFocusChange('row-0', true);
          tree!.onFocusChange('row-0', false);
        });
        await Promise.resolve();
      };

      // Tab (and Shift+Tab) move focus to the next control: the row lets it go.
      listeners.get('keydown')?.({ key: 'Tab' });
      await blurRow();
      expect(focused).toEqual([]);

      // Once that key press is over, a blur to nothing is still a windowed list moving the row: it keeps focus.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await blurRow();
      expect(focused).toEqual(['row-0']);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});

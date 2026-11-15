import * as React from 'react';
import {
  useHappierTreeInteraction,
  type HappierTreeNode,
} from '@happier-dev/plugin-ui/presentation';

import type { CollectionNavigationRow } from '@/components/ui/lists/collection/CollectionList';

type CollectionNavigationRowTreeItem = NonNullable<React.ComponentProps<typeof CollectionNavigationRow>['treeItem']>;

/** A column tree's row as the tree reads it: its key, depth (0 at the top), and whether and how it discloses. */
export type CollectionTreeRow = Readonly<{
  key: string;
  level: number;
  expandable: boolean;
  expanded: boolean;
}>;

/**
 * A column's disclosure tree (Projects, Services) bound to the shared tree owner (`useHappierTreeInteraction`):
 * treeitem levels and expanded state, one roving tab stop, arrows/Home/End move, Right/Left/Space disclose, Enter
 * activates (what a press on the row does). Focus repairs to the nearest visible ancestor when a branch closes.
 * Rows are the visible rows in drawing order; each `CollectionNavigationRow` takes `getRowProps(row)` as `treeItem`.
 */
export function useCollectionTreeKeyboard<Row extends CollectionTreeRow>(
  rows: readonly Row[],
  handlers: Readonly<{
    onToggle: (key: string) => void;
    onOpenRow: (row: Row) => void;
    /** A windowed list brings the row at this visible index into view, so focus can land on it once it mounts. */
    onRevealIndex?: (index: number) => void;
  }>,
) {
  const visibleNodes = React.useMemo((): HappierTreeNode[] => {
    const ancestors: Row[] = [];
    return rows.map((row) => {
      while (
        ancestors.length > 0 &&
        ancestors[ancestors.length - 1]!.level >= row.level
      )
        ancestors.pop();
      const node: HappierTreeNode = {
        key: row.key,
        parentKey: ancestors[ancestors.length - 1]?.key ?? null,
        depth: row.level,
        kind: row.expandable ? 'branch' : 'leaf',
        expanded: row.expanded,
      };
      if (row.expandable) ancestors.push(row);
      return node;
    });
  }, [rows]);
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  const handlersRef = React.useRef(handlers);
  handlersRef.current = handlers;
  const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
  const tree = useHappierTreeInteraction({
    visibleNodes,
    focusedKey,
    onFocus: setFocusedKey,
    onExpandedChange: (key, expanded) => {
      const row = rowsRef.current.find((candidate) => candidate.key === key);
      if (row && row.expanded !== expanded) handlersRef.current.onToggle(key);
    },
    onActivate: (key) => {
      const row = rowsRef.current.find((candidate) => candidate.key === key);
      if (row) handlersRef.current.onOpenRow(row);
    },
    onRevealIndex: (index) => handlersRef.current.onRevealIndex?.(index),
  });
  const { activeKey, bindFocusTarget, onFocusChange, onKeyDown, positionOf } =
    tree;
  const getRowPropsForActiveKey = React.useCallback(
    (
      row: Row,
      rowActiveKey: string | null,
    ): CollectionNavigationRowTreeItem => {
      // Where the row stands in the whole tree: a windowed list builds only some rows, out of order.
      const position = positionOf(row.key);
      return {
        webRole: 'treeitem',
        webTabIndex: row.key === rowActiveKey ? 0 : -1,
        accessibilityLevel: row.level + 1,
        ...(position
          ? {
              accessibilityPositionInSet: position.positionInSet,
              accessibilitySetSize: position.setSize,
            }
          : {}),
        accessibilityExpanded: row.expandable ? row.expanded : undefined,
        pressableRef: (target) =>
          bindFocusTarget(
            row.key,
            target?.focus ? { focus: () => target.focus?.() } : null,
          ),
        onFocus: () => onFocusChange(row.key, true),
        onBlur: () => onFocusChange(row.key, false),
        onKeyDown: (event) => {
          const key = event.nativeEvent?.key ?? event.key;
          if (key && onKeyDown(row.key, key, event)) event.preventDefault?.();
        },
      };
    },
    [bindFocusTarget, onFocusChange, onKeyDown, positionOf],
  );
  const getRowProps = React.useCallback(
    (row: Row) => getRowPropsForActiveKey(row, activeKey),
    [activeKey, getRowPropsForActiveKey],
  );
  return { activeKey, getRowProps, getRowPropsForActiveKey, positionOf };
}

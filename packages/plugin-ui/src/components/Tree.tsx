import {
  Fragment,
  useCallback,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { View } from 'react-native';

import { useHappierUiAccessibility } from '../environment/context.js';
import { useHappierNativeMinimumInteractiveTargetSize } from '../environment/interactiveTarget.js';
import { useHappierPageChromeInternal } from '../presentation/layout/pageChrome.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { HAPPIER_COLLECTION_LIST_METRICS } from '../presentation/collection/CollectionList.js';
import { HAPPIER_TREE_ROW_METRICS, HappierTreeRow, resolveHappierTreeRowIndentPx } from '../presentation/navigation/TreeRow.js';
import {
  useHappierTreeInteraction,
  type HappierTreeNode,
} from '../presentation/navigation/treeInteraction.js';
import { usePluginTheme } from './PluginUiProvider.js';

/** One visible row of an author's tree: the shared tree node plus what the row says. */
export type TreeItem = HappierTreeNode &
  Readonly<{
    title: string;
    /** The item's own mark (a folder or file glyph); it stands alone, never on a tile. */
    mark?: ReactNode;
    /** One quiet fact at the trailing edge ("2 days"). */
    meta?: string;
  }>;

export type TreeProps = Readonly<{
  /**
   * The author's current visible projection, in display order: a collapsed branch's descendants are absent.
   * The tree never crawls or pages; the owner of the data does.
   */
  items: readonly TreeItem[];
  /** Open or close a branch in place (its chevron, Right/Left). Never opens anything. */
  onExpandedChange: (key: string, expanded: boolean) => void;
  /** The row's own operation (press, Enter): open the file, show the folder. */
  onActivate: (key: string) => void;
  /** Each branch chevron's accessible name, with the item's name ("Expand docs"). */
  expandLabel: (item: TreeItem) => string;
  collapseLabel: (item: TreeItem) => string;
  /** The item whose detail is shown, drawn on the selected chip. */
  selectedKey?: string | null;
  /** Controlled keyboard focus; omitted, the tree keeps its own. */
  focusedKey?: string | null;
  onFocusedKeyChange?: (key: string) => void;
  /** An author's own controls at a row's trailing edge (a ⋯ menu). */
  renderTrailing?: (item: TreeItem) => ReactNode;
  /** An in-place editor instead of the title/meta/controls. The author owns its draft and Save/Cancel. */
  renderInlineEdit?: (item: TreeItem) => ReactNode;
  /**
   * The row inside the author's own host (a drag source, a drop outline, a measured box). The tree still draws the
   * row and owns its keyboard and semantics; the host only surrounds it. It must render `row` exactly once.
   */
  wrapRow?: (item: TreeItem, row: ReactElement) => ReactNode;
  /** `table`: the list-row rhythm, for a tree drawn with a column beside its names. */
  presentation?: 'tree' | 'table';
  accessibilityLabel: string;
  testID?: string;
}>;

/**
 * A plugin author's tree, drawn with the same row, rhythm and keyboard as Happier's own file trees: Up/Down/Home/
 * End move focus, Right expands or enters a child, Left collapses or returns to the parent, Enter activates.
 * Disclosure and activation stay separate intents, so opening a branch never opens an item.
 */
/** The shared tree row's own outset from its column (its hover chip's inset), already part of where a row starts. */
const TREE_ROW_MARGIN_PX = HAPPIER_COLLECTION_LIST_METRICS.rowInset - HAPPIER_TREE_ROW_METRICS.basePaddingPx;

export function Tree(props: TreeProps): ReactElement {
  const theme = usePluginTheme();
  const { reducedMotion } = useHappierUiAccessibility();
  const [ownFocusedKey, setOwnFocusedKey] = useState<string | null>(null);
  const focusedKey =
    props.focusedKey === undefined ? ownFocusedKey : props.focusedKey;
  const { onFocusedKeyChange } = props;
  const onFocus = useCallback(
    (key: string) => {
      setOwnFocusedKey(key);
      onFocusedKeyChange?.(key);
    },
    [onFocusedKeyChange],
  );
  const interaction = useHappierTreeInteraction({
    visibleNodes: props.items,
    focusedKey,
    onFocus,
    onExpandedChange: props.onExpandedChange,
    onActivate: props.onActivate,
  });
  // A touch host (its native target floor) draws the touch row height.
  const touch = useHappierNativeMinimumInteractiveTargetSize() !== undefined;
  // Phone-narrow by the tree's own measured width, the Collection's rule: before the first measurement the host's
  // phone header (it shows the title) already says so, so the first frame composes right.
  const pageChrome = useHappierPageChromeInternal();
  const [width, setWidth] = useState<number | null>(null);
  const compact = width === null ? pageChrome?.showsTitle === true : width < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx;
  // Only a tree with something to disclose keeps the disclosure column: a flat one is a list, its marks on the edge.
  const disclosureColumn = props.items.some((item) => item.kind === 'branch');
  return (
    <View
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width;
        setWidth((current) => (current === next ? current : next));
      }}
      role="tree"
      aria-label={props.accessibilityLabel}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
    >
      {props.items.map((item) => {
        const row = (
          <HappierTreeRow
            key={item.key}
            node={item}
            position={interaction.positionOf(item.key)}
            title={item.title}
            mark={item.mark}
            meta={item.meta}
            trailing={props.renderTrailing?.(item)}
            inlineEdit={props.renderInlineEdit?.(item)}
            selected={props.selectedKey === item.key}
            tabStop={interaction.activeKey === item.key}
            presentation={props.presentation}
            disclosureColumn={disclosureColumn}
            // A table tree stands on a page's sheet: its rows start where the page's rows do (their marks on one edge).
            {...(props.presentation === 'table' ? { style: { paddingLeft: resolveHappierTreeRowIndentPx(item.depth, {
              basePaddingPx: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx - TREE_ROW_MARGIN_PX }) } } : {})}
            touch={touch}
            compact={compact}
            theme={theme}
            reducedMotion={reducedMotion}
            onActivate={() => props.onActivate(item.key)}
            onFocus={() => interaction.onFocusChange(item.key, true)}
            onBlur={() => interaction.onFocusChange(item.key, false)}
            onKeyDown={(keyboardKey, event) =>
              interaction.onKeyDown(item.key, keyboardKey, event)
            }
            controlRef={(target) => interaction.bindFocusTarget(item.key, target)}
            disclosure={
              item.kind === 'branch'
                ? {
                    onPress: () =>
                      props.onExpandedChange(item.key, !item.expanded),
                    accessibilityLabel: item.expanded
                      ? props.collapseLabel(item)
                      : props.expandLabel(item),
                    ...(props.testID === undefined
                      ? {}
                      : { testID: `${props.testID}:disclosure:${item.key}` }),
                  }
                : undefined
            }
            {...(props.testID === undefined
              ? {}
              : { testID: `${props.testID}:row:${item.key}` })}
          />
        );
        return props.wrapRow ? (
          <Fragment key={item.key}>{props.wrapRow(item, row)}</Fragment>
        ) : (
          row
        );
      })}
    </View>
  );
}

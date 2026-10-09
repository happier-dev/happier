import {
  useCallback,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { View } from 'react-native';

import { useHappierUiAccessibility } from '../environment/context.js';
import { useHappierNativeMinimumInteractiveTargetSize } from '../environment/interactiveTarget.js';
import { HappierTreeRow } from '../presentation/navigation/TreeRow.js';
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
  return (
    <View
      role="tree"
      aria-label={props.accessibilityLabel}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
    >
      {props.items.map((item) => (
        <HappierTreeRow
          key={item.key}
          node={item}
          title={item.title}
          mark={item.mark}
          meta={item.meta}
          trailing={props.renderTrailing?.(item)}
          selected={props.selectedKey === item.key}
          tabStop={interaction.activeKey === item.key}
          presentation={props.presentation}
          touch={touch}
          theme={theme}
          reducedMotion={reducedMotion}
          onActivate={() => props.onActivate(item.key)}
          onFocus={() => onFocus(item.key)}
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
      ))}
    </View>
  );
}

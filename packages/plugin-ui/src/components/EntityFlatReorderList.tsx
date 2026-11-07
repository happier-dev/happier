import { Fragment, type ReactElement, type ReactNode } from 'react';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

export type EntityFlatReorderItem = Readonly<{ id: string; title: string }>;
export type EntityFlatReorderControls = Readonly<{
  renderHandle(testID?: string): ReactNode;
  moveBy(delta: number): Promise<boolean>;
}>;
export type EntityFlatReorderListProps = Readonly<{
  /** Distinguishes this list within the plugin's mounted surface. */
  localId: string;
  testID: string;
  items: readonly EntityFlatReorderItem[];
  /** The next item after the moved item, or null for the end of the list. */
  onReorder?: (id: string, beforeId: string | null) => Promise<boolean>;
  renderItem(item: EntityFlatReorderItem, controls: EntityFlatReorderControls): ReactNode;
}>;

const READ_ONLY_CONTROLS: EntityFlatReorderControls = {
  renderHandle: () => null,
  moveBy: async () => false,
};

/** The host's existing flat reorder owner supplies its grip, keyboard and touch chooser. */
export function EntityFlatReorderList(props: EntityFlatReorderListProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  return <>{host?.renderEntityFlatReorderList?.(props)
    ?? props.items.map(item => <Fragment key={item.id}>{props.renderItem(item, READ_ONLY_CONTROLS)}</Fragment>)}</>;
}

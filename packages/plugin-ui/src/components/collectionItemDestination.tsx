import { cloneElement, type ReactElement, type ReactNode } from 'react';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';
import type { ItemProps } from './List.js';
import type { CollectionAnatomy } from './Collection.js';

/** Retain the one List.Item menu when the host decorates a Collection item in any presentation. */
export function renderCollectionItemDestination<Item>(host: PluginUiPresentationHost | null, anatomy: CollectionAnatomy<Item>, item: Item, row: ReactElement<ItemProps>): ReactNode {
  const destination = anatomy.destination?.(item);
  const decorated = destination && host?.renderDestinationRow ? host.renderDestinationRow({
    ...destination, children: row,
    renderWithSecondaryActions: additional => cloneElement(row, {
      secondaryActions: [...(row.props.secondaryActions ?? []), ...additional.secondaryActions],
      onSecondaryAction: id => additional.secondaryActions.some(action => action.id === id)
        ? additional.onSecondaryAction(id) : row.props.onSecondaryAction?.(id),
    }),
  }) : row;
  return anatomy.wrapItem ? anatomy.wrapItem(item, decorated) : decorated;
}

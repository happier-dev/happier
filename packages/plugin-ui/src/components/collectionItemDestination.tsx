import { cloneElement, type ReactElement, type ReactNode } from 'react';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';
import type { ItemProps } from './List.js';
import type { CollectionAnatomy } from './Collection.js';

/** Retain the one List.Item menu when the host decorates a Collection item in any presentation. */
export function renderCollectionItemDestination<Item>(host: PluginUiPresentationHost | null, anatomy: CollectionAnatomy<Item>, item: Item, row: ReactElement<ItemProps>): ReactNode {
  const destination = anatomy.destination?.(item);
  // The row's own interactions stay nearest its content, including its explicit native drag source.
  const wrap = (content: ReactElement<ItemProps>) => anatomy.wrapItem ? anatomy.wrapItem(item, content) : content;
  return destination && host?.renderDestinationRow ? host.renderDestinationRow({
    ...destination, children: wrap(row),
    renderWithSecondaryActions: additional => wrap(cloneElement(row, {
      secondaryActions: [...(row.props.secondaryActions ?? []), ...additional.secondaryActions],
      onSecondaryAction: (id, selection) => additional.secondaryActions.some(action => action.id === id)
        ? additional.onSecondaryAction(id, selection) : row.props.onSecondaryAction?.(id, selection),
    })),
  }) : wrap(row);
}

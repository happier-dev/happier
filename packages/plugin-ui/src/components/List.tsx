import { createElement, type ReactElement, type ReactNode } from 'react';

import { createPrimitiveElement } from './primitiveElement.js';

export type ListProps<Item> = Readonly<{
  items?: readonly Item[];
  keyForItem?: (item: Item, index: number) => string;
  renderItem?: (item: Item, index: number) => ReactNode;
  density?: 'compact' | 'regular';
  children?: ReactNode;
}>;

function renderItems<Item>({
  items,
  keyForItem,
  renderItem,
}: Pick<ListProps<Item>, 'items' | 'keyForItem' | 'renderItem'>): ReactNode {
  if (!items) return undefined;

  return items.map((item, index) => createElement(
    'happier-plugin-list-item',
    {
      key: keyForItem?.(item, index) ?? index,
      primitive: 'ListItem',
      index,
      item,
    },
    renderItem?.(item, index),
  ));
}

export function List<Item>({
  items,
  keyForItem,
  renderItem,
  density,
  children,
}: ListProps<Item>): ReactElement {
  return createPrimitiveElement('List', 'happier-plugin-list', {
    density,
  }, children ?? renderItems({ items, keyForItem, renderItem }));
}

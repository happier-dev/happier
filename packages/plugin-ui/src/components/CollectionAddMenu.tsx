import type { ReactElement } from 'react';

import {
  HappierCollectionAddMenu,
  type HappierCollectionAddMenuProps,
} from '../presentation/collection/CollectionAddMenu.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Text } from './Text.js';

export type { CollectionAddMenuItem } from '../presentation/collection/CollectionAddMenu.js';

export type CollectionAddMenuProps = Omit<HappierCollectionAddMenuProps, 'host'> & Readonly<{
  /** Readable alternative where the host cannot present the collection add menu. */
  unavailableLabel?: string;
}>;

/**
 * The same grouped, searchable add menu used by core collections, including its notice slot.
 * Same-realm hosts bind the incumbent dropdown; other hosts show explicit unavailability.
 * Supply held choices and handle selection; the component neither fetches nor creates anything.
 */
export function CollectionAddMenu({ unavailableLabel, ...props }: CollectionAddMenuProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  if (!host?.collectionAddMenu) {
    return <Text testID={`${props.testID}-unavailable`} tone="secondary"
      valueKey="happier.plugin-ui.collectionAddMenu.unavailable"
      fallback={unavailableLabel ?? 'Adding items is unavailable on this host.'} />;
  }
  return <HappierCollectionAddMenu {...props} host={host.collectionAddMenu} />;
}

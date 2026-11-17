import * as React from 'react';
import {
  CollectionSpaceTabDropZone,
  type CollectionSpaceDrop,
} from '@/components/ui/lists/collection/CollectionSpaceTabDropZone';

export type SessionSpaceDrop = CollectionSpaceDrop;

const SESSION_DRAG_KINDS = ['session'] as const;

/** Retains Session payload admission while collection tabs share their drop presentation. */
export function SessionSpaceTabDropZone(
  props: Readonly<{
    spaceId: string;
    spaceDrop: () => SessionSpaceDrop | null;
    testID: string;
    children: React.ReactNode;
  }>,
): React.ReactElement {
  return <CollectionSpaceTabDropZone {...props} acceptedKinds={SESSION_DRAG_KINDS} />;
}

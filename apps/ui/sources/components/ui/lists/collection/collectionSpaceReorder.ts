import * as React from 'react';
import {
  resolveAnchoredListMoveV1,
  type AnchoredListPositionV1,
} from '@happier-dev/protocol/actions/anchoredListOrderV1';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import type {
  CollectionEntityKindV1,
  CollectionSpaceMutationV1,
} from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';

import { collectionSpaceSettingRefs } from '@/components/settings/session/collectionSpaceSettings';
import {
  entityReorderPreview,
  entityReorderRefused,
  type EntityFlatReorderBinding,
} from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import type { EntityFlatAxis } from '@/components/ui/treeDragDrop/geometry/entityFlatListStrategy';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

export type CollectionSpaceReorderMutation = Extract<
  CollectionSpaceMutationV1<CollectionEntityKindV1>,
  { op: 'reorder' }
>;

/**
 * A staged place in a space list (strip or Manage spaces) as the settings reorder intent: the space it lands
 * before, or null for the end. Null when the place leaves the order unchanged or names a space that is gone.
 */
export function resolveCollectionSpaceReorder(
  ids: readonly string[],
  spaceId: string,
  position: AnchoredListPositionV1,
): CollectionSpaceReorderMutation | null {
  const moved = resolveAnchoredListMoveV1(ids, spaceId, position);
  if (!moved || moved.every((id, index) => id === ids[index])) return null;
  return {
    op: 'reorder',
    spaceId,
    beforeSpaceId: moved[moved.indexOf(spaceId) + 1] ?? null,
  };
}

/**
 * The shared flat-reorder binding for an entity's saved spaces: the strip (horizontal) and Manage spaces
 * (vertical) both drag, stage and announce through `EntityFlatReorder` and submit the one `settings.invoke`
 * reorder intent through the list's `useCollectionSpaceEditing.invoke`. Selection never changes on reorder.
 */
export function useCollectionSpaceReorderBinding(
  input: Readonly<{
    entityKind: CollectionEntityKindV1;
    spaces: readonly Readonly<{ id: string; name: string }>[];
    invoke: (mutation: CollectionSpaceReorderMutation) => Promise<boolean>;
    enabled?: boolean;
    /** The strip is a row (Move before/after); Manage spaces is a column (Move above/below). */
    axis?: EntityFlatAxis;
  }>,
): EntityFlatReorderBinding {
  const accountScope = useActiveServerAccountScope();
  const scope: EntityDragScopeV1 | null =
    input.enabled === false || !accountScope
      ? null
      : { serverId: accountScope.serverId, accountId: accountScope.accountId };
  const { entityKind, spaces, invoke } = input;
  const axis = input.axis ?? 'vertical';
  const anchor = collectionSpaceSettingRefs(entityKind).spaces.anchor;
  return React.useMemo<EntityFlatReorderBinding>(() => {
    const items = spaces.map((space) => ({ id: space.id, title: space.name }));
    const ids = items.map((item) => item.id);
    return {
      scope,
      kind: 'collection-space',
      items,
      getItem: (id) =>
        scope && ids.includes(id)
          ? { kind: 'collection-space', scope, entityKind, spaceId: id }
          : null,
      getSourceId: (item) =>
        item.kind === 'collection-space' && item.entityKind === entityKind
          ? item.spaceId
          : null,
      resolve: (sourceId, position) => {
        const mutation = resolveCollectionSpaceReorder(ids, sourceId, position);
        if (!mutation)
          return entityReorderRefused(
            ids.includes(sourceId) ? 'same-position' : 'reorder_target_gone',
          );
        return {
          status: 'allowed',
          effect: {
            actionId: 'settings.invoke',
            input: {
              anchor,
              input: { kind: 'collection_space', entityKind, mutation },
            },
            preview: entityReorderPreview(position, items, axis),
          },
        };
      },
      execute: async (effect) => {
        const request = effect.input as {
          input?: { mutation?: CollectionSpaceReorderMutation };
        } | null;
        const mutation = request?.input?.mutation;
        if (
          effect.actionId !== 'settings.invoke' ||
          mutation?.op !== 'reorder'
        ) {
          return {
            status: 'refused',
            reason: {
              code: 'reorder_target_gone',
              message: t('entityDragDrop.reasons.gone'),
            },
          };
        }
        return (await invoke(mutation))
          ? { status: 'applied' }
          : {
              status: 'refused',
              reason: {
                code: 'space_reorder_not_applied',
                message: resolveActionExecutionFailureMessage({ ok: false, errorCode: 'space_reorder_not_applied' }, t('errors.operationFailed'))!,
              },
            };
      },
    };
  }, [anchor, axis, entityKind, invoke, scope?.serverId, scope?.accountId, spaces]);
}

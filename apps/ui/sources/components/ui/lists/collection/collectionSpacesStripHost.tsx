import * as React from 'react';
import type { PluginUiPresentationHost } from '@happier-dev/plugin-ui/advanced';
import { resolveAnchoredListMoveV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import type { EntityDragItemV1, EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';

import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
  EntityFlatReorderList,
  EntityFlatReorderRow,
  entityReorderPreview,
  entityReorderRefused,
  type EntityFlatReorderBinding,
} from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { KeyboardShortcutLabelsContext } from '@/keyboard/shortcutLabels';
import { useSessionListSpaceKeyboardCommands } from '@/keyboard/sessionListSpaces';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { EntityDropOutcomeV1 } from '@/components/ui/treeDragDrop/entityDragDropTypes';

import { CollectionSpaceSwipeZone, useCollectionSpaceSwipeTrack } from './CollectionSpaceSwipeZone';
import { renderCollectionSpacesStripTabs, useCollectionSpacesStripEdgeMask } from './CollectionSpacesStrip';

type StripHost = NonNullable<PluginUiPresentationHost['collectionSpacesStrip']>;
type ReorderInput = Parameters<NonNullable<StripHost['useReorder']>>[0];

const SAVED_VIEWS_LOCAL_ID = 'saved-views';

/** A plugin's saved views drag through the same flat reorder as core's spaces; the caller's write settles the move. */
export function createPluginSavedViewsReorderBinding(input: Readonly<{
  pluginId: string;
  scope: EntityDragScopeV1 | null;
  items: ReorderInput['items'];
  onReorder: ReorderInput['onReorder'];
}>): EntityFlatReorderBinding {
  return createPluginFlatReorderBinding({
    pluginId: input.pluginId, localId: SAVED_VIEWS_LOCAL_ID, scope: input.scope,
    items: input.items.map(item => ({ id: item.id, title: item.name })), axis: 'horizontal',
    executeMove: async (id, beforeId) => await input.onReorder?.(id, beforeId)
      ? { status: 'applied' }
      : { status: 'refused', reason: { code: 'saved_view_reorder_not_applied', message: t('errors.operationFailed') } },
  });
}

/** One plugin-item binding serves saved views and ordinary flat lists; the receiving owner settles each move. */
export function createPluginFlatReorderBinding(input: Readonly<{
  pluginId: string;
  localId: string;
  scope: EntityDragScopeV1 | null;
  items: readonly Readonly<{ id: string; title: string }>[];
  axis?: 'horizontal' | 'vertical';
  executeMove(id: string, beforeId: string | null): Promise<EntityDropOutcomeV1>;
}>): EntityFlatReorderBinding {
  const { pluginId, localId, scope, items } = input;
  const ids = items.map((item) => item.id);
  const contribution = { pluginId, localId };
  return {
    scope,
    kind: `plugin:${pluginId}/${localId}`,
    items,
    getItem: (id): EntityDragItemV1 | null => (scope && ids.includes(id)
      ? { kind: 'plugin', scope, contribution, reference: { id } }
      : null),
    getSourceId: (item) => {
      if (item.kind !== 'plugin' || item.contribution.pluginId !== pluginId || item.contribution.localId !== localId) return null;
      const reference = item.reference;
      return reference !== null && typeof reference === 'object' && !Array.isArray(reference) && typeof reference.id === 'string' ? reference.id : null;
    },
    resolve: (sourceId, position) => {
      const moved = resolveAnchoredListMoveV1(ids, sourceId, position);
      if (!moved || moved.every((id, index) => id === ids[index])) {
        return entityReorderRefused(ids.includes(sourceId) ? 'same-position' : 'reorder_target_gone');
      }
      return {
        status: 'allowed',
        effect: {
          actionId: 'plugin.flat_list.reorder',
          input: { id: sourceId, beforeId: moved[moved.indexOf(sourceId) + 1] ?? null },
          preview: entityReorderPreview(position, items, input.axis),
        },
      };
    },
    execute: async (effect) => {
      const move = effect.input as Readonly<{ id: string; beforeId: string | null }>;
      return input.executeMove(move.id, move.beforeId);
    },
  };
}

function usePluginSavedViewsReorderBinding(pluginId: string, input: ReorderInput): EntityFlatReorderBinding {
  const pointer = useHoverCapablePrimaryPointer();
  const accountScope = useActiveServerAccountScope();
  const { items, onReorder } = input;
  const enabled = onReorder !== undefined && pointer && items.length > 1 && accountScope !== null;
  const serverId = enabled ? accountScope.serverId : null;
  const accountId = enabled ? accountScope.accountId : null;
  // An author's inline callback must not rebuild the binding: a new binding resets the tab's drag gesture.
  const settle = useEventCallback((id: string, beforeId: string | null) => onReorder?.(id, beforeId) ?? Promise.resolve(false));
  return React.useMemo(() => createPluginSavedViewsReorderBinding({
    pluginId,
    scope: serverId === null || accountId === null ? null : { serverId, accountId },
    items,
    onReorder: settle,
  }), [accountId, items, pluginId, serverId, settle]);
}

function SavedViewsSwipeZone(props: React.ComponentProps<NonNullable<StripHost['SwipeZone']>>) {
  const phone = useViewportClass() === 'compact';
  const track = useCollectionSpaceSwipeTrack();
  return (
    <CollectionSpaceSwipeZone testID={props.testID} track={track} enabled={phone && (props.canPrevious || props.canNext)}
      canPrevious={props.canPrevious} canNext={props.canNext} onCommit={props.onCommit}>
      {props.children}
    </CollectionSpaceSwipeZone>
  );
}

function useSavedViewsOrdinalCommands(input: Parameters<NonNullable<StripHost['useOrdinalCommands']>>[0]) {
  const presented = useLayoutPresentationActive();
  useSessionListSpaceKeyboardCommands({ enabled: input.enabled && presented, selectOrdinal: input.selectOrdinal });
}

function useSavedViewsOrdinalLabel() {
  const labels = React.useContext(KeyboardShortcutLabelsContext);
  return React.useCallback((ordinal: number) => labels[`sessionList.space.select${ordinal}` as keyof typeof labels], [labels]);
}

/** The host leaves of `CollectionSavedViewsStrip`, the same ones core's own strip draws. */
export function createCollectionSpacesStripHost(pluginId: string | undefined): StripHost {
  return {
    renderTabs: renderCollectionSpacesStripTabs,
    useEdgeMask: useCollectionSpacesStripEdgeMask,
    useReducedMotion: useReducedMotionPreference,
    useOrdinalLabel: useSavedViewsOrdinalLabel,
    useOrdinalCommands: useSavedViewsOrdinalCommands,
    SwipeZone: SavedViewsSwipeZone,
    ...(pluginId === undefined ? {} : {
      useReorder(reorder: ReorderInput) {
        const binding = usePluginSavedViewsReorderBinding(pluginId, reorder);
        const { testID } = reorder;
        return React.useMemo(() => ({
          wrapList: (tabs: React.ReactNode) => <EntityFlatReorderList binding={binding} axis="horizontal" testID={testID}>{tabs}</EntityFlatReorderList>,
          wrapTab: (id: string, tab: React.ReactElement) => <EntityFlatReorderRow id={id}>{() => tab}</EntityFlatReorderRow>,
        }), [binding, testID]);
      },
    }),
  };
}

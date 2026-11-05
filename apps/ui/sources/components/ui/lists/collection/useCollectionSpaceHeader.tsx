import * as React from 'react';
import { View } from 'react-native';
import type { CollectionConditionBindings } from '@happier-dev/plugin-ui/components';
import type {
  CollectionEntityKindV1,
  CollectionSpaceIconV1,
  CollectionSpaceV1,
} from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type {
  CollectionFilterMapV1,
  EntityListFilterResultV1,
} from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import type { EntityFilterRegistryV1 } from '@happier-dev/protocol/collections/filter/fieldRegistryV1';
import {
  sameStrictJsonValue,
  type JsonValue,
} from '@happier-dev/protocol/json/strictJsonValue';

import { useViewportClass } from '@/utils/platform/useViewportClass';
import { t } from '@/text';
import { useSessionListSpaceKeyboardCommands } from '@/keyboard/sessionListSpaces';
import { useCollectionFilterSettingsCommand } from '@/components/settings/session/useCollectionFilterSettingsCommand';
import { collectionSpaceSettingRefs } from '@/components/settings/session/collectionSpaceSettings';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/destinationInstanceContext';
import { accountSettingsScopeKeySuffix, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

import {
  collectionConditionValueWords,
  useCollectionConditionHeader,
} from './useCollectionConditionHeader';
import { CollectionSpacesStrip } from './CollectionSpacesStrip';
import { CollectionSpaceSwipeTitle, CollectionSpaceSwipeZone, useCollectionSpaceSwipeTrack } from './CollectionSpaceSwipeZone';
import { CollectionSpaceTitle } from './CollectionSpaceTitle';
import { neighbourCollectionSpaceId } from './collectionSpaceSwipe';
import { useCollectionSpaceEditing } from './useCollectionSpaceEditing';
import { useSetCollectionSpacesEnabled } from './useSetCollectionSpacesEnabled';

/** What a mounted entity list hands its header: the space binding and its own typed filter writer. */
export type CollectionSpaceHeaderView<K extends CollectionEntityKindV1> =
  Readonly<{
    spaces: readonly CollectionSpaceV1<K>[];
    selectedSpaceId: string;
    selectedSpace: CollectionSpaceV1<K> | null;
    activeSpace: CollectionSpaceV1<K> | null;
    spacesEnabled: boolean;
    spacesReady: boolean;
    spaceSettingsScope: AccountSettingsScope | null;
    filters: CollectionFilterMapV1[K];
    /** Replaces the list's transient filter through the entity's own admission; false when refused. */
    setFilters: (filters: CollectionFilterMapV1[K]) => boolean;
  }>;

/**
 * The saved-space header of a Workflows or Discussions column (R9, lab `clspaces`/`clfilter`, no new
 * design): the same title chevron menu, spaces strip, condition tokens, filter button, condition editor and
 * save/edit form as Sessions, bound to that entity's spaces and filter registry. The column composes the
 * pieces into `CollectionList`'s `titleControl`, `strip` and header action; the list keeps its loader.
 */
export function useCollectionSpaceHeader<
  K extends CollectionEntityKindV1,
  Facts,
>(
  input: Readonly<{
    entityKind: K;
    /** `workflows-column-space` → `…-title`, `…-strip`, `…-filter`, `…-editor`, … */
    testIDPrefix: string;
    defaultName: string;
    view: CollectionSpaceHeaderView<K>;
    registry: EntityFilterRegistryV1<CollectionFilterMapV1[K], Facts>;
    bindings: CollectionConditionBindings;
    result?: EntityListFilterResultV1;
    readHeldFacts?: () => Iterable<Facts>;
    defaultIcon: CollectionSpaceIconV1;
    /** The existing layout/route owner decides which mounted header receives commands. */
    keyboardEnabled?: boolean;
    /** `section` keeps the title a heading under a page's own title on a phone. */
    titleScale?: 'page' | 'section';
  }>,
) {
  const { view, registry, bindings, testIDPrefix } = input;
  const destinationKey = useDestinationInstanceKey();
  const phone = useViewportClass() === 'compact';
  const anchorRef = React.useRef<View | null>(null);
  const savedFilter = view.activeSpace?.filter ?? null;
  const openSaveAsRef = React.useRef<() => void>(() => {});
  const conditions = useCollectionConditionHeader({
    testIDPrefix,
    registry,
    bindings,
    filters: view.filters,
    setFilters: view.setFilters,
    baseFilter: savedFilter,
    ...(input.result ? { result: input.result } : {}),
    ...(input.readHeldFacts ? { readHeldFacts: input.readHeldFacts } : {}),
    anchorRef,
    onSaveAsSpace: () => openSaveAsRef.current(),
  });
  const model = conditions.model;
  const summary = React.useMemo(
    () => model.rows.map((row) => collectionConditionValueWords(row.field, row.values)),
    [model.rows],
  );
  const suggestion = React.useMemo(
    () => ({
      name: summary.join(' · ').trim() || t('sessionsList.spacesNew'),
      icon: model.rows.some((row) => row.fieldId === 'attention')
        ? ({ kind: 'icon', name: 'attention' } as const)
        : input.defaultIcon,
    }),
    [input.defaultIcon, model.rows, summary],
  );

  const editing = useCollectionSpaceEditing({
    entityKind: input.entityKind,
    testIDPrefix,
    serverId: view.spaceSettingsScope?.serverId ?? null,
    spaces: view.spaces,
    selectedSpace: view.activeSpace,
    currentFilter: view.filters,
    suggestion,
    summary,
    anchorRef,
    onWillOpenForm: conditions.closeEditor,
  });
  const { selectSpace, openSaveAs, openEdit, saveChanges, formOverlay } =
    editing;
  openSaveAsRef.current = openSaveAs;
  const invokeSpace = editing.invoke;
  const stripReorder = React.useMemo(
    () => ({ entityKind: input.entityKind, invoke: invokeSpace }),
    [input.entityKind, invokeSpace],
  );

  const setFilters = view.setFilters;
  const select = React.useCallback(
    (spaceId: string) => {
      if (!view.spacesEnabled) return;
      if (spaceId === view.selectedSpaceId) {
        // Choosing the space you are in returns to it, dropping conditions added on top.
        if (savedFilter !== null) setFilters(savedFilter);
        return;
      }
      void selectSpace(spaceId);
    },
    [savedFilter, selectSpace, setFilters, view.selectedSpaceId, view.spacesEnabled],
  );
  const selectOrdinal = React.useCallback((ordinal: number) => {
    if (!view.spacesEnabled || !view.spacesReady) return false;
    const space = view.spaces[ordinal - 1];
    if (!space) return false;
    select(space.id);
    return true;
  }, [select, view.spaces, view.spacesEnabled, view.spacesReady]);
  useSessionListSpaceKeyboardCommands({
    enabled: input.keyboardEnabled === true,
    selectOrdinal,
    openFilter: conditions.openEditor,
  });
  useCollectionFilterSettingsCommand({
    entityKind: input.entityKind,
    accountScope: view.spaceSettingsScope,
    enabled: input.keyboardEnabled === true,
    contextKey: JSON.stringify([view.spaceSettingsScope ? accountSettingsScopeKeySuffix(view.spaceSettingsScope) : null, destinationKey, testIDPrefix]),
    openFilter: conditions.openEditor,
  });

  // Phone title/strip swipe (lab `clspaces:swipe`): pages through this entity's spaces in their order.
  const swipeTarget = (direction: -1 | 1) =>
    view.spacesEnabled
      ? neighbourCollectionSpaceId(view.spaces, view.selectedSpaceId, direction)
      : null;
  const onSwipeCommit = (direction: -1 | 1) => {
    const spaceId = swipeTarget(direction);
    if (spaceId !== null) select(spaceId);
  };
  const swipeTrack = useCollectionSpaceSwipeTrack();
  const setSpacesEnabled = useSetCollectionSpacesEnabled(input.entityKind);
  const spaceName = (direction: -1 | 1) => {
    const id = swipeTarget(direction);
    return id === null ? null : view.spaces.find((space) => space.id === id)?.name ?? null;
  };
  const swipeProps = {
    track: swipeTrack,
    enabled: phone && view.spacesEnabled && view.spaces.length > 1,
    canPrevious: swipeTarget(-1) !== null,
    canNext: swipeTarget(1) !== null,
    onCommit: onSwipeCommit,
  };

  const modified =
    savedFilter !== null &&
    !sameStrictJsonValue(view.filters as JsonValue, savedFilter as JsonValue);
  const label =
    view.activeSpace
      ? view.activeSpace.name
      : input.defaultName;
  const titleControl = (
    <CollectionSpaceSwipeZone testID={`${testIDPrefix}-title-swipe`} {...swipeProps}>
    <CollectionSpaceSwipeTitle track={swipeTrack} previousLabel={spaceName(-1)} nextLabel={spaceName(1)}>
    <CollectionSpaceTitle
      scope={view.spaceSettingsScope ? accountSettingsScopeKeySuffix(view.spaceSettingsScope) : input.entityKind}
      testIDPrefix={testIDPrefix}
      entityKind={input.entityKind}
      spaceShortcutPrefix="sessionList.space.select"
      filterShortcutId="sessionList.filter.open"
      label={label}
      {...(input.titleScale ? { titleScale: input.titleScale } : {})}
      spaces={view.spacesEnabled ? view.spaces : []}
      selectedSpaceId={view.selectedSpaceId}
      spacesEnabled={view.spacesReady ? view.spacesEnabled : null}
      onSetSpacesEnabled={setSpacesEnabled}
      modified={modified}
      onSelectSpace={select}
      onOpenFilter={conditions.openEditor}
      onSaveAs={openSaveAs}
      onSaveChanges={saveChanges}
      onEdit={openEdit}
    />
    </CollectionSpaceSwipeTitle>
    </CollectionSpaceSwipeZone>
  );
  const stripItems = React.useMemo(
    () =>
      view.spaces.map((space) => ({
        id: space.id,
        name: space.name,
        icon: space.icon,
      })),
    [view.spaces],
  );
  const strip = (
    <View ref={anchorRef} collapsable={false}>
      {view.spacesEnabled ? (
        <CollectionSpaceSwipeZone testID={`${testIDPrefix}-strip-swipe`} {...swipeProps}>
        <CollectionSpacesStrip
          testIDPrefix={`${testIDPrefix}-strip`}
          accessibilityLabel={t('sessionsList.spacesTitle')}
          items={stripItems}
          selectedId={view.selectedSpaceId}
          onSelect={select}
          addLabel={t('sessionsList.spacesNew')}
          onAdd={openSaveAs}
          reorder={stripReorder}
        />
        </CollectionSpaceSwipeZone>
      ) : null}
      {conditions.tokenRow}
    </View>
  );
  const overlays = (
    <>
      {conditions.editorOverlay}
      {formOverlay}
    </>
  );
  return {
    titleControl,
    strip,
    filterButton: <SettingAnchor setting={collectionSpaceSettingRefs(input.entityKind).filters}>{conditions.filterButton}</SettingAnchor>,
    overlays,
    reorder: editing.reorder,
  };
}

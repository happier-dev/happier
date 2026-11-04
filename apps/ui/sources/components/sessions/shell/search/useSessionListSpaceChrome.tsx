import * as React from 'react';
import type { View } from 'react-native';
import type { CollectionSpaceIconV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { collectionConditionValueLabels } from '@happier-dev/plugin-ui/components';

import { CollectionConditionTokens } from '@/components/ui/lists/collection/CollectionConditionTokens';
import { CollectionSpacesStrip } from '@/components/ui/lists/collection/CollectionSpacesStrip';
import { useCollectionSpaceEditing } from '@/components/ui/lists/collection/useCollectionSpaceEditing';
import { KeyboardShortcutLabelsContext } from '@/keyboard/shortcutLabels';
import type { SessionOrganizationProjection } from '@/sync/domains/session/organization/types';
import { t } from '@/text';

import {
  buildSessionListFilterAudienceOptions,
  buildSessionListFilterEditorLabels,
  readSessionListScopeLabel,
} from './SessionListFilterControl';
import { resolveSessionListFilterScopeAvailability } from './sessionListFilterEditorModel';
import { buildSessionListFilterTagOptions } from './sessionListFilterTagOptions';
import {
  buildSessionListConditionBindings,
  restoreSessionListConditionToBase,
  buildSessionListConditionModel,
  resolveSessionListBaseConditionFields,
} from './sessionListConditionFields';
import { toStoredSessionListFilter } from './storedSessionListFilter';
import { useProjectPickerOptions } from '@/components/projects/useProjectPickerOptions';
import { buildSessionListFilterSectionOptions } from './useSessionListFilterLocalOptions';
import { useSessionListSpaceNavigation } from './useSessionListSpaceNavigation';
import type { SessionListViewFilterController } from './useSessionListViewFilterController';

export type SessionListConditionToken = Readonly<{
  rowId: string;
  fieldId: string;
  field: string;
  values: readonly string[];
}>;

/** Fields that are on or off read by their name alone ("Needs me"). */
const TOGGLE_FIELDS: ReadonlySet<string> = new Set(['attention', 'coordinator', 'includeInactive']);

/** The conditions the list shows beyond its space, in words: tokens, the save form's name and summary. */
export function useSessionListConditionTokens(
  controller: SessionListViewFilterController,
  organizationProjectionsByServerId: Readonly<
    Record<string, SessionOrganizationProjection>
  >,
  baseFilters: SessionListViewFilterController['filters'],
): readonly SessionListConditionToken[] {
  const projects = useProjectPickerOptions();
  return React.useMemo(() => {
    const labels = buildSessionListFilterEditorLabels();
    const baseIncludeInactive = baseFilters.includeInactive ?? true;
    const hidden = resolveSessionListBaseConditionFields({
      filters: controller.filters,
      base: baseFilters,
      includeInactive: controller.includeInactive,
      baseIncludeInactive,
    });
    const choices = buildSessionListConditionBindings({
      editorLabels: labels,
      copy: labels.conditions,
      scopesAvailable: resolveSessionListFilterScopeAvailability(controller),
      homes: controller.homeOptions,
      tags: buildSessionListFilterTagOptions({ homeOptions: controller.homeOptions, organizationProjectionsByServerId }),
      projects,
      ...(controller.filters.sections ? { sections: buildSessionListFilterSectionOptions(controller.homeOptions, organizationProjectionsByServerId) } : {}),
      audiences: buildSessionListFilterAudienceOptions(controller.homeOptions, controller.viewContext),
      fixedShow: controller.fixedShow,
      attentionAvailable: controller.queryEnabled,
      inactiveVisibilityAvailable: controller.corpusStorage === 'active',
      sourceAvailable: controller.sourceAvailable,
    });
    const model = buildSessionListConditionModel(controller.filters, controller.includeInactive, choices.bindings);
    return model.rows.flatMap((row) => {
      if (hidden.has(row.fieldId)) return [];
      // Tokens say what narrows the list beyond its space; its own Whose is not one.
      if (row.fieldId === 'scope' && controller.filters.scope === baseFilters.scope) return [];
      // A picked Status group reads as its one word, as in the editor.
      const values = collectionConditionValueLabels(row.field, row.values, choices.formatValue);
      const field = row.operator === 'is_not' ? `${row.field.label} ${labels.conditions.operators.is_not}` : row.field.label;
      return [{ rowId: row.id, fieldId: row.fieldId, field, values }];
    });
  }, [baseFilters, controller, organizationProjectionsByServerId, projects]);
}

const isToggleToken = (token: SessionListConditionToken) => TOGGLE_FIELDS.has(token.fieldId);

function suggestSpaceName(
  tokens: readonly SessionListConditionToken[],
  fallback: string,
): string {
  const phrase = tokens
    .map((token) =>
      isToggleToken(token)
        ? token.field
        : token.values.join(` ${t('sessionsList.conditionOr')} `),
    )
    .join(' · ');
  return phrase.trim() || fallback;
}

function suggestSpaceIcon(
  filters: SessionListViewFilterController['filters'],
): CollectionSpaceIconV1 {
  const projects = filters.projects?.include ?? [];
  if (projects.length === 1) return { kind: 'project', project: projects[0] };
  if (filters.attention === 'needs_my_attention')
    return { kind: 'icon', name: 'attention' };
  return { kind: 'icon', name: 'list' };
}

/**
 * The Sessions column's space chrome (lab `clspaces`, `clfilter`): one owner for the strip, the filter
 * editor's open state and anchor, the condition tokens and the save/edit form. Every entry point — the
 * title menu, the strip, Find's filter button, ⌥F and the digit shortcuts — routes through it.
 */
export function useSessionListSpaceChrome(
  input: Readonly<{
    controller: SessionListViewFilterController;
    organizationProjectionsByServerId: Readonly<
      Record<string, SessionOrganizationProjection>
    >;
  }>,
) {
  const { controller } = input;
  const navigation = useSessionListSpaceNavigation(controller);
  const anchorRef = React.useRef<View | null>(null);
  const [filterOpen, setFilterOpen] = React.useState(false);
  React.useEffect(() => {
    if (!navigation.filterOpenRequested) return;
    setFilterOpen(true);
    navigation.acknowledgeFilterOpenRequest();
  }, [navigation]);

  const baseFilters = controller.defaultFilters;
  const tokens = useSessionListConditionTokens(
    controller,
    input.organizationProjectionsByServerId,
    baseFilters,
  );
  const allTokens = useSessionListConditionTokens(
    controller,
    input.organizationProjectionsByServerId,
    controller.contextDefaultFilters,
  );
  const closeFilter = React.useCallback(() => setFilterOpen(false), []);
  const storedFilter = React.useMemo(() => toStoredSessionListFilter(controller.filters), [controller.filters]);
  const suggestedIcon = React.useMemo(() => suggestSpaceIcon(controller.filters), [controller.filters]);
  const suggestion = React.useMemo(() => ({
    name: suggestSpaceName(allTokens, t('sessionsList.spacesNew')),
    icon: suggestedIcon,
  }), [allTokens, suggestedIcon]);
  const summary = React.useMemo(() => [
    readSessionListScopeLabel(controller.filters.scope),
    ...allTokens.map((token) => isToggleToken(token) ? token.field : token.values.join(', ')),
  ], [allTokens, controller.filters.scope]);
  const editing = useCollectionSpaceEditing({
    entityKind: 'sessionWork',
    testIDPrefix: 'session-list-space',
    serverId: controller.spaceSettingsScope?.serverId ?? null,
    spaces: controller.spaces,
    selectedSpace: controller.activeSpace,
    currentFilter: storedFilter,
    suggestion,
    summary,
    everywhereChoice: true,
    anchorRef,
    onWillOpenForm: closeFilter,
  });
  const { openSaveAs, openEdit, saveChanges, formOverlay: overlays } = editing;
  const stripReorder = React.useMemo(() => ({ entityKind: 'sessionWork' as const, invoke: editing.invoke }), [editing.invoke]);
  const removeToken = React.useCallback(
    (fieldId: string) => {
      restoreSessionListConditionToBase(fieldId, {
        filters: controller.filters,
        base: baseFilters,
        baseIncludeInactive: baseFilters.includeInactive ?? true,
        updateFilters: controller.updateFilters,
        setSource: controller.setSource,
        setIncludeInactive: controller.setIncludeInactive,
      });
    },
    [baseFilters, controller],
  );

  const shortcutLabels = React.useContext(KeyboardShortcutLabelsContext);
  const stripItems = React.useMemo(
    () =>
      controller.spaces.map((space, index) => ({
        id: space.id,
        name: space.name,
        icon: space.icon,
        shortcut:
          index < 9
            ? shortcutLabels[
                `sessionList.space.select${index + 1}` as keyof typeof shortcutLabels
              ]
            : undefined,
      })),
    [controller.spaces, shortcutLabels],
  );
  const strip = React.useMemo(() =>
    controller.fixedShow === 'runs' || !controller.spacesEnabled ? null : (
      <CollectionSpacesStrip
        testIDPrefix="session-list-spaces"
        accessibilityLabel={t('sessionsList.spacesTitle')}
        items={stripItems}
        selectedId={controller.selectedSpaceId}
        onSelect={(spaceId) => {
          void navigation.selectSpace(spaceId);
        }}
        addLabel={t('sessionsList.spacesNew')}
        onAdd={openSaveAs}
        reorder={stripReorder}
      />
    ), [controller.fixedShow, controller.spacesEnabled, controller.selectedSpaceId, stripItems, navigation, openSaveAs, stripReorder]);

  const conditionTokens = React.useMemo(() => tokens.map((token) => ({
    id: token.fieldId,
    label: token.field,
    valueLabel: isToggleToken(token) ? token.field : token.values.join(', '),
  })), [tokens]);
  const filterTokens = React.useMemo(() =>
    tokens.length === 0 ? null : (
      <CollectionConditionTokens
        testIDPrefix="session-list-filter"
        tokens={conditionTokens}
        onRemove={removeToken}
        onSave={openSaveAs}
      />
    ), [openSaveAs, removeToken, tokens]);

  const selectedIndex = controller.spaces.findIndex((space) => space.id === controller.selectedSpaceId);
  const spaceCount = controller.spaces.length;
  const selectRelative = navigation.selectRelative;
  const spaceSwipe = React.useMemo(() => controller.fixedShow === 'runs' || !controller.spacesEnabled ? undefined : {
    canPrevious: selectedIndex > 0,
    canNext: selectedIndex >= 0 && selectedIndex < spaceCount - 1,
    previousLabel: selectedIndex > 0 ? controller.spaces[selectedIndex - 1]?.name ?? null : null,
    nextLabel: selectedIndex >= 0 ? controller.spaces[selectedIndex + 1]?.name ?? null : null,
    onCommit: (direction: -1 | 1) => { selectRelative(direction); },
  }, [controller.fixedShow, controller.spaces, controller.spacesEnabled, selectRelative, selectedIndex, spaceCount]);

  return React.useMemo(() => ({
    navigation,
    anchorRef,
    filterOpen,
    setFilterOpen,
    activeCount: tokens.length,
    strip,
    filterTokens,
    overlays,
    openSaveAs,
    openEdit,
    saveChanges,
    spaceSwipe,
  }), [spaceSwipe, anchorRef, filterOpen, filterTokens, navigation, openEdit, openSaveAs, overlays, saveChanges, strip, tokens.length]);
}

export type SessionListSpaceChrome = ReturnType<
  typeof useSessionListSpaceChrome
>;

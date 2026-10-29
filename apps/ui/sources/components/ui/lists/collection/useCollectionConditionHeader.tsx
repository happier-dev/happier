import * as React from 'react';
import { View } from 'react-native';
import {
  applyCollectionConditionEdit,
  collectionConditionValueCountsFromFacts,
  conditionModelFromFilter,
  type CollectionConditionBindings,
  type CollectionConditionEdit,
  type CollectionConditionField,
  type CollectionConditionModel,
  type CollectionConditionRow,
  type CollectionConditionValueCountRequest,
  type CollectionConditionValueCounts,
} from '@happier-dev/plugin-ui/components';
import type { EntityListFilterResultV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import type { EntityFilterRegistryV1 } from '@happier-dev/protocol/collections/filter/fieldRegistryV1';
import {
  sameStrictJsonValue,
  type JsonValue,
} from '@happier-dev/protocol/json/strictJsonValue';

import {
  MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
  Popover,
} from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { t } from '@/text';

import {
  CollectionConditionEditor,
  buildCollectionConditionEditorLabels,
} from './CollectionConditionEditor';
import {
  CollectionConditionTokens,
  type CollectionConditionToken,
} from './CollectionConditionTokens';
import { CollectionFilterButton } from './CollectionFilterButton';

/** The filter popover's width and height cap (lab `clfilter:filter`), the same as the Sessions editor's. */
const EDITOR_WIDTH_PX = 356;
const EDITOR_MAX_HEIGHT_PX = 520;
const EDGE_PADDING = { horizontal: 8, vertical: 8 } as const;
/** Under a search field the editor takes the field's width, up to {@link EDITOR_WIDTH_PX} (lab `sfcols:mcpFilter`). */
const FIELD_WIDTH_PORTAL = { ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, matchAnchorWidth: true } as const;

function sameCondition(
  a: CollectionConditionRow,
  b: CollectionConditionRow,
): boolean {
  return (
    a.fieldId === b.fieldId &&
    a.operator === b.operator &&
    sameStrictJsonValue(a.values as JsonValue, b.values as JsonValue)
  );
}

export function collectionConditionValueWords(
  field: CollectionConditionField,
  values: readonly JsonValue[],
): string {
  // A field that is only on or off ("Needs you", "Unread") reads by its name alone.
  if (field.kind === 'boolean') return field.label;
  return values
    .map(
      (value) =>
        field.valueOptions.find((option) =>
          sameStrictJsonValue(option.value, value),
        )?.label ?? String(value),
    )
    .join(', ');
}

/**
 * The condition half of a Collection header (lab `clfilter:filter`, `sfcols:mcpFilter`): the filter button
 * with its count, the removable condition tokens and the shared `CollectionConditionEditor` popover (a sheet
 * on a phone), bound to one entity registry. Saved-space lists (Sessions-style Workflows, Discussions) wrap it
 * in {@link useCollectionSpaceHeader}; lists without spaces (Settings columns) use it as is, with the empty
 * filter as their base. The list keeps its loader and applies the filter to the facts it already holds.
 */
export function useCollectionConditionHeader<Filter, Facts>(
  input: Readonly<{
    /** `…-filter-open`, `…-editor`, `…-filter-chips`, `…-filter-token:<id>`. */
    testIDPrefix: string;
    registry: EntityFilterRegistryV1<Filter, Facts>;
    bindings: CollectionConditionBindings;
    filters: Filter;
    setFilters: (filters: Filter) => unknown;
    /**
     * Where the list starts: a space's saved filter, or the empty filter of a list without spaces. Rows equal
     * to it are not tokens; Clear and removing a token return to it. `null` while a space is still loading.
     */
    baseFilter: Filter | null;
    result?: EntityListFilterResultV1;
    /** Distinct, already-held ordinary subjects before local search/conditions; read only by an open value list. */
    readHeldFacts?: () => Iterable<Facts>;
    /**
     * The editor's anchor. Without one the popover opens under the list's search field when the list draws
     * one (give it `searchAnchorRef`), else under the filter button.
     */
    anchorRef?: React.RefObject<View | null>;
    /** Saved-space lists offer Save as space in the tokens and editor. */
    onSaveAsSpace?: () => void;
    /** Fields a control on the page already states (a kind segment): one indicator, so no token or count for them. */
    statedFields?: readonly string[];
  }>,
) {
  const { registry, bindings, testIDPrefix, filters, baseFilter, setFilters } =
    input;
  const phone = useViewportClass() === 'compact';
  const buttonAnchorRef = React.useRef<View | null>(null);
  const searchAnchorRef = React.useRef<View | null>(null);
  // The editor opens under the search field's left edge (lab `sfcols:mcpFilter`); a list without a search
  // field hangs it from the filter button in its header.
  const anchorRef = React.useMemo<React.RefObject<View | null>>(
    () =>
      input.anchorRef ?? {
        get current() {
          return searchAnchorRef.current ?? buttonAnchorRef.current;
        },
        set current(_node: View | null) {},
      },
    [input.anchorRef],
  );
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [valueRequest, setValueRequest] = React.useState<CollectionConditionValueCountRequest | null>(null);
  const closeEditor = React.useCallback(() => { setEditorOpen(false); setValueRequest(null); }, []);
  const openEditor = React.useCallback(() => setEditorOpen(true), []);
  const previousCounts = React.useRef<CollectionConditionValueCounts | undefined>(undefined);
  const readHeldFacts = input.readHeldFacts;
  const valueCounts = React.useMemo(() => {
    const counts = editorOpen && readHeldFacts ? collectionConditionValueCountsFromFacts(
      registry, filters, valueRequest, readHeldFacts, previousCounts.current,
    ) : undefined;
    previousCounts.current = counts;
    return counts;
  }, [editorOpen, filters, readHeldFacts, registry, valueRequest]);
  const countedBindings = React.useMemo(() => valueCounts ? { ...bindings, valueCounts } : bindings,
    [bindings, valueCounts]);

  const model = React.useMemo<CollectionConditionModel>(
    () => conditionModelFromFilter(registry, filters, countedBindings),
    [countedBindings, registry, filters],
  );
  const baseModel = React.useMemo(
    () =>
      baseFilter === null
        ? null
        : conditionModelFromFilter(registry, baseFilter, bindings),
    [bindings, registry, baseFilter],
  );
  // Tokens say what narrows the list beyond its base.
  const tokenRows = React.useMemo(
    () =>
      model.rows.filter(
        (row) => !baseModel?.rows.some((base) => sameCondition(base, row)),
      ),
    [baseModel, model.rows],
  );
  // Rows equal to the base are where the list starts, not conditions on it; adding such a field edits its row.
  const hiddenFieldIds = React.useMemo(
    () =>
      new Set(
        model.rows
          .filter((row) => !tokenRows.includes(row))
          .map((row) => row.fieldId),
      ),
    [model.rows, tokenRows],
  );
  const statedFields = input.statedFields;
  const tokens = React.useMemo<readonly CollectionConditionToken[]>(
    () =>
      tokenRows.filter((row) => !statedFields?.includes(row.fieldId)).map((row) => ({
        id: row.fieldId,
        label: row.field.label,
        valueLabel: collectionConditionValueWords(row.field, row.values),
      })),
    [statedFields, tokenRows],
  );

  const applyEdit = React.useCallback(
    (edit: CollectionConditionEdit) => {
      if (edit.type === 'clear') {
        // Clear returns the list to where it starts (its space, or everything).
        if (baseFilter !== null) setFilters(baseFilter);
        return;
      }
      try {
        setFilters(applyCollectionConditionEdit(registry, filters, edit));
      } catch {
        // A stale or refused edit leaves the filter as it was; the editor redraws from the current model.
      }
    },
    [registry, baseFilter, setFilters, filters],
  );
  const removeToken = React.useCallback(
    (fieldId: string) => {
      const row = model.rows.find((candidate) => candidate.fieldId === fieldId);
      if (!row) return;
      const base = baseModel?.rows.find(
        (candidate) => candidate.fieldId === fieldId,
      );
      applyEdit(
        base && base.operator !== 'unavailable'
          ? {
              type: 'change',
              rowId: row.id,
              condition: {
                fieldId,
                operator: base.operator,
                values: base.values,
              },
            }
          : { type: 'remove', rowId: row.id },
      );
    },
    [applyEdit, baseModel, model.rows],
  );

  const tokenRow =
    tokens.length > 0 ? (
      <CollectionConditionTokens
        testIDPrefix={`${testIDPrefix}-filter`}
        tokens={tokens}
        onRemove={removeToken}
        {...(input.onSaveAsSpace ? { onSave: input.onSaveAsSpace } : {})}
      />
    ) : null;
  const button = (
    <CollectionFilterButton
      testID={`${testIDPrefix}-filter-open`}
      activeCount={tokens.length}
      open={editorOpen}
      onPress={() => setEditorOpen((open) => !open)}
    />
  );
  const filterButton = input.anchorRef ? (
    button
  ) : (
    <View ref={buttonAnchorRef} collapsable={false}>
      {button}
    </View>
  );
  const labels = React.useMemo(
    () => buildCollectionConditionEditorLabels(),
    [],
  );
  const result = input.result;
  // Read when the editor is open, after the list has laid out its field. A caller's explicit anchor (a
  // space header) and a header button keep the editor's own width.
  const underSearchField = !input.anchorRef && searchAnchorRef.current !== null;
  const editorOverlay = (
    <Popover
      open={editorOpen}
      anchorRef={anchorRef}
      placement="bottom"
      gap={6}
      boundaryRef={null}
      edgePadding={EDGE_PADDING}
      maxWidthCap={EDITOR_WIDTH_PX}
      maxHeightCap={EDITOR_MAX_HEIGHT_PX}
      autoFocusOnOpen
      portal={underSearchField ? FIELD_WIDTH_PORTAL : MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
      onRequestClose={closeEditor}
      backdrop={false}
      phonePresentation="sheet"
      sheetHeader="none"
      accessibilityLabel={labels.title}
      containerStyle={{ paddingHorizontal: 0 }}
    >
      {({ maxHeight }) => (
        <FloatingOverlay
          maxHeight={maxHeight}
          surfaceChrome="theme"
          scrollEnabled={false}
        >
          <CollectionConditionEditor
            testID={`${testIDPrefix}-editor`}
            model={model}
            onChange={applyEdit}
            onValuePickerChange={setValueRequest}
            labels={labels}
            hiddenFieldIds={hiddenFieldIds}
            {...(result ? { result } : {})}
            {...(input.onSaveAsSpace
              ? { onSaveAsSpace: input.onSaveAsSpace }
              : {})}
            {...(phone
              ? {
                  onDone: closeEditor,
                  ...(result?.coverage === 'complete'
                    ? {
                        doneLabel: t('sessionsList.filterShowCount', {
                          count: result.matchedCount,
                        }),
                      }
                    : {}),
                }
              : {})}
            maxHeight={maxHeight}
          />
        </FloatingOverlay>
      )}
    </Popover>
  );
  return {
    model,
    tokens,
    tokenRow,
    filterButton,
    searchAnchorRef,
    editorOverlay,
    applyEdit,
    openEditor,
    closeEditor,
  };
}

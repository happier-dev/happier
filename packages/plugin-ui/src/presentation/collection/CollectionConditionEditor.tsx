import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Platform, ScrollView, View, type ViewStyle } from 'react-native';
import type { EntityListFilterResultV1, EntityFilterConditionOperatorV1 } from '@happier-dev/plugin-sdk/ui';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import {
  HappierPressable,
  type HappierPressableStyleState,
} from '../interaction/Pressable.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { useOptionalHappierUiTheme } from '../../environment/context.js';
import { useHappierMaterialColorResolver } from '../layout/Surface.js';
import { HAPPIER_MENU_ROW_METRICS } from '../interaction/Menu.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import type {
  CollectionConditionEdit,
  CollectionConditionField,
  CollectionConditionModel,
  CollectionConditionRow,
  CollectionConditionValueOption,
  CollectionConditionValueCountRequest,
} from './conditionModel.js';
import {
  collectionConditionOptionValues,
  collectionConditionValueLabels,
  isCollectionConditionOptionPicked,
} from './conditionModel.js';
import { HAPPIER_DISCLOSURE_CHEVRON_METRICS, HappierDisclosureChevron } from './DisclosureChevron.js';

/**
 * The one condition editor (lab `clfilter:filter`, P6 §4.1): a filter as a list of conditions —
 * Field · operator · values · remove — that starts from what the list shows, lists the fields it can add
 * beneath, and counts the result live. One view (owner 2026-11-11): a field opens its values in place, under
 * it, and a pick becomes its condition there, so existing and new conditions never part across two views. Sessions, Workflows, Discussions, Settings columns and plugin pages draw
 * this same body over the shared condition model; each supplies its own registry, labels and host.
 *
 * The editor holds only which field's values are open and the order fields stood in when it opened. Every change leaves as one {@link CollectionConditionEdit}
 * that the owner applies through its registry, so the filter keeps a single writer.
 */
export type HappierCollectionConditionTextRole =
  | 'title'
  | 'field'
  | 'operator'
  | 'value'
  | 'join'
  | 'action'
  | 'count'
  | 'option'
  /** A value's held count in a value list: quiet and tabular, never announced as it arrives. */
  | 'optionCount'
  | 'groupTitle'
  | 'empty';

export type HappierCollectionConditionIcon =
  | 'remove'
  | 'check';

export type HappierCollectionConditionEditorHost = Readonly<{
  /** One run of text in an anatomy role (the host owns type and ink). */
  Text: ComponentType<
    Readonly<{
      role: HappierCollectionConditionTextRole;
      numberOfLines?: number;
      accessibilityRole?: 'header';
      testID?: string;
      children: ReactNode;
    }>
  >;
  /** The host's glyph for one of the editor's own marks. */
  Icon: ComponentType<Readonly<{ name: HappierCollectionConditionIcon }>>;
  /** A field's mark in the list of fields the filter can add, when the host has one. */
  FieldIcon?: ComponentType<Readonly<{ fieldId: string }>>;
  /** The host's search field, for a long value list. */
  SearchField: ComponentType<
    Readonly<{
      value: string;
      onChangeText: (text: string) => void;
      placeholder: string;
      testID?: string;
      style: HappierStyleProp;
    }>
  >;
  /** A footer action in the host's button chrome. */
  Button: ComponentType<
    Readonly<{
      label: string;
      tone: 'default' | 'primary';
      disabled?: boolean;
      onPress: () => void;
      testID?: string;
    }>
  >;
  /**
   * A hit area the host asks for where the pointer is a finger. Controls keep their drawn sizes; each
   * one's hit area reaches into the room around it within its row (DESIGN.md → touch targets).
   */
  touchTargetPx?: number;
  /** Ink fills, read while rendering so they follow the host theme. */
  useColors: () => Readonly<{
    fill: string;
    fillHover: string;
    divider: string;
    focus: string;
  }>;
}>;

export type HappierCollectionConditionEditorLabels = Readonly<{
  title: string;
  clear: string;
  add: string;
  addSearch: string;
  /** Joins two values of one condition ("happier or website"). */
  or: string;
  operators: Readonly<
    Record<EntityFilterConditionOperatorV1 | 'unavailable', string>
  >;
  remove: (field: string) => string;
  count: (count: number) => string;
  countPartial: (count: number) => string;
  saveAsSpace: string;
  done: string;
  noFields: string;
  noValues: string;
}>;

/** A host-drawn picker for a field whose values need more than one flat list (nested or paged choices). */
export type HappierCollectionConditionValuePicker = (
  input: Readonly<{
    field: CollectionConditionField;
    row: CollectionConditionRow | null;
    close: () => void;
    maxHeight?: number;
  }>,
) => ReactNode | null;

export type HappierCollectionConditionEditorProps = Readonly<{
  host: HappierCollectionConditionEditorHost;
  model: CollectionConditionModel;
  onChange: (edit: CollectionConditionEdit) => void;
  labels: HappierCollectionConditionEditorLabels;
  /** Distinct matched items and coverage from the list's own projection. */
  result?: EntityListFilterResultV1;
  /** A host whose result is not a plain count (a live preview) words it itself. */
  resultSummary?: string;
  onSaveAsSpace?: () => void;
  onDone?: () => void;
  doneLabel?: string;
  doneDisabled?: boolean;
  /** Rows the list starts from: drawn, never removed (Sessions' Whose). */
  lockedFieldIds?: ReadonlySet<string>;
  /** Rows equal to the list's own base: not drawn; adding the field edits that row. */
  hiddenFieldIds?: ReadonlySet<string>;
  /** The Add filter list's order and groups; fields outside every group follow ungrouped. */
  fieldGroups?: readonly Readonly<{
    id: string;
    title: string;
    fieldIds: readonly string[];
  }>[];
  /** Fields offered in Add filter; defaults to every field the model makes available. */
  addableFieldIds?: ReadonlySet<string>;
  /** The words for a value without a bound option label. */
  formatValue?: (field: CollectionConditionField, value: JsonValue) => string;
  /** Words for a whole condition when its values read as fewer choices (a status group stored as its states). */
  summarizeValues?: (field: CollectionConditionField, values: readonly JsonValue[]) => readonly string[] | null;
  renderValuePicker?: HappierCollectionConditionValuePicker;
  /** Demand only while a value list is presented; null on Back/dismissal/unmount. Never asks for a read. */
  onValuePickerChange?: (request: CollectionConditionValueCountRequest | null) => void;
  maxHeight?: number;
  testID?: string;
}>;

export const HAPPIER_COLLECTION_CONDITION_EDITOR_METRICS = Object.freeze({
  /** The popover's width (lab `clfilter:filter`). */
  width: 356,
  padding: 10,
  rowMinHeight: 34,
  fieldWidth: 76,
  operatorWidth: 40,
  valueMinHeight: 26,
  valueRadius: 7,
  removeSize: 22,
  optionMinHeight: 34,
  footerMinHeight: 52,
  /** A value list longer than this offers search. */
  searchThreshold: 8,
});

/** A condition row's control reaches the row's edges vertically and half the 6 px gap toward its neighbours. */
function rowControlHitReach(drawnHeight: number) {
  const vertical = Math.max(0, (HAPPIER_COLLECTION_CONDITION_EDITOR_METRICS.rowMinHeight - drawnHeight) / 2);
  return { top: vertical, bottom: vertical, left: 3, right: 3 };
}

const M = HAPPIER_COLLECTION_CONDITION_EDITOR_METRICS;

const sameValue = (a: JsonValue, b: JsonValue) =>
  JSON.stringify(a) === JSON.stringify(b);

const optionValues = collectionConditionOptionValues;
const optionPicked = isCollectionConditionOptionPicked;
const includesValue = (values: readonly JsonValue[], value: JsonValue) =>
  values.some((candidate) => sameValue(candidate, value));

/** One value (a radio choice) or several (a set, OR within the condition). */
const isMultiValue = (field: CollectionConditionField) => field.kind === 'set';

/** The words of an open value list stand one disclosure box in from their field's name, under the field. */
const VALUE_INDENT = HAPPIER_DISCLOSURE_CHEVRON_METRICS.boxPx;
// A field or value list is a list picker: its rows take the menu's inset rounded highlight (HAPPIER_MENU_ROW_METRICS),
// stepping out of the body's padding to the menu inset while their words stay on the group titles' edge.
const OPTION_ROW = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
  minHeight: M.optionMinHeight,
  marginHorizontal: -M.padding + HAPPIER_MENU_ROW_METRICS.insetPx,
  paddingHorizontal: M.padding + 8 - HAPPIER_MENU_ROW_METRICS.insetPx,
  borderRadius: HAPPIER_MENU_ROW_METRICS.highlightRadiusPx,
} as const satisfies HappierPortableStyle;

const styles = Object.freeze({
  root: { width: '100%', minWidth: 300 } satisfies ViewStyle,
  body: {
    paddingHorizontal: M.padding,
    paddingTop: M.padding,
    paddingBottom: M.padding,
  } satisfies ViewStyle,
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 28,
    paddingHorizontal: 4,
    marginBottom: 4,
  } satisfies ViewStyle,
  grow: { flex: 1, minWidth: 0 } satisfies ViewStyle,
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: M.rowMinHeight,
    paddingLeft: 8,
    paddingRight: 4,
  } satisfies ViewStyle,
  field: { width: M.fieldWidth, flexShrink: 0 } satisfies ViewStyle,
  operator: {
    width: M.operatorWidth,
    height: 24,
    flexShrink: 0,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  } satisfies HappierPortableStyle,
  value: {
    flex: 1,
    minWidth: 0,
    minHeight: M.valueMinHeight,
    borderRadius: M.valueRadius,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
  } satisfies HappierPortableStyle,
  valueContent: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    overflow: 'hidden',
  } satisfies HappierPortableStyle,
  remove: {
    width: M.removeSize,
    height: M.removeSize,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  } satisfies HappierPortableStyle,
  removeSlot: { width: M.removeSize } satisfies ViewStyle,
  operatorLabel: { width: M.operatorWidth, height: 24, flexShrink: 0, alignItems: 'center', justifyContent: 'center' } satisfies ViewStyle,
  footer: {
    minHeight: M.footerMinHeight,
    marginHorizontal: M.padding,
    paddingLeft: 4,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } satisfies ViewStyle,
  // The fields a filter can add follow its conditions, parted from them by the popover's hairline. With no
  // conditions above them they follow the header directly: no hairline and no gap of their own.
  fields: { marginTop: 6, paddingTop: 6, borderTopWidth: 1 } satisfies ViewStyle,
  search: { marginVertical: 4 } satisfies ViewStyle,
  groupTitle: {
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 2,
  } satisfies ViewStyle,
  option: OPTION_ROW,
  // A value under its field: the same edge-to-edge row, its words one disclosure box in.
  valueOption: { ...OPTION_ROW, paddingLeft: M.padding + 8 + VALUE_INDENT } satisfies HappierPortableStyle,
  valueSearch: { marginVertical: 4, marginLeft: 8 + VALUE_INDENT } satisfies ViewStyle,
  optionMark: { width: 16, alignItems: 'center' } satisfies ViewStyle,
  empty: { paddingHorizontal: 8, paddingVertical: 10 } satisfies ViewStyle,
  valuesEmpty: { paddingLeft: 8 + VALUE_INDENT, paddingVertical: 10 } satisfies ViewStyle,
});

/**
 * The order fields stand in while the popover is open: its conditions first, then what it can add (in the owner's
 * groups). A field keeps its place when it gains or loses its condition, so nothing moves under the pointer; a field
 * that appears later joins the end. The next opening orders afresh.
 */
function useStableFieldOrder(
  conditionIds: readonly string[],
  addIds: readonly string[],
): Readonly<{ order: readonly string[]; openedWithConditions: number }> {
  const state = useRef<{ order: string[]; openedWithConditions: number } | null>(null);
  if (state.current === null) {
    state.current = { order: [...conditionIds, ...addIds], openedWithConditions: conditionIds.length };
  } else {
    for (const id of [...conditionIds, ...addIds]) if (!state.current.order.includes(id)) state.current.order.push(id);
  }
  return state.current;
}

export const HappierCollectionConditionEditor = memo(
  function HappierCollectionConditionEditor(
    props: HappierCollectionConditionEditorProps,
  ): ReactElement {
    const { host, labels, model, onChange } = props;
    const colors = host.useColors();
    const theme = useOptionalHappierUiTheme();
    const hitTarget = host.touchTargetPx;
    // The one field whose values are open, in place under it; null when every field is folded.
    const [openFieldId, setOpenFieldId] = useState<string | null>(null);
    const close = useCallback(() => setOpenFieldId(null), []);
    const toggle = useCallback((fieldId: string) => setOpenFieldId((open) => open === fieldId ? null : fieldId), []);
    const [fieldQuery, setFieldQuery] = useState('');
    const shownRows = useMemo(
      () => model.rows.filter((row) => !props.hiddenFieldIds?.has(row.fieldId)),
      [model.rows, props.hiddenFieldIds],
    );
    const rowForField = useCallback(
      (fieldId: string) =>
        model.rows.find((row) => row.fieldId === fieldId) ?? null,
      [model.rows],
    );
    const fieldsById = useMemo(
      () =>
        new Map(
          model.availableFields.map((field) => [field.id, field] as const),
        ),
      [model.availableFields],
    );
    const countDemand = useRef<{ key: string; request: CollectionConditionValueCountRequest | null }>({ key: 'null', request: null });
    const countDemandListener = useRef(props.onValuePickerChange);
    useEffect(() => { countDemandListener.current = props.onValuePickerChange; }, [props.onValuePickerChange]);
    useEffect(() => {
      if (!props.onValuePickerChange) return;
      const field = openFieldId === null ? undefined
        : fieldsById.get(openFieldId) ?? rowForField(openFieldId)?.field;
      const request = field ? { fieldId: field.id, options: field.valueOptions.map(({ value, values }) =>
        values ? { value, values } : { value }) } : null;
      // Count arrivals and label-only rebindings cannot feed demand back into the producer.
      const key = JSON.stringify(request);
      if (countDemand.current.key === key) return;
      countDemand.current = { key, request };
      props.onValuePickerChange(request);
    }, [fieldsById, openFieldId, props.onValuePickerChange, rowForField]);
    useEffect(() => () => {
      if (countDemand.current.request === null) return;
      countDemand.current = { key: 'null', request: null };
      countDemandListener.current?.(null);
    }, []);

    // Fills resolve through the containing material: on glass a field is the plane's tint, never an opaque block.
    const paintColor = useHappierMaterialColorResolver();
    const press = (
      state: HappierPressableStyleState,
      base: HappierPortableStyle,
      fill?: string,
    ): HappierStyleProp => [
      base,
      fill !== undefined
        ? {
            backgroundColor: paintColor(
              state.hovered || state.pressed ? colors.fillHover : fill,
            ),
          }
        : null,
      happierFocusRingStyle({ visible: state.focused, color: colors.focus }),
    ];

    // A one-choice field ("Needs me · Waiting on you") is added whole; any other field opens its values in place.
    const startField = useCallback(
      (field: CollectionConditionField) => {
        const existing = rowForField(field.id);
        const choices = field.valueOptions.filter((option) => !option.disabled);
        if (
          !isMultiValue(field) &&
          choices.length === 1 &&
          !props.renderValuePicker?.({ field, row: existing, close })
        ) {
          const condition = {
            fieldId: field.id,
            operator: field.operators[0]!,
            values: [choices[0]!.value],
          };
          onChange(
            existing && existing.operator !== 'unavailable'
              ? { type: 'change', rowId: existing.id, condition }
              : { type: 'add', condition },
          );
          setOpenFieldId(null);
          return;
        }
        toggle(field.id);
      },
      [close, onChange, props, rowForField, toggle],
    );

    const pickValue = useCallback(
      (
        field: CollectionConditionField,
        option: CollectionConditionValueOption,
      ) => {
        const row = rowForField(field.id);
        const live = row && row.operator !== 'unavailable' ? row : null;
        const operator = live
          ? (live.operator as EntityFilterConditionOperatorV1)
          : field.operators[0]!;
        if (!isMultiValue(field)) {
          const condition = {
            fieldId: field.id,
            operator,
            values: [...optionValues(option)],
          };
          onChange(
            live
              ? { type: 'change', rowId: live.id, condition }
              : { type: 'add', condition },
          );
          setOpenFieldId(null);
          return;
        }
        const current = live?.values ?? [];
        const picked = optionValues(option);
        const values = optionPicked(current, option)
          ? current.filter((value) => !includesValue(picked, value))
          : [...current, ...picked.filter((value) => !includesValue(current, value))];
        if (live && values.length === 0)
          onChange({ type: 'remove', rowId: live.id });
        else if (live)
          onChange({
            type: 'change',
            rowId: live.id,
            condition: { fieldId: field.id, operator, values },
          });
        else
          onChange({
            type: 'add',
            condition: { fieldId: field.id, operator, values },
          });
      },
      [onChange, rowForField],
    );

    const toggleOperator = useCallback(
      (row: CollectionConditionRow) => {
        if (row.operator === 'unavailable') return;
        const next = row.field.operators.find(
          (operator) => operator !== row.operator,
        );
        // A field holding both operators keeps each as its own row; the toggle only moves a lone one.
        if (
          !next ||
          model.rows.some(
            (candidate) =>
              candidate.fieldId === row.fieldId && candidate.operator === next,
          )
        )
          return;
        onChange({
          type: 'change',
          rowId: row.id,
          condition: {
            fieldId: row.fieldId,
            operator: next,
            values: row.values,
          },
        });
      },
      [model.rows, onChange],
    );

    const countLabel =
      props.resultSummary ??
      (props.result?.coverage === 'complete'
        ? labels.count(props.result.matchedCount)
        : props.result?.coverage === 'partial'
          ? labels.countPartial(props.result.matchedCount)
          : '');
    const bodyMaxHeight =
      props.maxHeight === undefined
        ? undefined
        : Math.max(0, props.maxHeight - M.footerMinHeight);
    const { Text, Icon, Button, FieldIcon, SearchField } = host;

    // Conditions, then the fields the filter can add, each standing once and keeping its place while open.
    const addable = addableFields(props);
    const addableIds = new Set(addable.map((field) => field.id));
    const groups = props.fieldGroups ?? [];
    const grouped = new Set(groups.flatMap((group) => group.fieldIds));
    const groupedAddable = [
      ...groups.flatMap((group) => group.fieldIds.filter((id) => addableIds.has(id))),
      ...addable.filter((field) => !grouped.has(field.id)).map((field) => field.id),
    ];
    const conditionIds = [...new Set(shownRows.map((row) => row.fieldId))];
    const { order, openedWithConditions } = useStableFieldOrder(conditionIds, groupedAddable);
    const conditionedNow = new Set(conditionIds);
    // A field stands where it stood at opening: with the conditions, or among the fields to add.
    const openedConditions = new Set(order.slice(0, openedWithConditions));
    const needle = fieldQuery.trim().toLocaleLowerCase();
    const searchable = addable.length > M.searchThreshold;
    const fieldOf = (id: string) => fieldsById.get(id) ?? rowForField(id)?.field ?? null;
    const conditionsPart = order.filter((id) => openedConditions.has(id) && (conditionedNow.has(id) || addableIds.has(id)));
    const addPart = order.filter((id) => !openedConditions.has(id) && (conditionedNow.has(id) || addableIds.has(id)))
      .filter((id) => !needle || conditionedNow.has(id) || (fieldOf(id)?.label.toLocaleLowerCase().includes(needle) ?? false));
    // Fields outside the owner's groups stand under the filter's own word for them ("Add filter").
    const groupTitleOf = (id: string) => groups.find((group) => group.fieldIds.includes(id))?.title ?? labels.add;

    const valuesOf = (field: CollectionConditionField): ReactNode => {
      const custom = props.renderValuePicker?.({
        field,
        row: rowForField(field.id),
        close,
        ...(bodyMaxHeight === undefined ? {} : { maxHeight: bodyMaxHeight }),
      });
      return custom ? (
        <View testID={`collection-filter-values:${field.id}`}>{custom}</View>
      ) : (
        <ValueList
          field={field}
          row={rowForField(field.id)}
          host={host}
          labels={labels}
          colors={colors}
          press={press}
          onPick={pickValue}
        />
      );
    };

    const conditionRow = (row: CollectionConditionRow) => {
      const locked = props.lockedFieldIds?.has(row.fieldId) === true;
      const togglesOperator =
        row.operator !== 'unavailable' &&
        row.field.operators.length > 1 &&
        row.field.kind === 'set';
      const values =
        props.summarizeValues?.(row.field, row.values) ??
        collectionConditionValueLabels(row.field, row.values, props.formatValue);
      const shown = values.length > 0 ? values : ['—'];
      return (
        <View
          key={row.id}
          testID={`collection-filter-condition:${row.fieldId}:${row.operator}`}
          style={styles.row}
        >
          <View style={styles.field}>
            <Text role="field" numberOfLines={1}>
              {row.field.label}
            </Text>
          </View>
          {togglesOperator ? (
            <HappierPressable
              testID={`collection-filter-condition:${row.fieldId}:${row.operator}:operator`}
              accessibilityRole="button"
              accessibilityLabel={`${row.field.label} ${labels.operators[row.operator]}`}
              onPress={() => toggleOperator(row)}
              hitTarget={hitTarget}
              hitReach={rowControlHitReach(24)}
              style={(state) =>
                press(state, styles.operator, 'transparent')
              }
            >
              <Text role="operator">
                {labels.operators[row.operator]}
              </Text>
            </HappierPressable>
          ) : (
            <View style={styles.operatorLabel}>
              <Text role="operator">
                {labels.operators[row.operator]}
              </Text>
            </View>
          )}
          <HappierPressable
            testID={`collection-filter-condition:${row.fieldId}:${row.operator}:value`}
            accessibilityRole="button"
            accessibilityLabel={`${row.field.label}: ${values.join(', ')}`}
            expanded={openFieldId === row.fieldId}
            disabled={!row.available}
            onPress={() => toggle(row.fieldId)}
            hitTarget={hitTarget}
            hitReach={rowControlHitReach(M.valueMinHeight)}
            style={(state) => press(state, styles.value, colors.fill)}
          >
            {/* The chip's long values clip inside it; the chip itself never clips, so its hit area reaches the row. */}
            <View style={styles.valueContent}>
              {shown.map((value, index) => (
                <View
                  key={`${index}:${value}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    flexShrink: 1,
                    minWidth: 0,
                  }}
                >
                  {index > 0 ? <Text role="join">{labels.or}</Text> : null}
                  <Text role="value" numberOfLines={1}>
                    {value}
                  </Text>
                </View>
              ))}
            </View>
          </HappierPressable>
          <View style={styles.removeSlot}>
            {locked ? null : (
              <HappierPressable
                testID={`collection-filter-condition:${row.fieldId}:${row.operator}:remove`}
                accessibilityRole="button"
                accessibilityLabel={labels.remove(row.field.label)}
                onPress={() =>
                  onChange({ type: 'remove', rowId: row.id })
                }
                hitTarget={hitTarget}
                // The row's last control: half the gap toward the value, the row's end padding beyond it.
                hitReach={{ ...rowControlHitReach(M.removeSize), right: 4 }}
                style={(state) => press(state, styles.remove, 'transparent')}
              >
                <Icon name="remove" />
              </HappierPressable>
            )}
          </View>
        </View>
      );
    };

    // A field with conditions draws them; one without is a row that opens its values in place.
    const fieldBlock = (id: string) => {
      const field = fieldOf(id);
      if (field === null) return null;
      const rows = shownRows.filter((row) => row.fieldId === id);
      const open = openFieldId === id;
      return (
        <View key={id}>
          {rows.length > 0 ? rows.map(conditionRow) : (
            <HappierPressable
              testID={`collection-filter-field:${id}`}
              accessibilityRole="button"
              accessibilityLabel={field.label}
              expanded={open}
              onPress={() => startField(field)}
              style={(state) => press(state, styles.option, 'transparent')}
            >
              {FieldIcon ? (
                <View style={styles.optionMark}>
                  <FieldIcon fieldId={id} />
                </View>
              ) : null}
              <View style={styles.grow}>
                <Text role="option" numberOfLines={1}>
                  {field.label}
                </Text>
              </View>
              <HappierDisclosureChevron expanded={open}
                color={theme?.colors.secondaryText ?? colors.divider} reducedMotion />
            </HappierPressable>
          )}
          {open ? valuesOf(field) : null}
        </View>
      );
    };

    const titledAddPart: ReactNode[] = [];
    let lastGroupTitle: string | null = null;
    for (const id of addPart) {
      const title = groupTitleOf(id);
      if (title !== null && title !== lastGroupTitle) {
        titledAddPart.push(
          <View key={`group:${title}`} style={styles.groupTitle}>
            <Text role="groupTitle">{title}</Text>
          </View>,
        );
      }
      lastGroupTitle = title;
      titledAddPart.push(fieldBlock(id));
    }

    return (
      <View testID={props.testID ?? 'collection-filter'} style={styles.root}>
        <ScrollView
          style={
            bodyMaxHeight === undefined
              ? undefined
              : { maxHeight: bodyMaxHeight }
          }
          contentContainerStyle={styles.body}
          showsVerticalScrollIndicator={Platform.OS === 'web'}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <View style={styles.grow}>
              <Text role="title" accessibilityRole="header">
                {labels.title}
              </Text>
            </View>
            <HappierPressable
              testID="collection-filter-clear"
              accessibilityRole="button"
              accessibilityLabel={labels.clear}
              onPress={() => onChange({ type: 'clear' })}
              hitTarget={hitTarget}
              style={(state) =>
                press(
                  state,
                  {
                    paddingHorizontal: 4,
                    minHeight: 24,
                    borderRadius: 6,
                    justifyContent: 'center',
                  },
                  'transparent',
                )
              }
            >
              <Text role="count">{labels.clear}</Text>
            </HappierPressable>
          </View>
          {conditionsPart.map(fieldBlock)}
          {addPart.length > 0 || searchable ? (
            <View testID="collection-filter-fields"
              style={conditionsPart.length > 0 ? [styles.fields, { borderTopColor: colors.divider }] : null}>
              {searchable ? (
                <SearchField
                  value={fieldQuery}
                  onChangeText={setFieldQuery}
                  placeholder={labels.addSearch}
                  testID="collection-filter-fields-search"
                  style={styles.search}
                />
              ) : null}
              {searchable && addPart.length === 0 ? (
                <View style={styles.empty}>
                  <Text role="empty">{labels.noFields}</Text>
                </View>
              ) : null}
              {titledAddPart}
            </View>
          ) : null}
        </ScrollView>
        {/* Nothing to count and nothing to press: no footer, so the editor never ends in an empty band. */}
        {countLabel || props.onSaveAsSpace || props.onDone ? (
        <View
          style={[
            styles.footer,
            { borderTopWidth: 1, borderTopColor: colors.divider },
          ]}
        >
          <View style={styles.grow}>
            <Text
              role="count"
              numberOfLines={1}
              testID="collection-filter-count"
            >
              {countLabel}
            </Text>
          </View>
          {props.onSaveAsSpace ? (
            <Button
              testID="session-list-space-save"
              tone="default"
              label={labels.saveAsSpace}
              onPress={props.onSaveAsSpace}
            />
          ) : null}
          {props.onDone ? (
            <Button
              testID="collection-filter-done"
              tone="primary"
              label={props.doneLabel ?? labels.done}
              {...(props.doneDisabled === undefined
                ? {}
                : { disabled: props.doneDisabled })}
              onPress={props.onDone}
            />
          ) : null}
        </View>
        ) : null}
      </View>
    );
  },
);

/** Fields the filter can add: available, allowed by the owner, and not already a visible condition. */
function addableFields(
  props: HappierCollectionConditionEditorProps,
): readonly CollectionConditionField[] {
  const visible = new Set(
    props.model.rows
      .filter((row) => !props.hiddenFieldIds?.has(row.fieldId))
      .map((row) => row.fieldId),
  );
  return props.model.availableFields.filter(
    (field) =>
      !visible.has(field.id) &&
      (props.addableFieldIds === undefined ||
        props.addableFieldIds.has(field.id)) &&
      (field.valueOptions.length > 0 || props.renderValuePicker !== undefined),
  );
}

type PressStyle = (
  state: HappierPressableStyleState,
  base: HappierPortableStyle,
  fill?: string,
) => HappierStyleProp;

/** A field's values, open in place under it. The popover's own body scrolls them with everything else. */
function ValueList(
  props: Readonly<{
    field: CollectionConditionField;
    row: CollectionConditionRow | null;
    host: HappierCollectionConditionEditorHost;
    labels: HappierCollectionConditionEditorLabels;
    colors: ReturnType<HappierCollectionConditionEditorHost['useColors']>;
    press: PressStyle;
    onPick: (
      field: CollectionConditionField,
      option: CollectionConditionValueOption,
    ) => void;
  }>,
): ReactElement {
  const { field, host, labels } = props;
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const options = needle
    ? field.valueOptions.filter((option) =>
        (option.label ?? JSON.stringify(option.value))
          .toLocaleLowerCase()
          .includes(needle),
      )
    : field.valueOptions;
  const multi = isMultiValue(field);
  const { Text, Icon, SearchField } = host;
  return (
    <View testID={`collection-filter-values:${field.id}`}>
      {field.valueOptions.length > M.searchThreshold ? (
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder={field.label}
          testID="collection-filter-values-search"
          style={styles.valueSearch}
        />
      ) : null}
      {options.length === 0 ? (
        <View style={styles.valuesEmpty}>
          <Text role="empty">{labels.noValues}</Text>
        </View>
      ) : null}
      {options.map((option) => {
        const selected =
          props.row !== null && optionPicked(props.row.values, option);
        const label =
          option.label ??
          (typeof option.value === 'string'
            ? option.value
            : JSON.stringify(option.value));
        const valueKey = typeof option.value === 'string' ? option.value : JSON.stringify(option.value);
        return (
          <HappierPressable
            key={JSON.stringify(option.value)}
            testID={`collection-filter-value:${field.id}:${valueKey}`}
            accessibilityRole={multi ? 'checkbox' : 'radio'}
            accessibilityLabel={label}
            checked={selected}
            disabled={option.disabled === true}
            onPress={() => props.onPick(field, option)}
            style={(state) => props.press(state, styles.valueOption, 'transparent')}
          >
            <View style={styles.grow}>
              <Text role="option" numberOfLines={1}>
                {label}
              </Text>
            </View>
            {/* How many held rows carry it (lab `clfilter:add`); absent when nothing local says. */}
            {option.count !== undefined ? (
              <Text role="optionCount" numberOfLines={1} testID={`collection-filter-value-count:${field.id}:${valueKey}`}>
                {String(option.count)}
              </Text>
            ) : null}
            <View style={styles.optionMark}>
              {selected ? <Icon name="check" /> : null}
            </View>
          </HappierPressable>
        );
      })}
    </View>
  );
}

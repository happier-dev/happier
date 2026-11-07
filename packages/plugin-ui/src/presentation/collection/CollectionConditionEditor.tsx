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

/**
 * The one condition editor (lab `clfilter:filter`, P6 §4.1): a filter as a list of conditions —
 * Field · operator · values · remove — that starts from what the list shows, grows with Add filter and
 * counts the result live. Sessions, Workflows, Discussions, Settings columns and plugin pages draw
 * this same body over the shared condition model; each supplies its own registry, labels and host.
 *
 * The editor holds only which picker is open. Every change leaves as one {@link CollectionConditionEdit}
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
  | 'add'
  | 'remove'
  | 'back'
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
  /** A field's mark in the Add filter list, when the host has one. */
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
  back: string;
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
  addMinHeight: 32,
  addRadius: 8,
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

type Picker = Readonly<{ kind: 'add' } | { kind: 'values'; fieldId: string }>;

const styles = Object.freeze({
  root: { width: '100%', minWidth: 300 } satisfies ViewStyle,
  body: {
    paddingHorizontal: M.padding,
    paddingTop: M.padding,
    paddingBottom: 4,
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
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: M.addMinHeight,
    marginTop: 4,
    paddingHorizontal: 8,
    borderRadius: M.addRadius,
  } satisfies HappierPortableStyle,
  footer: {
    minHeight: M.footerMinHeight,
    marginHorizontal: M.padding,
    paddingLeft: 4,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } satisfies ViewStyle,
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    paddingHorizontal: 4,
  } satisfies ViewStyle,
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 28,
    paddingHorizontal: 6,
    borderRadius: 6,
  } satisfies HappierPortableStyle,
  search: { marginVertical: 4 } satisfies ViewStyle,
  groupTitle: {
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 2,
  } satisfies ViewStyle,
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: M.optionMinHeight,
    paddingHorizontal: 8,
    borderRadius: 7,
  } satisfies HappierPortableStyle,
  optionMark: { width: 16, alignItems: 'center' } satisfies ViewStyle,
  empty: { paddingHorizontal: 8, paddingVertical: 10 } satisfies ViewStyle,
});

export const HappierCollectionConditionEditor = memo(
  function HappierCollectionConditionEditor(
    props: HappierCollectionConditionEditorProps,
  ): ReactElement {
    const { host, labels, model, onChange } = props;
    const colors = host.useColors();
  const hitTarget = host.touchTargetPx;
    const [picker, setPicker] = useState<Picker | null>(null);
    const close = useCallback(() => setPicker(null), []);
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
      const field = picker?.kind === 'values'
        ? fieldsById.get(picker.fieldId) ?? rowForField(picker.fieldId)?.field : undefined;
      const request = field ? { fieldId: field.id, options: field.valueOptions.map(({ value, values }) =>
        values ? { value, values } : { value }) } : null;
      // Count arrivals and label-only rebindings cannot feed demand back into the producer.
      const key = JSON.stringify(request);
      if (countDemand.current.key === key) return;
      countDemand.current = { key, request };
      props.onValuePickerChange(request);
    }, [fieldsById, picker, props.onValuePickerChange, rowForField]);
    useEffect(() => () => {
      if (countDemand.current.request === null) return;
      countDemand.current = { key: 'null', request: null };
      countDemandListener.current?.(null);
    }, []);

    const press = (
      state: HappierPressableStyleState,
      base: HappierPortableStyle,
      fill?: string,
    ): HappierStyleProp => [
      base,
      fill !== undefined
        ? {
            backgroundColor:
              state.hovered || state.pressed ? colors.fillHover : fill,
          }
        : null,
      happierFocusRingStyle({ visible: state.focused, color: colors.focus }),
    ];

    // A one-choice field ("Needs me · Waiting on you") is added whole; any other field opens its values.
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
          setPicker(null);
          return;
        }
        setPicker({ kind: 'values', fieldId: field.id });
      },
      [close, onChange, props, rowForField],
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
          setPicker(null);
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
    const { Text, Icon, Button } = host;

    if (picker) {
      const field =
        picker.kind === 'values'
          ? (fieldsById.get(picker.fieldId) ??
            rowForField(picker.fieldId)?.field ??
            null)
          : null;
      const custom =
        field &&
        props.renderValuePicker?.({
          field,
          row: rowForField(field.id),
          close,
          ...(props.maxHeight === undefined
            ? {}
            : { maxHeight: props.maxHeight }),
        });
      return (
        <View
          testID={`${props.testID ?? 'collection-filter'}-picker`}
          style={styles.root}
        >
          <View style={[styles.body, { paddingBottom: M.padding }]}>
            <View style={styles.pickerHeader}>
              <HappierPressable
                testID="collection-filter-back"
                accessibilityRole="button"
                accessibilityLabel={labels.back}
                onPress={close}
                style={(state) => press(state, styles.back, 'transparent')}
              >
                <Icon name="back" />
                <Text role="action">{labels.title}</Text>
              </HappierPressable>
            </View>
            {custom ? (
              custom
            ) : picker.kind === 'add' ? (
              <AddFieldList
                {...props}
                colors={colors}
                press={press}
                onPick={startField}
              />
            ) : field ? (
              <ValueList
                field={field}
                row={rowForField(field.id)}
                host={host}
                labels={labels}
                colors={colors}
                press={press}
                maxHeight={bodyMaxHeight}
                onPick={pickValue}
              />
            ) : null}
          </View>
        </View>
      );
    }

    const canAdd = addableFields(props).length > 0;
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
          {shownRows.map((row) => {
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
                                    disabled={!row.available}
                  onPress={() =>
                    setPicker({ kind: 'values', fieldId: row.fieldId })
                  }
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
          })}
          {canAdd ? (
            <HappierPressable
              testID="collection-filter-add"
              accessibilityRole="button"
              accessibilityLabel={labels.add}
                            onPress={() => setPicker({ kind: 'add' })}
              hitTarget={hitTarget}
              // Half its top margin toward the last row's controls.
              hitReach={{ top: 2 }}
              style={(state) => press(state, styles.add, colors.fill)}
            >
              <Icon name="add" />
              <Text role="action">{labels.add}</Text>
            </HappierPressable>
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

/** Fields Add filter offers: available, allowed by the owner, and not already a visible condition. */
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

function AddFieldList(
  props: HappierCollectionConditionEditorProps &
    Readonly<{
      colors: ReturnType<HappierCollectionConditionEditorHost['useColors']>;
      press: PressStyle;
      onPick: (field: CollectionConditionField) => void;
    }>,
): ReactElement {
  const { host, labels } = props;
  const [query, setQuery] = useState('');
  const fields = addableFields(props);
  const needle = query.trim().toLocaleLowerCase();
  const matching = needle
    ? fields.filter((field) => field.label.toLocaleLowerCase().includes(needle))
    : fields;
  const groups = props.fieldGroups ?? [];
  const grouped = new Set(groups.flatMap((group) => group.fieldIds));
  const sections = [
    ...groups.map((group) => ({
      id: group.id,
      title: group.title,
      fields: group.fieldIds.flatMap((id) =>
        matching.filter((field) => field.id === id),
      ),
    })),
    {
      id: 'other',
      title: null as string | null,
      fields: matching.filter((field) => !grouped.has(field.id)),
    },
  ].filter((section) => section.fields.length > 0);
  const { Text, FieldIcon, SearchField } = host;
  return (
    <View testID="collection-filter-fields">
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={labels.addSearch}
        testID="collection-filter-fields-search"
        style={styles.search}
      />
      {sections.length === 0 ? (
        <View style={styles.empty}>
          <Text role="empty">{labels.noFields}</Text>
        </View>
      ) : null}
      {sections.map((section) => (
        <View key={section.id}>
          {section.title ? (
            <View style={styles.groupTitle}>
              <Text role="groupTitle">{section.title}</Text>
            </View>
          ) : null}
          {section.fields.map((field) => (
            <HappierPressable
              key={field.id}
              testID={`collection-filter-field:${field.id}`}
              accessibilityRole="button"
              accessibilityLabel={field.label}
              onPress={() => props.onPick(field)}
              style={(state) =>
                props.press(state, styles.option, 'transparent')
              }
            >
              {FieldIcon ? (
                <View style={styles.optionMark}>
                  <FieldIcon fieldId={field.id} />
                </View>
              ) : null}
              <View style={styles.grow}>
                <Text role="option" numberOfLines={1}>
                  {field.label}
                </Text>
              </View>
            </HappierPressable>
          ))}
        </View>
      ))}
    </View>
  );
}

function ValueList(
  props: Readonly<{
    field: CollectionConditionField;
    row: CollectionConditionRow | null;
    host: HappierCollectionConditionEditorHost;
    labels: HappierCollectionConditionEditorLabels;
    colors: ReturnType<HappierCollectionConditionEditorHost['useColors']>;
    press: PressStyle;
    maxHeight?: number;
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
          style={styles.search}
        />
      ) : null}
      <ScrollView
        style={
          props.maxHeight === undefined
            ? undefined
            : { maxHeight: props.maxHeight - 48 }
        }
        keyboardShouldPersistTaps="handled"
      >
        {options.length === 0 ? (
          <View style={styles.empty}>
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
              style={(state) =>
                props.press(state, styles.option, 'transparent')
              }
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
      </ScrollView>
    </View>
  );
}

import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import {
  resolveFieldBoxColors,
  FIELD_BOX_METRICS,
} from '@/components/ui/forms/fieldBox';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { Modal } from '@/modal';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

import { SavedSecretPickerModal } from './SavedSecretPickerModal';
import {
  ValueRefEditorModal,
  getValueRefEditorModalTitle,
} from './ValueRefEditorModal';
import {
  useValueRefRowsEditor,
  type ValueRefRowsKind,
} from './useValueRefRowsEditor';

/** Below this width a row can't hold name · value · type · ⋯ side by side: rows become value + chevron. */
const INLINE_MIN_WIDTH_PX = 440;
const NEW_ROW_ID = '\u0000new';
const MACHINE_VALUE_REGEX = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

type RowType =
  | 'literal'
  | 'savedSecret'
  | 'machine'
  | 'template'
  | 'sessionAttested';

function rowType(valueRef: ValueRefV1): RowType {
  if (valueRef.t === 'literal')
    return MACHINE_VALUE_REGEX.test(valueRef.v) ? 'machine' : 'literal';
  return valueRef.t;
}

function typeTitle(type: RowType): string {
  switch (type) {
    case 'literal':
      return t('capabilities.valueRows.text');
    case 'savedSecret':
      return t('capabilities.valueRows.savedSecret');
    case 'machine':
      return t('capabilities.valueRows.fromMachine');
    case 'template':
      return t('capabilities.valueRows.template');
    case 'sessionAttested':
      return t('capabilities.valueRows.fromSession');
  }
}

function literalText(valueRef: ValueRefV1): string {
  return valueRef.t === 'literal' ? valueRef.v : '';
}

/** One line saying what a row holds: the value and its kind, a saved secret's name, or what it is. */
export function describeValueRef(
  valueRef: ValueRefV1,
  secretName: (secretId: string) => string | null,
): string {
  const type = rowType(valueRef);
  if (type === 'savedSecret' && valueRef.t === 'savedSecret')
    return (
      secretName(valueRef.secretId) ?? t('capabilities.valueRows.needsValue')
    );
  if (type === 'literal' || type === 'machine') {
    const text = literalText(valueRef);
    return text.length === 0
      ? t('capabilities.valueRows.needsValue')
      : `${text} · ${typeTitle(type)}`;
  }
  return typeTitle(type);
}

/** What a literal typed into a "From the machine" field means: `${NAME}`, with or without the braces. */
function machineValue(text: string): string | null {
  const trimmed = text.trim();
  if (MACHINE_VALUE_REGEX.test(trimmed)) return trimmed;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? '${' + trimmed + '}' : null;
}

/**
 * The one editor of named values (environment variables, headers) that each point at a value: text, a
 * Saved Secret, or a variable from the machine's own environment. Each row is name · value · type · ⋯,
 * edited in place; a row commits when focus leaves it (or when its type or secret is chosen), so the
 * caller saves on each `onChangeEntries`. Narrow: rows show the value and push the row editor.
 */
export const ValueRefRowsEditor = React.memo(function ValueRefRowsEditor(
  props: Readonly<{
    kind: ValueRefRowsKind;
    entries: Readonly<Record<string, ValueRefV1>>;
    onChangeEntries: (next: Record<string, ValueRefV1>) => void;
    secrets: SavedSecret[];
    scope?: AccountSettingsScope | null;
    /** The add-a-row button's label; absent when `declaredNames` fixes the rows. */
    addLabel?: string;
    /**
     * The names are declared elsewhere (a registry server's inputs, a pasted config's keys): they read as fixed text,
     * rows can't be removed or renamed, and no row is added. Only the values and their types are edited.
     */
    declaredNames?: boolean;
    /** What each declared name is for, by name: a quiet line under that row, so the name is said once. */
    descriptions?: Readonly<Record<string, string>>;
    /** Test ids: `<prefix>.row.<i>.{name,value,type,more}` and `<prefix>.add`. */
    testIdPrefix: string;
    /** Names whose value is missing (the banner's "Add key" lands here): drawn as the attention field. */
    attentionKeys?: ReadonlySet<string>;
    /** Read-only rows (a header the sign-in provides), shown after the editable ones. */
    fixedRows?: readonly Readonly<{
      key: string;
      value: string;
      type: string;
    }>[];
  }>,
) {
  const { theme } = useUnistyles();
  const catalog = useSavedSecretCatalog(
    props.scope === undefined ? undefined : { scope: props.scope },
  );
  const editor = useValueRefRowsEditor({
    kind: props.kind,
    entries: props.entries as Record<string, ValueRefV1>,
    onChangeEntries: props.onChangeEntries,
  });
  const [width, setWidth] = React.useState<number | null>(null);
  const [pendingRow, setPendingRow] = React.useState(false);
  const [typeWidths, setTypeWidths] = React.useState<Readonly<Record<string, number>>>({});
  const onTypeWidth = React.useCallback(
    (rowId: string, width: number) => setTypeWidths((current) => (current[rowId] === width ? current : { ...current, [rowId]: width })),
    [],
  );
  const inline = width === null || width >= INLINE_MIN_WIDTH_PX;

  const secretName = React.useCallback(
    (secretId: string): string | null =>
      catalog.entries.find((entry) => entry.ref === secretId)?.name ??
      props.secrets.find((secret) => secret.id === secretId)?.name ??
      null,
    [catalog.entries, props.secrets],
  );

  const openRowModal = React.useCallback(
    (key: string | null, valueRef: ValueRefV1) => {
      Modal.show({
        component: ValueRefEditorModal,
        props: {
          kind: props.kind,
          initialKey: key ?? '',
          lockKey: props.declaredNames === true,
          initialValueRef: valueRef,
          secrets: props.secrets,
          ...(props.scope === undefined ? {} : { scope: props.scope }),
          onDelete:
            key === null || props.declaredNames === true
              ? null
              : () => {
                  editor.removeEntry(key);
                },
          onSubmit: ({ key: nextKey, valueRef: nextValueRef }) => {
            const result = editor.submitEntry(key, nextKey, nextValueRef);
            if (!result.ok)
              Modal.alert(
                t('common.error'),
                result.error === 'duplicate_key'
                  ? t('capabilities.valueRows.duplicateName')
                  : t('errors.operationFailed'),
              );
            return result.ok;
          },
        },
        chrome: {
          kind: 'card',
          title: getValueRefEditorModalTitle(props.kind),
          dimensions: { size: 'lg' },
        },
        closeOnBackdrop: true,
      });
    },
    [
      editor.removeEntry,
      editor.submitEntry,
      props.declaredNames,
      props.kind,
      props.scope,
      props.secrets,
    ],
  );

  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setWidth((current) => (current === next ? current : next));
  }, []);

  const typeColumnWidth = Math.max(
    0,
    ...editor.rows.map((row) => typeWidths[row.key] ?? 0),
    pendingRow ? (typeWidths[NEW_ROW_ID] ?? 0) : 0,
  );

  const describe = (valueRef: ValueRefV1): string =>
    describeValueRef(valueRef, secretName);

  return (
    <View style={styles.list} onLayout={onLayout}>
      {editor.rows.map((row, index) =>
        inline ? (
          <ValueRefInlineRow
            key={row.key}
            kind={props.kind}
            rowKey={row.key}
            valueRef={row.valueRef}
            testID={`${props.testIdPrefix}.row.${index}`}
            attention={props.attentionKeys?.has(row.key) === true}
            secretName={
              row.valueRef.t === 'savedSecret'
                ? secretName(row.valueRef.secretId)
                : null
            }
            scope={props.scope}
            declaredName={props.declaredNames === true}
            description={props.descriptions?.[row.key]}
            typeColumnWidth={typeColumnWidth}
            onTypeWidth={onTypeWidth}
            onSubmit={(key, valueRef) =>
              editor.submitEntry(row.key, key, valueRef)
            }
            onRemove={() => {
              editor.removeEntry(row.key);
            }}
            onEditInModal={() => openRowModal(row.key, row.valueRef)}
          />
        ) : (
          <View key={row.key}>
            <Item
              testID={`${props.testIdPrefix}.row.${index}`}
              title={row.key}
              titleStyle={styles.mono}
              subtitle={describe(row.valueRef)}
              onPress={() => openRowModal(row.key, row.valueRef)}
              showDivider={false}
            />
            {props.descriptions?.[row.key] ? (
              <Text variant="meta" style={[styles.description, { color: theme.colors.text.secondary }]}>
                {props.descriptions[row.key]}
              </Text>
            ) : null}
          </View>
        ),
      )}
      {props.fixedRows?.map((row) => (
        <View key={row.key} style={styles.fixedRow}>
          <Text
            variant="body"
            style={[styles.mono, styles.fixedKey]}
            numberOfLines={1}
          >
            {row.key}
          </Text>
          <Text variant="body" style={styles.fixedValue} numberOfLines={1}>
            {row.value}
          </Text>
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {row.type}
          </Text>
        </View>
      ))}
      {inline && pendingRow ? (
        <ValueRefInlineRow
          kind={props.kind}
          rowKey={null}
          valueRef={{ t: 'literal', v: '' }}
          testID={`${props.testIdPrefix}.row.new`}
          attention={false}
          secretName={null}
          scope={props.scope}
          autoFocus
          typeColumnWidth={typeColumnWidth}
          onTypeWidth={onTypeWidth}
          onSubmit={(key, valueRef) => {
            const result = editor.submitEntry(null, key, valueRef);
            if (result.ok) setPendingRow(false);
            return result;
          }}
          onRemove={() => setPendingRow(false)}
          onEditInModal={() => {
            setPendingRow(false);
            openRowModal(null, { t: 'literal', v: '' });
          }}
        />
      ) : null}
      {props.declaredNames === true || props.addLabel === undefined ? null : (
      <View style={styles.addRow}>
        <RoundButton
          testID={`${props.testIdPrefix}.add`}
          size="small"
          display="inverted"
          title={props.addLabel}
          leading={
            <Icon name="plus" size={14} color={theme.colors.text.secondary} />
          }
          onPress={() =>
            inline
              ? setPendingRow(true)
              : openRowModal(null, { t: 'literal', v: '' })
          }
        />
      </View>
      )}
    </View>
  );
});

type SubmitResult = ReturnType<
  ReturnType<typeof useValueRefRowsEditor>['submitEntry']
>;

const ValueRefInlineRow = React.memo(function ValueRefInlineRow(
  props: Readonly<{
    kind: ValueRefRowsKind;
    /** `null` for the row being added. */
    rowKey: string | null;
    valueRef: ValueRefV1;
    testID: string;
    attention: boolean;
    secretName: string | null;
    scope?: AccountSettingsScope | null;
    autoFocus?: boolean;
    /** The name is fixed text: no rename, no remove. */
    declaredName?: boolean;
    /** What the declared name is for, quietly under the row. */
    description?: string;
    /** The list's one source-column width (the widest source any row shows), so name, value and source line up down the list. */
    typeColumnWidth: number;
    onTypeWidth: (rowId: string, width: number) => void;
    onSubmit: (key: string, valueRef: ValueRefV1) => SubmitResult;
    onRemove: () => void;
    onEditInModal: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { onTypeWidth } = props;
  const rowId = props.rowKey ?? NEW_ROW_ID;
  const onTypeLayout = React.useCallback(
    (event: LayoutChangeEvent) => onTypeWidth(rowId, Math.ceil(event.nativeEvent.layout.width)),
    [onTypeWidth, rowId],
  );
  const savedType = rowType(props.valueRef);
  const [type, setType] = React.useState<RowType>(savedType);
  const [name, setName] = React.useState(props.rowKey ?? '');
  const [value, setValue] = React.useState(literalText(props.valueRef));
  const [error, setError] = React.useState<string | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);

  // Follow the saved value whenever it changes underneath (another device, a type change committed here).
  React.useEffect(() => {
    setType(rowType(props.valueRef));
    setValue(literalText(props.valueRef));
  }, [props.valueRef]);
  React.useEffect(() => {
    if (props.rowKey !== null) setName(props.rowKey);
  }, [props.rowKey]);

  const valueRefFor = (nextType: RowType, text: string): ValueRefV1 | null => {
    if (nextType === 'literal') return { t: 'literal', v: text };
    if (nextType === 'machine') {
      const machine = machineValue(text);
      return machine ? { t: 'literal', v: machine } : null;
    }
    return props.valueRef;
  };

  const presentSubmission = (result: SubmitResult) => {
    setError(result.ok ? null : result.error === 'invalid_key'
      ? t(props.kind === 'env' ? 'capabilities.valueRows.invalidEnvName' : 'capabilities.valueRows.invalidHeaderName')
      : result.error === 'duplicate_key' ? t('capabilities.valueRows.duplicateName') : t('errors.operationFailed'));
  };

  const commit = (
    nextType: RowType = type,
    text: string = value,
    nextName: string = name,
  ): void => {
    if (props.rowKey === null && !nextName.trim()) {
      // An untouched new row leaves quietly.
      if (!text.trim()) props.onRemove();
      return;
    }
    const valueRef = valueRefFor(nextType, text);
    if (!valueRef) {
      setError(t('capabilities.valueRows.invalidMachine'));
      return;
    }
    if (
      props.rowKey !== null &&
      nextName === props.rowKey &&
      valueRef === props.valueRef
    )
      return;
    if (
      props.rowKey !== null &&
      nextName === props.rowKey &&
      valueRef.t === 'literal' &&
      props.valueRef.t === 'literal' &&
      valueRef.v === props.valueRef.v
    )
      return;
    const result = props.onSubmit(nextName, valueRef);
    presentSubmission(result);
  };

  // A new row waits for its value: leaving its name for its value must not file it away half typed.
  const onNameBlur = () => {
    if (props.rowKey === null && !value.trim()) return;
    commit();
  };
  const onValueBlur = () => commit();

  const pickSecret = (thenType: RowType) => {
    Modal.show({
      component: SavedSecretPickerModal,
      props: {
        ...(props.scope === undefined ? {} : { scope: props.scope }),
        selectedId:
          props.valueRef.t === 'savedSecret' ? props.valueRef.secretId : null,
        includeNoneRow: false,
        onSelectId: (id: string | null) => {
          if (!id) return;
          const result = props.onSubmit(name, {
            t: 'savedSecret',
            secretId: id,
          });
          if (result.ok) setType(thenType);
          presentSubmission(result);
        },
      },
      chrome: {
        kind: 'card',
        title: t('settings.mcpServersPickSecretTitle'),
        dimensions: { size: 'lg' },
      },
      closeOnBackdrop: true,
    });
  };

  const chooseType = (id: string) => {
    const next = id as RowType;
    if (next === type) return;
    if (next === 'savedSecret') {
      pickSecret(next);
      return;
    }
    const text =
      next === 'machine'
        ? '${' + (name.trim().toUpperCase() || 'NAME') + '}'
        : type === 'machine'
          ? ''
          : value;
    setType(next);
    setValue(text);
    commit(next, text);
  };

  const typeItems = React.useMemo(
    () => [
      {
        id: 'literal',
        title: typeTitle('literal'),
        icon: (
          <Icon name="text-aa" size={16} color={theme.colors.text.secondary} />
        ),
      },
      {
        id: 'savedSecret',
        title: typeTitle('savedSecret'),
        icon: (
          <Icon name="lock" size={16} color={theme.colors.text.secondary} />
        ),
      },
      ...(props.kind === 'env'
        ? [
            {
              id: 'machine',
              title: typeTitle('machine'),
              icon: (
                <Icon
                  name="desktop"
                  size={16}
                  color={theme.colors.text.secondary}
                />
              ),
            },
          ]
        : []),
    ],
    [props.kind, theme.colors.text.secondary],
  );

  const moreItems = React.useMemo(
    (): DropdownMenuItem[] => [
      { id: 'edit', title: t('capabilities.valueRows.edit') },
      ...(props.declaredName === true
        ? []
        : [
            {
              id: 'remove',
              title: t('capabilities.valueRows.remove'),
              destructive: true,
            },
          ]),
    ],
    [props.declaredName],
  );

  const fieldColors = resolveFieldBoxColors(theme);
  const special = type === 'template' || type === 'sessionAttested';

  return (
    <View style={styles.rowWrap}>
      <View style={styles.row} testID={props.testID}>
        {props.declaredName === true ? (
          <View style={styles.nameLabel}>
            <Text
              variant="body"
              testID={`${props.testID}.name`}
              style={[styles.declaredName, { color: theme.colors.text.primary }]}
            >
              {name.replace(/([_-])/g, '$1\u200b')}
            </Text>
          </View>
        ) : (
          <FieldTextInput
            testID={`${props.testID}.name`}
            value={name}
            onChangeText={(text) => {
              setName(props.kind === 'env' ? text.toUpperCase() : text);
              setError(null);
            }}
            onBlur={onNameBlur}
            accessibilityLabel={t('capabilities.valueRows.name')}
            placeholder={
              props.kind === 'env'
                ? t('settings.mcpServersEnvKeyPlaceholder')
                : t('settings.mcpServersHeaderKeyPlaceholder')
            }
            autoCapitalize={props.kind === 'env' ? 'characters' : 'none'}
            autoFocus={props.autoFocus}
            invalid={Boolean(error)}
            monospace
            style={styles.name}
          />
        )}
        <View style={styles.value}>
          {type === 'savedSecret' ? (
            <HappierPressable
                            testID={`${props.testID}.value`}
                            onPress={() => pickSecret('savedSecret')}
                            accessibilityRole="button"
                            accessibilityLabel={props.secretName ?? t('capabilities.valueRows.chooseSecret')}
                            hasPopup="dialog"
                        >
                            {renderDropdownItemTriggerRightElement({
                                detail: props.secretName,
                                open: false,
                                detailColor: theme.colors.text.primary,
                                chevronColor: theme.colors.text.secondary,
                                field: resolveFieldBoxColors(theme, props.attention ? 'invalid' : 'idle'),
                                placeholder: t('capabilities.valueRows.chooseSecret'),
                                placeholderColor: theme.colors.input.placeholder,
                                leading: <Icon name="lock" size={14} color={theme.colors.text.secondary} />,
                                fieldSpan: 'row',
                            })}
                        </HappierPressable>
          ) : special ? (
            <Text
              variant="body"
              numberOfLines={1}
              style={[
                styles.specialValue,
                { color: theme.colors.text.secondary },
              ]}
            >
              {props.valueRef.t === 'template'
                ? props.valueRef.template
                : props.valueRef.t === 'sessionAttested'
                  ? props.valueRef.field
                  : ''}
            </Text>
          ) : (
            <FieldTextInput
              testID={`${props.testID}.value`}
              value={value}
              onChangeText={(text) => {
                setValue(text);
                setError(null);
              }}
              onBlur={onValueBlur}
              accessibilityLabel={t('capabilities.valueRows.value')}
              placeholder={
                type === 'machine'
                  ? '${NAME}'
                  : t('capabilities.valueRows.value')
              }
              invalid={props.attention}
              monospace
            />
          )}
        </View>
        {/* The source and ⋯ stay together at their own width: a row too narrow for them under the value wraps them below it, never truncating the chosen source. */}
        <View style={styles.trailing}>
        <View style={[styles.typeCell, { minWidth: props.typeColumnWidth }]}>
          <View style={styles.typeNatural} onLayout={onTypeLayout}>
          {special ? (
            <Text
              variant="meta"
              style={[styles.typeFixed, { color: theme.colors.text.secondary }]}
            >
              {typeTitle(type)}
            </Text>
          ) : (
            <ValueFieldSelect
              testID={`${props.testID}.type`}
              label={t('capabilities.valueRows.typeLabel')}
              items={typeItems}
              selectedId={type}
              onSelect={chooseType}
            />
          )}
          </View>
        </View>
          <DropdownMenu
            testID={`${props.testID}.more`}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={moreItems}
            onSelect={(id) => {
              setMenuOpen(false);
              if (id === 'remove') props.onRemove();
              else props.onEditInModal();
            }}
            placement="bottom"
            popoverAnchorAlign="end"
            variant="slim"
            matchTriggerWidth={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
              <IconButton
                testID={`${props.testID}.more.trigger`}
                iconName="dots-three"
                variant="plain"
                accessibilityLabel={t('capabilities.valueRows.more', {
                  name: name || t('capabilities.valueRows.name'),
                })}
                tooltip={t('common.more')}
                tooltipHidden={menuOpen}
                onPress={toggle}
              />
            )}
          />
        </View>
      </View>
      {props.description ? (
        <Text variant="meta" testID={`${props.testID}.description`} style={[styles.description, { color: theme.colors.text.secondary }]}>
          {props.description}
        </Text>
      ) : null}
      {error ? (
        <Text
          variant="meta"
          testID={`${props.testID}.error`}
          style={{ color: theme.colors.state.danger.foreground }}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.space.s8,
  },
  rowWrap: {
    gap: theme.space.s4,
  },
  description: {
    paddingTop: theme.space.s2,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  // The bases are the narrowest a name and a value read whole; the trailing source + ⋯ cluster wraps beneath them
  // when the row cannot hold all three.
  name: {
    flexGrow: 2,
    flexShrink: 1,
    flexBasis: 110,
    minWidth: 0,
  },
  value: {
    flexGrow: 3,
    flexShrink: 1,
    flexBasis: 170,
    minWidth: 0,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: theme.space.s8,
  },
  // Every row's source sits in one column as wide as the widest source (measured on the natural child, so it can shrink back).
  typeCell: { flexShrink: 0, alignItems: 'flex-start' },
  typeNatural: { flexShrink: 0 },
  typeFixed: {
    flexShrink: 0,
    paddingHorizontal: theme.space.s8,
  },
  // A name the config fixes reads as a label, whole: it is never an input to truncate or edit. A long one breaks
  // after an underscore or hyphen (a zero-width space marks each), and anywhere only when it has to.
  nameLabel: {
    flexGrow: 2,
    flexShrink: 1,
    flexBasis: 110,
    minWidth: 0,
    minHeight: FIELD_BOX_METRICS.minHeightPx,
    justifyContent: 'center',
  },
  declaredName: {
    ...Typography.mono(),
    ...({ overflowWrap: 'anywhere' } as const),
  },
  specialValue: {
    ...Typography.mono(),
  },
  mono: {
    ...Typography.mono(),
  },
  fixedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minHeight: FIELD_BOX_METRICS.minHeightPx,
  },
  fixedKey: {
    flexGrow: 2,
    flexBasis: 0,
  },
  fixedValue: {
    flexGrow: 3,
    flexBasis: 0,
  },
  addRow: {
    flexDirection: 'row',
  },
}));

import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierInputField, happierPageTextMetrics, resolveHappierActionFieldPresentation, useHappierInputPicker } from '@happier-dev/plugin-ui/presentation';
import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readInputOptionValue } from '@happier-dev/protocol/inputs';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
    AMBIGUOUS_INLINE_LIMIT,
    isLiteralWidgetSetupField,
    type WidgetSetupField,
    type WidgetSetupRow,
    type WidgetSetupValue,
} from './widgetSetupModel';

const FOLLOW_ID = 'follow';
const ANOTHER_ID = 'another';
const PICKER_ID = 'picker';
const RETRY_ID = 'retry';
const pinId = (index: number) => `pin:${index}`;

export type WidgetSetupFieldChange =
    | Readonly<{ kind: 'follow'; slot: string }>
    | Readonly<{ kind: 'pin'; value: JsonValue }>
    | Readonly<{ kind: 'clear' }>;

/**
 * One input of the Set up / Edit inputs step (lab `dashboards` IN): what it is and one control that
 * says how it is bound. Follows reads quiet behind the link glyph; a pin shows the value with its own
 * mark; a needed field asks for a choice; two or three surface values are choices in place; a value
 * that no longer resolves keeps its name with the invalid border and is never swapped for another.
 * A per-viewer input (a connection on a shared surface) is each viewer's own: the row says so and
 * offers nothing to choose.
 *
 * The field menu lists Follow first, then a few pinnable values, then Another… (search over every
 * choice the one options resolver returned). Literal inputs (nothing to follow, no discovered
 * choices) are the public typed field itself, as in Action and Workflow forms.
 */
export function WidgetSetupFieldRow(props: Readonly<{
    entry: WidgetSetupField;
    row: WidgetSetupRow;
    /** Pinnable values from the one options resolver (static or dynamic). */
    options: readonly WidgetSetupValue[];
    optionsStatus: 'loading' | 'ready' | 'failed';
    /** Reads the choices again after a failed read (the one options resolver's retry). */
    onRetryOptions?: () => void;
    /** A primitive value currently pinned (text, number, boolean) for the plain controls. */
    plainValue: JsonValue | undefined;
    phone: boolean;
    /** A repair opened the step at this input: its choices start open. */
    autoOpen?: boolean;
    /**
     * Each new value asks this input for the focus (the Add surface's ↵ while it is still needed):
     * a chosen-value input opens its choices, a typed one takes the keyboard.
     */
    focusRequest?: number;
    disabled?: boolean;
    onChange: (change: WidgetSetupFieldChange) => void;
    testID: string;
}>): React.ReactElement {
    const { entry, row } = props;
    const field = entry.field;
    if (entry.viewer) return <ViewerFieldRow {...props} />;
    if (row.kind === 'choices') return <ChoicesFieldRow {...props} row={row} />;
    if (!entry.follow && isLiteralWidgetSetupField(field)) return <LiteralFieldRow {...props} />;
    return <BindingFieldRow {...props} />;
}

function rowSubtitle(props: Readonly<{ entry: WidgetSetupField; row: WidgetSetupRow }>): string | undefined {
    if (props.row.kind === 'invalid') return t('widgetAdd.invalidReason');
    if (props.row.kind === 'needed' && props.entry.neededHint) return props.entry.neededHint;
    return props.entry.field.description;
}

function NeededTag(): React.ReactElement {
    return <Text style={styles.needed}>{t('widgetAdd.needed')}</Text>;
}

function BindingFieldRow(props: React.ComponentProps<typeof WidgetSetupFieldRow>): React.ReactElement {
    const { theme } = useUnistyles();
    const { entry, row, options } = props;
    const field = entry.field;
    const [open, setOpen] = React.useState(props.autoOpen === true || Boolean(props.focusRequest));
    const [lastFocusRequest, setLastFocusRequest] = React.useState(props.focusRequest);
    const [searching, setSearching] = React.useState(false);
    // Open in this render, not a later passive effect: the menu's opening listener
    // must be mounted before input delivered in the command's commit can cancel it.
    if (props.focusRequest !== lastFocusRequest) {
        setLastFocusRequest(props.focusRequest);
        if (props.focusRequest) setOpen(true);
    }
    const follow = entry.follow;
    // A few likely values sit in the menu; the rest wait behind Another… (lab IN "Follow or pin").
    const shortlist = options.length > AMBIGUOUS_INLINE_LIMIT && !searching ? options.slice(0, AMBIGUOUS_INLINE_LIMIT) : options;
    const pinCategory = follow ? t('widgetAdd.pinGroup') : undefined;
    // The type's own picker (the custom-picker slot): its answer is checked like any other value
    // and pins exactly like a listed choice; cancelling leaves the binding as it was.
    const picker = useHappierInputPicker({
        field: entry.field,
        value: row.kind === 'pinned' ? props.plainValue : follow?.values[0]?.value,
        ...(props.optionsStatus === 'ready' && (field.optionsSourceId !== undefined || field.options !== undefined
            || (field.inputType !== undefined && !('hostType' in field.inputType))) ? { options } : {}),
        onSelect: (picked) => {
            const value = readInputOptionValue(picked);
            if (value === undefined) return;
            props.onChange({ kind: 'pin', value });
        },
    });

    const openPicker = picker.open;
    const pickerLabel = picker.affordance?.label;
    const pickerAccessibilityLabel = picker.affordance?.accessibilityLabel;

    const items = React.useMemo<DropdownMenuItem[]>(() => {
        const list: DropdownMenuItem[] = [];
        if (follow && !searching && follow.values.length <= 1) {
            list.push({
                id: FOLLOW_ID,
                testID: `${props.testID}.follow`,
                title: follow.label,
                ...(follow.values[0] ? { subtitle: follow.values[0].label } : {}),
                category: t('widgetAdd.followGroup'),
                icon: <Icon name="link" size={16} color={theme.colors.text.secondary} />,
                checked: row.kind === 'follows',
            });
        }
        shortlist.forEach((option, index) => {
            list.push({
                id: pinId(index),
                testID: `${props.testID}.option.${index}`,
                title: option.label,
                ...(option.description ? { subtitle: option.description } : {}),
                ...(pinCategory ? { category: pinCategory } : {}),
                ...(option.icon ? { icon: <Icon name={option.icon} size={16} color={theme.colors.text.secondary} /> } : {}),
                ...(option.disabled ? { disabled: true } : {}),
                checked: row.kind === 'pinned' && row.value !== null && sameStrictJsonValue(row.value.value, option.value),
            });
        });
        if (!searching && options.length > shortlist.length) {
            list.push({
                id: ANOTHER_ID,
                testID: `${props.testID}.another`,
                title: t('widgetAdd.another'),
                subtitle: t('widgetAdd.anotherSubtitle'),
                ...(pinCategory ? { category: pinCategory } : {}),
                icon: <Icon name="magnifying-glass" size={16} color={theme.colors.text.secondary} />,
            });
        }
        // A failed read says so in the menu and offers to read again, rather than an empty list.
        if (!searching && props.optionsStatus === 'failed' && props.onRetryOptions) {
            list.push({
                id: RETRY_ID,
                testID: `${props.testID}.retry`,
                title: t('common.retry'),
                subtitle: t('widgetAdd.optionsFailed'),
                icon: <Icon name="arrow-clockwise" size={16} color={theme.colors.text.secondary} />,
            });
        }
        if (!searching && pickerLabel !== undefined) {
            list.push({
                id: PICKER_ID,
                testID: `${props.testID}.picker`,
                title: pickerLabel,
                ...(pickerAccessibilityLabel ? { accessibilityLabel: pickerAccessibilityLabel } : {}),
                ...(pinCategory ? { category: pinCategory } : {}),
                disabled: props.optionsStatus === 'loading',
            });
        }
        return list;
    }, [follow, options.length, pickerAccessibilityLabel, pickerLabel, pinCategory, props.onRetryOptions, props.optionsStatus, props.testID, row, searching, shortlist, theme.colors.text.secondary]);

    const select = React.useCallback((id: string) => {
        if (id === RETRY_ID) {
            props.onRetryOptions?.();
            return;
        }
        if (id === PICKER_ID) {
            setOpen(false);
            void openPicker();
            return;
        }
        if (id === ANOTHER_ID) {
            // The same menu, now searching every choice; it reopens in place under the field.
            setSearching(true);
            setOpen(true);
            return;
        }
        setSearching(false);
        if (id === FOLLOW_ID && follow) {
            props.onChange({ kind: 'follow', slot: follow.slot });
            return;
        }
        const option = shortlist[Number(id.slice('pin:'.length))];
        if (!option || option.disabled) return;
        props.onChange({ kind: 'pin', value: option.value });
    }, [follow, openPicker, props, shortlist]);
    const onOpenChange = React.useCallback((next: boolean) => {
        setOpen(next);
        if (!next) setSearching(false);
    }, []);

    const trigger = describeTrigger(row, theme.colors.text.secondary, theme.colors.state.danger.foreground);
    const emptyLabel = props.optionsStatus === 'loading'
        ? t('widgetAdd.optionsLoading')
        : props.optionsStatus === 'failed' ? t('widgetAdd.optionsFailed') : t('widgetAdd.noChoices');
    return (
        <DropdownMenu
            testID={props.testID}
            open={open}
            onOpenChange={onOpenChange}
            items={items}
            onSelect={select}
            selectedId={selectedIdFor(row, shortlist)}
            search={searching}
            searchPlaceholder={t('widgetAdd.searchChoices', { field: entry.field.title })}
            emptyLabel={emptyLabel}
            showCategoryTitles
            variant="default"
            matchTriggerWidth={false}
            maxWidthCap={360}
            itemTrigger={{
                title: entry.field.title,
                subtitle: picker.error ?? rowSubtitle(props),
                showSelectedSubtitle: false,
                detailFormatter: () => trigger.detail,
                field: trigger.field,
                // An empty choice names what it asks for, in the field's own words.
                placeholder: t('widgetAdd.chooseField', { field: entry.field.title }),
                itemProps: {
                    testID: `${props.testID}.trigger`,
                    titleAccessory: row.kind === 'needed' && entry.field.required ? <NeededTag /> : undefined,
                    // The line says what the field needs or why it is lost; it wraps rather than cuts off.
                    subtitleLines: 0,
                    accessoryLayout: props.phone ? 'stacked' : 'inline',
                    disabled: props.disabled,
                    showDivider: true,
                    accessibilityLabel: [entry.field.title, trigger.spoken].filter(Boolean).join(', '),
                },
            }}
        />
    );
}

function selectedIdFor(row: WidgetSetupRow, shortlist: readonly WidgetSetupValue[]): string | null {
    if (row.kind === 'follows') return FOLLOW_ID;
    if (row.kind === 'pinned' && row.value) {
        const selected = row.value.value;
        const index = shortlist.findIndex((option) => sameStrictJsonValue(option.value, selected));
        return index >= 0 ? pinId(index) : null;
    }
    return null;
}

function describeTrigger(row: WidgetSetupRow, secondary: string, danger: string): Readonly<{
    detail: string | null;
    spoken: string;
    field: Readonly<{ leading?: React.ReactNode; secondary?: string | null; quietValue?: boolean; invalid?: boolean }>;
}> {
    switch (row.kind) {
        case 'follows':
            return {
                detail: row.label,
                spoken: [row.label, row.valueLabel].filter(Boolean).join(' '),
                field: { leading: <Icon name="link" size={15} color={secondary} />, secondary: row.valueLabel, quietValue: true },
            };
        case 'pinned': {
            const value = row.value;
            const label = value?.label ?? row.label;
            return {
                detail: label || null,
                spoken: label,
                field: {
                    leading: <Icon name={value?.icon ?? 'push-pin'} size={15} color={secondary} />,
                    secondary: value?.description ?? null,
                },
            };
        }
        case 'invalid':
            return {
                detail: row.label ?? t('widgetAdd.invalidValue'),
                spoken: `${row.label ?? ''} ${t('widgetAdd.invalidValue')}`.trim(),
                field: {
                    leading: <Icon name="warning" size={15} color={danger} />,
                    secondary: row.label ? t('widgetAdd.invalidValue') : null,
                    invalid: true,
                },
            };
        case 'needed':
        case 'choices':
        case 'viewer':
            return { detail: null, spoken: t('widgetAdd.needed'), field: {} };
    }
}

/**
 * A per-viewer input (lab `dashboards` dscope Q3): everyone who sees this copy reads it with their
 * own connection, so there is nothing to choose; someone without one gets the card's Connect state.
 */
function ViewerFieldRow(props: React.ComponentProps<typeof WidgetSetupFieldRow>): React.ReactElement {
    return (
        <Item
            testID={props.testID}
            title={props.entry.field.title}
            subtitle={props.row.kind === 'invalid' ? t('widgetAdd.invalidReason') : t('widgetAdd.viewerOnly')}
            subtitleLines={0}
            showChevron={false}
            mode="info"
        />
    );
}

/** Two or three values the surface offers, in place, the likeliest chosen (lab IN "Ambiguous, a few"). */
function ChoicesFieldRow(props: React.ComponentProps<typeof WidgetSetupFieldRow> & Readonly<{
    row: Extract<WidgetSetupRow, { kind: 'choices' }>;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { entry, row } = props;
    return (
        <View testID={props.testID}>
            <Item
                title={entry.field.title}
                subtitle={entry.field.description ?? t('widgetAdd.choicesCount', { count: row.choices.length })}
                showChevron={false}
                showDivider={false}
                mode="info"
            />
            <ItemGroup surface="none" accessibilityRole="radiogroup" accessibilityLabel={entry.field.title}>
                {row.choices.map((choice, index) => (
                    <Item
                        key={index}
                        testID={`${props.testID}.choice.${index}`}
                        title={choice.label}
                        {...(choice.description ? { subtitle: choice.description } : {})}
                        {...(choice.icon ? { icon: <Icon name={choice.icon} size={18} color={theme.colors.text.secondary} /> } : {})}
                        accessibilityRole="radio"
                        webRole="radio"
                        selected={index === row.selectedIndex}
                        disabled={props.disabled}
                        onPress={() => props.onChange({ kind: 'pin', value: choice.value })}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
        </View>
    );
}

/**
 * A literal input — text, a number, a switch, a list, JSON, static choices or several choices — is
 * the one public typed field (`HappierInputField`, the same Action fields and Workflow inputs use),
 * set in the step's row: it chooses and draws the control, parses what is typed, keeps multiple
 * choices a collection and offers the type's own picker. The row adds only the title, the line under
 * it and the Needed tag. A value typed back to empty clears the input.
 */
function LiteralFieldRow(props: React.ComponentProps<typeof WidgetSetupFieldRow>): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const { entry, row } = props;
    // A list input that declares no placeholder would draw as a blank block: say what to type in it.
    const field = React.useMemo(() => (entry.field.widget === 'text_list' && entry.field.placeholder === undefined
        ? { ...entry.field, placeholder: t(entry.field.listSeparator === 'newline' ? 'widgetAdd.listOnePerLine' : 'widgetAdd.listCommaSeparated') }
        : entry.field), [entry.field]);
    const value = props.plainValue;
    const multiple = field.widget === 'multiselect';
    const choices = multiple || field.widget === 'select';
    const selection = !choices ? undefined : multiple ? (Array.isArray(value) ? value : []) : value;
    const options = React.useMemo(() => props.options.map((option, index) => ({
        value: option.value,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        ...(option.disabled ? { disabled: true } : {}),
        testID: `${props.testID}.option.${index}`,
    })), [props.options, props.testID]);
    const presentation = resolveHappierActionFieldPresentation(field, value, selection);
    // The shared field exposes no focus handle, so the row hands the keyboard to the first control
    // the field drew (web only; a native keyboard arrives with the person's own tap).
    const controlHost = React.useRef<View>(null);
    React.useEffect(() => {
        if (!props.focusRequest || Platform.OS !== 'web') return;
        const host = controlHost.current as unknown as { querySelector?: (selector: string) => { focus?: () => void } | null } | null;
        host?.querySelector?.('input, textarea, [role="radio"], [role="checkbox"], [role="switch"], button')?.focus?.();
    }, [props.focusRequest]);
    // A switch or a short field sits beside its title; choices and multi-line text go beneath it.
    const stacked = props.phone || presentation.kind === 'select' || (presentation.kind === 'text' && presentation.multiline);
    return (
        <Item
            testID={props.testID}
            title={field.title}
            // A chosen value that stopped resolving says why; a typed one is still being typed, and the
            // step's line says what is needed.
            subtitle={choices || (row.kind === 'needed' && entry.neededHint) ? rowSubtitle(props) : field.description}
            subtitleLines={0}
            titleAccessory={row.kind === 'needed' && field.required ? <NeededTag /> : undefined}
            showChevron={false}
            accessoryLayout={stacked ? 'stacked' : 'inline'}
            rightElement={(
                <View ref={controlHost} collapsable={false}>
                <HappierInputField<JsonValue>
                    frame="none"
                    field={field}
                    value={value}
                    selection={selection as JsonValue | readonly JsonValue[] | undefined}
                    options={options}
                    optionsStatus={props.optionsStatus}
                    optionsNotice={props.optionsStatus === 'failed' ? (
                        <SurfaceStateCard kind="error" size="line" title={t('widgetAdd.optionsFailed')} testID={`${props.testID}.optionsFailed`}
                            {...(props.onRetryOptions ? { action: { label: t('common.retry'), onPress: props.onRetryOptions } } : {})} />
                    ) : null}
                    disabled={props.disabled === true}
                    isEqual={sameStrictJsonValue}
                    keyForOption={(_option, index) => String(index)}
                    controlTestID={`${props.testID}.input`}
                    testID={`${props.testID}.control`}
                    theme={presentationTheme}
                    onChange={(next) => props.onChange(next === undefined ? { kind: 'clear' } : { kind: 'pin', value: next as JsonValue })}
                />
                </View>
            )}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    needed: { ...Typography.default('semiBold'), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary },
}));

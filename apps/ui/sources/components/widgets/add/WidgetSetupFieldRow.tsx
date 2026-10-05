import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveHappierActionFieldPresentation, useHappierInputPicker } from '@happier-dev/plugin-ui/presentation';
import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol';
import { readInputOptionValue } from '@happier-dev/protocol/inputs';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
    AMBIGUOUS_INLINE_LIMIT,
    type WidgetSetupField,
    type WidgetSetupRow,
    type WidgetSetupValue,
} from './widgetSetupModel';

const FOLLOW_ID = 'follow';
const ANOTHER_ID = 'another';
const PICKER_ID = 'picker';
const pinId = (index: number) => `pin:${index}`;
/** Two to four short static choices are a segmented control, all visible (the control table). */
const SEGMENTED_MAX = 4;

export type WidgetSetupFieldChange =
    | Readonly<{ kind: 'follow'; slot: string }>
    | Readonly<{ kind: 'pin'; value: JsonValue }>;

/**
 * One input of the Set up / Edit inputs step (lab `dashboards` IN): what it is and one control that
 * says how it is bound. Follows reads quiet behind the link glyph; a pin shows the value with its own
 * mark; a needed field asks for a choice; two or three surface values are choices in place; a value
 * that no longer resolves keeps its name with the invalid border and is never swapped for another.
 * A per-viewer input (a connection on a shared surface) is each viewer's own: the row says so and
 * offers nothing to choose.
 *
 * The field menu lists Follow first, then a few pinnable values, then Another… (search over every
 * choice the one options resolver returned). Plain inputs (text, a switch, 2–4 static choices) use
 * the same controls as Action fields.
 */
export function WidgetSetupFieldRow(props: Readonly<{
    entry: WidgetSetupField;
    row: WidgetSetupRow;
    /** Pinnable values from the one options resolver (static or dynamic). */
    options: readonly WidgetSetupValue[];
    optionsStatus: 'loading' | 'ready' | 'failed';
    /** A primitive value currently pinned (text, number, boolean) for the plain controls. */
    plainValue: JsonValue | undefined;
    phone: boolean;
    disabled?: boolean;
    onChange: (change: WidgetSetupFieldChange) => void;
    testID: string;
}>): React.ReactElement {
    const { entry, row } = props;
    const field = entry.field;
    const plain = !entry.follow && !entry.viewer ? plainControlKind(field.widget, field.options?.length ?? 0) : null;
    if (plain) return <PlainFieldRow {...props} kind={plain} />;
    if (entry.viewer) return <ViewerFieldRow {...props} />;
    if (row.kind === 'choices') return <ChoicesFieldRow {...props} row={row} />;
    return <BindingFieldRow {...props} />;
}

function plainControlKind(widget: string, staticOptions: number): 'text' | 'number' | 'boolean' | 'segmented' | null {
    switch (widget) {
        case 'text':
        case 'url':
        case 'textarea': return 'text';
        case 'number':
        case 'integer': return 'number';
        case 'boolean': return 'boolean';
        case 'select': return staticOptions >= 2 && staticOptions <= SEGMENTED_MAX ? 'segmented' : null;
        default: return null;
    }
}

function rowSubtitle(props: Readonly<{ entry: WidgetSetupField; row: WidgetSetupRow }>): string | undefined {
    if (props.row.kind === 'invalid') return t('widgetAdd.invalidReason');
    return props.entry.field.description;
}

function NeededTag(): React.ReactElement {
    return <Text style={styles.needed}>{t('widgetAdd.needed')}</Text>;
}

function BindingFieldRow(props: React.ComponentProps<typeof WidgetSetupFieldRow>): React.ReactElement {
    const { theme } = useUnistyles();
    const { entry, row, options } = props;
    const [open, setOpen] = React.useState(false);
    const [searching, setSearching] = React.useState(false);
    const follow = entry.follow;
    // A few likely values sit in the menu; the rest wait behind Another… (lab IN "Follow or pin").
    const shortlist = options.length > AMBIGUOUS_INLINE_LIMIT && !searching ? options.slice(0, AMBIGUOUS_INLINE_LIMIT) : options;
    const pinCategory = follow ? t('widgetAdd.pinGroup') : undefined;
    // The type's own picker (the custom-picker slot): its answer is checked like any other value
    // and pins exactly like a listed choice; cancelling leaves the binding as it was.
    const picker = useHappierInputPicker({
        field: entry.field,
        value: row.kind === 'pinned' ? row.value?.value : undefined,
        ...(props.optionsStatus === 'ready' ? { options } : {}),
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
    }, [follow, options.length, pickerAccessibilityLabel, pickerLabel, pinCategory, props.optionsStatus, props.testID, row, searching, shortlist, theme.colors.text.secondary]);

    const select = React.useCallback((id: string) => {
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

/** Plain inputs keep the Action field grammar: text is a field, a boolean a switch, 2–4 choices segmented. */
function PlainFieldRow(props: React.ComponentProps<typeof WidgetSetupFieldRow> & Readonly<{
    kind: 'text' | 'number' | 'boolean' | 'segmented';
}>): React.ReactElement {
    const field = props.entry.field;
    const value = props.plainValue;
    const subtitle = rowSubtitle(props);
    const titleAccessory = props.row.kind === 'needed' && field.required ? <NeededTag /> : undefined;
    if (props.kind === 'boolean') {
        return (
            <Item
                testID={props.testID}
                title={field.title}
                subtitle={subtitle}
                titleAccessory={titleAccessory}
                showChevron={false}
                rightElement={(
                    <Switch
                        testID={`${props.testID}.switch`}
                        accessibilityLabel={field.title}
                        value={value === true}
                        disabled={props.disabled}
                        onValueChange={(next) => props.onChange({ kind: 'pin', value: next })}
                    />
                )}
            />
        );
    }
    if (props.kind === 'segmented') {
        const options = field.options ?? [];
        const selected = options.findIndex((option) => option.value === value);
        return (
            <Item
                testID={props.testID}
                title={field.title}
                subtitle={subtitle}
                titleAccessory={titleAccessory}
                showChevron={false}
                accessoryLayout={props.phone ? 'stacked' : 'inline'}
                rightElement={(
                    <SegmentedTabBar
                        role="radiogroup"
                        accessibilityLabel={field.title}
                        testIDPrefix={`${props.testID}.segment`}
                        tabs={options.map((option, index) => ({ id: String(index), label: option.label }))}
                        activeTabId={selected >= 0 ? String(selected) : ''}
                        onSelectTab={(id) => {
                            const option = options[Number(id)];
                            if (option && typeof option.value === 'string') props.onChange({ kind: 'pin', value: option.value });
                        }}
                    />
                )}
            />
        );
    }
    return (
        <PlainTextFieldRow {...props} numeric={props.kind === 'number'} subtitle={subtitle} titleAccessory={titleAccessory} />
    );
}

function PlainTextFieldRow(props: React.ComponentProps<typeof WidgetSetupFieldRow> & Readonly<{
    numeric: boolean;
    subtitle: string | undefined;
    titleAccessory: React.ReactNode;
}>): React.ReactElement {
    const field = props.entry.field;
    const stored = props.plainValue;
    const [text, setText] = React.useState(() => (typeof stored === 'string' || typeof stored === 'number' ? String(stored) : ''));
    const onChangeText = (next: string) => {
        setText(next);
        if (!props.numeric) {
            props.onChange({ kind: 'pin', value: next });
            return;
        }
        // The same parsing Action and Workflow fields use: a number pins only once it is complete
        // and admissible for its widget (an integer field never pins 1.5).
        const presentation = resolveHappierActionFieldPresentation(field, stored);
        const value = presentation.kind === 'text' ? presentation.parseText(next) : undefined;
        if (typeof value === 'number') props.onChange({ kind: 'pin', value });
    };
    return (
        <Item
            testID={props.testID}
            title={field.title}
            subtitle={props.subtitle}
            titleAccessory={props.titleAccessory}
            showChevron={false}
            accessoryLayout={props.phone ? 'stacked' : 'inline'}
            rightElement={(
                <FieldTextInput
                    testID={`${props.testID}.input`}
                    accessibilityLabel={field.title}
                    value={text}
                    onChangeText={onChangeText}
                    {...(field.placeholder ? { placeholder: field.placeholder } : {})}
                    {...(props.numeric ? { inputMode: 'decimal' as const, keyboardType: 'decimal-pad' as const } : {})}
                    {...(field.widget === 'textarea' ? { multiline: true } : {})}
                    editable={props.disabled !== true}
                />
            )}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    needed: { ...Typography.default('semiBold'), fontSize: 11, lineHeight: 14, color: theme.colors.text.tertiary },
}));

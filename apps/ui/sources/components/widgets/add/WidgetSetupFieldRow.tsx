import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierInputField, HappierPressable, happierPageTextMetrics, resolveHappierActionFieldPresentation } from '@happier-dev/plugin-ui/presentation';
import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readInputOptionValue } from '@happier-dev/protocol/inputs';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { isNothingToChoose, readOptionSourceEmptyState } from './optionSourceEmptyState';
import {
    type WidgetSetupField,
    type WidgetSetupRow,
    type WidgetSetupValue,
} from './widgetSetupModel';

const FOLLOW_ID = 'follow';
const OWN_ID = 'own';

/** Whether the input reads the surface's value (one control) rather than its own (control + editor). */
function followsSurface(row: WidgetSetupRow): boolean {
    return row.kind === 'follows' || (row.kind === 'invalid' && row.follows === true);
}
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
 * The public typed field owns choices, literal values and custom pickers, as in Action and Workflow
 * forms. Its host slot adds only the current binding and the option to follow the surface again.
 */
export function WidgetSetupFieldRow(props: Readonly<{
    entry: WidgetSetupField;
    row: WidgetSetupRow;
    /** Pinnable values from the one options resolver (static or dynamic). */
    options: readonly WidgetSetupValue[];
    /** The choices read's state; a failure is said once for the whole form (`WidgetSetupOptionsNotice`). */
    optionsStatus: 'loading' | 'ready' | 'failed';
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
    const { entry } = props;
    if (entry.viewer) return <ViewerFieldRow {...props} />;
    return <InputFieldRow {...props} />;
}

function rowSubtitle(props: Readonly<{ entry: WidgetSetupField; row: WidgetSetupRow }>): string | undefined {
    if (props.row.kind === 'invalid') return t('widgetAdd.invalidReason');
    if (props.row.kind === 'needed' && props.entry.neededHint) return props.entry.neededHint;
    return props.entry.field.description;
}

function NeededTag(): React.ReactElement {
    return <Text style={styles.needed}>{t('widgetAdd.needed')}</Text>;
}

/**
 * Only the follow/pin affordance is widget-specific; typed choices and pickers stay public. The one
 * control says how the input is bound (lab IN "Follow or pin"): following, it is the whole row and
 * names the value it follows; "Own value" hands the value to the typed editor beneath it, starting
 * from what the surface had, so the value is never shown twice.
 */
function WidgetBindingControl(props: React.ComponentProps<typeof WidgetSetupFieldRow>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const follow = props.entry.follow;
    const [open, setOpen] = React.useState(false);
    const following = followsSurface(props.row);
    const trigger = describeTrigger(props.row, theme.colors.text.secondary, theme.colors.state.danger.foreground);
    const commands = useCurrentUiContextLocalCommands(follow && !props.disabled ? [{ key: 'open',
        title: [props.entry.field.prompt ?? props.entry.field.title, trigger.spoken].filter(Boolean).join(', '),
        invoke: value => setOpen(typeof value === 'boolean' ? value : !open) }] : [], { unbound: 'local' });
    if (!follow) return null;
    return <DropdownMenu
        testID={props.testID}
        open={open}
        onOpenChange={next => { void commands.invoke('open', next); }}
        items={[{ id: FOLLOW_ID, title: follow.label, checked: following, testID: `${props.testID}.binding.follow`,
            ...(follow.values[0] ? { subtitle: follow.values[0].label } : {}),
            icon: <Icon name="link" size={16} color={theme.colors.text.secondary} /> },
        { id: OWN_ID, title: t('widgetAdd.ownValue'), subtitle: t('widgetAdd.ownValueHint'), checked: !following,
            testID: `${props.testID}.binding.own`,
            icon: <Icon name="pencil-simple" size={16} color={theme.colors.text.secondary} /> }]}
        onSelect={(id) => {
            if (id === FOLLOW_ID) props.onChange({ kind: 'follow', slot: follow.slot });
            else if (following) {
                const current = follow.values[0]?.value;
                props.onChange(current === undefined ? { kind: 'clear' } : { kind: 'pin', value: current });
            }
        }}
        selectedId={following ? FOLLOW_ID : OWN_ID}
        placement="bottom"
        matchTriggerWidth={false}
        // The binding is a control inside the input's row, never a second row: its field box stands on
        // the row's control edge, the same edge as the typed editor beneath it (FA18 P2).
        trigger={({ toggle }) => (
            <HappierPressable
                testID={`${props.testID}.trigger`}
                onPress={toggle}
                disabled={props.disabled}
                accessibilityRole="button"
                accessibilityLabel={[props.entry.field.prompt ?? props.entry.field.title, trigger.spoken].filter(Boolean).join(', ')}
                expanded={open}
                hasPopup="menu"
                style={styles.bindingTrigger}
            >
                {renderDropdownItemTriggerRightElement({
                    detail: trigger.detail,
                    open,
                    detailColor: theme.colors.text.primary,
                    chevronColor: theme.colors.text.secondary,
                    field: resolveFieldBoxColors(theme, trigger.field.invalid ? 'invalid' : 'idle'),
                    fieldSpan: 'column',
                    ...(trigger.field.leading ? { leading: trigger.field.leading } : {}),
                    secondary: trigger.field.secondary ?? null,
                    quietValue: trigger.field.quietValue === true,
                    secondaryColor: theme.colors.text.tertiary,
                    quietValueColor: theme.colors.text.secondary,
                })}
            </HappierPressable>
        )}
    />;
}

function describeTrigger(row: WidgetSetupRow, secondary: string, danger: string): Readonly<{
    detail: string | null;
    spoken: string;
    field: Readonly<{ leading?: React.ReactNode; secondary?: string | null; quietValue?: boolean; invalid?: boolean }>;
}> {
    switch (row.kind) {
        case 'follows': {
            // What it follows, then what that is now (lab IN "🔗 This session  happier"); a value that
            // reads the same as its source is said once.
            const value = row.valueLabel === row.label ? null : row.valueLabel;
            return {
                detail: row.label,
                spoken: [row.label, value].filter(Boolean).join(' '),
                field: { leading: <Icon name="link" size={15} color={secondary} />, secondary: value, quietValue: true },
            };
        }
        case 'invalid':
            if (row.follows) return {
                detail: row.label ?? t('widgetAdd.invalidValue'),
                spoken: `${row.label ?? ''} ${t('widgetAdd.invalidValue')}`.trim(),
                field: {
                    leading: <Icon name="warning" size={15} color={danger} />,
                    secondary: row.label ? t('widgetAdd.invalidValue') : null,
                    invalid: true,
                },
            };
            // The editor beneath holds the value that stopped resolving; the binding only says whose it is.
            return {
                detail: t('widgetAdd.ownValue'),
                spoken: `${t('widgetAdd.ownValue')} ${t('widgetAdd.invalidValue')}`,
                field: { leading: <Icon name="warning" size={15} color={danger} />, invalid: true },
            };
        case 'pinned':
        case 'needed':
        case 'choices':
            // The value itself is the editor's beneath; the binding says only that it is this widget's own.
            return {
                detail: t('widgetAdd.ownValue'),
                spoken: t('widgetAdd.ownValue'),
                field: { leading: <Icon name="pencil-simple" size={15} color={secondary} /> },
            };
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

/**
 * A literal input — text, a number, a switch, a list, JSON, static choices or several choices — is
 * the one public typed field (`HappierInputField`, the same Action fields and Workflow inputs use),
 * set in the step's row: it chooses and draws the control, parses what is typed, keeps multiple
 * choices a collection and offers the type's own picker. The row adds only the title, the line under
 * it and the Needed tag. A value typed back to empty clears the input.
 */
function InputFieldRow(props: React.ComponentProps<typeof WidgetSetupFieldRow>): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    const { entry, row } = props;
    // A list input that declares no placeholder would draw as a blank block: say what to type in it.
    const field = React.useMemo(() => (entry.field.widget === 'text_list' && entry.field.placeholder === undefined
        ? { ...entry.field, placeholder: t(entry.field.listSeparator === 'newline' ? 'widgetAdd.listOnePerLine' : 'widgetAdd.listCommaSeparated') }
        : entry.field), [entry.field]);
    const value = props.plainValue ?? (row.kind === 'follows' ? entry.follow?.values[0]?.value : undefined);
    const choices = field.widget === 'select' || field.widget === 'multiselect';
    const selection = choices ? value : undefined;
    const choicesOptions = row.kind === 'choices' ? row.choices : props.options;
    const options = React.useMemo(() => choicesOptions.map((option, index) => ({
        value: option.value,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        ...(option.disabled ? { disabled: true } : {}),
        testID: `${props.testID}.option.${index}`,
    })), [choicesOptions, props.testID]);
    const presentation = resolveHappierActionFieldPresentation(field, value, selection);
    // The shared field exposes no focus handle, so the row hands the keyboard to the first control
    // the field drew (web only; a native keyboard arrives with the person's own tap).
    const controlHost = React.useRef<View>(null);
    React.useEffect(() => {
        if (!(props.focusRequest || props.autoOpen) || Platform.OS !== 'web') return;
        const host = controlHost.current as unknown as { querySelector?: (selector: string) => { focus?: () => void } | null } | null;
        host?.querySelector?.('input, textarea, [role="radio"], [role="checkbox"], [role="switch"], button')?.focus?.();
    }, [props.autoOpen, props.focusRequest]);
    const subtitle = row.kind === 'invalid' && !entry.follow && row.label
        ? `${row.label} · ${rowSubtitle(props)}`
        : choices || (row.kind === 'needed' && entry.neededHint) ? rowSubtitle(props) : field.description;
    const titleAccessory = row.kind === 'needed' && field.required ? <NeededTag /> : undefined;
    // The shared field decides how a fixed choice is drawn (two to four short ones are a segmented
    // control, anything else one compact choice field); the row only places them: beside the title when
    // there is room, and multi-line text beneath it.
    // A value the choices cannot name (a period) is read from the row's own label.
    const valueLabel = row.kind === 'pinned' ? row.label : row.kind === 'follows' ? row.valueLabel ?? undefined : row.kind === 'invalid' ? row.label ?? undefined : undefined;
    const stacked = props.phone || (presentation.kind === 'text' && presentation.multiline);
    // A source that settled with nothing to offer and nothing chosen: no choice field that cannot succeed, but what is
    // missing and, where the source names one, the place to make the first choice (DESIGN-1118-B M6).
    if (field.optionsSourceId !== undefined && isNothingToChoose({ field, optionsStatus: props.optionsStatus,
        optionCount: choicesOptions.length, value, follows: followsSurface(row) })) {
        return <NothingToChooseRow title={field.prompt ?? field.title} optionsSourceId={field.optionsSourceId}
            phone={props.phone} testID={props.testID} />;
    }
    if (entry.follow && followsSurface(row)) {
        // Following the surface: the binding control is the row's one control and names the value.
        return (
            <Item
                testID={props.testID}
                title={field.prompt ?? field.title}
                subtitle={subtitle}
                subtitleLines={0}
                titleAccessory={titleAccessory}
                showChevron={false}
                accessoryLayout={props.phone ? 'stacked' : 'inline'}
                rightElement={<WidgetBindingControl {...props} />}
            />
        );
    }
    return (
        <Item
            testID={props.testID}
            title={field.prompt ?? field.title}
            // A chosen value that stopped resolving says why; a typed one is still being typed, and the
            // step's line says what is needed.
            subtitle={subtitle}
            subtitleLines={0}
            titleAccessory={titleAccessory}
            showChevron={false}
            // Only a switch stays beside its label; every wider control (a choice, a field) moves beneath
            // it when the row is narrow (a pane column), never squeezing the label into a stack of lines.
            accessoryLayout={stacked ? 'stacked' : presentation.kind === 'toggle' ? 'inline' : 'adaptive'}
            // The label stands at the top of its row beside a control that grows taller (a segmented choice, a field).
            contentAlign="start"
            rightElement={(
                <View ref={controlHost} collapsable={false}>
                <HappierInputField<JsonValue>
                    frame="none"
                    leading={entry.follow ? <WidgetBindingControl {...props} /> : undefined}
                    field={field}
                    value={value}
                    selection={selection as JsonValue | readonly JsonValue[] | undefined}
                    options={options}
                    renderChoiceControls={control => <WidgetChoiceControls control={control} label={field.prompt ?? field.title} />}
                    renderPicker={control => <WidgetPickerControl control={control} label={field.prompt ?? field.title} />}
                    {...(valueLabel === undefined ? {} : { valueLabel })}
                    // A repair, or ↵ with this input still needed, opens its choices where the request lands.
                    openRequest={(props.focusRequest ?? 0) + (props.autoOpen ? 1 : 0)}
                    optionsStatus={props.optionsStatus}
                    disabled={props.disabled === true}
                    isEqual={sameStrictJsonValue}
                    keyForOption={(_option, index) => String(index)}
                    controlTestID={`${props.testID}.input`}
                    testID={`${props.testID}.control`}
                    theme={presentationTheme}
                    onChange={(next) => { const value = readInputOptionValue(next);
                        props.onChange(value === undefined ? { kind: 'clear' } : { kind: 'pin', value }); }}
                />
                </View>
            )}
        />
    );
}

/** An input whose source has nothing to choose yet: says so, and offers the source's next step when it has one. */
function NothingToChooseRow(props: Readonly<{ title: string; optionsSourceId: string; phone: boolean; testID: string }>): React.ReactElement {
    const router = useRouter();
    const empty = readOptionSourceEmptyState(props.optionsSourceId);
    const action = empty.action;
    return (
        <Item
            testID={props.testID}
            title={props.title}
            subtitle={empty.message}
            subtitleLines={0}
            showChevron={false}
            accessoryLayout={props.phone ? 'stacked' : 'adaptive'}
            {...(action ? { rightElement: <RoundButton testID={`${props.testID}.emptyAction`} size="small" display="secondary"
                title={action.label} onPress={() => router.push(action.href as Parameters<typeof router.push>[0])} /> } : {})}
        />
    );
}

/**
 * A failed choices read, said once for the whole form: the inputs share one options resolver, so one line and one
 * Retry read every input again, instead of the same line under each row.
 */
export function WidgetSetupOptionsNotice(props: Readonly<{
    /** What the form sets up, naming the Retry command. */
    label: string;
    onRetry?: (callerContext?: ActionExecutorContext) => void;
    disabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const { onRetry } = props;
    const commands = useCurrentUiContextLocalCommands(onRetry && !props.disabled
        ? [{ key: 'retry', title: `${t('common.retry')}: ${props.label}`, invoke: (_input, callerContext) => onRetry(callerContext) }] : [],
        { unbound: 'local' });
    return (
        <SurfaceStateCard kind="error" size="line" title={t('widgetAdd.optionsFailed')} testID={props.testID}
            {...(onRetry ? { action: { label: t('common.retry'), onPress: () => { void commands.invoke('retry'); } } } : {})} />
    );
}

type ChoiceControls = Parameters<NonNullable<React.ComponentProps<typeof HappierInputField<JsonValue>>['renderChoiceControls']>>[0];
function WidgetChoiceControls(props: Readonly<{ control: ChoiceControls; label: string }>) {
    const { control, label } = props;
    const commands = useCurrentUiContextLocalCommands(control.disabled ? [] : [
        { key: 'open', title: `${t('common.open')}: ${label}`, invoke: value => control.onOpenChange(typeof value === 'boolean' ? value : !control.open) },
        ...(control.open ? [{ key: 'close', title: `${t('common.close')}: ${label}`, invoke: () => control.onOpenChange(false) }] : []),
        ...(control.open && control.searchable ? [{ key: 'search', title: `${t('common.search')}: ${label}`,
            invoke: (value: unknown) => { if (typeof value === 'string') control.onQueryChange(value); } }] : []),
    ], { unbound: 'local' });
    return <>{control.render({ onOpenChange: next => { void commands.invoke('open', next); },
        onQueryChange: value => { void commands.invoke('search', value); } })}</>;
}

type PickerControl = Parameters<NonNullable<React.ComponentProps<typeof HappierInputField<JsonValue>>['renderPicker']>>[0];
function WidgetPickerControl(props: Readonly<{ control: PickerControl; label: string }>) {
    const { control } = props;
    const commands = useCurrentUiContextLocalCommands(control.disabled ? [] : [{ key: 'open', title: `${control.label}: ${props.label}`,
        invoke: control.open }], { unbound: 'local' });
    return <>{control.render(async () => { await commands.invoke('open'); })}</>;
}

const styles = StyleSheet.create((theme) => ({
    bindingTrigger: { minHeight: HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE, justifyContent: 'center' },
    needed: { ...Typography.default('semiBold'), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary },
}));

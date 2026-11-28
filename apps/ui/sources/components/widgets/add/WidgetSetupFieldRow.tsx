import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { Platform, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierInputField, HappierPressable, happierPageTextMetrics, resolveHappierActionFieldPresentation, resolveHappierChoiceControl, useHappierInputPickerPort, type HappierFocusable } from '@happier-dev/plugin-ui/presentation';
import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readInputOptionValue } from '@happier-dev/protocol/inputs';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE, useOptionalHappierUiPalette } from '@happier-dev/plugin-ui/environment';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { isNothingToChoose, readOptionSourceEmptyState } from './optionSourceEmptyState';
import {
    type WidgetSetupField,
    type WidgetSetupInheritedReading,
    type WidgetSetupRow,
    type WidgetSetupValue,
} from './widgetSetupModel';

const FOLLOW_ID = 'follow';
const OWN_ID = 'own';

function formatFollowReading(source: string, value: string | null | undefined): string {
    return value && value !== source ? t('widgetAdd.inheritedValue', { value, source }) : source;
}

function formatGroupReading(reading: WidgetSetupInheritedReading, includeSource = true): string {
    const value = reading.kind === 'single' ? reading.valueLabel : t('widgetAdd.severalValues');
    if (!includeSource || reading.source === undefined) return value;
    return formatFollowReading(t(reading.source === 'page' ? 'widgetAdd.thisPage' : 'widgetFrame.followingGroup'), value);
}

type WidgetBindingInForce =
    | Readonly<{ kind: 'group'; source: string }>
    | Readonly<{ kind: 'page'; source: string }>
    | Readonly<{ kind: 'own' }>
    | Readonly<{ kind: 'unset' }>;

function bindingInForce({ entry, row, plainValue }: React.ComponentProps<typeof WidgetSetupFieldRow>, editingOwn: boolean): WidgetBindingInForce {
    if (editingOwn && (row.kind === 'needed' || (row.kind === 'follows' && row.implicit))) return { kind: 'own' };
    if (row.kind === 'follows' || (row.kind === 'invalid' && row.follows === true)) {
        const source = row.label ?? entry.follow?.label ?? entry.field.title;
        return { kind: entry.follow?.group ? 'group' : 'page', source };
    }
    if (plainValue !== undefined || row.kind === 'pinned' || row.kind === 'choices') return { kind: 'own' };
    return { kind: 'unset' };
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

function rowSubtitle(props: Readonly<{ entry: WidgetSetupField; row: WidgetSetupRow }>, inherited?: string): string | undefined {
    if (props.row.kind === 'invalid') return t('widgetAdd.invalidReason');
    if (props.row.kind === 'needed' && props.entry.neededHint) return props.entry.neededHint;
    return inherited ?? props.entry.field.description;
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
function WidgetBindingControl(props: React.ComponentProps<typeof WidgetSetupFieldRow> & Readonly<{
    binding: WidgetBindingInForce;
    onChooseOwn: () => void;
    onChooseFollow: (slot: string) => void;
    controlRef: (node: HappierFocusable | null) => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const follow = props.entry.follow;
    const [open, setOpen] = React.useState(false);
    const { binding } = props;
    const selectedId = binding.kind === 'own' ? OWN_ID : binding.kind === 'unset' ? null : FOLLOW_ID;
    const trigger = describeTrigger(binding, props.row, theme.colors.text.secondary, theme.colors.state.danger.foreground);
    const selectedReading = {
        title: trigger.detail,
        ...(trigger.field.secondary == null ? {} : { subtitle: trigger.field.secondary }),
    };
    const commands = useCurrentUiContextLocalCommands(follow && !props.disabled ? [{ key: 'open',
        title: [props.entry.field.prompt ?? props.entry.field.title, trigger.spoken].filter(Boolean).join(', '),
        invoke: value => setOpen(typeof value === 'boolean' ? value : !open) }] : [], { unbound: 'local' });
    if (!follow) return null;
    return <DropdownMenu
        testID={props.testID}
        open={open}
        onOpenChange={next => { void commands.invoke('open', next); }}
        items={[
            { id: FOLLOW_ID, checked: selectedId === FOLLOW_ID,
                ...(selectedId === FOLLOW_ID ? selectedReading : { title: formatFollowReading(follow.label, follow.values[0]?.label) }),
                testID: `${props.testID}.binding.follow`,
                icon: <Icon name="link" size={16} color={theme.colors.text.secondary} /> },
            { id: OWN_ID, title: t('widgetAdd.ownValue'), subtitle: t('widgetAdd.ownValueHint'), checked: selectedId === OWN_ID,
                ...(selectedId === OWN_ID ? selectedReading : {}),
                testID: `${props.testID}.binding.own`,
                icon: <Icon name="pencil-simple" size={16} color={theme.colors.text.secondary} /> },
        ]}
        onSelect={(id) => {
            if (id === FOLLOW_ID && selectedId !== FOLLOW_ID) props.onChooseFollow(follow.slot);
            if (id === OWN_ID) props.onChooseOwn();
        }}
        selectedId={selectedId}
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
                controlRef={props.controlRef}
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

function describeTrigger(binding: WidgetBindingInForce, row: WidgetSetupRow, secondary: string, danger: string): Readonly<{
    detail: string;
    spoken: string;
    field: Readonly<{ leading?: React.ReactNode; secondary?: string | null; quietValue?: boolean; invalid?: boolean }>;
}> {
    const warning = row.kind === 'invalid' ? t('widgetAdd.invalidValue') : null;
    if (binding.kind === 'group' || binding.kind === 'page') {
        const detail = formatFollowReading(binding.source, row.kind === 'follows' ? row.valueLabel : undefined);
        return {
            detail,
            spoken: warning === null ? detail : `${detail} ${warning}`,
            field: warning !== null
                ? { leading: <Icon name="warning" size={15} color={danger} />, secondary: warning, invalid: true }
                : { leading: <Icon name="link" size={15} color={secondary} />, quietValue: true },
        };
    }
    const detail = binding.kind === 'own' ? t('widgetAdd.ownValue') : t('widgetAdd.needed');
    return {
        detail,
        spoken: warning === null ? detail : `${detail} ${warning}`,
        field: warning !== null
            ? { leading: <Icon name="warning" size={15} color={danger} />, secondary: warning, invalid: true }
            : binding.kind === 'own' ? { leading: <Icon name="pencil-simple" size={15} color={secondary} /> } : {},
    };
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
    const placeholderInk = useOptionalHappierUiPalette(presentationTheme)?.placeholder ?? presentationTheme.colors.mutedText;
    const picker = useHappierInputPickerPort();
    const { entry, row } = props;
    const [ownRequest, setOwnRequest] = React.useState(0);
    const binding = bindingInForce(props, ownRequest > 0);
    // An unset group input can preview what its children read even without a binding of its own.
    const groupReading = row.kind === 'needed' && binding.kind === 'unset' ? entry.inherited : undefined;
    const surfaceOnly = entry.follow !== undefined && (binding.kind === 'page' || binding.kind === 'group');
    const choices = entry.field.widget === 'select' || entry.field.widget === 'multiselect';
    const value = props.plainValue;
    const selection = choices ? value : undefined;
    const choicesOptions = row.kind === 'choices' ? row.choices : props.options;
    const options = React.useMemo(() => choicesOptions.map((option, index) => ({
        value: option.value,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        ...(option.disabled ? { disabled: true } : {}),
        testID: `${props.testID}.option.${index}`,
    })), [choicesOptions, props.testID]);
    const presentation = resolveHappierActionFieldPresentation(entry.field, value, selection);
    const inherited = groupReading ? formatGroupReading(groupReading, entry.follow === undefined) : undefined;
    const subtitleOnly = inherited !== undefined && (presentation.kind === 'toggle'
        || (presentation.kind === 'select' && entry.field.allowCustomValue !== true
            && (resolveHappierChoiceControl(presentation, options) === 'segmented'
                || (options.length === 0 && picker?.describe(entry.field) != null))));
    const inheritedSubtitle = subtitleOnly ? inherited : undefined;
    const accessibilityReading = groupReading && (entry.follow || subtitleOnly) ? formatGroupReading(groupReading) : undefined;
    const placeholder = inheritedSubtitle === undefined ? inherited : undefined;
    const isInheritedPopup = placeholder !== undefined && presentation.kind === 'select';
    // RN Web reads the existing placeholder token from CSS rather than the native color prop.
    const textPlaceholderStyle = Platform.OS === 'web' && placeholder !== undefined && presentation.kind === 'text'
        ? { ['--happier-placeholder-color' as string]: placeholderInk } as ViewStyle
        : undefined;
    // Shared authored choice placeholders can be valid readings in value ink. This row's inherited
    // popup uses the same placeholder slot with this control's existing placeholder role.
    const fieldTheme = React.useMemo(() => isInheritedPopup
        ? { ...presentationTheme, colors: { ...presentationTheme.colors, text: placeholderInk } }
        : presentationTheme, [isInheritedPopup, placeholderInk, presentationTheme]);
    const field = React.useMemo(() => {
        if (placeholder !== undefined) return { ...entry.field, placeholder };
        // A list input that declares no placeholder would draw as a blank block: say what to type in it.
        if (entry.field.widget === 'text_list' && entry.field.placeholder === undefined) {
            return { ...entry.field, placeholder: t(entry.field.listSeparator === 'newline' ? 'widgetAdd.listOnePerLine' : 'widgetAdd.listCommaSeparated') };
        }
        return entry.field;
    }, [entry.field, placeholder]);
    const controlRef = React.useRef<HappierFocusable | null>(null);
    const registerControl = React.useCallback((node: HappierFocusable | null) => { controlRef.current = node; }, []);
    const bindingRef = React.useRef<HappierFocusable | null>(null);
    const registerBinding = React.useCallback((node: HappierFocusable | null) => { bindingRef.current = node; }, []);
    const openRequest = (props.focusRequest ?? 0) + (props.autoOpen ? 1 : 0) + ownRequest;
    React.useEffect(() => {
        // An Add/repair hand-off stays in the row while the typed choice is unavailable.
        if (openRequest) (controlRef.current ?? bindingRef.current)?.focus();
    }, [openRequest, surfaceOnly]);
    const chooseOwn = () => {
        if (surfaceOnly) {
            const current = row.kind === 'follows' ? entry.follow?.values[0]?.value : undefined;
            props.onChange(current === undefined ? { kind: 'clear' } : { kind: 'pin', value: current });
        }
        setOwnRequest(request => request + 1);
    };
    const bindingMenu = entry.follow ? <WidgetBindingControl {...props} binding={binding} controlRef={registerBinding}
        onChooseOwn={chooseOwn} onChooseFollow={(slot) => {
            setOwnRequest(0);
            props.onChange({ kind: 'follow', slot });
        }} /> : undefined;
    const subtitle = row.kind === 'invalid' && !entry.follow && row.label
        ? `${row.label} · ${rowSubtitle(props)}`
        : choices || inheritedSubtitle !== undefined || (row.kind === 'needed' && entry.neededHint)
            ? rowSubtitle(props, inheritedSubtitle) : field.description;
    const titleAccessory = row.kind === 'needed' && field.required ? <NeededTag /> : undefined;
    // The shared field decides how a fixed choice is drawn (two to four short ones are a segmented
    // control, anything else one compact choice field); the row only places them: beside the title when
    // there is room, and multi-line text beneath it.
    // A value the choices cannot name (a period) is read from the row's own label.
    const valueLabel = row.kind === 'pinned' ? row.label : row.kind === 'invalid' ? row.label ?? undefined : undefined;
    const stacked = props.phone || (presentation.kind === 'text' && presentation.multiline);
    // A source that settled with nothing to offer and nothing chosen: no choice field that cannot succeed, but what is
    // missing and, where the source names one, the place to make the first choice (DESIGN-1118-B M6).
    if (inherited === undefined && field.optionsSourceId !== undefined && isNothingToChoose({ field, optionsStatus: props.optionsStatus,
        optionCount: choicesOptions.length, value, follows: binding.kind === 'group' || binding.kind === 'page' })) {
        return <NothingToChooseRow title={field.prompt ?? field.title} optionsSourceId={field.optionsSourceId}
            phone={props.phone} testID={props.testID} bindingMenu={bindingMenu} />;
    }
    if (surfaceOnly) {
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
                rightElement={bindingMenu}
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
            subtitleStyle={inheritedSubtitle !== undefined && subtitle === inheritedSubtitle ? { color: placeholderInk } : undefined}
            subtitleLines={0}
            titleAccessory={titleAccessory}
            showChevron={false}
            // Only a switch stays beside its label; every wider control (a choice, a field) moves beneath
            // it when the row is narrow (a pane column), never squeezing the label into a stack of lines.
            accessoryLayout={stacked ? 'stacked' : presentation.kind === 'toggle' ? 'inline' : 'adaptive'}
            // The label stands at the top of its row beside a control that grows taller (a segmented choice, a field).
            contentAlign="start"
            rightElement={(
                <View style={textPlaceholderStyle}>
                <HappierInputField<JsonValue>
                    frame="none"
                    leading={bindingMenu}
                    field={field}
                    value={value}
                    selection={selection as JsonValue | readonly JsonValue[] | undefined}
                    options={options}
                    renderChoiceControls={control => <WidgetChoiceControls control={control} label={field.prompt ?? field.title} />}
                    renderPicker={control => <WidgetPickerControl control={control} label={field.prompt ?? field.title} />}
                    {...(valueLabel === undefined ? {} : { valueLabel })}
                    // A repair, or ↵ with this input still needed, opens its choices where the request lands.
                    openRequest={openRequest}
                    controlRef={registerControl}
                    {...(accessibilityReading === undefined ? {} : { accessibilityReading })}
                    optionsStatus={props.optionsStatus}
                    disabled={props.disabled === true}
                    isEqual={sameStrictJsonValue}
                    keyForOption={(_option, index) => String(index)}
                    controlTestID={`${props.testID}.input`}
                    testID={`${props.testID}.control`}
                    theme={fieldTheme}
                    onChange={(next) => { const value = readInputOptionValue(next);
                        props.onChange(value === undefined ? { kind: 'clear' } : { kind: 'pin', value }); }}
                />
                </View>
            )}
        />
    );
}

/** An input whose source has nothing to choose yet: says so, and offers the source's next step when it has one. */
function NothingToChooseRow(props: Readonly<{
    title: string;
    optionsSourceId: string;
    phone: boolean;
    testID: string;
    bindingMenu?: React.ReactElement;
}>): React.ReactElement {
    const router = useRouter();
    const empty = readOptionSourceEmptyState(props.optionsSourceId);
    const action = empty.action;
    const button = action ? <RoundButton testID={`${props.testID}.emptyAction`} size="small" display="secondary"
        title={action.label} onPress={() => router.push(action.href as Parameters<typeof router.push>[0])} /> : undefined;
    return (
        <Item
            testID={props.testID}
            title={props.title}
            subtitle={empty.message}
            subtitleLines={0}
            showChevron={false}
            accessoryLayout={props.phone ? 'stacked' : 'adaptive'}
            rightElement={props.bindingMenu && button ? <View>{props.bindingMenu}{button}</View> : props.bindingMenu ?? button}
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

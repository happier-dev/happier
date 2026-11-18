import * as React from 'react';
import { ApprovalProfileSelect } from '@/components/approvals/ApprovalProfileSelect';
import { resolveApprovalProfileMachineDefault, useApprovalProfiles } from '@/hooks/approvals/useApprovalProfiles';
import { Platform, View } from 'react-native';

import { usePopoverBoundaryRef } from '@/components/ui/popover/PopoverBoundary';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, HAPPIER_PAGE_METRICS, HappierPressable } from '@happier-dev/plugin-ui/presentation';

import type { WorkflowSessionAuthoringSelection, WorkflowStepExecutionSelection, WorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { readAuthoredSessionModelRef } from '@/sync/domains/teams/teamCredentialProviderModelSelection';
import type { WorkflowEngineChoiceV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import type { WorkflowRoleV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputChipPickerPopover } from '@/components/sessions/agentInput/components/AgentInputChipPickerPopover';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { Text, TextInput } from '@/components/ui/text/Text';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Item } from '@/components/ui/lists/Item';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { resolveRoleDisplayName } from '@/sync/domains/roles/roleCatalog';
import { Typography } from '@/constants/Typography';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import { t } from '@/text';

import {
    findSessionAuthoringAgentTargetOption,
    formatSessionAuthoringToolList,
    parseSessionAuthoringToolList,
    resolveSessionAuthoringAgentId,
    resolveSessionAuthoringFieldControl,
    resolveSessionAuthoringFieldTitle,
    resolveSessionAuthoringFieldValue,
    type SessionAuthoringControlFacts,
    type SessionAuthoringFieldControlModel,
    type SessionAuthoringFieldId,
    type SessionAuthoringFieldUnavailableReason,
    type SessionAuthoringFieldOption,
} from './sessionAuthoringFieldControls';
import { SessionAuthoringConnectedServicesField } from './SessionAuthoringConnectedServicesField';
import { SessionAuthoringCapabilitiesField } from './SessionAuthoringCapabilitiesField';
import { useSessionAuthoringControls } from './useSessionAuthoringControls';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useSessionAuthoringEnginePicker } from './useSessionAuthoringEnginePicker';
import { SessionAuthoringFieldSelectTrigger } from './SessionAuthoringFieldSelectTrigger';
import { PERMISSION_CONTROL_ICON } from '@/components/sessions/agentInput/definitions/createPermissionActionChip';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * The standalone, controlled Session-authoring controls.
 *
 * Values in, `onChangeField` out. This composition deliberately has no composer,
 * no submit affordance and registers no keyboard command: launching is the
 * host's own explicit action (page Run now / Save), never a side effect of
 * editing a value here. It also never selects a draft, navigates, creates a
 * resource or records a remembered selection — choosing a value only reports
 * that value to its owner.
 *
 * The chips, popovers and effective-policy owner are the ones ordinary Session
 * authoring already uses, so a workflow step and New Session cannot offer
 * different choices for the same field.
 */

/**
 * These chips and the window-name input keep the chip row's dense design height under every pointer.
 * A finger reaches the chips through the shared pressable's hit area; a wrapping chip row meets at its
 * gap rather than overlapping because the reach of each side is bounded by the free space.
 */
/** Half the chip row's 8 px gap on every side: wrapped chips' hit areas meet, never overlap. */
const AUTHORING_CHIP_HIT_REACH = 4;

const styles = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    fields: {
        alignSelf: 'stretch',
    },
    // The composer bar keeps its own denser variant; this is the same chip in
    // the roomier authoring context, from the same theme tokens.
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s6,
        justifyContent: 'center',
        gap: theme.space.s6,
        // Reserved, so the changed state and the focus ring never move a neighbour.
        borderWidth: 1,
        borderColor: 'transparent',
    },
    /** A value set for this subject (not inherited): the chip carries its border. */
    chipChanged: {
        borderColor: theme.colors.border.strong,
    },
    fieldTrigger: {
        alignSelf: 'stretch',
    },
    chipPressed: {
        opacity: motionTokens.press.opacity,
    },
    chipText: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.composer.chipTint,
    },
    unavailableText: {
        ...Typography.variant('body'),
        color: theme.colors.text.tertiary,
    },
    preservedChip: {
        alignSelf: 'flex-start',
        gap: theme.space.s2,
    },
    fieldAnchor: {
        alignSelf: 'stretch',
        minWidth: 0,
    },
    /** Sized to its value but never past its column: a long value truncates inside the chip (C24). */
    chipAnchor: {
        alignSelf: 'flex-start',
        maxWidth: '100%',
    },
    textInput: {
        ...Typography.default('regular'),
        color: theme.colors.text.primary,
        paddingVertical: theme.space.s6,
        paddingHorizontal: theme.space.s10,
        minHeight: HAPPIER_PAGE_METRICS.controlHeightPx,
        minWidth: 160,
    },
}));

/** The incumbent Connected Services chip presentation, shared by non-composer authoring hosts. */
export function useSessionAuthoringChipRenderContext(
    popoverAnchorRef: React.RefObject<React.ComponentRef<typeof View> | null>,
): AgentInputExtraActionChipRenderContext {
    const { theme } = useUnistyles();
    return React.useMemo(() => ({
        chipStyle: (pressed: boolean) => [styles.chip, pressed ? styles.chipPressed : null],
        showLabel: true,
        iconColor: theme.colors.composer.chipTint,
        textStyle: styles.chipText,
        countTextStyle: styles.chipText,
        popoverAnchorRef,
    }), [popoverAnchorRef, theme.colors.composer.chipTint]);
}

/** One selectable value: a chip that names the current choice and its picker. */
/** A field the Agent or the target can never offer here, or that another owner supplies: a set leaves it out. */
function isNeverOfferedHere(control: SessionAuthoringFieldControlModel): boolean {
    return control.kind === 'unavailable' && (control.reason === 'not_supported_on_target'
        || control.reason === 'agent_has_no_options' || control.reason === 'owned_by_host');
}

/** The picker row that returns a changed value to the one it inherits; never a field's own option id. */
const RESET_OPTION_ID = '$inherit';

function SessionAuthoringOptionChip(props: Readonly<{
    controlId: string;
    title: string;
    options: readonly SessionAuthoringFieldOption[];
    selectedOptionId: string;
    /** Shown instead of "Default" when the selection names no offered option. */
    unselectedLabel?: string;
    valueLabel?: string;
    pickerOptions?: readonly AgentInputChipPickerOption[];
    disabled?: boolean;
    presentation: SessionAuthoringControlsPresentation;
    /** Set for this subject rather than inherited: the chip is bordered and says so. */
    changed?: boolean;
    changedAccessibilityHint?: string;
    /** A changed value's way back: the picker leads with it ("Use workflow's"), choosing it clears the value. */
    reset?: Readonly<{ label: string; onReset: () => void }>;
    onSelect: (optionId: string) => void;
    /** The value's identity mark (the Agent's), leading a bordered chip. */
    leading?: React.ReactNode;
    /** Fields only: `row` when its row stacks the field under the label. */
    fieldSpan?: 'content' | 'row';
    /** Mounted only while the picker is open (the engine picker's readiness read). */
    openDemand?: React.ReactNode;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    // A labelled select sits in a host's panel (Step options): its choices open within that panel. A chip keeps
    // the composer's rule of opening over the whole window (agent-input popovers ignore a modal's boundary).
    const panelBoundaryRef = usePopoverBoundaryRef();
    const currentLabel = props.valueLabel ?? resolveSessionAuthoringOptionLabel(props.options, props.selectedOptionId, props.unselectedLabel);
    const offered = props.pickerOptions ?? props.options;
    const reset = props.changed === true ? props.reset : undefined;
    const pickerOptions = React.useMemo(() => reset === undefined ? offered
        : [{ id: RESET_OPTION_ID, label: reset.label }, ...offered], [offered, reset]);
    const onSelect = props.onSelect;
    const select = React.useCallback((optionId: string) => {
        if (optionId === RESET_OPTION_ID) reset?.onReset();
        else onSelect(optionId);
    }, [onSelect, reset]);

    const picker = (
        <AgentInputChipPickerPopover
            open={open}
            anchorRef={anchorRef}
            title={props.title}
            options={pickerOptions}
            selectedOptionId={props.selectedOptionId}
            onSelect={select}
            onRequestClose={() => setOpen(false)}
            maxHeightCap={460}
            {...(props.presentation === 'selects' && panelBoundaryRef !== null ? { boundaryRef: panelBoundaryRef } : {})}
        />
    );
    const openDemand = open ? props.openDemand : null;
    if (props.presentation === 'selects') {
        // The bordered field select, unlabelled: the host's group names the set (WF-REDESIGN-1116 change b).
        return (
            <>
                <SessionAuthoringFieldSelectTrigger
                    anchorRef={anchorRef}
                    title={props.title}
                    label={currentLabel}
                    leading={props.leading}
                    open={open}
                    {...(props.disabled === true ? { disabled: true } : {})}
                    {...(props.changed === true && props.changedAccessibilityHint !== undefined
                        ? { accessibilityHint: props.changedAccessibilityHint } : {})}
                    onPress={() => setOpen((current) => !current)}
                    testID={props.testID}
                />
                {picker}
                {openDemand}
            </>
        );
    }
    if (props.presentation === 'chips' && props.changed === true) {
        // A value this subject sets is the canonical bordered chip, the one the header's Where and
        // Triggers chips are, so the header line reads as one set (lab E1). Its chooser stays this
        // field's own picker, anchored to the chip.
        return (
            <>
                <View ref={anchorRef} collapsable={false} style={styles.chipAnchor}>
                    <SelectionListFilterChip
                        filter={{
                            id: props.controlId,
                            testID: props.testID,
                            label: props.title,
                            valueLabel: currentLabel,
                            // A changed value names its field ("Permissions: Read-only"), so it reads without its row.
                            showLabel: true,
                            ...(props.leading === undefined ? {} : { icon: props.leading }),
                            ...(props.changedAccessibilityHint === undefined ? {} : { accessibilityHint: props.changedAccessibilityHint }),
                            disabled: props.disabled === true,
                            // The chip only asks to open; this field's own picker below is the chooser.
                            open: false,
                            onOpenChange: (next) => { if (next) setOpen(true); },
                            renderPopoverContent: () => null,
                        }}
                    />
                </View>
                {picker}
                {openDemand}
            </>
        );
    }

    return (
        <>
            <View
                ref={anchorRef}
                collapsable={false}
                style={props.presentation === 'fields' ? styles.fieldAnchor : styles.chipAnchor}
            >
                <HappierPressable
                    testID={props.testID}
                    accessibilityRole="button"
                    accessibilityLabel={`${props.title}: ${currentLabel}`}
                    {...(props.changed === true && props.changedAccessibilityHint !== undefined
                        ? { accessibilityHint: props.changedAccessibilityHint }
                        : {})}
                    disabled={props.disabled === true}
                    expanded={open}
                    hasPopup="menu"
                    hitReach={AUTHORING_CHIP_HIT_REACH}
                    onPress={() => setOpen((current) => !current)}
                    style={(state) => props.presentation === 'fields'
                        // The field box inside draws the ring.
                        ? [styles.fieldTrigger, HAPPIER_FOCUS_RING_DELEGATED_STYLE]
                        : [
                            styles.chip,
                            props.changed === true ? styles.chipChanged : null,
                            state.pressed ? styles.chipPressed : null,
                            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                        ]}
                >
                    {(state) => props.presentation === 'fields'
                        ? renderDropdownItemTriggerRightElement({
                            leading: props.leading,
                            detail: currentLabel,
                            open,
                            detailColor: theme.colors.text.primary,
                            chevronColor: theme.colors.text.secondary,
                            // Stacked under its label in a settings row, the field spans the row (E1).
                            ...(props.fieldSpan === undefined ? {} : { fieldSpan: props.fieldSpan }),
                            // The field box carries the keyboard focus ring.
                            field: resolveFieldBoxColors(theme, state.focused ? 'focused' : 'idle'),
                        })
                        : (
                            <>
                                {/* The value's identity mark leads the chip, as in every other presentation (lab dpRev `add`). */}
                                {props.leading ?? null}
                                <Text numberOfLines={1} style={styles.chipText}>
                                    {currentLabel}
                                </Text>
                            </>
                        )}
                </HappierPressable>
            </View>
            {picker}
            {openDemand}
        </>
    );
}

function SessionAuthoringFieldControl(props: Readonly<{
    control: SessionAuthoringFieldControlModel;
    values: WorkflowSessionAuthoringSelection;
    facts: SessionAuthoringControlFacts;
    disabled?: boolean;
    onChangeField: (
        field: SessionAuthoringFieldId,
        value: WorkflowSessionAuthoringSelection[SessionAuthoringFieldId],
    ) => void;
    chipRenderContext: AgentInputExtraActionChipRenderContext;
    presentation: SessionAuthoringControlsPresentation;
    changed: boolean;
    changedAccessibilityHint?: string;
    reset?: Readonly<{ label: string; onReset: () => void }>;
    testIDPrefix: string;
}>): React.ReactElement {
    const { control, facts, onChangeField, values } = props;
    const chipState = {
        presentation: props.presentation,
        changed: props.changed,
        ...(props.changedAccessibilityHint === undefined ? {} : { changedAccessibilityHint: props.changedAccessibilityHint }),
        ...(props.reset === undefined ? {} : { reset: props.reset }),
    };
    const testID = `${props.testIDPrefix}-${control.field}`;

    const apply = React.useCallback((optionId: string, groupId?: string) => {
        onChangeField(control.field, resolveSessionAuthoringFieldValue({
            selection: groupId === undefined
                ? { field: control.field, optionId }
                : { field: control.field, optionId, groupId },
            values,
            facts,
            now: Date.now(),
        }));
    }, [control.field, facts, onChangeField, values]);

    switch (control.kind) {
        case 'unavailable':
            // Explicitly unavailable, never silently missing: the reader can see
            // that the field exists and that this target cannot offer it.
            return (
                <Text testID={`${testID}-unavailable`} style={styles.unavailableText}>
                    {sessionAuthoringUnavailableText(control.field, control.reason)}
                </Text>
            );

        case 'connectedServices':
            return (
                <SessionAuthoringConnectedServicesField
                    agentId={control.agentId}
                    agentIdentity={control.agentIdentity}
                    connectedAccounts={control.connectedAccounts}
                    context={control.context}
                    value={values.connectedServices}
                    onChange={(bindings) => onChangeField('connectedServices', bindings)}
                    chipRenderContext={props.chipRenderContext}
                    trigger={props.presentation === 'selects' ? 'select' : 'chip'}
                    testID={`${testID}-connected-services`}
                />
            );

        case 'mcp':
            return (
                <SessionAuthoringCapabilitiesField
                    agentId={control.agentId}
                    context={control.context}
                    value={values.capabilitySelection}
                    onChange={(selection) => onChangeField('capabilitySelection', selection)}
                    chipRenderContext={props.chipRenderContext}
                    trigger={props.presentation === 'selects' ? 'select' : 'chip'}
                    testID={`${testID}-mcp`}
                />
            );

        case 'text':
            return (
                <TextInput
                    testID={`${testID}-input`}
                    style={styles.textInput}
                    value={control.value}
                    placeholder={control.placeholder}
                    accessibilityLabel={control.title}
                    editable={props.disabled !== true}
                    onChangeText={(next) => apply(next)}
                />
            );

        case 'toolList':
            return (
                <SessionAuthoringToolListInput
                    boxed={props.presentation === 'selects'}
                    testID={`${testID}-input`}
                    title={control.title}
                    value={control.value}
                    placeholder={control.placeholder}
                    disabled={props.disabled === true}
                    onChange={(tools) => onChangeField('allowedTools', tools)}
                />
            );

        case 'options': {
            const chip = (
                <SessionAuthoringOptionChip
                    controlId={control.field}
                    fieldSpan="row"
                    {...(props.presentation === 'selects' && control.field === 'permissionMode'
                        ? { leading: <SessionAuthoringFieldMark name={PERMISSION_CONTROL_ICON} /> } : {})}
                    title={control.title}
                    options={control.options}
                    selectedOptionId={control.selectedOptionId}
                    {...(control.unselectedLabel === undefined
                        ? {}
                        : { unselectedLabel: control.unselectedLabel })}
                    {...(props.disabled === true ? { disabled: true } : {})}
                    {...chipState}
                    onSelect={(optionId) => apply(optionId)}
                    testID={testID}
                />
            );
            // A preserved value states its repair beside the chip; the fields
            // presentation states it as the row's description instead.
            if (control.preserved === undefined || props.presentation === 'fields') return chip;
            return (
                <View style={styles.preservedChip}>
                    {chip}
                    <Text testID={`${testID}-repair`} style={styles.unavailableText}>{control.preserved.repair}</Text>
                </View>
            );
        }

        case 'optionGroups':
            return (
                <View style={styles.root}>
                    {control.groups.map((group) => (
                        <SessionAuthoringOptionChip
                            key={group.id}
                            controlId={`${control.field}-${group.id}`}
                            title={group.title}
                            options={group.options}
                            selectedOptionId={group.selectedOptionId}
                            {...(props.disabled === true ? { disabled: true } : {})}
                            {...chipState}
                            onSelect={(optionId) => apply(optionId, group.id)}
                            testID={`${testID}-${group.id}`}
                        />
                    ))}
                </View>
            );
    }
}

/**
 * `chips` (default): the composer's chips, as the header and a step's composer
 * show them. `fields`: one labelled row per field whose trigger is a bordered
 * field select, as a settings pane shows them. `selects`: a wrapping row of
 * those bordered field selects with no rows or per-field labels, for a page
 * outside the composer that names the set in its own group ("Who runs it").
 * All present the same field models and open the same pickers.
 */
export type SessionAuthoringControlsPresentation = 'chips' | 'fields' | 'selects';

export type SessionAuthoringControlsProps = Readonly<{
    metadata?: Metadata | null;
    presentation?: SessionAuthoringControlsPresentation;
    /** A titled host section can omit the engine row's repeated title with null. */
    engineFieldTitle?: string | null;
    /**
     * Fields this subject sets itself rather than inherits (own-property
     * presence, never equality). Their chips are bordered; `'all'` borders every
     * chip (a subject whose values are always its own, like the workflow defaults).
     */
    overriddenFields?: ReadonlySet<SessionAuthoringFieldId> | 'all';
    /** Announced on a changed chip ("Changed for this step"). */
    overriddenAccessibilityHint?: string;
    /**
     * A subject that inherits its values (a workflow step): a changed chip's picker leads with
     * `label` ("Use workflow's"), which returns the field to the inherited value. The engine resets as
     * one field, `agentTarget`.
     */
    resetOverride?: Readonly<{ label: string; onResetField: (field: SessionAuthoringFieldId) => void }>;
    /** The host draws the engine chip beside these chips (a step card's header), so it alone says "Choose an agent". */
    engineChipBeside?: boolean;
    /** Which fields to render, in the caller's order. */
    fields: readonly SessionAuthoringFieldId[];
    values: WorkflowStepExecutionSelection;
    /** Atomic engine selection (Agent, model, mode and effort/config). */
    onChangeFields?: (fields: Partial<WorkflowStepExecutionSelection>) => void;
    engine?: WorkflowEngineChoiceV1;
    workflowRoles?: readonly WorkflowRoleV1[];
    onChangeEngine?: (engine: WorkflowEngineChoiceV1) => void;
    onChangeField: (
        field: SessionAuthoringFieldId,
        value: WorkflowSessionAuthoringSelection[SessionAuthoringFieldId],
    ) => void;
    facts?: SessionAuthoringControlFacts;
    /**
     * `fields` presentation: what a host states on a field's own row, end-aligned on its title line
     * (a step's "Workflow defaults" and reset), so the row names the field once.
     */
    fieldMeta?: Readonly<Partial<Record<SessionAuthoringFieldId, React.ReactNode>>>;
    /**
     * `selects` in a host with its own label track (a workflow's More settings): each field on a row
     * the host draws from the field's canonical title and its field select, as Machine and Folder are.
     */
    renderFieldRow?: (field: SessionAuthoringFieldId, title: string, control: React.ReactNode) => React.ReactNode;
    /** Renders the current values without allowing a change. */
    disabled?: boolean;
    testIDPrefix?: string;
    /**
     * A host choice that leads the engine picker (a background task's Auto). While `selected`, the
     * engine row reads `valueLabel` and the option is the picker's selection.
     */
    engineLeadingOption?: Readonly<{ option: AgentInputChipPickerOption; selected: boolean; valueLabel: string }>;
}>;

/**
 * Which Agent answers a selection's fields, and that Agent's effective policy.
 *
 * Decided here, once, from the selected target and the host's catalog facts. A
 * caller that resolved its own id could only re-derive it — and the workflow
 * editor's re-derivation was how a plugin Agent ended up displaying and
 * persisting the bundled default's models, permission modes and configuration.
 * The controls and the summary below both read it, so a summary can never name
 * a value the controls would not show.
 */
function useResolvedSessionAuthoringControls(
    values: WorkflowSessionAuthoringSelection,
    facts: SessionAuthoringControlFacts,
    metadata: Metadata | null | undefined,
) {
    const agentId = resolveSessionAuthoringAgentId({
        agentTarget: values.agentTarget ?? null,
        facts,
    });

    const controls = useSessionAuthoringControls({
        // The policy hook always answers for some Agent; an unresolved
        // selection is handled by the field projection, which refuses to
        // present Agent-owned fields rather than show this one's answers.
        agentId: agentId ?? DEFAULT_AGENT_ID,
        metadata: metadata ?? null,
        permissionMode: isPermissionMode(values.permissionMode) ? values.permissionMode : null,
        modelMode: readAuthoredSessionModelRef(values)?.modelId ?? null,
        // Authoring a definition can always change these; whether the *target*
        // supports a field is answered by that field's own capability facts.
        canChangeModel: true,
        canChangeSessionMode: true,
        canChangeConfigOption: true,
        acpSessionModeSelectedIdOverride: values.acpSessionModeId ?? null,
        acpConfigOptionOverridesOverride: values.sessionConfigOptionOverrides ?? null,
    });
    return { agentId, controls };
}

/**
 * The allowed-tools list as typed text. It keeps what the person typed (a
 * trailing comma, a half-written name) and reports the parsed list, so the
 * value and the text never fight while typing.
 */
function SessionAuthoringToolListInput(props: Readonly<{
    /** `selects`: the bordered page field beside its row label. */
    boxed?: boolean;
    testID: string;
    title: string;
    value: readonly string[];
    placeholder: string;
    disabled: boolean;
    onChange: (tools: string[] | undefined) => void;
}>): React.ReactElement {
    const [text, setText] = React.useState(() => formatSessionAuthoringToolList(props.value));
    const valueKey = props.value.join('\n');
    React.useEffect(() => {
        setText((current) => (parseSessionAuthoringToolList(current) ?? []).join('\n') === valueKey
            ? current
            : formatSessionAuthoringToolList(props.value));
    }, [valueKey]);
    const change = (next: string) => {
        setText(next);
        props.onChange(parseSessionAuthoringToolList(next));
    };
    if (props.boxed === true) return (
        <FieldTextInput
            testID={props.testID}
            value={text}
            monospace
            placeholder={props.placeholder}
            accessibilityLabel={props.title}
            editable={!props.disabled}
            autoCapitalize="none"
            onChangeText={change}
        />
    );
    return (
        <TextInput
            testID={props.testID}
            style={styles.textInput}
            value={text}
            placeholder={props.placeholder}
            accessibilityLabel={props.title}
            editable={!props.disabled}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(next) => {
                setText(next);
                props.onChange(parseSessionAuthoringToolList(next));
            }}
        />
    );
}

/** What an option chip says for its current selection: the one reading every presentation shares. */
function resolveSessionAuthoringOptionLabel(
    options: readonly SessionAuthoringFieldOption[],
    selectedOptionId: string,
    unselectedLabel: string | undefined,
): string {
    return options.find((option) => option.id === selectedOptionId)?.label ?? unselectedLabel ?? t('common.default');
}

/**
 * The effective value of each option field, as its chip reads it — the closed
 * summary of a settings group ("Opus 5.5 · Accept edits"). Fields without a
 * single chosen option (text, grouped, MCP, services) are left out rather than
 * summarized differently from their control.
 */
export function useSessionAuthoringFieldSummary(params: Readonly<{
    fields: readonly SessionAuthoringFieldId[];
    values: WorkflowSessionAuthoringSelection;
    facts?: SessionAuthoringControlFacts;
    metadata?: Metadata | null;
}>): readonly string[] {
    const facts = params.facts ?? EMPTY_FACTS;
    const { agentId, controls } = useResolvedSessionAuthoringControls(params.values, facts, params.metadata);
    return React.useMemo(() => params.fields.flatMap((field) => {
        const control = resolveSessionAuthoringFieldControl({ field, values: params.values, controls, facts, agentId });
        if (control.kind !== 'options') return [];
        return [resolveSessionAuthoringOptionLabel(control.options, control.selectedOptionId, control.unselectedLabel)];
    }), [agentId, controls, facts, params.fields, params.values]);
}

const EMPTY_FACTS: SessionAuthoringControlFacts = {};

/** What a step's engine chip reads: its own engine, or the participant a Run supplies for it. */
type SessionAuthoringEngine = WorkflowEngineChoiceV1 | NonNullable<WorkflowStepSelectionV1['participant']>;

/**
 * What the Agent & model control says: a role by its name, or the Agent and its model ("Claude ·
 * Opus 5.5"). The chip and a phone's value row read it here, so they never word it two ways.
 */
export function formatSessionAuthoringEngineLabel(params: Readonly<{
    engine: SessionAuthoringEngine | undefined;
    workflowRoles: readonly WorkflowRoleV1[] | undefined;
    agentLabel: string;
    values: WorkflowSessionAuthoringSelection;
    modelLabel?: string;
}>): string {
    if (params.engine && 'roleId' in params.engine) return resolveRoleDisplayName(params.engine.roleId, params.workflowRoles);
    // An identity the Run supplies from a named input is that input's, not an unchosen Agent.
    if (params.engine && 'kind' in params.engine && params.engine.kind === 'input') {
        return t('workflows.page.blocks.fromInput', { name: params.engine.name });
    }
    if (!params.values.agentTarget) return t('agentInput.agent.unselected');
    return [params.agentLabel, params.modelLabel].filter(Boolean).join(' · ');
}

/** The Agent & model summary for a host that shows it as a value row rather than the chip. */
export function useSessionAuthoringEngineSummary(params: Readonly<{
    values: WorkflowStepExecutionSelection;
    engine?: SessionAuthoringEngine;
    workflowRoles?: readonly WorkflowRoleV1[];
    facts?: SessionAuthoringControlFacts;
    metadata?: Metadata | null;
}>): string {
    const facts = params.facts ?? EMPTY_FACTS;
    const { agentId, controls } = useResolvedSessionAuthoringControls(params.values, facts, params.metadata);
    const enginePicker = useSessionAuthoringEnginePicker({ values: params.values, facts, disabled: true });
    const modelControl = resolveSessionAuthoringFieldControl({ field: 'modelSelection', values: params.values,
        controls, facts, agentId });
    // The CLI's own model is no choice to name: the summary is the Agent alone.
    const modelLabel = params.values.modelSelection == null
        ? readAuthoredSessionModelRef(params.values)?.modelId
        : modelControl.kind === 'options'
            ? modelControl.selectedOptionId === 'default' ? undefined
                : resolveSessionAuthoringOptionLabel(modelControl.options, modelControl.selectedOptionId, modelControl.unselectedLabel)
            : params.values.modelSelection.ref.modelId;
    return formatSessionAuthoringEngineLabel({ engine: params.engine, workflowRoles: params.workflowRoles,
        agentLabel: enginePicker.label, values: params.values, modelLabel });
}

export function SessionAuthoringControls(props: SessionAuthoringControlsProps): React.ReactElement {
    const { theme } = useUnistyles();
    const testIDPrefix = props.testIDPrefix ?? 'session-authoring-control';
    const facts = props.facts ?? EMPTY_FACTS;
    const overlayAnchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);

    const { agentId, controls } = useResolvedSessionAuthoringControls(props.values, facts, props.metadata);
    const engineSummary = useSessionAuthoringEngineSummary(props);
    const selectedRoleId = props.engine && 'roleId' in props.engine ? props.engine.roleId : null;
    const roleSelection = React.useMemo(() => props.onChangeEngine === undefined ? undefined : {
        value: selectedRoleId,
        workflowRoles: props.workflowRoles,
        onChange: (roleId: string) => { if (!props.disabled) props.onChangeEngine?.({ roleId }); },
    }, [props.disabled, selectedRoleId, props.onChangeEngine, props.workflowRoles]);
    const leadingOption = props.engineLeadingOption;
    const leadingOptions = React.useMemo(() => leadingOption ? [leadingOption.option] : undefined, [leadingOption?.option]);
    const enginePicker = useSessionAuthoringEnginePicker({ values: props.values, facts,
        disabled: props.disabled, onChangeFields: props.onChangeFields, roleSelection, leadingOptions });
    const leadingSelection = leadingOption?.selected === true ? leadingOption : null;
    const engineField = props.onChangeFields === undefined ? undefined
        : props.fields.find(field => field === 'agentTarget' || field === 'modelSelection');

    const chipRenderContext = useSessionAuthoringChipRenderContext(overlayAnchorRef);

    const presentation = props.presentation ?? 'chips';
    const isChanged = (field: SessionAuthoringFieldId) => props.overriddenFields === 'all'
        || (props.overriddenFields?.has(field) ?? false);
    // Controls without an option picker still need the same way back to inheritance.
    const withReset = (field: SessionAuthoringFieldId, control: React.ReactNode): React.ReactNode => {
        const reset = props.resetOverride;
        if (reset === undefined || !isChanged(field)) return control;
        const title = resolveSessionAuthoringFieldTitle(field,
            findSessionAuthoringAgentTargetOption(facts.agentTargets, props.values.agentTarget)) ?? field;
        return <View key={field} style={styles.root}>
            {control}
            <HappierPressable testID={`${testIDPrefix}-${field}-reset`} accessibilityRole="button"
                accessibilityLabel={`${title}: ${reset.label}`} disabled={props.disabled}
                onPress={() => reset.onResetField(field)}
                style={(state) => [styles.chip, state.pressed ? styles.chipPressed : null,
                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
                <Text style={styles.chipText}>{reset.label}</Text>
            </HappierPressable>
        </View>;
    };
    const controlFor = (field: SessionAuthoringFieldId) => resolveSessionAuthoringFieldControl({
        field,
        values: props.values,
        controls,
        facts,
        agentId,
    });
    // A settings form with no Agent chosen yet says so once, where its Agent-owned fields would be,
    // instead of a row of "Unavailable" each (owner 2026-11-06). A one-field form (a host listing its
    // fields one by one, as Step options do) only hides the row; that host says it once.
    const waitsOnAgent = presentation === 'fields' && props.fields.length > 1 && props.fields.some((field) => {
        if (engineField !== undefined && (field === 'agentTarget' || field === 'modelSelection'
            || field === 'acpSessionModeId' || field === 'sessionConfigOptionOverrides')) return false;
        const control = controlFor(field);
        return control.kind === 'unavailable' && control.reason === 'requires_agent_target';
    });
    let agentLineShown = false;
    const { renderFieldRow } = props;
    // `selects` on a host's label track: the row names the field with its canonical title.
    const inRow = (field: SessionAuthoringFieldId, control: React.ReactNode): React.ReactNode => presentation !== 'selects' || renderFieldRow === undefined
        ? control
        : <React.Fragment key={field}>{renderFieldRow(field, resolveSessionAuthoringFieldTitle(field,
            findSessionAuthoringAgentTargetOption(facts.agentTargets, props.values.agentTarget)) ?? field, control)}</React.Fragment>;

    return (
        <View
            ref={overlayAnchorRef}
            testID={testIDPrefix}
            style={presentation === 'fields' || props.renderFieldRow !== undefined ? styles.fields : styles.root}
        >
            {props.fields.map((field) => {
                if (field === 'approvalProfileId') return inRow(field, withReset(field, <SessionAuthoringApprovalProfileField key={field}
                    value={props.values.approvalProfileId} serverId={facts.agentPickerContext?.serverId}
                    machineId={facts.agentPickerContext?.machineId ?? null} presentation={presentation}
                    // A host whose unset values inherit (it offers a way back to its parent's) names the inherited default.
                    {...(props.resetOverride === undefined ? {} : { inherited: true })}
                    onChange={value => props.onChangeField('approvalProfileId', value)} disabled={props.disabled}
                    titleMeta={props.fieldMeta?.approvalProfileId} testID={`${testIDPrefix}-approvalProfileId`} />));
                if (presentation !== 'chips' && field === 'profileId' && !props.values.profileId) return null;
                if (engineField !== undefined && (field === 'acpSessionModeId' || field === 'sessionConfigOptionOverrides')) return null;
                if (engineField !== undefined && (field === 'agentTarget' || field === 'modelSelection')) {
                    if (field !== engineField) return null;
                    const rendered = <SessionAuthoringOptionChip
                        controlId="engine" title={t('workflows.page.sections.agentTitle')}
                        options={[]} pickerOptions={enginePicker.options}
                        selectedOptionId={leadingSelection?.option.id ?? enginePicker.selectedOptionId ?? ''}
                        valueLabel={leadingSelection?.valueLabel ?? engineSummary}
                        // The Session list's own agent mark, read on the picker's Machine (it knows Machine-contributed Agents).
                        {...(leadingSelection === null && agentId !== null ? { leading: <SessionAgentCatalogIdentityIcon agentId={agentId}
                            machineId={facts.agentPickerContext?.machineId ?? null} serverId={facts.agentPickerContext?.serverId ?? null} size={14} /> } : {})}
                        disabled={props.disabled} presentation={presentation} fieldSpan="row"
                        changed={isChanged('agentTarget') || isChanged('modelSelection')}
                        {...(props.overriddenAccessibilityHint === undefined ? {} : { changedAccessibilityHint: props.overriddenAccessibilityHint })}
                        {...(props.resetOverride === undefined ? {} : { reset: { label: props.resetOverride.label,
                            onReset: () => props.resetOverride?.onResetField('agentTarget') } })}
                        onSelect={enginePicker.onSelect} testID={`${testIDPrefix}-${engineField}`}
                        openDemand={enginePicker.readinessDemand}
                    />;
                    return presentation !== 'fields' || props.engineFieldTitle === null ? <React.Fragment key={field}>{rendered}</React.Fragment>
                        : <Item key={field} testID={`${testIDPrefix}-${engineField}-row`}
                            title={props.engineFieldTitle === undefined ? t('workflows.page.sections.agentTitle') : props.engineFieldTitle} mode="info" accessoryLayout="stacked" rightElement={rendered}
                            titleMeta={props.fieldMeta?.[engineField]} />;
                }
                const control = controlFor(field);
                const fieldControl = (
                    <SessionAuthoringFieldControl
                        key={field}
                        control={control}
                        values={props.values}
                        facts={facts}
                        {...(props.disabled === true ? { disabled: true } : {})}
                        onChangeField={props.onChangeField}
                        chipRenderContext={chipRenderContext}
                        presentation={presentation}
                        changed={isChanged(field)}
                        {...(props.overriddenAccessibilityHint === undefined
                            ? {}
                            : { changedAccessibilityHint: props.overriddenAccessibilityHint })}
                        {...(props.resetOverride === undefined ? {} : { reset: { label: props.resetOverride.label,
                            onReset: () => props.resetOverride?.onResetField(field) } })}
                        testIDPrefix={testIDPrefix}
                    />
                );
                const rendered = control.kind === 'options' || control.kind === 'optionGroups'
                    ? fieldControl : withReset(field, fieldControl);
                // A chip row beside its engine chip (in this row, or the host's: a step card's header) says "Choose an
                // agent" once, there; the fields that wait on it add nothing. A lone field still says why.
                if (presentation === 'chips') {
                    if ((engineField !== undefined || props.engineChipBeside === true)
                        && control.kind === 'unavailable' && control.reason === 'requires_agent_target') return null;
                    // A host listing a subject's whole set (a step's options) leaves out what it can never offer, as a form does.
                    return props.engineChipBeside === true && isNeverOfferedHere(control) ? null : rendered;
                }
                // A row of field selects, like a form, holds only the decisions this subject has (see below).
                if (presentation === 'selects') return control.kind === 'unavailable' && (control.reason === 'not_supported_on_target'
                    || control.reason === 'agent_has_no_options' || control.reason === 'owned_by_host'
                    // The engine in this row or beside it (a step card header's chip) asks for the Agent once.
                    || (control.reason === 'requires_agent_target' && (engineField !== undefined || props.engineChipBeside === true))) ? null : inRow(field, rendered);
                // A settings form holds only the decisions this step has: a field the Agent or the target can
                // never offer (a Windows-only field on Linux, an Agent with no such options) is left out rather
                // than listed as "Unavailable". Fields that wait on something or say what to do stay.
                // A control this host never supplies (`owned_by_host`) is not this form's decision either
                // (owner 2026-11-06). Agent-owned fields with no Agent yet give way to one line, said where
                // the first of them would be.
                if (control.kind === 'unavailable' && control.reason === 'requires_agent_target' && waitsOnAgent && !agentLineShown) {
                    agentLineShown = true;
                    // A form row like its siblings, so the line keeps the rows' text edge.
                    return <Item key={field} testID={`${testIDPrefix}-requires-agent`} title={t('newSession.chooseAgentFirst')}
                        titleStyle={styles.unavailableText} mode="info" showChevron={false} />;
                }
                if (control.kind === 'unavailable' && (control.reason === 'requires_agent_target' || isNeverOfferedHere(control))) return null;
                return (
                    <Item
                        key={field}
                        testID={`${testIDPrefix}-${field}-row`}
                        title={resolveSessionAuthoringFieldTitle(field, findSessionAuthoringAgentTargetOption(facts.agentTargets, props.values.agentTarget)) ?? field}
                        {...(control.kind === 'options' && control.preserved !== undefined
                            ? { subtitle: control.preserved.repair, subtitleTestID: `${testIDPrefix}-${field}-repair` }
                            : {})}
                        mode="info"
                        accessoryLayout="stacked"
                        rightElement={rendered}
                        titleMeta={props.fieldMeta?.[field]}
                    />
                );
            })}
        </View>
    );
}

/**
 * Why a field cannot be chosen here, and what to do about it, where the reader can act. A field with
 * no remedy of its own stays plainly unavailable.
 */
export function SessionAuthoringApprovalProfileField(props: Readonly<{
    value: string | null | undefined; serverId?: string | null; machineId?: string | null; testID: string; disabled?: boolean;
    presentation?: SessionAuthoringControlsPresentation; titleMeta?: React.ReactNode; onChange: (value: string | null | undefined) => void;
    /** An unset value inherits its host's parent (a workflow step): the chip names the inherited Machine default. */
    inherited?: boolean;
}>) {
    const source = useApprovalProfiles(props.value, props.serverId ?? undefined, { demand: false, machineId: props.machineId });
    const machineDefault = React.useMemo(() => resolveApprovalProfileMachineDefault(source, props.machineId),
        [source.displayProfiles, source.machineApprovalProfiles, props.machineId]); // eslint-disable-line react-hooks/exhaustive-deps
    return <ApprovalProfileSelect mode="session" value={props.value} source={source} machineDefault={machineDefault}
        testID={props.testID} disabled={props.disabled} titleMeta={props.titleMeta} presentation={props.presentation}
        {...(props.inherited === true ? { inherited: true } : {})} onChange={props.onChange} />;
}

function sessionAuthoringUnavailableText(field: SessionAuthoringFieldId, reason: SessionAuthoringFieldUnavailableReason): string {
    if (reason === 'loading') return t('common.loading');
    if (reason === 'profile_catalog_unavailable') return t('common.unavailable');
    if (field === 'profileId') {
        return reason === 'feature_disabled'
            ? t('newSession.profileUnavailableTurnedOff')
            : t('newSession.profileUnavailableNoneYet');
    }
    return t('common.unavailable');
}

/** A field select's leading mark, at the size and tone the placement fields' marks use. */
function SessionAuthoringFieldMark(props: Readonly<{ name: React.ComponentProps<typeof Icon>['name'] }>): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name={props.name} size={14} color={theme.colors.text.secondary} />;
}

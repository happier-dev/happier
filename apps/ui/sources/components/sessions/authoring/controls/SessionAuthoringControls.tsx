import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, HappierPressable } from '@happier-dev/plugin-ui/presentation';

import type { WorkflowEngineSelectionV1, WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowRoleV1 } from '@happier-dev/protocol';

import { DEFAULT_AGENT_ID, hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputChipPickerPopover } from '@/components/sessions/agentInput/components/AgentInputChipPickerPopover';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { Text, TextInput } from '@/components/ui/text/Text';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Item } from '@/components/ui/lists/Item';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { resolveRoleDisplayName } from '@/sync/domains/roles/roleCatalog';
import { Typography } from '@/constants/Typography';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import { t } from '@/text';

import {
    resolveSessionAuthoringAgentId,
    resolveSessionAuthoringFieldControl,
    resolveSessionAuthoringFieldTitle,
    resolveSessionAuthoringFieldValue,
    type SessionAuthoringControlFacts,
    type SessionAuthoringFieldControlModel,
    type SessionAuthoringFieldId,
    type SessionAuthoringFieldOption,
} from './sessionAuthoringFieldControls';
import { SessionAuthoringConnectedServicesField } from './SessionAuthoringConnectedServicesField';
import { SessionAuthoringMcpSelectionField } from './SessionAuthoringMcpSelectionField';
import { useSessionAuthoringControls } from './useSessionAuthoringControls';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useSessionAuthoringEnginePicker } from './useSessionAuthoringEnginePicker';

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
 * These chips and the window-name input are the real press frames, not icons
 * inside a larger row, so they take the canonical platform target as a minimum
 * height. `hitSlop` cannot stand in for it: react-native-web's `Pressable`
 * never reads it and the desktop app is the web bundle, so a slop-declared
 * target there is a target that does not exist. Growth is on the free vertical
 * axis, so a wrapping chip row still meets at its gap rather than overlapping.
 * Under a precise pointer they keep the chip row's dense height (the shared
 * touch-floor policy), the height of the other chips beside them.
 */
const MINIMUM_TARGET_SIZE = resolveTouchTargetFloorPx(Platform.OS) ?? undefined;

const styles = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.margins.sm,
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
        paddingHorizontal: 10,
        paddingVertical: 6,
        minHeight: MINIMUM_TARGET_SIZE,
        justifyContent: 'center',
        gap: 6,
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
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.composer.chipTint,
    },
    unavailableText: {
        ...Typography.default('regular'),
        fontSize: 13,
        color: theme.colors.text.tertiary,
    },
    preservedChip: {
        alignSelf: 'flex-start',
        gap: 2,
    },
    fieldAnchor: {
        alignSelf: 'stretch',
        minWidth: 0,
    },
    textInput: {
        ...Typography.default('regular'),
        color: theme.colors.text.primary,
        paddingVertical: 6,
        paddingHorizontal: 10,
        minHeight: MINIMUM_TARGET_SIZE,
        minWidth: 160,
    },
}));

/** One selectable value: a chip that names the current choice and its picker. */
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
    onSelect: (optionId: string) => void;
    /** The value's identity mark (the Agent's), leading a bordered chip. */
    leading?: React.ReactNode;
    /** Fields only: `row` when its row stacks the field under the label. */
    fieldSpan?: 'content' | 'row';
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    const currentLabel = props.valueLabel ?? resolveSessionAuthoringOptionLabel(props.options, props.selectedOptionId, props.unselectedLabel);
    const pickerOptions = props.pickerOptions ?? props.options;

    const picker = (
        <AgentInputChipPickerPopover
            open={open}
            anchorRef={anchorRef}
            title={props.title}
            options={pickerOptions}
            selectedOptionId={props.selectedOptionId}
            onSelect={props.onSelect}
            onRequestClose={() => setOpen(false)}
            maxHeightCap={460}
        />
    );
    if (props.presentation === 'chips' && props.changed === true) {
        // A value this subject sets is the canonical bordered chip, the one the header's Where and
        // Triggers chips are, so the header line reads as one set (lab E1). Its chooser stays this
        // field's own picker, anchored to the chip.
        return (
            <>
                <View ref={anchorRef} collapsable={false} style={{ alignSelf: 'flex-start' }}>
                    <SelectionListFilterChip
                        filter={{
                            id: props.controlId,
                            testID: props.testID,
                            label: props.title,
                            valueLabel: currentLabel,
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
            </>
        );
    }

    return (
        <>
            <View
                ref={anchorRef}
                collapsable={false}
                style={props.presentation === 'fields' ? styles.fieldAnchor : { alignSelf: 'flex-start' }}
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
                            <Text numberOfLines={1} style={styles.chipText}>
                                {currentLabel}
                            </Text>
                        )}
                </HappierPressable>
            </View>
            {picker}
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
    testIDPrefix: string;
}>): React.ReactElement {
    const { control, facts, onChangeField, values } = props;
    const chipState = {
        presentation: props.presentation,
        changed: props.changed,
        ...(props.changedAccessibilityHint === undefined ? {} : { changedAccessibilityHint: props.changedAccessibilityHint }),
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
                    {t('common.unavailable')}
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
                    testID={`${testID}-connected-services`}
                />
            );

        case 'mcp':
            return (
                <SessionAuthoringMcpSelectionField
                    agentId={control.agentId}
                    context={control.context}
                    value={values.mcpSelection}
                    onChange={(selection) => onChangeField('mcpSelection', selection)}
                    chipRenderContext={props.chipRenderContext}
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

        case 'options': {
            const chip = (
                <SessionAuthoringOptionChip
                    controlId={control.field}
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
 * field select, as a settings pane shows them. Both present the same field
 * models and open the same pickers.
 */
export type SessionAuthoringControlsPresentation = 'chips' | 'fields';

export type SessionAuthoringControlsProps = Readonly<{
    metadata?: Metadata | null;
    presentation?: SessionAuthoringControlsPresentation;
    /**
     * Fields this subject sets itself rather than inherits (own-property
     * presence, never equality). Their chips are bordered; `'all'` borders every
     * chip (a subject whose values are always its own, like the workflow defaults).
     */
    overriddenFields?: ReadonlySet<SessionAuthoringFieldId> | 'all';
    /** Announced on a changed chip ("Changed for this step"). */
    overriddenAccessibilityHint?: string;
    /** Which fields to render, in the caller's order. */
    fields: readonly SessionAuthoringFieldId[];
    values: WorkflowSessionAuthoringSelection;
    /** Atomic engine selection (Agent, model, mode and effort/config). */
    onChangeFields?: (fields: Partial<WorkflowSessionAuthoringSelection>) => void;
    engine?: WorkflowEngineSelectionV1;
    workflowRoles?: readonly WorkflowRoleV1[];
    onChangeEngine?: (engine: WorkflowEngineSelectionV1) => void;
    onChangeField: (
        field: SessionAuthoringFieldId,
        value: WorkflowSessionAuthoringSelection[SessionAuthoringFieldId],
    ) => void;
    facts?: SessionAuthoringControlFacts;
    /** Renders the current values without allowing a change. */
    disabled?: boolean;
    testIDPrefix?: string;
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
        modelMode: values.modelSelection?.ref.modelId ?? null,
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

/**
 * What the Agent & model control says: a role by its name, or the Agent and its model ("Claude ·
 * Opus 5.5"). The chip and a phone's value row read it here, so they never word it two ways.
 */
function formatSessionAuthoringEngineLabel(params: Readonly<{
    engine: WorkflowEngineSelectionV1 | undefined;
    workflowRoles: readonly WorkflowRoleV1[] | undefined;
    agentLabel: string;
    values: WorkflowSessionAuthoringSelection;
    controls: ReturnType<typeof useResolvedSessionAuthoringControls>['controls'];
    facts: SessionAuthoringControlFacts;
    agentId: ReturnType<typeof resolveSessionAuthoringAgentId>;
}>): string {
    if (params.engine && 'role' in params.engine) return resolveRoleDisplayName(params.engine.role, params.workflowRoles);
    if (!params.values.agentTarget) return t('agentInput.agent.unselected');
    const modelControl = resolveSessionAuthoringFieldControl({ field: 'modelSelection', values: params.values,
        controls: params.controls, facts: params.facts, agentId: params.agentId });
    const modelLabel = modelControl.kind === 'options'
        ? resolveSessionAuthoringOptionLabel(modelControl.options, modelControl.selectedOptionId, modelControl.unselectedLabel)
        : params.values.modelSelection?.ref.modelId;
    return [params.agentLabel, modelLabel].filter(Boolean).join(' · ');
}

/** The Agent & model summary for a host that shows it as a value row rather than the chip. */
export function useSessionAuthoringEngineSummary(params: Readonly<{
    values: WorkflowSessionAuthoringSelection;
    engine?: WorkflowEngineSelectionV1;
    workflowRoles?: readonly WorkflowRoleV1[];
    facts?: SessionAuthoringControlFacts;
    metadata?: Metadata | null;
}>): string {
    const facts = params.facts ?? EMPTY_FACTS;
    const { agentId, controls } = useResolvedSessionAuthoringControls(params.values, facts, params.metadata);
    const enginePicker = useSessionAuthoringEnginePicker({ values: params.values, facts, disabled: true });
    return formatSessionAuthoringEngineLabel({ engine: params.engine, workflowRoles: params.workflowRoles,
        agentLabel: enginePicker.label, values: params.values, controls, facts, agentId });
}

export function SessionAuthoringControls(props: SessionAuthoringControlsProps): React.ReactElement {
    const testIDPrefix = props.testIDPrefix ?? 'session-authoring-control';
    const facts = props.facts ?? EMPTY_FACTS;
    const overlayAnchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    const { theme } = useUnistyles();

    const { agentId, controls } = useResolvedSessionAuthoringControls(props.values, facts, props.metadata);
    const engineSummary = useSessionAuthoringEngineSummary(props);
    const roleSelection = React.useMemo(() => props.onChangeEngine === undefined ? undefined : {
        value: props.engine && 'role' in props.engine ? props.engine.role : null,
        workflowRoles: props.workflowRoles,
        onChange: (role: string) => { if (!props.disabled) props.onChangeEngine?.({ role }); },
    }, [props.disabled, props.engine, props.onChangeEngine, props.workflowRoles]);
    const enginePicker = useSessionAuthoringEnginePicker({ values: props.values, facts,
        disabled: props.disabled, onChangeFields: props.onChangeFields, roleSelection });
    const engineField = props.onChangeFields === undefined ? undefined
        : props.fields.find(field => field === 'agentTarget' || field === 'modelSelection');

    const chipRenderContext = React.useMemo<AgentInputExtraActionChipRenderContext>(() => ({
        chipStyle: (pressed: boolean) => [styles.chip, pressed ? styles.chipPressed : null],
        showLabel: true,
        iconColor: theme.colors.composer.chipTint,
        textStyle: styles.chipText,
        countTextStyle: styles.chipText,
        popoverAnchorRef: overlayAnchorRef,
    }), [theme.colors.composer.chipTint]);

    const presentation = props.presentation ?? 'chips';
    const isChanged = (field: SessionAuthoringFieldId) => props.overriddenFields === 'all'
        || (props.overriddenFields?.has(field) ?? false);

    return (
        <View
            ref={overlayAnchorRef}
            testID={testIDPrefix}
            style={presentation === 'fields' ? styles.fields : styles.root}
        >
            {props.fields.map((field) => {
                if (engineField !== undefined && (field === 'acpSessionModeId' || field === 'sessionConfigOptionOverrides')) return null;
                if (engineField !== undefined && (field === 'agentTarget' || field === 'modelSelection')) {
                    if (field !== engineField) return null;
                    const rendered = <SessionAuthoringOptionChip
                        controlId="engine" title={t('workflows.page.sections.agentTitle')}
                        options={[]} pickerOptions={enginePicker.options}
                        selectedOptionId={enginePicker.selectedOptionId ?? ''}
                        valueLabel={engineSummary}
                        {...(agentId !== null && hasAgentIconMark(agentId, theme) ? { leading: <AgentIcon agentId={agentId} size={14} /> } : {})}
                        disabled={props.disabled} presentation={presentation} fieldSpan="row"
                        changed={isChanged('agentTarget') || isChanged('modelSelection')}
                        onSelect={enginePicker.onSelect} testID={`${testIDPrefix}-${engineField}`}
                    />;
                    return presentation === 'chips' ? <React.Fragment key={field}>{rendered}</React.Fragment>
                        : <Item key={field} testID={`${testIDPrefix}-${engineField}-row`}
                            title={t('workflows.page.sections.agentTitle')} mode="info" accessoryLayout="stacked" rightElement={rendered} />;
                }
                const control = resolveSessionAuthoringFieldControl({
                    field,
                    values: props.values,
                    controls,
                    facts,
                    agentId,
                });
                const rendered = (
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
                        testIDPrefix={testIDPrefix}
                    />
                );
                if (presentation === 'chips') return rendered;
                return (
                    <Item
                        key={field}
                        testID={`${testIDPrefix}-${field}-row`}
                        title={resolveSessionAuthoringFieldTitle(field) ?? field}
                        {...(control.kind === 'options' && control.preserved !== undefined
                            ? { subtitle: control.preserved.repair, subtitleTestID: `${testIDPrefix}-${field}-repair` }
                            : {})}
                        mode="info"
                        accessoryLayout="adaptive"
                        rightElement={rendered}
                    />
                );
            })}
        </View>
    );
}

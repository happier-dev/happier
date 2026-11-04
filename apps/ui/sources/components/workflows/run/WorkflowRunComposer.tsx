import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierInputField } from '@happier-dev/plugin-ui/presentation';
import type { JsonValue, RoleOverrideV1, WorkflowDefinitionV1, WorkflowMaterializedLeafV1 } from '@happier-dev/protocol';
import { workflowInputTitle, workflowInputToFieldHint, type WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';
import { validateWorkflowDefinition } from '@happier-dev/protocol/workflows/workflowValidationV1';
import type { InputOptionsConsumerV1 } from '@happier-dev/protocol/inputs';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { actionInputOptionValueKey, isSameActionInputOptionValue, readActionInputOptionValue, type ActionInputOptionValue } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { AgentInput } from '@/components/sessions/agentInput';
import { registerComposerFocusTarget, requestRegisteredComposerFocus } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createExecutionRunStartContentChip } from '@/components/sessions/runs/launcher/executionRunStartChips';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { InputTypePickerHostProvider } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { useExecutableParticipantLabel } from '@/components/sessions/authoring/useExecutableParticipantLabel';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { SurfaceStateCard } from '@/components/ui/surfaces';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useKeyboardShortcutHandlers } from '@/keyboard';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';
import { buildWorkflowRunStartInputs, projectWorkflowRunInputFields, type WorkflowRunInputFieldState } from '@/sync/domains/workflows/workflowAuthoring';
import { findWorkflowMainInput, isWorkflowChoiceInput, isWorkflowHostBoundInput, resolveWorkflowBuiltinInputPresentation } from '../presentation/workflowBuiltinInputPresentation';
import { formatWorkflowInputValue } from '@/sync/domains/workflows/workflowInputText';
import { describeWorkflowCommandBlockedReason, describeWorkflowInputRepair } from '@/components/workflows/presentation/workflowBlockedReasonText';
import { WorkflowAcceptedRunRoles, WorkflowRunRoles, workflowUsedRoleIds } from './WorkflowRunRoles';
import { useWorkflowRunRolePrefill } from './useWorkflowRunRolePrefill';
import { useWorkflowRunVisibility } from './useWorkflowRunVisibility';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { countWorkflowStepsV1, walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';
import type { WorkflowRunNowRetainedRequest } from './useWorkflowRunNowController';
import { resolveAgentInputColumn } from '@/components/sessions/agentInput/layout/agentInputColumn';

const styles = StyleSheet.create((theme) => ({
    root: { minWidth: 0 },
    // The request's label and the status/Start footer sit in the composer's own column, so they share
    // the card's edges on every host and width (New centres that column on a wide page).
    column: { width: '100%', alignItems: 'center' },
    columnInner: { width: '100%' },
    footer: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.space.s8, paddingBottom: theme.space.s12, paddingTop: theme.space.s8 },
    status: { flex: 1, minWidth: 0, minHeight: theme.space.s16, justifyContent: 'center', gap: theme.space.s4 },
    hostedPanel: { borderWidth: 0, borderTopWidth: 0, borderBottomWidth: 0, borderRadius: 0 },
    summary: { ...Typography.variant('meta'), color: theme.colors.text.secondary, paddingVertical: theme.space.s12, paddingBottom: theme.space.s8 },
    mainLabel: { ...Typography.variant('meta'), color: theme.colors.text.primary, paddingTop: theme.space.s12 },
    start: { alignItems: 'flex-end', gap: theme.space.s4 },
    shortcut: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
    keyHint: { ...({ ...Typography.variant('micro', 'regular'), ...Typography.mono(), ...Typography.tabular() }), color: theme.colors.text.secondary },
    fields: { gap: theme.space.s12, padding: theme.space.s12 },
    secondary: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    required: { ...Typography.variant('meta'), color: theme.colors.text.destructive },
    /** Readiness, not an error: quiet warning tone, aligned with the composer card's content edge. */
    readiness: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
    readinessText: { color: theme.colors.state.warning.foreground, flexShrink: 1 },
    // Popover and sheet content carries its own ink; a bare Text has no colour and reads black on dark.
    body: { color: theme.colors.text.primary },
    // The request is typed in the composer; its readiness leads the Inputs fields at their own rhythm.
    mainReadiness: { paddingHorizontal: theme.space.s12, paddingTop: theme.space.s12 },
    visibilityStatus: { color: theme.colors.text.secondary, flexShrink: 1 },
}));

const EMPTY_RAW_TEXT: Readonly<Record<string, string>> = {};
const EMPTY_VALUES: Readonly<Record<string, JsonValue>> = {};
const EMPTY_AUTOCOMPLETE_KINDS: React.ComponentProps<typeof AgentInput>['autocompleteKinds'] = [];
const EMPTY_AUTOCOMPLETE_SUGGESTIONS: React.ComponentProps<typeof AgentInput>['autocompleteSuggestions'] = async () => [];

export type WorkflowRunComposerProps = Readonly<{
    inputs: readonly WorkflowInputDefinition[];
    /** Discovery reopens this admitted descriptor; local field bags cannot grant a source read. */
    optionsConsumer?: Extract<InputOptionsConsumerV1, { kind: 'workflow' }>;
    values: Readonly<Record<string, JsonValue | undefined>>;
    onChangeValues: (next: Readonly<Record<string, JsonValue | undefined>>) => void;
    rawTextValues?: Readonly<Record<string, string>>;
    onChangeRawTextValues?: (next: Readonly<Record<string, string>>) => void;
    onRun: (inputs: Readonly<Record<string, JsonValue>> | undefined, roleOverrides?: readonly RoleOverrideV1[], visibleTeamId?: string) => void;
    definition?: WorkflowDefinitionV1;
    sourceArtifactId?: string | null;
    /** Accepted repeat facts: their presence makes targets and Roles read-only. */
    materializedLeaves?: readonly WorkflowMaterializedLeafV1[];
    roleOverrides?: readonly RoleOverrideV1[];
    onCancel: () => void;
    pending?: boolean;
    /** Admission is unresolved after a lost reply, rather than refused. */
    reconciling?: boolean;
    /**
     * Why the last Start was refused, from the canonical Workflow problem owner.
     * It stays in the composer beside Start, which remains available to retry.
     */
    startProblem?: string | null;
    startDisabled?: boolean;
    /**
     * The request this surface already sent while its admission is unsettled
     * (`WorkflowRunNowController.retainedRequest`). Start re-sends exactly it,
     * so the review shows its values read-only instead of the editable ones.
     */
    retainedRequest?: WorkflowRunNowRetainedRequest | null;
    /** The opening launcher requests focus once its caller input and Start are ready. */
    autoFocusComposer?: boolean;
    /** A host with its own gutter (the Start pane and phone sheet) sets the column's side inset; defaults to the conversation's. */
    contentPaddingHorizontal?: number;
    /** Hangs from the control that already names the run key (Run now): Start does not repeat it. */
    triggerNamesShortcut?: boolean;
    testIDPrefix?: string;
    workflowName?: string;
    preview?: string;
    includesUnsavedEdits?: boolean;
    notice?: string;
    machineId?: string | null;
    directory?: string | null;
    serverId?: string | null;
    /** Exact invoking Session, used by the shared declared context-default owner. */
    originSession?: ActionSessionAddressV1;
    /** Placement comes from the host, including New's phone floating composer. */
    surfaceGroup?: React.ComponentProps<typeof AgentInput>['surfaceGroup'];
    /** Where and Roles come from their incumbent composer control owners. */
    extraActionChips?: readonly AgentInputExtraActionChip[];
    workflowChip?: AgentInputExtraActionChip;
    /** Retained, but never submitted, when the selection has no text input. */
    retainedText?: string;
    authoringControls?: Pick<React.ComponentProps<typeof AgentInput>,
        'machineName' | 'machinePopover' | 'currentPath' | 'folderChipState' | 'onRemoveFolder' | 'pathPopover'>;
    /** Catalog-facing input copy (built-ins); authored workflows name their inputs themselves. */
    inputPresentation?: WorkflowRunInputPresentation;
    /** Demand-mounted choice from the shared executable participant picker. */
    pickAgentParticipant?: React.ComponentProps<typeof InputTypePickerHostProvider>['pickAgentParticipant'];
}>;

export type WorkflowRunInputPresentation = Readonly<Record<string, Readonly<{
    title: string;
    /** The composer's empty-field prompt when the input has no authored description. */
    placeholder?: string;
    optionLabels?: Readonly<Record<string, string>>;
}>>>;

/** One start presentation; FIN owns defaults, validation and the admitted input map. */
export function WorkflowRunComposer(props: WorkflowRunComposerProps): React.ReactElement {
    const { theme } = useUnistyles();
    const shortcutLabel = useKeyboardShortcutLabel('workflow.run');
    // The key is said once: not beside a trigger that already names it, and not on a phone, which has no keys.
    const phone = useDeviceType() === 'phone';
    const runShortcut = phone || props.triggerNamesShortcut === true ? undefined : shortcutLabel;
    const prefix = props.testIDPrefix ?? 'workflow-run-inputs';
    const acceptedRepeat = props.materializedLeaves !== undefined;
    // Replay admission validates the immutable accepted bindings, not today's authored defaults or catalog.
    const definitionValidation = React.useMemo(() => props.definition && !acceptedRepeat
        ? validateWorkflowDefinition(props.definition) : null, [acceptedRepeat, props.definition]);
    const definitionIssue = definitionValidation?.issues.find((issue) => issue.severity === 'error') ?? null;
    const roleIds = React.useMemo(() => props.definition ? workflowUsedRoleIds(props.definition) : [], [props.definition]);
    // While an earlier request is unsettled, the review is that request: its inputs, Roles and Team.
    const retained = props.retainedRequest ?? null;
    const { width: screenWidth } = useWindowDimensions();
    const column = resolveAgentInputColumn({
        screenWidth,
        ...(props.contentPaddingHorizontal === undefined ? {} : { contentPaddingHorizontal: props.contentPaddingHorizontal }),
    });
    const columnStyle = [styles.column, { paddingHorizontal: column.paddingHorizontal }];
    const columnInnerStyle = [styles.columnInner, column.maxWidth === undefined ? null : { maxWidth: column.maxWidth }];
    const retainedSource = retained?.input.source;
    const visibility = useWorkflowRunVisibility(acceptedRepeat ? null : props.sourceArtifactId);
    const visibleTeamId = retainedSource !== undefined
        ? retainedSource.kind === 'catalog' ? null : retainedSource.visibleTeamId ?? null
        : visibility.resolution.ok ? visibility.resolution.visibleTeamId : null;
    const selectedTeam = visibility.teams.find((team) => team.id === visibleTeamId);
    const visibilityLabel = selectedTeam ? t('workflows.start.visibility.visibleTo', { team: selectedTeam.name ?? selectedTeam.id })
        : t('workflows.start.visibility.chooseTeam');
    const roleDraft = useWorkflowRunRolePrefill(!acceptedRepeat && roleIds.length > 0 ? props.sourceArtifactId : null);
    const roleOverrides = retained ? retained.input.roleOverrides ?? props.roleOverrides ?? [] : props.roleOverrides ?? roleDraft.overrides;
    const [localRawTextValues, setLocalRawTextValues] = React.useState<Readonly<Record<string, string>>>({});
    const rawTextValues = retained ? EMPTY_RAW_TEXT : props.rawTextValues ?? localRawTextValues;
    const setRawTextValues = props.onChangeRawTextValues ?? setLocalRawTextValues;
    const values = retained ? retained.input.inputs ?? EMPTY_VALUES : props.values;
    const fields = React.useMemo(() => projectWorkflowRunInputFields({
        inputs: props.inputs, values, rawTextValues, originSession: props.originSession,
    }), [props.inputs, values, props.originSession, rawTextValues]);
    // Nothing in the review can change while it re-sends the retained request.
    const locked = props.pending === true || retained !== null;
    // The line says which request it re-sends: this Run, Run again, or Another round.
    const retainedLine = retained?.unresolved !== true ? null : retainedSource?.kind === 'inline' && retainedSource.replay
        ? retainedSource.replay.intent === 'another_round' ? t('workflows.start.retry.anotherRound') : t('workflows.start.retry.runAgain')
        : t('workflows.start.retry.start');
    // Host-bound inputs (the previous round, a trigger id, a diff fingerprint) are never asked; they keep their defaults.
    const personFields = React.useMemo(() => fields.filter((field) => !isWorkflowHostBoundInput(field.definition)), [fields]);
    const mainName = findWorkflowMainInput(props.inputs)?.name;
    const main = personFields.find((field) => field.definition.name === mainName) ?? null;
    const remaining = personFields.filter((field) => field !== main);
    const missingFields = fields.filter((field) => field.errorCode === 'missing_required_input');
    const missing = missingFields.length;
    // A built-in reads in its own words wherever its form opens; the source it reads options for names it.
    const inputPresentation = React.useMemo(() => props.inputPresentation
        ?? resolveWorkflowBuiltinInputPresentation(props.optionsConsumer?.workflow), [props.inputPresentation, props.optionsConsumer?.workflow]);
    const inputTitle = (definition: WorkflowInputDefinition) => workflowInputTitle(definition, inputPresentation?.[definition.name]);
    const blocked = fields.find((field) => field.blocking) ?? null;
    // A retained request was reviewed when it was first sent; the canonical admission owner re-checks it.
    const disabled = props.pending === true || (retained === null && (props.startDisabled === true || blocked !== null || definitionIssue !== null
        || (!acceptedRepeat && roleDraft.status !== 'ready') || visibility.status !== 'ready' || !visibility.resolution.ok));
    const hasMainInput = main !== null;
    const presented = useLayoutPresentationActive();
    const [focusRef] = React.useState(() => Symbol('workflow-run-input'));
    const focusRequestRef = React.useRef<(() => void) | null>(null);
    const focusCurrentRef = React.useRef(false);
    focusCurrentRef.current = hasMainInput && !locked && presented;
    const onComposerFocusRequestChange = React.useCallback((request: (() => void) | null) => {
        focusRequestRef.current = request;
    }, []);
    React.useEffect(() => {
        if (!hasMainInput) return;
        return registerComposerFocusTarget(focusRef, {
            isCurrent: () => focusCurrentRef.current,
            focusComposer: () => {
                if (!focusCurrentRef.current || !focusRequestRef.current) return false;
                focusRequestRef.current();
                return true;
            },
        });
    }, [focusRef, hasMainInput]);
    const initialFocusApplied = React.useRef(false);
    React.useEffect(() => {
        if (!props.autoFocusComposer || disabled || !presented || !hasMainInput || initialFocusApplied.current) return;
        initialFocusApplied.current = requestRegisteredComposerFocus(focusRef);
    }, [disabled, focusRef, hasMainInput, presented, props.autoFocusComposer]);
    const reason = retained !== null ? retainedLine : blocked === null ? (!acceptedRepeat && roleDraft.status !== 'ready'
        ? roleDraft.status === 'failed' ? t('workflows.start.rolesPrefillFailed') : t('common.loading')
        : definitionIssue !== null ? describeWorkflowCommandBlockedReason({ reason: 'definition_invalid', blockingIssue: definitionIssue })
        : props.startProblem ?? null) : blocked.errorCode === 'missing_required_input'
        ? t('workflows.start.addToStart', { name: inputTitle(blocked.definition) }) : t('workflows.issue.invalid_input');
    // 07 §3: an untouched missing value is readiness, not an error. It never interrupts as an alert.
    const readinessOnly = retained !== null || blocked?.errorCode === 'missing_required_input' || (roleDraft.status === 'loading' && blocked === null);
    const visibilityHint = retained !== null ? undefined : visibility.status !== 'ready' ? visibility.status === 'failed'
        ? t('workflows.start.visibility.loadFailed') : t('common.loading')
        : !visibility.resolution.ok ? t('workflows.start.visibility.chooseTeam') : undefined;
    const changeText = React.useCallback((name: string, text: string) => {
        // Raw buffers survive intermediate numbers and malformed JSON. Only FIN parses them.
        setRawTextValues({ ...rawTextValues, [name]: text });
    }, [rawTextValues, setRawTextValues]);
    const changeValue = React.useCallback((name: string, value: JsonValue | undefined) => {
        const next = { ...rawTextValues };
        delete next[name];
        setRawTextValues(next);
        props.onChangeValues({ ...props.values, [name]: value });
    }, [props.onChangeValues, props.values, rawTextValues, setRawTextValues]);
    const submit = React.useCallback(() => {
        if (disabled) return;
        const inputs = buildWorkflowRunStartInputs(fields);
        if (visibleTeamId !== null) props.onRun(inputs, roleOverrides, visibleTeamId);
        else if (props.definition) props.onRun(inputs, roleOverrides);
        else props.onRun(inputs);
    }, [disabled, fields, props.definition, props.onRun, roleOverrides, visibleTeamId]);
    useKeyboardShortcutHandlers({ 'workflow.run': submit });
    const summary = React.useMemo(() => {
        if (!props.definition) return (props.preview ?? props.workflowName ?? t('workflows.start.preview')).replace(/\s*\n\s*/g, ' → ');
        const first = props.definition.blocks[0];
        const last = props.definition.blocks.at(-1);
        const route = first ? [workflowBlockReferenceLabel(first), ...(last && last !== first ? [workflowBlockReferenceLabel(last)] : [])].join(' → ') : '';
        return [t('workflows.examples.stepCount', { count: countWorkflowStepsV1(props.definition.blocks) }), route].filter(Boolean).join(' · ');
    }, [props.definition, props.preview, props.workflowName]);
    // The sheet header already names the workflow; the fixed chip identifies its saved definition.
    const workflowLabel = [t('workflows.start.workflow'),
        ...(props.sourceArtifactId && !props.includesUnsavedEdits ? [t('workflows.page.saveStatus.saved')] : [])].join(' · ');
    // Start keeps its own word while it works: the spinner replaces it in place and the line beside it
    // says "Starting…", so the pressed button never changes width (DESIGN-16 D11).
    const startLabel = retained?.unresolved === true ? t('workflows.start.retry.action') : t('workflows.start.start');
    const chips = React.useMemo<readonly AgentInputExtraActionChip[]>(() => [
        ...(props.workflowChip ? [props.workflowChip] : [createExecutionRunStartContentChip({
            key: 'workflow-start-definition', icon: 'git-branch', label: workflowLabel,
            title: t('workflows.start.workflow'), testID: `${prefix}-workflow-chip`,
            renderContent: <View style={styles.fields}><Text style={styles.body}>{props.preview ?? props.workflowName ?? t('workflows.start.preview')}</Text></View>,
        })]),
        ...(remaining.length === 0 && missing === 0 ? [] : [createExecutionRunStartContentChip({
            key: 'workflow-start-inputs', icon: 'sliders-horizontal',
            label: missing === 1 ? t('workflows.start.neededNamed', { name: inputTitle(missingFields[0]!.definition) })
                : missing > 1 ? t('workflows.start.needed', { count: missing }) : t('workflows.start.inputs'),
            title: t('workflows.start.inputs'), testID: `${prefix}-inputs-chip`,
            revision: JSON.stringify([values, rawTextValues, locked]),
            renderContent: <View>
                {main?.errorCode === 'missing_required_input' ? <View style={styles.mainReadiness}>
                    <FieldItem label={inputTitle(main.definition)}>
                        <Text style={styles.readinessText}>{t('workflows.start.required')}</Text>
                    </FieldItem>
                </View> : null}
                <WorkflowRunInputs fields={remaining} values={values} rawTextValues={rawTextValues}
                onChangeText={changeText} onChangeValue={changeValue} pending={locked}
                machineId={props.machineId ?? null} serverId={props.serverId ?? null} prefix={prefix}
                optionsConsumer={props.optionsConsumer}
                pickAgentParticipant={props.pickAgentParticipant}
                {...(inputPresentation === undefined ? {} : { presentation: inputPresentation })} />
            </View>,
        })]),
        ...(props.extraActionChips ?? []),
        ...(visibility.teams.length === 0 ? [] : [createExecutionRunStartContentChip({
            key: 'workflow-start-visibility', icon: 'users', label: visibilityLabel,
            title: t('workflows.start.visibility.title'), testID: `${prefix}-visibility-chip`, revision: `${visibleTeamId ?? ''}:${locked}`,
            renderContent: <View style={styles.fields}>
                {visibility.teams.length === 1 ? <Text style={styles.body}>{visibilityLabel}</Text>
                    : <WorkflowRunVisibilityChoice teams={visibility.teams} selectedId={visibleTeamId}
                        onSelect={visibility.onChange} pending={locked} />}
                <Text style={styles.secondary}>{t('workflows.start.visibility.transcripts')}</Text>
            </View>,
        })]),
        ...(!props.definition || (roleIds.length === 0 && roleOverrides.length === 0
            && !props.materializedLeaves?.some((leaf) => leaf.role)) ? [] : [createExecutionRunStartContentChip({
            key: 'workflow-start-roles', icon: 'users', title: t('workflows.start.rolesTitle'),
            label: roleOverrides.length > 0 ? t('workflows.start.rolesChanged', { count: roleOverrides.length }) : t('workflows.start.rolesYour'),
            testID: `${prefix}-roles-chip`, revision: JSON.stringify([roleOverrides, locked]),
            renderContent: <View style={styles.fields}>{acceptedRepeat
                ? <WorkflowAcceptedRunRoles leaves={props.materializedLeaves ?? []} />
                : roleDraft.status !== 'ready' && retained === null ? <View>
                    <Text accessibilityRole={roleDraft.status === 'failed' ? 'alert' : undefined}>
                        {roleDraft.status === 'failed' ? t('workflows.start.rolesPrefillFailed') : t('common.loading')}
                    </Text>
                    {roleDraft.status === 'failed' ? <RoundButton size="small" title={t('common.retry')} onPress={roleDraft.retry} /> : null}
                </View> : <WorkflowRunRoles definition={props.definition} roleIds={roleIds}
                    serverId={props.serverId} machineId={props.machineId ?? null} directory={props.directory ?? null}
                    overrides={roleOverrides} onChange={roleDraft.onChange} pending={locked} prefix={prefix} />}</View>,
        })]),
        ...(props.materializedLeaves === undefined ? [] : [createExecutionRunStartContentChip({
            key: 'workflow-start-targets', icon: 'stack',
            // The chip names what the steps run in, beside "Workflow" ("A session" said nothing there, DESIGN-15 R11).
            label: [...new Set(props.materializedLeaves.map((leaf) => leaf.executionTarget.kind === 'session'
                ? t('workflows.start.targetsSessions') : t('workflows.start.targetsBackground')))].join(' · '),
            title: t('workflows.start.targetsTitle'),
            testID: `${prefix}-targets-chip`, renderContent: <View style={styles.fields}>{props.materializedLeaves.map((leaf) => {
                const block = leaf.sourceKey === '$root' && props.definition
                    ? walkWorkflowBlocks(props.definition.blocks).find((candidate) => candidate.id === leaf.blockId) : null;
                return <FieldItem key={JSON.stringify([leaf.sourceKey, leaf.blockId])}
                    label={block ? workflowBlockReferenceLabel(block) : t('workflows.start.workflow')}>
                    <Text style={styles.body}>{leaf.executionTarget.kind === 'session' ? t('workflows.page.sections.aSession') : t('workflows.page.sections.aBackgroundRun')}</Text>
                </FieldItem>;
            })}</View>,
        })]),
    ].map((chip) => ({
        ...chip,
        ...(chip.key === 'workflow-start-definition' ? { controlId: 'workflow' as const }
            : chip.key === 'workflow-start-inputs' ? { controlId: 'workflowInputs' as const }
                : chip.key === 'workflow-start-roles' ? { controlId: 'workflowRoles' as const }
                    : chip.key === 'workflow-start-targets' ? { controlId: 'workflowTargets' as const }
                        : chip.key === 'workflow-start-visibility' ? { controlId: 'sessionAccess' as const } : {}),
    })), [changeText, changeValue, main, missing, missingFields, inputPresentation, prefix, props.extraActionChips, props.machineId, props.directory, props.pending,
        props.preview, props.serverId, props.optionsConsumer, props.pickAgentParticipant, values, locked, props.workflowChip, props.workflowName, rawTextValues, remaining,
        acceptedRepeat, props.definition, props.materializedLeaves, roleDraft.onChange, roleDraft.retry, roleDraft.status, roleIds, roleOverrides,
        visibility.teams, visibility.onChange, visibilityLabel, visibleTeamId, workflowLabel]);
    return (
        <View testID={prefix} style={styles.root}>
            <View testID={`${prefix}-${main === null ? 'preview' : 'main'}`}>
                <View style={columnStyle}><View style={columnInnerStyle}>
                    {main === null ? <Text testID={`${prefix}-summary`} selectable numberOfLines={1} style={styles.summary}>{summary}</Text>
                        : <Text style={styles.mainLabel}>{inputTitle(main.definition)}</Text>}
                </View></View>
                <PluginContextualResourceStoreProvider>
                    <AgentInput
                        panelPresentation="document"
                        inputPresentation={main === null ? 'controlsOnly' : 'full'}
                        panelStyle={styles.hostedPanel}
                        {...(props.contentPaddingHorizontal === undefined ? {} : { contentPaddingHorizontal: props.contentPaddingHorizontal })}
                        surfaceGroup={props.surfaceGroup}
                        {...props.authoringControls}
                        value={main === null ? props.preview ?? props.workflowName ?? t('workflows.start.preview')
                            : rawTextValues[main.definition.name] ?? formatWorkflowInputValue(main.value)}
                        onChangeText={(text) => { if (main !== null) changeText(main.definition.name, text); }}
                        placeholder={main === null ? t('workflows.start.preview') : main.definition.description ?? inputPresentation?.[main.definition.name]?.placeholder ?? inputTitle(main.definition)}
                        inputAccessibilityLabel={main === null ? t('workflows.start.preview') : inputTitle(main.definition)}
                        inputAccessibilityHint={main?.blocking ? reason ?? undefined : undefined}
                        disabled={locked}
                        onComposerFocusRequestChange={onComposerFocusRequestChange}
                        voiceAffordance="none"
                        autocompleteKinds={EMPTY_AUTOCOMPLETE_KINDS}
                        autocompleteSuggestions={EMPTY_AUTOCOMPLETE_SUGGESTIONS}
                        barControlIds={[...new Set([
                            ...chips.flatMap((chip) => chip.controlId ? [chip.controlId] : []),
                            ...(props.authoringControls ? ['machine' as const, 'path' as const] : []),
                        ])]}
                        extraActionChips={chips}
                    />
                </PluginContextualResourceStoreProvider>
            </View>
            <View style={columnStyle}><View testID={`${prefix}-footer`} style={[columnInnerStyle, styles.footer]}>
                <View testID={`${prefix}-status`} style={styles.status}>
                    {props.notice ? <Text style={styles.secondary}>{props.notice}</Text> : null}
                    {props.reconciling ? <Text testID={`${prefix}-reconciling`} accessibilityLiveRegion="polite" style={styles.secondary}>{t('workflows.start.stillStarting')}</Text> : null}
                    {props.pending && !props.reconciling ? <Text testID={`${prefix}-starting`} accessibilityLiveRegion="polite" style={styles.secondary}>{t('workflows.start.starting')}</Text> : null}
                    {props.includesUnsavedEdits ? <Text testID={`${prefix}-unsaved`} style={styles.secondary}>{t('workflows.start.unsaved')}</Text> : null}
                    {visibility.shared ? <Text style={styles.secondary}>{t('workflows.start.visibility.machines')}</Text> : null}
                    {selectedTeam?.sessionCreationPolicy === 'team_required' ? <Text testID={`${prefix}-team-required`}
                        accessibilityLiveRegion="polite" style={styles.secondary}>{t('workflows.start.visibility.requiredSessionsEditable')}</Text> : null}
                    {retained !== null ? null : visibility.status !== 'ready' ? <View style={styles.readiness}>
                        <Text accessibilityRole={visibility.status === 'failed' ? 'alert' : undefined} style={styles.visibilityStatus}>
                            {visibility.status === 'failed' ? t('workflows.start.visibility.loadFailed') : t('common.loading')}
                        </Text>
                        {visibility.status === 'failed' ? <RoundButton testID={`${prefix}-visibility-retry`} size="small"
                            title={t('common.retry')} onPress={visibility.retry} /> : null}
                    </View> : !visibility.resolution.ok ? <Text style={styles.readinessText}>{t('workflows.start.visibility.chooseTeam')}</Text> : null}
                    {main === null && props.retainedText ? <Text testID={`${prefix}-retained-text`} style={styles.secondary}>{props.retainedText}</Text> : null}
                    {reason === null ? null : <View testID={`${prefix}-reason`} style={styles.readiness}
                        {...(readinessOnly ? {} : { accessibilityRole: 'alert' as const })}>
                        {blocked?.errorCode === 'missing_required_input' ? <Icon name="warning" size={ICON_SIZE.xs} color={theme.colors.state.warning.foreground} /> : null}
                        <Text testID={`${prefix}-reason-text`} style={retained !== null || (readinessOnly && blocked !== null) ? styles.readinessText
                            : readinessOnly ? styles.secondary : styles.required}>{reason}</Text>
                    </View>}
                </View>
                {/* Start at the action size, with its key hint quietly beneath it (convo-N7). */}
                <View style={styles.start}>
                    <RoundButton testID={`${prefix}-run`} size="small"
                        title={startLabel}
                        accessibilityLabel={startLabel}
                        leading={<Icon name={retained?.unresolved === true ? 'arrow-clockwise' : 'play'} size={ICON_SIZE.xs}
                            color={disabled ? theme.colors.text.tertiary : theme.colors.button.primary.tint} />}
                        // A pending Start keeps the primary look under its spinner (as the hold card's does);
                        // `submit` ignores presses until it settles.
                        disabled={disabled && props.pending !== true} loading={props.pending}
                        accessibilityHint={reason ?? visibilityHint} onPress={submit} />
                    {runShortcut ? <View testID={`${prefix}-shortcut`} style={styles.shortcut}
                        accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        <Text style={styles.keyHint}>{runShortcut}</Text>
                        <Text style={styles.secondary}>{t('workflows.start.shortcutStarts')}</Text>
                    </View> : null}
                </View>
            </View></View>
        </View>
    );
}

function WorkflowRunVisibilityChoice(props: Readonly<{
    teams: readonly Readonly<{ id: string; name: string | null }>[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    pending: boolean;
}>) {
    const [open, setOpen] = React.useState(false);
    return <DropdownMenu open={open} onOpenChange={setOpen} selectedId={props.selectedId}
        items={props.teams.map((team) => ({ id: team.id, title: team.name ?? team.id, disabled: props.pending }))}
        itemTrigger={{ title: t('workflows.start.visibility.chooseTeam'), itemProps: { disabled: props.pending } }}
        onSelect={(id) => { props.onSelect(id); setOpen(false); }} />;
}

/** A choice, several choices, or a value a custom picker returned (already validated by its host). */
function readWorkflowSelection(value: unknown): JsonValue | undefined {
    if (!Array.isArray(value)) return readActionInputOptionValue(value);
    return value.flatMap((item) => {
        const option = readActionInputOptionValue(item);
        return option === undefined ? [] : [option];
    });
}

function isParticipantInput(definition: WorkflowInputDefinition): boolean {
    return definition.inputType !== undefined && 'hostType' in definition.inputType && definition.inputType.hostType === 'agentParticipant';
}

/** Opened by a participant field's Browse; the picker module and its reads load only then. */
const pickAgentParticipantOnDemand: NonNullable<WorkflowRunComposerProps['pickAgentParticipant']> = async (request) => {
    const { presentExecutableParticipantPicker } = await import('@/components/sessions/authoring/ExecutableParticipantPickerModal');
    if (request.signal.aborted) return null;
    return presentExecutableParticipantPicker({ accountLifetime: request.accountLifetime, multiple: request.multiple,
        ...(request.selected === undefined ? {} : { selected: request.selected }), signal: request.signal });
};

/** A chosen participant reads as its session or model; other choice fields keep their option labels. */
function WithParticipantLabel(props: Readonly<{ participant: boolean; value: unknown; serverId: string | null;
    children: (valueLabel: string | undefined) => React.ReactElement }>): React.ReactElement {
    return props.participant && props.value !== undefined
        ? <ParticipantLabel value={props.value} serverId={props.serverId}>{props.children}</ParticipantLabel>
        : props.children(undefined);
}

function ParticipantLabel(props: Readonly<{ value: unknown; serverId: string | null;
    children: (valueLabel: string | undefined) => React.ReactElement }>): React.ReactElement {
    return props.children(useExecutableParticipantLabel(props.value, props.serverId));
}

/** Only mounted while Inputs is open; option reads stay local to this leaf. */
export function WorkflowRunInputs(props: Readonly<{
    fields: readonly WorkflowRunInputFieldState[];
    values: WorkflowRunComposerProps['values'];
    rawTextValues: Readonly<Record<string, string>>;
    onChangeText: (name: string, text: string) => void;
    onChangeValue: (name: string, value: JsonValue | undefined) => void;
    pending: boolean;
    machineId: string | null;
    serverId: string | null;
    prefix: string;
    optionsConsumer?: WorkflowRunComposerProps['optionsConsumer'];
    pickAgentParticipant?: WorkflowRunComposerProps['pickAgentParticipant'];
    /** Catalog-facing copy; input names and option values remain the authored contract. */
    presentation?: WorkflowRunInputPresentation;
}>) {
    const { theme } = useUnistyles();
    const accountLifetime = useWorkflowAccountLifetime();
    const selectTheme = usePluginUiTheme(theme);
    // Every Run form (composer, trigger, Run again) shows only what a person is asked for.
    const fields = React.useMemo(() => props.fields.filter((field) => !isWorkflowHostBoundInput(field.definition)), [props.fields]);
    const requests = fields.map(({ definition }) => ({
        field: workflowInputToFieldHint(definition, props.presentation?.[definition.name]),
        draftInput: props.values,
        ...(props.optionsConsumer ? { consumer: props.optionsConsumer } : {}),
    }));
    const { resolveOptions, state: optionsState, retry, snapshot } = useInputFieldOptions({
        requests,
        machineId: props.machineId, serverId: props.serverId,
        accountLifetime,
        enabled: fields.some((field) => field.definition.optionsSourceId !== undefined || field.definition.inputType !== undefined),
    });
    return <InputTypePickerHostProvider enabled={fields.some((field) => field.definition.inputType !== undefined)}
        {...resolveOptions.pickerContext}
        pickAgentParticipant={props.pickAgentParticipant ?? pickAgentParticipantOnDemand}
        contextKey={JSON.stringify([props.optionsConsumer, props.values, snapshot])}>
        <CoreCollectionScope><View style={styles.fields}>{fields.map((field) => {
        const definition = field.definition;
        const presentation = props.presentation?.[definition.name];
        const title = workflowInputTitle(definition, presentation);
        const id = `${props.prefix}-${definition.name}`;
        const repair = field.errorCode === 'missing_required_input' ? t('workflows.start.required')
            : describeWorkflowInputRepair({ valueType: definition.valueType, errorCode: field.errorCode });
        const state = props.values[definition.name] === undefined && props.rawTextValues[definition.name] === undefined
            ? definition.default === undefined ? t('workflows.start.optional')
                : t('workflows.start.defaultValue', { value: typeof definition.default === 'string'
                    ? presentation?.optionLabels?.[definition.default] ?? formatWorkflowInputValue(definition.default)
                    : formatWorkflowInputValue(definition.default) })
            : definition.description;
        if (isWorkflowChoiceInput(definition)) {
            const hint = workflowInputToFieldHint(definition, presentation);
            const options = resolveOptions(hint);
            const optionState = optionsState(hint);
            const selected = Array.isArray(field.value)
                ? field.value.flatMap((value) => {
                    const option = readActionInputOptionValue(value);
                    return option === undefined ? [] : [option];
                })
                : readActionInputOptionValue(field.value);
            return <FieldItem key={definition.name} label={title} supportingText={repair ?? state}>
                <WithParticipantLabel participant={isParticipantInput(definition)} value={field.value} serverId={props.serverId}>{(valueLabel) =>
                <HappierInputField<ActionInputOptionValue> frame="none" field={hint} value={field.value}
                    {...(valueLabel === undefined ? {} : { valueLabel })}
                    selection={selected} options={options} optionsStatus={optionState.status}
                    optionsNotice={<SurfaceStateCard kind="error" size="line" title={t('workflows.start.choicesFailed')}
                        diagnosticCode={optionState.errorCode} action={{ label: t('common.retry'), onPress: retry }} />}
                    isEqual={isSameActionInputOptionValue} keyForOption={(option) => actionInputOptionValueKey(option.value)}
                    theme={selectTheme} disabled={props.pending} testID={id}
                    onChange={(value) => props.onChangeValue(definition.name, readWorkflowSelection(value))} />}
                </WithParticipantLabel>
            </FieldItem>;
        }
        if (definition.valueType === 'boolean') return <SegmentedChoiceItem
            key={definition.name} title={title} subtitle={repair ?? state}
            value={field.value === true ? 'yes' : field.value === false ? 'no' : 'unset'}
            options={[
                ...(!definition.required ? [{ id: 'unset', label: t('workflows.page.blocks.notSet') }] : []),
                { id: 'yes', label: t('common.yes') }, { id: 'no', label: t('common.no') },
            ]}
            onChange={(value) => props.onChangeValue(definition.name, value === 'unset' ? undefined : value === 'yes')}
            disabled={props.pending} testIDPrefix={id} />;
        const value = props.rawTextValues[definition.name] ?? (definition.valueType === 'json' && field.value !== undefined
            ? JSON.stringify(field.value) : formatWorkflowInputValue(field.value));
        // A missing required value is readiness, said as supporting text; only a value the person
        // typed that cannot be used is an error on the field (07 §3: untouched fields never show errors).
        const missingRequired = field.errorCode === 'missing_required_input';
        return <FieldItem key={definition.name} label={title} supportingText={missingRequired ? repair ?? state : state}>
            <FieldTextInput testID={id} value={value}
                accessibilityLabel={title} error={missingRequired ? null : repair}
                multiline={definition.valueType !== 'number'} monospace={definition.valueType === 'json'}
                inputMode={definition.valueType === 'number' ? 'decimal' : undefined}
                editable={!props.pending} onChangeText={(text) => props.onChangeText(definition.name, text)} />
        </FieldItem>;
    })}</View></CoreCollectionScope></InputTypePickerHostProvider>;
}

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierInputField } from '@happier-dev/plugin-ui/presentation';
import type { JsonValue, RoleOverrideV1, WorkflowDefinitionV1, WorkflowMaterializedLeafV1 } from '@happier-dev/protocol';
import { workflowInputToFieldHint, type WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';
import { validateWorkflowDefinition } from '@happier-dev/protocol/workflows/workflowValidationV1';
import type { InputOptionsConsumerV1 } from '@happier-dev/protocol/inputs';
import { actionInputOptionValueKey, isSameActionInputOptionValue, readActionInputOptionValue, type ActionInputOptionValue } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { AgentInput } from '@/components/sessions/agentInput';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createExecutionRunStartContentChip } from '@/components/sessions/runs/launcher/executionRunStartChips';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { InputTypePickerHostProvider } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { SurfaceStateCard } from '@/components/ui/surfaces';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
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
import { t } from '@/text';
import { buildWorkflowRunStartInputs, projectWorkflowRunInputFields, type WorkflowRunInputFieldState } from '@/sync/domains/workflows/workflowAuthoring';
import { formatWorkflowInputValue } from '@/sync/domains/workflows/workflowInputText';
import { describeWorkflowCommandBlockedReason, describeWorkflowInputRepair } from '@/components/workflows/presentation/workflowBlockedReasonText';
import { WorkflowAcceptedRunRoles, WorkflowRunRoles, workflowUsedRoleIds } from './WorkflowRunRoles';
import { useWorkflowRunRolePrefill } from './useWorkflowRunRolePrefill';
import { useWorkflowRunVisibility } from './useWorkflowRunVisibility';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { countWorkflowStepsV1, walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

const styles = StyleSheet.create((theme) => ({
    root: { minWidth: 0 },
    footer: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.margins.sm, padding: theme.margins.md, paddingTop: theme.margins.sm },
    status: { flex: 1, minWidth: 0, minHeight: theme.margins.lg, justifyContent: 'center', gap: theme.margins.xs },
    hostedPanel: { borderWidth: 0, borderTopWidth: 0, borderBottomWidth: 0, borderRadius: 0 },
    summary: { ...Typography.rowMeta(), color: theme.colors.text.secondary, padding: theme.margins.md, paddingBottom: theme.margins.sm },
    mainLabel: { ...Typography.rowMeta(), color: theme.colors.text.primary, paddingHorizontal: theme.margins.md, paddingTop: theme.margins.md },
    start: { alignItems: 'flex-end', gap: theme.margins.xs },
    shortcut: { flexDirection: 'row', alignItems: 'center', gap: theme.margins.xs },
    keyHint: { ...Typography.keyHint(), color: theme.colors.text.secondary },
    fields: { gap: theme.margins.md, padding: theme.margins.md },
    secondary: { ...Typography.rowMeta(), color: theme.colors.text.secondary },
    required: { ...Typography.rowMeta(), color: theme.colors.text.destructive },
    /** Readiness, not an error: quiet warning tone, aligned with the composer card's content edge. */
    readiness: { flexDirection: 'row', alignItems: 'center', gap: theme.margins.xs },
    readinessText: { color: theme.colors.state.warning.foreground, flexShrink: 1 },
    visibilityStatus: { color: theme.colors.text.secondary, flexShrink: 1 },
}));

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
    testIDPrefix?: string;
    workflowName?: string;
    preview?: string;
    includesUnsavedEdits?: boolean;
    notice?: string;
    machineId?: string | null;
    serverId?: string | null;
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
    const runShortcut = useKeyboardShortcutLabel('workflow.run');
    const prefix = props.testIDPrefix ?? 'workflow-run-inputs';
    const acceptedRepeat = props.materializedLeaves !== undefined;
    // Replay admission validates the immutable accepted bindings, not today's authored defaults or catalog.
    const definitionValidation = React.useMemo(() => props.definition && !acceptedRepeat
        ? validateWorkflowDefinition(props.definition) : null, [acceptedRepeat, props.definition]);
    const definitionIssue = definitionValidation?.issues.find((issue) => issue.severity === 'error') ?? null;
    const roleIds = React.useMemo(() => props.definition ? workflowUsedRoleIds(props.definition) : [], [props.definition]);
    const visibility = useWorkflowRunVisibility(acceptedRepeat ? null : props.sourceArtifactId);
    const visibleTeamId = visibility.resolution.ok ? visibility.resolution.visibleTeamId : null;
    const selectedTeam = visibility.teams.find((team) => team.id === visibleTeamId);
    const visibilityLabel = selectedTeam ? t('workflows.start.visibility.visibleTo', { team: selectedTeam.name ?? selectedTeam.id })
        : t('workflows.start.visibility.chooseTeam');
    const roleDraft = useWorkflowRunRolePrefill(!acceptedRepeat && roleIds.length > 0 ? props.sourceArtifactId : null);
    const roleOverrides = props.roleOverrides ?? roleDraft.overrides;
    const [localRawTextValues, setLocalRawTextValues] = React.useState<Readonly<Record<string, string>>>({});
    const rawTextValues = props.rawTextValues ?? localRawTextValues;
    const setRawTextValues = props.onChangeRawTextValues ?? setLocalRawTextValues;
    const fields = React.useMemo(() => projectWorkflowRunInputFields({
        inputs: props.inputs, values: props.values, rawTextValues,
    }), [props.inputs, props.values, rawTextValues]);
    const main = fields.find((field) => field.definition.valueType === 'string' && !isWorkflowChoiceInput(field.definition)) ?? null;
    const remaining = fields.filter((field) => field !== main);
    const missingFields = fields.filter((field) => field.errorCode === 'missing_required_input');
    const missing = missingFields.length;
    const inputTitle = (definition: WorkflowInputDefinition) => props.inputPresentation?.[definition.name]?.title ?? definition.name;
    const blocked = fields.find((field) => field.blocking) ?? null;
    const disabled = props.pending === true || props.startDisabled === true || blocked !== null || definitionIssue !== null
        || (!acceptedRepeat && roleDraft.status !== 'ready') || visibility.status !== 'ready' || !visibility.resolution.ok;
    const reason = blocked === null ? (!acceptedRepeat && roleDraft.status !== 'ready'
        ? roleDraft.status === 'failed' ? t('workflows.start.rolesPrefillFailed') : t('common.loading')
        : definitionIssue !== null ? describeWorkflowCommandBlockedReason({ reason: 'definition_invalid', blockingIssue: definitionIssue })
        : props.startProblem ?? null) : blocked.errorCode === 'missing_required_input'
        ? t('workflows.start.addToStart', { name: inputTitle(blocked.definition) }) : t('workflows.issue.invalid_input');
    // 07 §3: an untouched missing value is readiness, not an error. It never interrupts as an alert.
    const readinessOnly = blocked?.errorCode === 'missing_required_input' || (roleDraft.status === 'loading' && blocked === null);
    const visibilityHint = visibility.status !== 'ready' ? visibility.status === 'failed'
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
    const startLabel = props.reconciling ? t('workflows.start.stillStarting')
        : props.pending ? t('workflows.start.starting') : t('workflows.start.start');
    const chips = React.useMemo<readonly AgentInputExtraActionChip[]>(() => [
        ...(props.workflowChip ? [props.workflowChip] : [createExecutionRunStartContentChip({
            key: 'workflow-start-definition', icon: 'git-branch', label: workflowLabel,
            title: t('workflows.start.workflow'), testID: `${prefix}-workflow-chip`,
            renderContent: <View style={styles.fields}><Text>{props.preview ?? props.workflowName ?? t('workflows.start.preview')}</Text></View>,
        })]),
        ...(remaining.length === 0 && missing === 0 ? [] : [createExecutionRunStartContentChip({
            key: 'workflow-start-inputs', icon: 'sliders-horizontal',
            label: missing === 1 ? t('workflows.start.neededNamed', { name: inputTitle(missingFields[0]!.definition) })
                : missing > 1 ? t('workflows.start.needed', { count: missing }) : t('workflows.start.inputs'),
            title: t('workflows.start.inputs'), testID: `${prefix}-inputs-chip`,
            revision: JSON.stringify([props.values, rawTextValues]),
            renderContent: <View>
                {main?.errorCode === 'missing_required_input' ? <View style={styles.fields}>
                    <Text>{inputTitle(main.definition)}</Text><Text style={styles.readinessText}>{t('workflows.start.required')}</Text>
                </View> : null}
                <WorkflowRunInputs fields={remaining} values={props.values} rawTextValues={rawTextValues}
                onChangeText={changeText} onChangeValue={changeValue} pending={props.pending === true}
                machineId={props.machineId ?? null} serverId={props.serverId ?? null} prefix={prefix}
                optionsConsumer={props.optionsConsumer}
                {...(props.inputPresentation === undefined ? {} : { presentation: props.inputPresentation })} />
            </View>,
        })]),
        ...(props.extraActionChips ?? []),
        ...(visibility.teams.length === 0 ? [] : [createExecutionRunStartContentChip({
            key: 'workflow-start-visibility', icon: 'users', label: visibilityLabel,
            title: t('workflows.start.visibility.title'), testID: `${prefix}-visibility-chip`, revision: visibleTeamId ?? '',
            renderContent: <View style={styles.fields}>
                {visibility.teams.length === 1 ? <Text>{visibilityLabel}</Text>
                    : <WorkflowRunVisibilityChoice teams={visibility.teams} selectedId={visibleTeamId}
                        onSelect={visibility.onChange} pending={props.pending === true} />}
                <Text style={styles.secondary}>{t('workflows.start.visibility.transcripts')}</Text>
            </View>,
        })]),
        ...(!props.definition || (roleIds.length === 0 && roleOverrides.length === 0
            && !props.materializedLeaves?.some((leaf) => leaf.role)) ? [] : [createExecutionRunStartContentChip({
            key: 'workflow-start-roles', icon: 'users', title: t('workflows.start.rolesTitle'),
            label: roleOverrides.length > 0 ? t('workflows.start.rolesChanged', { count: roleOverrides.length }) : t('workflows.start.rolesYour'),
            testID: `${prefix}-roles-chip`, revision: JSON.stringify(roleOverrides),
            renderContent: <View style={styles.fields}>{acceptedRepeat
                ? <WorkflowAcceptedRunRoles leaves={props.materializedLeaves ?? []} />
                : roleDraft.status !== 'ready' ? <View>
                    <Text accessibilityRole={roleDraft.status === 'failed' ? 'alert' : undefined}>
                        {roleDraft.status === 'failed' ? t('workflows.start.rolesPrefillFailed') : t('common.loading')}
                    </Text>
                    {roleDraft.status === 'failed' ? <RoundButton size="small" title={t('common.retry')} onPress={roleDraft.retry} /> : null}
                </View> : <WorkflowRunRoles definition={props.definition} roleIds={roleIds}
                    overrides={roleOverrides} onChange={roleDraft.onChange} pending={props.pending === true} prefix={prefix} />}</View>,
        })]),
        ...(props.materializedLeaves === undefined ? [] : [createExecutionRunStartContentChip({
            key: 'workflow-start-targets', icon: 'stack',
            label: [...new Set(props.materializedLeaves.map((leaf) => leaf.executionTarget.kind === 'session'
                ? t('workflows.page.sections.aSession') : t('workflows.page.sections.aBackgroundRun')))].join(' · '),
            title: t('workflows.start.targetsTitle'),
            testID: `${prefix}-targets-chip`, renderContent: <View style={styles.fields}>{props.materializedLeaves.map((leaf) => {
                const block = leaf.sourceKey === '$root' && props.definition
                    ? walkWorkflowBlocks(props.definition.blocks).find((candidate) => candidate.id === leaf.blockId) : null;
                return <FieldItem key={JSON.stringify([leaf.sourceKey, leaf.blockId])}
                    label={block ? workflowBlockReferenceLabel(block) : t('workflows.start.workflow')}>
                    <Text>{leaf.executionTarget.kind === 'session' ? t('workflows.page.sections.aSession') : t('workflows.page.sections.aBackgroundRun')}</Text>
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
    })), [changeText, changeValue, main, missing, missingFields, props.inputPresentation, prefix, props.extraActionChips, props.machineId, props.pending,
        props.preview, props.serverId, props.optionsConsumer, props.values, props.workflowChip, props.workflowName, rawTextValues, remaining,
        acceptedRepeat, props.definition, props.materializedLeaves, roleDraft.onChange, roleDraft.retry, roleDraft.status, roleIds, roleOverrides,
        visibility.teams, visibility.onChange, visibilityLabel, visibleTeamId, workflowLabel]);
    return (
        <View testID={prefix} style={styles.root}>
            <View testID={`${prefix}-${main === null ? 'preview' : 'main'}`}>
                {main === null ? <Text testID={`${prefix}-summary`} selectable numberOfLines={1} style={styles.summary}>{summary}</Text>
                    : <Text style={styles.mainLabel}>{inputTitle(main.definition)}</Text>}
                <PluginContextualResourceStoreProvider>
                    <AgentInput
                        panelPresentation="document"
                        chipPresentation="bordered"
                        inputPresentation={main === null ? 'controlsOnly' : 'full'}
                        panelStyle={styles.hostedPanel}
                        surfaceGroup={props.surfaceGroup}
                        {...props.authoringControls}
                        value={main === null ? props.preview ?? props.workflowName ?? t('workflows.start.preview')
                            : rawTextValues[main.definition.name] ?? formatWorkflowInputValue(main.value)}
                        onChangeText={(text) => { if (main !== null) changeText(main.definition.name, text); }}
                        placeholder={main === null ? t('workflows.start.preview') : main.definition.description ?? props.inputPresentation?.[main.definition.name]?.placeholder ?? inputTitle(main.definition)}
                        inputAccessibilityLabel={main === null ? t('workflows.start.preview') : inputTitle(main.definition)}
                        inputAccessibilityHint={main?.blocking ? reason ?? undefined : undefined}
                        disabled={props.pending === true}
                        voiceAffordance="none"
                        autocompleteKinds={EMPTY_AUTOCOMPLETE_KINDS}
                        autocompleteSuggestions={EMPTY_AUTOCOMPLETE_SUGGESTIONS}
                        barControlIds={[...new Set([
                            ...chips.flatMap((chip) => chip.controlId ? [chip.controlId] : []),
                            ...(props.authoringControls ? ['machine' as const, 'path' as const] : []),
                        ])]}
                        extraActionChips={chips}
                        autoActionBarLayout="wrap"
                        collapseEmptyStatusRow
                    />
                </PluginContextualResourceStoreProvider>
            </View>
            <View testID={`${prefix}-footer`} style={styles.footer}>
                <View testID={`${prefix}-status`} style={styles.status}>
                    {props.notice ? <Text style={styles.secondary}>{props.notice}</Text> : null}
                    {props.reconciling ? <Text testID={`${prefix}-reconciling`} accessibilityLiveRegion="polite" style={styles.secondary}>{t('workflows.start.stillStarting')}</Text> : null}
                    {props.pending && !props.reconciling ? <Text testID={`${prefix}-starting`} accessibilityLiveRegion="polite" style={styles.secondary}>{t('workflows.start.starting')}</Text> : null}
                    {props.includesUnsavedEdits ? <Text testID={`${prefix}-unsaved`} style={styles.secondary}>{t('workflows.start.unsaved')}</Text> : null}
                    {visibility.shared ? <Text style={styles.secondary}>{t('workflows.start.visibility.machines')}</Text> : null}
                    {selectedTeam?.sessionCreationPolicy === 'team_required' ? <Text testID={`${prefix}-team-required`}
                        accessibilityLiveRegion="polite" style={styles.secondary}>{t('workflows.start.visibility.requiredSessionsEditable')}</Text> : null}
                    {visibility.status !== 'ready' ? <View style={styles.readiness}>
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
                        <Text testID={`${prefix}-reason-text`} style={readinessOnly ? blocked === null ? styles.secondary : styles.readinessText : styles.required}>{reason}</Text>
                    </View>}
                </View>
                {/* Start at the action size, with its key hint quietly beneath it (convo-N7). */}
                <View style={styles.start}>
                    <RoundButton testID={`${prefix}-run`} size="small"
                        title={startLabel}
                        accessibilityLabel={startLabel}
                        leading={<Icon name="play" size={ICON_SIZE.xs}
                            color={disabled ? theme.colors.text.tertiary : theme.colors.button.primary.tint} />}
                        disabled={disabled} loading={props.pending}
                        accessibilityHint={reason ?? visibilityHint} onPress={submit} />
                    {runShortcut ? <View testID={`${prefix}-shortcut`} style={styles.shortcut}
                        accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        <Text style={styles.keyHint}>{runShortcut}</Text>
                        <Text style={styles.secondary}>{t('workflows.start.shortcutStarts')}</Text>
                    </View> : null}
                </View>
            </View>
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

/** A declared source, enum or input type is chosen, never typed into the main composer. */
function isWorkflowChoiceInput(definition: WorkflowInputDefinition): boolean {
    return definition.optionsSourceId !== undefined || definition.enum !== undefined || definition.inputType !== undefined;
}

/** A choice, several choices, or a value a custom picker returned (already validated by its host). */
function readWorkflowSelection(value: unknown): JsonValue | undefined {
    if (!Array.isArray(value)) return readActionInputOptionValue(value);
    return value.flatMap((item) => {
        const option = readActionInputOptionValue(item);
        return option === undefined ? [] : [option];
    });
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
    /** Catalog-facing copy; input names and option values remain the authored contract. */
    presentation?: WorkflowRunInputPresentation;
}>) {
    const { theme } = useUnistyles();
    const selectTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const requests = props.fields.map(({ definition }) => ({
        field: workflowInputToFieldHint(definition, props.presentation?.[definition.name]),
        draftInput: props.values,
        ...(props.optionsConsumer ? { consumer: props.optionsConsumer } : {}),
    }));
    const { resolveOptions, state: optionsState, retry, snapshot } = useInputFieldOptions({
        requests,
        machineId: props.machineId, serverId: props.serverId,
        enabled: props.fields.some((field) => field.definition.optionsSourceId !== undefined || field.definition.inputType !== undefined),
    });
    return <InputTypePickerHostProvider enabled={props.fields.some((field) => field.definition.inputType !== undefined)}
        {...resolveOptions.pickerContext}
        contextKey={JSON.stringify([props.optionsConsumer, props.values, snapshot])}>
        <View style={styles.fields}>{props.fields.map((field) => {
        const definition = field.definition;
        const presentation = props.presentation?.[definition.name];
        const title = presentation?.title ?? definition.name;
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
                <HappierInputField<ActionInputOptionValue> frame="none" field={hint} value={field.value}
                    selection={selected} options={options} optionsStatus={optionState.status}
                    optionsNotice={<SurfaceStateCard kind="error" size="line" title={t('common.error')}
                        diagnosticCode={optionState.errorCode} action={{ label: t('common.retry'), onPress: retry }} />}
                    isEqual={isSameActionInputOptionValue} keyForOption={(option) => actionInputOptionValueKey(option.value)}
                    theme={selectTheme} disabled={props.pending} testID={id}
                    onChange={(value) => props.onChangeValue(definition.name, readWorkflowSelection(value))} />
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
    })}</View></InputTypePickerHostProvider>;
}

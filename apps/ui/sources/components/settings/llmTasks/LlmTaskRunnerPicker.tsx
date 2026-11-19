import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { formatProviderReasoningEffortLevelLabel, PROVIDER_REASONING_EFFORT_OPTION_ID, ProviderReasoningEffortLevelV1Schema } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import {
    isLlmTaskRunnerAutoV1,
    type LlmTaskPermissionMode,
    type LlmTaskRunnerChoiceV1,
} from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import {
    LLM_TASK_DECLARATIONS_V1,
    readLlmTaskPermissionModeV1,
    supportsLlmTaskRunnerPermissionV1,
    type LlmTaskIdV1,
    type LlmTaskRunnerResolutionWireV1,
} from '@happier-dev/protocol/llm/tasks/llmTaskRunnerSelection';
import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { SessionAuthoringControls } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import { findSessionAuthoringAgentTargetOption, type SessionAuthoringControlFacts, type SessionAuthoringFieldId } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { useSessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/useSessionAuthoringControlFacts';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { projectLlmTaskRunnerAuthoringSelection, readLlmTaskRunnerFromAuthoringSelection } from './llmTaskRunnerAuthoringSelection';
import { useLlmTaskRunnerAutoResolution, type LlmTaskRunnerAutoResolutionState } from './useLlmTaskRunnerAutoResolution';

export const LLM_TASK_RUNNER_AUTO_OPTION_ID = 'llm-task-runner:auto';

export type LlmTaskRunnerPickerProps = Readonly<{
    task: LlmTaskIdV1;
    /** The stored choice; `{ mode: 'auto' }` is Auto, and so is null unless `unsetMeansAuto` is false. */
    value: LlmTaskRunnerChoiceV1 | null | undefined;
    /** False where an unset choice means the task does not run (replay summaries): unset is shown as not chosen. */
    unsetMeansAuto?: boolean;
    /** The Session the task runs for: Auto stays on its own Agent. Absent outside a Session (the default Agent). */
    sessionAgentTargetKey?: string | null;
    /** `fields` (default) for Settings rows; `chips` for a quiet choice beside the action it affects. */
    presentation?: 'fields' | 'chips';
    onChange: (next: LlmTaskRunnerChoiceV1) => void;
    /** The Machine the task runs on: Agents, models and Auto come from it. */
    machineId: string | null;
    serverId: string | null;
    /** The engine row's title; null when the host section already names it. */
    engineFieldTitle?: string | null;
    permissionTitle?: string;
    disabled?: boolean;
    testIDPrefix?: string;
    /** Whether the task has something to run on: an explicit choice, or Auto with a ready pick. */
    onAvailabilityChange?: (available: boolean) => void;
}>;

/**
 * The one picker for a background task's runner: the composer's engine chips (Agent, model, effort,
 * connected service) led by Auto, plus the task's permission level when it allows more than one.
 */
export function LlmTaskRunnerPicker(props: LlmTaskRunnerPickerProps): React.ReactElement {
    const facts = useSessionAuthoringControlFacts({ machineId: props.machineId, serverId: props.serverId });
    return <LlmTaskRunnerControls {...props} facts={facts} />;
}

const AUTO_FIELDS: readonly SessionAuthoringFieldId[] = ['agentTarget'];
const EXPLICIT_FIELDS: readonly SessionAuthoringFieldId[] = ['agentTarget', 'connectedServices'];

function formatRunner(resolution: LlmTaskRunnerResolutionWireV1 | null | undefined, facts: SessionAuthoringControlFacts): string | null {
    if (!resolution?.ok) return null;
    const agentTargetKey = resolution.runner.modelSelection.agentTargetKey;
    const agent = facts.agentTargets?.find(option => buildBackendTargetKeyV2(option.target) === agentTargetKey)?.label;
    const effort = resolution.runner.sessionConfigOptionOverrides?.overrides[PROVIDER_REASONING_EFFORT_OPTION_ID]?.value;
    const effortLabel = typeof effort === 'string' ? formatEffort(effort) : null;
    return [agent, resolution.title ?? resolution.runner.modelSelection.modelId, effortLabel].filter(Boolean).join(' · ');
}

function formatEffort(value: string): string {
    const level = ProviderReasoningEffortLevelV1Schema.safeParse(value);
    return level.success ? formatProviderReasoningEffortLevelLabel(level.data) : value;
}

function readSettled(state: LlmTaskRunnerAutoResolutionState): LlmTaskRunnerResolutionWireV1 | null {
    return state.status === 'ready' ? state.resolution : state.status === 'idle' ? null : state.last;
}

/** Facts-injected body of {@link LlmTaskRunnerPicker}. */
export function LlmTaskRunnerControls(props: LlmTaskRunnerPickerProps & Readonly<{ facts: SessionAuthoringControlFacts }>): React.ReactElement {
    const { task, facts, onChange } = props;
    const declaration = LLM_TASK_DECLARATIONS_V1[task];
    const unset = props.unsetMeansAuto === false && props.value == null;
    const auto = !unset && isLlmTaskRunnerAutoV1(props.value);
    const permissionMode = readLlmTaskPermissionModeV1(task, props.value?.permissionMode);
    const eligibleFacts = React.useMemo(() => ({
        ...facts,
        agentTargets: facts.agentTargets?.filter(option => supportsLlmTaskRunnerPermissionV1(permissionMode, option.noTools)),
    }), [facts, permissionMode]);
    const values = React.useMemo(() => projectLlmTaskRunnerAuthoringSelection(props.value, facts), [props.value, facts]);
    const sessionAgentTargetKey = props.sessionAgentTargetKey ?? null;
    const resolutionState = useLlmTaskRunnerAutoResolution({ task, machineId: props.machineId, serverId: props.serverId,
        permissionMode, sessionAgentTargetKey, enabled: auto });
    const settled = readSettled(resolutionState);
    const currentRunner = formatRunner(settled, facts);
    const autoLabel = currentRunner ? t('llmTaskRunner.autoCurrently', { runner: currentRunner })
        : settled?.ok === false ? t('llmTaskRunner.autoNothingReady') : t('llmTaskRunner.auto');

    const onAvailabilityChange = props.onAvailabilityChange;
    // Unknown while Auto is first being read: the host keeps what it last knew rather than flashing a notice.
    const available = !auto || settled?.ok === true ? true
        : settled?.ok === false || (resolutionState.status === 'idle' && props.machineId === null) ? false : null;
    React.useEffect(() => { if (available !== null) onAvailabilityChange?.(available); }, [onAvailabilityChange, available]);

    const latest = React.useRef({ onChange, permissionMode, values, auto, facts });
    latest.current = { onChange, permissionMode, values, auto, facts };
    const chooseAuto = React.useCallback(() => {
        latest.current.onChange({ v: 1, mode: 'auto', permissionMode: latest.current.permissionMode });
    }, []);
    const machineId = props.machineId;
    const autoOption = React.useMemo<AgentInputChipPickerOption>(() => ({
        id: LLM_TASK_RUNNER_AUTO_OPTION_ID,
        label: t('llmTaskRunner.auto'),
        ...(currentRunner ? { subtitle: currentRunner } : {}),
        icon: <AutoIcon />,
        closeOnSelectImmediate: false,
        onSelectImmediate: chooseAuto,
        renderDetailContent: () => <LlmTaskRunnerAutoDetail machineId={machineId} state={resolutionState} runner={currentRunner}
            facts={facts} sessionAgentTargetKey={sessionAgentTargetKey} />,
    }), [chooseAuto, currentRunner, machineId, resolutionState, facts, sessionAgentTargetKey]);
    const engineLeadingOption = React.useMemo(() => ({ option: autoOption, selected: auto, valueLabel: autoLabel }),
        [autoOption, auto, autoLabel]);

    const writeExplicit = React.useCallback((fields: Partial<WorkflowSessionAuthoringSelection>) => {
        const current = latest.current;
        // Auto has no engine; a change of Agent or model starts an explicit runner.
        const runner = readLlmTaskRunnerFromAuthoringSelection({ ...current.values, ...fields }, current.permissionMode);
        if (runner) current.onChange(runner);
    }, []);
    const onChangeField = React.useCallback((field: SessionAuthoringFieldId, value: WorkflowSessionAuthoringSelection[SessionAuthoringFieldId]) => {
        writeExplicit({ [field]: value });
    }, [writeExplicit]);

    const permissionOptions = React.useMemo(() => declaration.permissionModes.map(mode => ({
        id: mode, label: t(`llmTaskRunner.permission.${mode}`), description: t(`llmTaskRunner.permissionDescription.${mode}`),
    })), [declaration]);
    const testIDPrefix = props.testIDPrefix ?? `llm-task-runner-${task}`;

    return (
        <>
            <SessionAuthoringControls
                presentation={props.presentation ?? 'fields'}
                fields={auto || unset ? AUTO_FIELDS : EXPLICIT_FIELDS}
                values={values}
                facts={eligibleFacts}
                {...(props.engineFieldTitle !== undefined ? { engineFieldTitle: props.engineFieldTitle } : {})}
                engineLeadingOption={engineLeadingOption}
                onChangeFields={writeExplicit}
                onChangeField={onChangeField}
                {...(props.disabled ? { disabled: true } : {})}
                testIDPrefix={testIDPrefix}
            />
            {permissionOptions.length > 1 && !unset ? (
                <SegmentedChoiceItem<LlmTaskPermissionMode>
                    title={props.permissionTitle ?? t('llmTaskRunner.permissionTitle')}
                    options={permissionOptions}
                    value={permissionMode}
                    disabled={props.disabled}
                    onChange={(mode) => {
                        const current = latest.current;
                        const selected = findSessionAuthoringAgentTargetOption(current.facts.agentTargets, current.values.agentTarget);
                        if (current.auto || !supportsLlmTaskRunnerPermissionV1(mode, selected?.noTools)) {
                            current.onChange({ v: 1, mode: 'auto', permissionMode: mode });
                            return;
                        }
                        const runner = readLlmTaskRunnerFromAuthoringSelection(current.values, mode);
                        if (runner) current.onChange(runner);
                    }}
                    testIDPrefix={`${testIDPrefix}-permission`}
                />
            ) : null}
        </>
    );
}

function AutoIcon() {
    const { theme } = useUnistyles();
    return <Icon name="sparkle" size={14} color={theme.colors.text.secondary} />;
}

/** What Auto means and what it picks on this Machine right now. */
function LlmTaskRunnerAutoDetail(props: Readonly<{
    machineId: string | null;
    state: LlmTaskRunnerAutoResolutionState;
    runner: string | null;
    facts: SessionAuthoringControlFacts;
    sessionAgentTargetKey: string | null;
}>) {
    const settled = readSettled(props.state);
    const status = props.machineId === null ? t('llmTaskRunner.chooseMachine')
        : props.runner ? t('llmTaskRunner.currently', { runner: props.runner })
        : settled?.ok === false ? t(settled.reason === 'no_ready_agent' ? 'llmTaskRunner.noReadyAgent' : 'llmTaskRunner.noMatchingModel')
        : props.state.status === 'failed' ? t('llmTaskRunner.unavailable')
        : t('llmTaskRunner.checking');
    return (
        <View style={styles.detail} testID="llm-task-runner-auto-detail">
            <Text style={styles.description}>
                {t('llmTaskRunner.autoDescription')}
            </Text>
            <Text style={styles.status} accessibilityLiveRegion="polite" testID="llm-task-runner-auto-status">{status}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    detail: { gap: theme.space.s8, padding: theme.space.s12 },
    description: { ...Typography.variant('body'), color: theme.colors.text.secondary },
    status: { ...Typography.variant('body', 'medium'), color: theme.colors.text.primary },
}));

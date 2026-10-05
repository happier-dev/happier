import * as React from 'react';
import { Pressable, View } from 'react-native';
import type { JsonValue, RoleOverrideV1 } from '@happier-dev/protocol';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { createExecutionRunStartContentChip } from '@/components/sessions/runs/launcher/executionRunStartChips';
import { WorkflowStartPicker, type WorkflowStartSelection } from '@/components/workflows/run/WorkflowStartPicker';
import { WorkflowRunComposer, type WorkflowRunComposerProps } from '@/components/workflows/run/WorkflowRunComposer';
import { useWorkflowRunNowController } from '@/components/workflows/run/useWorkflowRunNowController';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { Icon } from '@/components/ui/icons/Icon';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { NewSessionSimplePanelProps } from '../components/NewSessionSimplePanel';

/** New's workflow selection lives at its composer leaf, alongside the existing prompt store. */
export function useNewSessionWorkflowStart(params: Readonly<{ panelProps: NewSessionSimplePanelProps; prompt: string; surfaceGroup?: WorkflowRunComposerProps['surfaceGroup'] }>) {
    const { panelProps: props, prompt } = params;
    const router = useRouter();
    const runNow = useWorkflowRunNowController();
    const scope = useActiveServerAccountScope();
    const workflowDecision = useFeatureDecision('workflows', props.targetServerId
        ? { scopeKind: 'spawn', serverId: props.targetServerId } : { scopeKind: 'runtime' });
    const targetIsCurrent = scope !== null && (!props.targetServerId
        || areServerProfileIdentifiersEquivalent(scope.serverId, props.targetServerId));
    const [selected, setSelection] = React.useState<Readonly<{
        value: WorkflowStartSelection;
        lifetime: ReturnType<typeof captureActiveServerAccountScopeLifetime>;
    }> | null>(null);
    const selection = selected !== null && (selected.lifetime !== null ? selected.lifetime.isCurrent()
        : selected.value.source.kind === 'catalog' && scope === null) ? selected.value : null;
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    const [values, setValues] = React.useState<WorkflowRunComposerProps['values']>({});
    const [rawTextValues, setRawTextValues] = React.useState<Readonly<Record<string, string>>>({});
    const pendingRunId = React.useRef<string | null>(null);
    const select = React.useCallback((next: WorkflowStartSelection) => {
        setSelection({ value: next, lifetime: captureActiveServerAccountScopeLifetime() });
        setValues({}); setRawTextValues({}); pendingRunId.current = null;
    }, []);
    const remove = React.useCallback(() => {
        setSelection(null); setValues({}); setRawTextValues({}); pendingRunId.current = null;
    }, []);
    const chip = React.useMemo<AgentInputExtraActionChip>(() => {
        const base = createExecutionRunStartContentChip({
            key: 'workflow-start-definition', icon: 'git-branch', label: selection?.name ?? t('workflows.start.workflow'),
            title: t('workflows.start.workflow'), testID: 'new-session-workflow-chip',
            renderContent: ({ requestClose, maxHeight }) => <WorkflowStartPicker onSelect={select} onRequestClose={requestClose} maxHeight={maxHeight} />,
        });
        return { ...base, controlId: 'workflow', collapsedContentPopover: { ...base.collapsedContentPopover!, scrollEnabled: false },
            render: (context) => <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {base.render(context)}
                {selection ? <Pressable testID="new-session-workflow-remove" accessibilityRole="button"
                    accessibilityLabel={t('workflows.start.remove')} onPress={remove} hitSlop={8}>
                    <Icon name="x" size={14} color={context.iconColor} />
                </Pressable> : null}
            </View> };
    }, [remove, select, selection]);
    const main = selection?.definition.inputs.find((input) => input.valueType === 'string');
    const changeRawTextValues = React.useCallback((next: Readonly<Record<string, string>>) => {
        if (main && next[main.name] !== undefined) props.setSessionPrompt(next[main.name]);
        setRawTextValues(next);
    }, [main, props.setSessionPrompt]);
    const submit = React.useCallback(async (inputs: Readonly<Record<string, JsonValue>> | undefined, roleOverrides?: readonly RoleOverrideV1[]) => {
        if (!selection || !props.selectedMachineId || !props.selectedPath) return;
        if (workflowDecision?.state !== 'enabled' || !targetIsCurrent) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        const runId = pendingRunId.current ?? randomUUID();
        pendingRunId.current = runId;
        const admitted = await runNow.runNow({
            runId, source: selection.source, metadata: { title: selection.name, description: selection.description },
            ...(inputs === undefined ? {} : { inputs: { ...inputs } }),
            ...(roleOverrides === undefined ? {} : { roleOverrides: [...roleOverrides] }),
            project: { machineId: props.selectedMachineId, directory: props.selectedPath },
            isInvocationCurrent: () => lifetime.isCurrent() && selectionRef.current === selection,
        });
        if (!admitted || !lifetime.isCurrent() || selectionRef.current !== selection) return;
        pendingRunId.current = null;
        router.push({ pathname: '/workflows/runs/[runId]', params: { runId: admitted.run.id } } as never);
    }, [props.selectedMachineId, props.selectedPath, router, runNow, selection, targetIsCurrent, workflowDecision?.state]);
    const composer = selection === null ? null : <WorkflowRunComposer key={selection.id}
        surfaceGroup={params.surfaceGroup}
        definition={selection.definition} sourceArtifactId={selection.source.kind === 'saved' ? selection.source.definitionId : null}
        inputs={selection.definition.inputs} values={main ? { ...values, [main.name]: prompt } : values}
        optionsConsumer={selection.source.kind === 'saved' ? { kind: 'workflow', workflow: selection.source.definitionId }
            : selection.source.kind === 'catalog' ? { kind: 'workflow', workflow: selection.source.workflow } : undefined}
        onChangeValues={setValues} rawTextValues={main ? { ...rawTextValues, [main.name]: prompt } : rawTextValues}
        onChangeRawTextValues={changeRawTextValues} workflowName={selection.name} preview={selection.description}
        workflowChip={chip} retainedText={main ? undefined : prompt} machineId={props.selectedMachineId}
        serverId={props.targetServerId} onRun={(inputs, roleOverrides) => { void submit(inputs, roleOverrides); }} onCancel={remove}
        startDisabled={!props.selectedMachineId || !props.selectedPath || props.isCreating
            || !targetIsCurrent || workflowDecision?.state !== 'enabled'}
        pending={runNow.stateFor(pendingRunId.current ?? '') === 'submitting'}
        authoringControls={{ machineName: props.machineName, machinePopover: props.machinePopover,
            currentPath: props.selectedPath, folderChipState: props.folderChipState,
            onRemoveFolder: props.onRemoveFolder, pathPopover: props.pathPopover }}
        extraActionChips={props.agentInputExtraActionChips} />;
    return { chip, composer };
}

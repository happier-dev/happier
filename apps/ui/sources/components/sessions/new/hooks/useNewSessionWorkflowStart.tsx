import * as React from 'react';
import { Pressable, View } from 'react-native';
import type { JsonValue, RoleOverrideV1 } from '@happier-dev/protocol';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { createWorkflowRunActionChip } from '@/components/sessions/agentInput/sessionActions/createWorkflowRunActionChip';
import { WorkflowStartPicker, type WorkflowStartSelection } from '@/components/workflows/run/WorkflowStartPicker';
import { WorkflowRunComposer, type WorkflowRunComposerProps } from '@/components/workflows/run/WorkflowRunComposer';
import { findWorkflowMainInput } from '@/components/workflows/presentation/workflowBuiltinInputPresentation';
import { useWorkflowRunNowController } from '@/components/workflows/run/useWorkflowRunNowController';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { Icon } from '@/components/ui/icons/Icon';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { createWorkflowStartWhereChip } from '@/components/workflows/run/workflowStartWhereChip';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { NewSessionSimplePanelProps } from '../components/NewSessionSimplePanel';

/** New's workflow selection lives at its composer leaf, alongside the existing prompt store. */
export function useNewSessionWorkflowStart(params: Readonly<{ panelProps: NewSessionSimplePanelProps; prompt: string; surfaceGroup?: WorkflowRunComposerProps['surfaceGroup'] }>) {
    const { panelProps: props, prompt } = params;
    const router = useRouter();
    const runNow = useWorkflowRunNowController();
    const { clearRefusal } = runNow;
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
    // While this selection's start is unsettled, the review is the request it already sent: its inputs,
    // Roles, Team and Where. A deliberate new selection resets the id, so it never shows another's request.
    // (A first press still in flight keeps the page's controls in place: only an unknown outcome swaps them.)
    const retained = runNow.retainedRequest?.unresolved === true && runNow.retainedRequest.input.runId === pendingRunId.current
        ? runNow.retainedRequest : null;
    const retainedMachine = useMachinePresenceSummary(scope?.serverId, retained?.project?.machineId);
    const select = React.useCallback((next: WorkflowStartSelection) => {
        setSelection({ value: next, lifetime: captureActiveServerAccountScopeLifetime() });
        setValues({}); setRawTextValues({}); pendingRunId.current = null; clearRefusal();
    }, [clearRefusal]);
    const remove = React.useCallback(() => {
        setSelection(null); setValues({}); setRawTextValues({}); pendingRunId.current = null; clearRefusal();
    }, [clearRefusal]);
    const chip = React.useMemo<AgentInputExtraActionChip>(() => {
        const base = createWorkflowRunActionChip({
            label: selection?.name ?? t('workflows.start.workflow'),
            title: t('workflows.start.workflow'), testID: 'new-session-workflow-chip',
            renderContent: ({ requestClose, maxHeight }) => <WorkflowStartPicker onSelect={select} onRequestClose={requestClose} maxHeight={maxHeight} />,
        });
        return { ...base,
            render: (context) => <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {base.render(context)}
                {selection ? <Pressable testID="new-session-workflow-remove" accessibilityRole="button"
                    accessibilityLabel={t('workflows.start.remove')} onPress={remove} hitSlop={8}>
                    <Icon name="x" size={14} color={context.iconColor} />
                </Pressable> : null}
            </View> };
    }, [remove, select, selection]);
    const main = selection ? findWorkflowMainInput(selection.definition.inputs) : undefined;
    const changeRawTextValues = React.useCallback((next: Readonly<Record<string, string>>) => {
        if (main && next[main.name] !== undefined) props.setSessionPrompt(next[main.name]);
        setRawTextValues(next);
    }, [main, props.setSessionPrompt]);
    const submit = React.useCallback(async (inputs: Readonly<Record<string, JsonValue>> | undefined, roleOverrides?: readonly RoleOverrideV1[]) => {
        if (!selection || workflowDecision?.state !== 'enabled' || !targetIsCurrent) return;
        // Try again re-sends the retained request; today's machine and folder belong to the next start.
        const project = props.selectedMachineId && props.selectedPath
            ? { machineId: props.selectedMachineId, directory: props.selectedPath } : null;
        if (retained === null && project === null) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        const runId = pendingRunId.current ?? randomUUID();
        pendingRunId.current = runId;
        const admitted = await runNow.runNow({
            runId,
            ...(retained !== null ? { ...retained.input, ...(retained.project === undefined ? {} : { project: retained.project }) } : {
                source: selection.source, metadata: { title: selection.name, description: selection.description },
                ...(inputs === undefined ? {} : { inputs: { ...inputs } }),
                ...(roleOverrides === undefined ? {} : { roleOverrides: [...roleOverrides] }),
                ...(project === null ? {} : { project }),
            }),
            isInvocationCurrent: () => lifetime.isCurrent() && selectionRef.current === selection,
            // New keeps its start form in place and says why beside Start (lab T4-ST).
            refusal: 'inline',
        });
        if (!admitted || !lifetime.isCurrent() || selectionRef.current !== selection) return;
        pendingRunId.current = null;
        router.push(createWorkflowRunRoute(admitted.run.id, lifetime.scope.serverId) as never);
    }, [props.selectedMachineId, props.selectedPath, retained, router, runNow, selection, targetIsCurrent, workflowDecision?.state]);
    const retainedWhere = React.useMemo(() => retained?.project === undefined ? null : [createWorkflowStartWhereChip({
        target: retained.project, machineName: retainedMachine.name ?? retained.project.machineId,
        machineHomeDir: retainedMachine.homeDir,
        testID: 'new-session-workflow-where-chip', testIDPrefix: 'new-session-workflow-where',
    })], [retained, retainedMachine.name, retainedMachine.homeDir]);
    const composer = selection === null ? null : <WorkflowRunComposer key={selection.id}
        surfaceGroup={params.surfaceGroup}
        definition={selection.definition} sourceArtifactId={selection.source.kind === 'saved' ? selection.source.definitionId : null}
        inputs={selection.definition.inputs} values={main ? { ...values, [main.name]: prompt } : values}
        optionsConsumer={selection.source.kind === 'saved' ? { kind: 'workflow', workflow: selection.source.definitionId }
            : selection.source.kind === 'catalog' ? { kind: 'workflow', workflow: selection.source.workflow } : undefined}
        onChangeValues={setValues} rawTextValues={main ? { ...rawTextValues, [main.name]: prompt } : rawTextValues}
        onChangeRawTextValues={changeRawTextValues} workflowName={selection.name} preview={selection.description}
        workflowChip={chip} retainedText={main ? undefined : prompt}
        machineId={retained ? retained.project?.machineId ?? null : props.selectedMachineId}
        directory={retained ? retained.project?.directory ?? null : props.selectedPath}
        retainedRequest={retained}
        serverId={props.targetServerId} onRun={(inputs, roleOverrides) => { void submit(inputs, roleOverrides); }} onCancel={remove}
        startDisabled={!props.selectedMachineId || !props.selectedPath || props.isCreating
            || !targetIsCurrent || workflowDecision?.state !== 'enabled'}
        pending={runNow.isPending(pendingRunId.current ?? '')}
        reconciling={runNow.stateFor(pendingRunId.current ?? '') === 'reconciling'}
        startProblem={runNow.refusal}
        // The page's machine, folder and Agent controls describe the next start, so the review of a
        // request already sent shows its own Where instead of them.
        authoringControls={retained ? undefined : { machineName: props.machineName, machinePopover: props.machinePopover,
            currentPath: props.selectedPath, folderChipState: props.folderChipState,
            onRemoveFolder: props.onRemoveFolder, pathPopover: props.pathPopover }}
        extraActionChips={retained ? retainedWhere ?? undefined : props.agentInputExtraActionChips} />;
    return { chip, composer };
}

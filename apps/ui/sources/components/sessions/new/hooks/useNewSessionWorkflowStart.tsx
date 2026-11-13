import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { View } from 'react-native';
import type { JsonValue} from '@happier-dev/protocol/json/strictJsonValue';
import type { RoleOverrideV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import type { SessionManagedCreationV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
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
import { createWorkflowStartPlacementChips } from '@/components/workflows/run/workflowStartPlacementChips';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { NewSessionSimplePanelProps } from '../components/NewSessionSimplePanel';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { managedMachineCreationIntent, type ManagedMachineAcquisitionDraft, type ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import type { ManagedMachineCreationProgress } from '@/components/settings/machines/managed/managedMachineCreation';
import { runNewManagedWorkflowCreation, type AcceptedManagedWorkflowCreation } from '../modules/newManagedWorkflowCreation';
import type { NewSessionManagedMachineDraftModel } from './newSessionScreenModelTypes';
import { buildNewSessionManagedProgressBadge } from './screenModel/newSessionManagedProgressBadge';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useComposerTextSource, useComposerTextValue, type ComposerTextSource } from '@/components/sessions/agentInput/composerTextStore';

type ManagedWorkflowAttempt = {
    workflow: WorkflowStartSelection;
    draft: ManagedMachineSelectionDraft;
    acquisition: ManagedMachineAcquisitionDraft;
    accepted?: AcceptedManagedWorkflowCreation;
};

/**
 * Renders the workflow composer with the live prompt. Only this leaf follows the text, so a keystroke
 * re-renders the selected workflow's composer and not the New composer card around it.
 */
function WorkflowPromptLeaf(props: Readonly<{ source: ComposerTextSource; render: (prompt: string) => React.ReactElement }>) {
    return props.render(useComposerTextValue(props.source));
}

/** New's workflow selection lives at its composer leaf, alongside the existing prompt store. */
export function useNewSessionWorkflowStart(params: Readonly<{
    panelProps: NewSessionSimplePanelProps; prompt: string | ComposerTextSource; surfaceGroup?: WorkflowRunComposerProps['surfaceGroup'];
    /** The card's own composer facts (its status line, side inset and width) that the workflow composer keeps. */
    host?: Pick<WorkflowRunComposerProps, 'connectionStatus' | 'contentPaddingHorizontal' | 'maxWidthCap'>;
}>) {
    const { panelProps: props } = params;
    const promptSource = useComposerTextSource(params.prompt);
    const router = useRouter();
    const runNow = useWorkflowRunNowController();
    const { clearRefusal } = runNow;
    const scope = useActiveServerAccountScope();
    const mounted = useMountedRef();
    const latestProps = React.useRef(props);
    latestProps.current = props;
    const managedAttempt = React.useRef<ManagedWorkflowAttempt | null>(null);
    const managedAbort = React.useRef<AbortController | null>(null);
    const [managedBusy, setManagedBusy] = React.useState(false);
    const [managedState, setManagedState] = React.useState<Readonly<{ attempt: ManagedWorkflowAttempt; progress: ManagedMachineCreationProgress }> | null>(null);
    const managedApproval = useActionApprovalContinuation({ scopeKey: `new-workflow:${scope ? serverAccountScopeKeySuffix(scope) : 'unbound'}`,
        serverId: scope?.serverId ?? '', onExecuted: () => {} });
    React.useEffect(() => () => managedAbort.current?.abort(), []);
    const retireManagedAttempt = React.useCallback(() => {
        managedAbort.current?.abort();
        managedAbort.current = null;
        managedAttempt.current = null;
        setManagedState(null);
        setManagedBusy(false);
    }, []);
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
        retireManagedAttempt();
        setSelection({ value: next, lifetime: captureActiveServerAccountScopeLifetime() });
        setValues({}); setRawTextValues({}); pendingRunId.current = null; clearRefusal();
    }, [clearRefusal, retireManagedAttempt]);
    const remove = React.useCallback(() => {
        retireManagedAttempt();
        setSelection(null); setValues({}); setRawTextValues({}); pendingRunId.current = null; clearRefusal();
    }, [clearRefusal, retireManagedAttempt]);
    useCurrentUiContextLocalCommands(selection ? [{ key: 'remove', title: t('workflows.start.remove'),
        description: 'new-session.workflow.remove', invoke: remove }] : [], { contextKey: 'new-session.workflow' });
    const chip = React.useMemo<AgentInputExtraActionChip>(() => {
        const base = createWorkflowRunActionChip({
            label: selection?.name ?? t('workflows.start.workflow'),
            pending: selection !== null,
            currentUiContextCommandScope: 'new-session.workflow',
            title: t('workflows.start.workflow'), testID: 'new-session-workflow-chip',
            renderContent: ({ requestClose, maxHeight }) => <WorkflowStartPicker onSelect={select} onRequestClose={requestClose} maxHeight={maxHeight}
                currentUiContextCommandScope="new-session.workflow" />,
        });
        return { ...base,
            render: (context) => <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {base.render(context)}
                {selection ? <HappierPressable testID="new-session-workflow-remove" accessibilityRole="button"
                    accessibilityLabel={t('workflows.start.remove')} onPress={remove}>
                    <Icon name="x" size={14} color={context.iconColor} />
                </HappierPressable> : null}
            </View> };
    }, [remove, select, selection]);
    const main = selection ? findWorkflowMainInput(selection.definition.inputs) : undefined;
    const changeRawTextValues = React.useCallback((next: Readonly<Record<string, string>>) => {
        if (main && next[main.name] !== undefined) props.setSessionPrompt(next[main.name]);
        setRawTextValues(next);
    }, [main, props.setSessionPrompt]);
    const submittedValues = React.useRef<Readonly<{ inputs: Readonly<Record<string, JsonValue>> | undefined; roleOverrides?: readonly RoleOverrideV1[] }> | null>(null);
    const submit = React.useCallback(async (inputs: Readonly<Record<string, JsonValue>> | undefined, roleOverrides?: readonly RoleOverrideV1[],
        recovery?: Readonly<{ retryInstallation?: boolean; setupRecovery?: 'retry' | 'skip' }>) => {
        if (!selection || workflowDecision?.state !== 'enabled' || !targetIsCurrent || managedAbort.current) return;
        const managed = props.managedMachineDraft;
        const draft = managed?.selection;
        // Try again re-sends the retained request; today's machine and folder belong to the next start.
        const project = props.selectedMachineId && props.selectedPath
            ? { machineId: props.selectedMachineId, directory: props.selectedPath } : null;
        if (retained === null && project === null && !draft) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        const runId = pendingRunId.current ?? randomUUID();
        pendingRunId.current = runId;
        submittedValues.current = { inputs, roleOverrides };
        const startRun = (target: typeof project, managedCreation?: SessionManagedCreationV1) => runNow.runNow({
            runId,
            ...(retained !== null ? { ...retained.input, ...(retained.project === undefined ? {} : { project: retained.project }) } : {
                source: selection.source, metadata: { title: selection.name, description: selection.description },
                ...(managedCreation === undefined ? {} : { managedCreation }),
                ...(inputs === undefined ? {} : { inputs: { ...inputs } }),
                ...(roleOverrides === undefined ? {} : { roleOverrides: [...roleOverrides] }),
                ...(target === null ? {} : { project: target }),
            }),
            isInvocationCurrent: () => lifetime.isCurrent() && selectionRef.current === selection,
            // New keeps its start form in place and says why beside Start (lab T4-ST).
            refusal: 'inline',
        });
        let admitted: Awaited<ReturnType<typeof runNow.runNow>>;
        if (draft && managed) {
            if (!managed.onAcquisitionChange) return;
            let attempt = managedAttempt.current;
            if (!attempt || attempt.workflow !== selection
                || !sameStrictJsonValue(managedMachineCreationIntent(attempt.draft), managedMachineCreationIntent(draft))) {
                attempt = { workflow: selection, draft, acquisition: managed.acquisition ?? { requestId: runId, selection: draft.selection } };
                managedAttempt.current = attempt;
            }
            const activeAttempt = attempt;
            const cancellation = new AbortController();
            managedAbort.current = cancellation;
            const retirement = lifetime.onRetire(() => cancellation.abort());
            const isCurrent = () => mounted.current && lifetime.isCurrent() && !cancellation.signal.aborted
                && selectionRef.current === selection && managedAttempt.current === activeAttempt
                && sameStrictJsonValue(managedMachineCreationIntent(latestProps.current.managedMachineDraft?.selection), managedMachineCreationIntent(draft));
            const progress = (value: ManagedMachineCreationProgress) => {
                if (isCurrent()) setManagedState({ attempt: activeAttempt, progress: value });
            };
            setManagedBusy(true);
            try {
                // Persist paid-resource correlation before its explicit acquire can be admitted.
                managed.onAcquisitionChange(activeAttempt.acquisition);
                const result = await runNewManagedWorkflowCreation({ draft, acquisition: activeAttempt.acquisition,
                    accepted: activeAttempt.accepted, scope: lifetime.scope, signal: cancellation.signal, isCurrent,
                    readScopeDraft: () => latestProps.current.managedMachineDraft?.selection ?? null,
                    onAcquisitionChange: value => {
                        activeAttempt.acquisition = value;
                        if (isCurrent()) managed.onAcquisitionChange?.(value);
                    }, onProgress: progress, onApprovalPending: managedApproval.requestApproval,
                    ...recovery,
                    startRun: (machineId, managedCreation) => startRun({ machineId, directory: props.selectedPath || '~' }, managedCreation),
                    onAccepted: value => { activeAttempt.accepted = value; },
                });
                if (!isCurrent() || result.kind !== 'accepted') return;
                if (result.binding.kind === 'incomplete') {
                    progress({ kind: 'failed', managedId: result.accepted.machine.id, code: result.binding.code });
                    return;
                }
                admitted = result.accepted.run;
            } catch (error) {
                progress({ kind: 'failed', code: error instanceof Error && 'code' in error && typeof error.code === 'string'
                    ? error.code : 'managed_creation_failed' });
                return;
            } finally {
                retirement.dispose();
                if (managedAbort.current === cancellation) {
                    managedAbort.current = null;
                    if (mounted.current) setManagedBusy(false);
                }
            }
        } else {
            admitted = await startRun(project);
        }
        if (!admitted || !lifetime.isCurrent() || selectionRef.current !== selection) return;
        pendingRunId.current = null;
        router.push(createWorkflowRunRoute(admitted.run.id, lifetime.scope.serverId) as never);
    }, [props.managedMachineDraft, props.selectedMachineId, props.selectedPath, retained, router, runNow, selection,
        targetIsCurrent, workflowDecision?.state, managedApproval.requestApproval, mounted]);
    const managedProgress = React.useMemo(() => managedState?.attempt === managedAttempt.current
        && sameStrictJsonValue(managedMachineCreationIntent(managedState?.attempt.draft), managedMachineCreationIntent(props.managedMachineDraft?.selection))
        ? managedState?.progress : undefined, [managedState, props.managedMachineDraft?.selection]);
    const managedFailure = managedProgress?.kind === 'failed'
        ? resolveSystemTaskFailureMessage({ code: managedProgress.code, message: null }) ?? t('newSession.failedToStart') : null;
    const managedMachineDraft: NewSessionManagedMachineDraftModel | undefined = selection && props.managedMachineDraft ? {
        ...props.managedMachineDraft, creationScope: 'task', progress: managedProgress ?? { kind: 'idle' },
        cancel: () => { retireManagedAttempt(); props.managedMachineDraft?.cancel?.(); },
        retryInstallation: () => { const values = submittedValues.current; if (values) void submit(values.inputs, values.roleOverrides, { retryInstallation: true }); },
        retrySetup: () => { const values = submittedValues.current; if (values) void submit(values.inputs, values.roleOverrides, { setupRecovery: 'retry' }); },
        continueWithoutSetup: () => { const values = submittedValues.current; if (values) void submit(values.inputs, values.roleOverrides, { setupRecovery: 'skip' }); },
        // Delete remains available through the admitted Machine's canonical detail/review owner.
        deleteMachine: undefined,
    } : undefined;
    const managedProgressBadge = buildNewSessionManagedProgressBadge(managedMachineDraft);
    const hostStatusBadges = props.statusBadges;
    const statusBadges = React.useMemo(() => managedProgressBadge
        ? [...(hostStatusBadges ?? []), managedProgressBadge] : hostStatusBadges, [hostStatusBadges, managedProgressBadge]);
    const retainedWhere = React.useMemo(() => retained?.project === undefined ? null : createWorkflowStartPlacementChips({
        target: retained.project, machineName: retainedMachine.name ?? retained.project.machineId,
        machineHomeDir: retainedMachine.homeDir,
        testID: 'new-session-workflow-where-chip', testIDPrefix: 'new-session-workflow-where',
    }), [retained, retainedMachine.name, retainedMachine.homeDir]);
    const composer = selection === null ? null : <WorkflowPromptLeaf key={selection.id} source={promptSource} render={prompt => <WorkflowRunComposer
        surfaceGroup={params.surfaceGroup} {...params.host}
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
        startDisabled={(props.managedMachineDraft?.selection ? !props.managedMachineDraft.onAcquisitionChange : !props.selectedMachineId || !props.selectedPath) || props.isCreating
            || !targetIsCurrent || workflowDecision?.state !== 'enabled'}
        pending={managedBusy || runNow.isPending(pendingRunId.current ?? '')}
        reconciling={runNow.stateFor(pendingRunId.current ?? '') === 'reconciling'}
        startProblem={managedFailure ? { message: managedFailure } : runNow.refusal}
        // The page's machine, folder and Agent controls describe the next start, so the review of a
        // request already sent shows its own Where instead of them.
        authoringControls={retained ? undefined : { machineName: props.machineName, machinePopover: props.machinePopover,
            currentPath: props.selectedPath, folderChipState: props.folderChipState,
            onRemoveFolder: props.onRemoveFolder, pathPopover: props.pathPopover }}
        extraActionChips={retained ? retainedWhere ?? undefined : props.agentInputExtraActionChips}
        // The host's own status row (a docked draft's status, new draft, collapse and close) stays in every mode.
        statusBadges={statusBadges} statusTrailingActions={props.statusTrailingActions} />} />;
    return { chip, composer, managedMachineDraft };
}

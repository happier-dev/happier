import * as React from 'react';
import { BUILTIN_WORKFLOW_CATALOG_V1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { RoleOverrideV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';
import type { WorkflowRunStartRequestV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowStartSelection } from '@/components/workflows/run/WorkflowStartPicker';

import type { WorkflowRunComposerModalProps } from '@/components/workflows/run/useWorkflowRunComposerModal';
import { useWorkflowRunNowController, type WorkflowRunNowRequest, type WorkflowReviewedSetup } from '@/components/workflows/run/useWorkflowRunNowController';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { randomUUID } from '@/platform/randomUUID';
import { tLoose } from '@/text';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { findWorkflowMainInput } from '../presentation/workflowBuiltinInputPresentation';

type PendingStart = Readonly<{
    entry: Readonly<{ definition: WorkflowPluginSourceV1['definition']; title: string; description: string; source: WorkflowRunStartRequestV1['source'] }>;
    lifetime: ActiveServerAccountScopeLifetime;
    project: WorkflowProjectTargetV1;
    originSession?: Readonly<{ serverId?: string; sessionId: string }>;
    origin?: WorkflowRunNowRequest['origin'];
    onComplete?: WorkflowRunNowRequest['onComplete'];
    prepareOrigin?: (request: Readonly<{ runId: string; inputs: Readonly<Record<string, JsonValue>> | undefined;
        retainedDraft: string; submittedDraft: string | null }>) => Promise<NonNullable<WorkflowRunNowRequest['origin']>>;
    retainedDraft: string;
    mainInputName: string | null;
    values: Readonly<Record<string, JsonValue | undefined>>;
    rawTextValues: Readonly<Record<string, string>>;
    roleOverrides?: readonly RoleOverrideV1[];
    visibleTeamId?: string;
}>;

/**
 * One retained input review and admission for both composers. Placement and origin are captured
 * with the selected source; the caller supplies navigation after the existing start owner settles.
 */
export function useWorkflowComposerStart(params: Readonly<{
    project: WorkflowProjectTargetV1 | null;
    originSession?: Readonly<{ serverId?: string; sessionId: string }>;
    origin?: WorkflowRunNowRequest['origin'];
    onComplete?: WorkflowRunNowRequest['onComplete'];
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    /** Stable contextual Start identity; direct instance consumers may omit it. */
    intentKey?: string;
    prepareOrigin?: PendingStart['prepareOrigin'];
    onStarted: (result: WorkflowRunStartResultV1, serverId: string) => void;
}>) {
    const [pending, setPending] = React.useState<PendingStart | null>(null);
    const pendingRef = React.useRef(pending);
    pendingRef.current = pending;
    const runNow = useWorkflowRunNowController(pending?.lifetime ?? params.accountLifetime, params.intentKey);
    const { clearRefusal } = runNow;
    const mounted = useMountedRef();
    // One press is one admission: a retry after a lost response reuses the same Run id.
    const pendingRunIdRef = React.useRef<string | null>(null);
    const pendingRunId = params.intentKey === undefined ? pendingRunIdRef.current : runNow.pendingRunId;
    const onStartedRef = React.useRef(params.onStarted);
    onStartedRef.current = params.onStarted;
    const machineId = params.project?.machineId ?? null;
    const directory = params.project?.directory ?? null;

    const admit = React.useCallback(async (
        selected: PendingStart,
        inputs: Readonly<Record<string, JsonValue>> | undefined,
        roleOverrides?: readonly RoleOverrideV1[],
        visibleTeamId?: string,
    ) => {
        const isCurrent = () => mounted.current && selected.lifetime.isCurrent() && pendingRef.current === selected;
        if (!isCurrent() || params.project === null) return;
        const { entry } = selected;
        const runId = params.intentKey === undefined ? pendingRunIdRef.current ?? randomUUID() : undefined;
        if (runId !== undefined) pendingRunIdRef.current = runId;
        const submittedDraft = selected.mainInputName === null ? null : inputs?.[selected.mainInputName];
        const prepared: WorkflowRunNowRequest = {
            source: entry.source.kind === 'catalog' || visibleTeamId === undefined ? entry.source : { ...entry.source, visibleTeamId },
            reviewedDefinition: entry.definition,
            metadata: { title: entry.title },
            ...(inputs === undefined ? {} : { inputs: { ...inputs } }),
            ...(roleOverrides === undefined ? {} : { roleOverrides: [...roleOverrides] }),
            project: selected.project,
            originSessionId: selected.originSession?.sessionId,
            origin: selected.origin,
            onComplete: selected.onComplete,
        };
        const admitted = await runNow.runNow({
            runId,
            ...(selected.prepareOrigin ? { prepareRequest: async (runId: string) => ({ ...prepared,
                origin: await selected.prepareOrigin!({ runId, inputs, retainedDraft: selected.retainedDraft,
                    submittedDraft: submittedDraft === null ? null : typeof submittedDraft === 'string' ? submittedDraft : '' }) }) } : prepared),
            isInvocationCurrent: isCurrent,
            // The start form stays open and says why beside Start, with its inputs and draft kept (lab T4-ST).
            refusal: 'inline',
        });
        if (admitted === null || !isCurrent()) return;
        pendingRunIdRef.current = null;
        setPending(null);
        onStartedRef.current(admitted, selected.lifetime.scope.serverId);
    }, [mounted, params.intentKey, params.project, runNow]);

    const start = React.useCallback((
        workflow: string | WorkflowPluginSourceV1 | WorkflowStartSelection,
        options?: Readonly<{ retainedDraft?: string; reuseInputs?: boolean }>,
    ) => {
        const existingRunId = params.intentKey === undefined ? pendingRunIdRef.current : runNow.pendingRunId;
        if (pendingRef.current !== null && options?.reuseInputs && existingRunId !== null
            && runNow.hasUnsettledAdmission(existingRunId)) return false;
        const lifetime = params.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : params.accountLifetime;
        if (lifetime === null || !lifetime.isCurrent() || !machineId || !directory || params.project === null) return false;
        let entry: PendingStart['entry'];
        if (typeof workflow === 'string') {
            const builtin = BUILTIN_WORKFLOW_CATALOG_V1.find((candidate) => candidate.id === workflow);
            if (!builtin) return false;
            entry = { definition: builtin.definition, title: tLoose(builtin.titleKey), description: tLoose(builtin.descriptionKey),
                source: { kind: 'catalog', workflow: builtin.id } };
        } else if ('source' in workflow) {
            // A Run… picker choice (built-in, saved or plugin) already names its exact start source.
            entry = { definition: workflow.definition, title: workflow.name, description: workflow.description, source: workflow.source };
        } else {
            entry = { definition: workflow.definition, title: workflow.title, description: workflow.description ?? '',
                source: { kind: 'catalog', workflow: workflow.workflow, pluginVersion: workflow.version } };
        }
        if (params.intentKey === undefined) pendingRunIdRef.current = null;
        if (existingRunId === null || !runNow.hasUnsettledAdmission(existingRunId)) clearRefusal();
        // The composer's retained draft is the question: it prefills the first text input, as New does.
        const text = options?.retainedDraft ?? '';
        const main = findWorkflowMainInput(entry.definition.inputs);
        const draft = main && text.trim() ? { [main.name]: text } : {};
        const dismissed = runNow.reviewedSetup();
        const retained = dismissed?.retainedDraft === text
            && (options?.reuseInputs || JSON.stringify(dismissed.source) === JSON.stringify(entry.source)) ? dismissed : null;
        const next = { entry, lifetime, values: retained?.values ?? draft, rawTextValues: retained?.rawTextValues ?? draft,
            roleOverrides: retained?.roleOverrides, visibleTeamId: retained?.visibleTeamId, project: params.project,
            origin: params.origin, originSession: params.originSession, onComplete: params.onComplete,
            retainedDraft: text, mainInputName: main?.name ?? null, prepareOrigin: params.prepareOrigin };
        pendingRef.current = next;
        runNow.retainReviewedSetup({ source: entry.source, retainedDraft: text, values: next.values, rawTextValues: next.rawTextValues,
            roleOverrides: next.roleOverrides, visibleTeamId: next.visibleTeamId });
        setPending(next);
        return true;
    }, [clearRefusal, directory, machineId, params.accountLifetime, params.intentKey, params.onComplete, params.origin, params.originSession, params.prepareOrigin, params.project, runNow]);

    const cancel = React.useCallback(() => {
        pendingRef.current = null;
        clearRefusal();
        setPending(null);
    }, [clearRefusal]);
    const changeSetup = React.useCallback((change: Partial<Pick<WorkflowReviewedSetup, 'values' | 'rawTextValues' | 'roleOverrides' | 'visibleTeamId'>>) => {
        const current = pendingRef.current;
        if (!current) return;
        const next = { ...current, ...change };
        pendingRef.current = next;
        runNow.retainReviewedSetup({ source: next.entry.source, retainedDraft: next.retainedDraft,
            values: next.values, rawTextValues: next.rawTextValues, roleOverrides: next.roleOverrides, visibleTeamId: next.visibleTeamId });
        setPending(next);
    }, [runNow]);
    const changeValues = React.useCallback((values: PendingStart['values']) => changeSetup({ values }), [changeSetup]);
    const changeRawTextValues = React.useCallback((rawTextValues: PendingStart['rawTextValues']) => changeSetup({ rawTextValues }), [changeSetup]);
    const changeRoleOverrides = React.useCallback((roleOverrides: readonly RoleOverrideV1[]) => changeSetup({ roleOverrides }), [changeSetup]);
    const changeVisibleTeamId = React.useCallback((visibleTeamId: string) => changeSetup({ visibleTeamId }), [changeSetup]);
    const hasUnsettledAdmission = runNow.hasUnsettledAdmission(pendingRunId ?? '');
    React.useEffect(() => {
        if (params.project === null || hasUnsettledAdmission) return;
        const project = params.project;
        setPending(current => current && (current.project.machineId !== project.machineId || current.project.directory !== project.directory)
            ? { ...current, project } : current);
    }, [hasUnsettledAdmission, params.project]);
    // The review of an unknown outcome is the request this selection already sent. A new selection
    // resets the id, so it never shows another selection's request; Try again keeps this one.
    const retainedRequest = runNow.retainedRequest?.input.runId === pendingRunId
        ? runNow.retainedRequest : null;
    const modalProps = React.useMemo(() => pending === null ? null : {
        // The composer asks only for person inputs; host-bound ones keep their defaults in the submission.
        inputs: (retainedRequest?.reviewedDefinition ?? pending.entry.definition).inputs,
        definition: retainedRequest?.reviewedDefinition ?? pending.entry.definition,
        sourceArtifactId: pending.entry.source.kind === 'saved' ? pending.entry.source.definitionId
            : pending.entry.source.kind === 'inline' ? pending.entry.source.sourceArtifactId : undefined,
        optionsConsumer: pending.entry.source.kind === 'catalog' ? { kind: 'workflow', workflow: pending.entry.source.workflow }
            : pending.entry.source.kind === 'saved' ? { kind: 'workflow', workflow: pending.entry.source.definitionId } : undefined,
        values: pending.values,
        onChangeValues: changeValues,
        rawTextValues: pending.rawTextValues,
        onChangeRawTextValues: changeRawTextValues,
        roleOverrides: pending.roleOverrides,
        onChangeRoleOverrides: changeRoleOverrides,
        visibleTeamId: pending.visibleTeamId,
        onChangeVisibleTeamId: changeVisibleTeamId,
        workflowName: pending.entry.title,
        preview: pending.entry.description,
        machineId: pending.project.machineId,
        directory: pending.project.directory,
        serverId: pending.lifetime.scope.serverId,
        originSession: pending.originSession ? { serverId: pending.originSession.serverId ?? pending.lifetime.scope.serverId,
            sessionId: pending.originSession.sessionId } : undefined,
        onRun: (inputs: Readonly<Record<string, JsonValue>> | undefined, roleOverrides?: readonly RoleOverrideV1[], visibleTeamId?: string) => {
            const selected = pendingRef.current;
            if (selected) void admit(selected, inputs, roleOverrides, visibleTeamId);
        },
        onCancel: cancel,
        retainedRequest,
        pending: runNow.isPending(pendingRunId ?? ''),
        reconciling: runNow.stateFor(pendingRunId ?? '') === 'reconciling',
        startProblem: runNow.refusal,
        startDisabled: params.project === null,
    } satisfies WorkflowRunComposerModalProps, [admit, cancel, changeRawTextValues, changeRoleOverrides, changeVisibleTeamId, changeValues, params.project, pending, pendingRunId, retainedRequest, runNow]);
    React.useEffect(() => pending?.lifetime.onRetire(cancel).dispose, [cancel, pending?.lifetime]);
    return { start, composerProps: modalProps };
}

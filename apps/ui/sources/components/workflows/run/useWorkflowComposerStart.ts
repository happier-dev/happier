import * as React from 'react';
import { BUILTIN_WORKFLOW_CATALOG_V1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { RoleOverrideV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';
import type { WorkflowRunStartRequestV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowStartSelection } from '@/components/workflows/run/WorkflowStartPicker';

import { useWorkflowRunComposerModal, type WorkflowRunComposerModalProps } from '@/components/workflows/run/useWorkflowRunComposerModal';
import { useWorkflowRunNowController, type WorkflowRunNowRequest } from '@/components/workflows/run/useWorkflowRunNowController';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { randomUUID } from '@/platform/randomUUID';
import { tLoose } from '@/text';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { findWorkflowMainInput } from '../presentation/workflowBuiltinInputPresentation';

type BuiltinWorkflowEntry = (typeof BUILTIN_WORKFLOW_CATALOG_V1)[number];

/**
 * The built-ins a session's "+" can start: those that run on their own beside it. A built-in that
 * runs inside a session (Keep going) needs that session as its run's origin. Declared Session
 * defaults, including Review & converge's review target, use that exact Session below.
 */
export const SESSION_STARTABLE_BUILTIN_WORKFLOWS: readonly BuiltinWorkflowEntry[] = BUILTIN_WORKFLOW_CATALOG_V1;

type PendingStart = Readonly<{
    entry: Readonly<{ definition: WorkflowPluginSourceV1['definition']; title: string; description: string; source: WorkflowRunStartRequestV1['source'] }>;
    lifetime: ActiveServerAccountScopeLifetime;
    project: WorkflowProjectTargetV1;
    originSession?: Readonly<{ serverId?: string; sessionId: string }>;
    origin?: WorkflowRunNowRequest['origin'];
    onComplete?: WorkflowRunNowRequest['onComplete'];
    prepareOrigin?: (request: Readonly<{ runId: string; inputs: Readonly<Record<string, JsonValue>> | undefined;
        retainedDraft: string; submittedDraft: string }>) => Promise<NonNullable<WorkflowRunNowRequest['origin']>>;
    retainedDraft: string;
    mainInputName: string | null;
    values: Readonly<Record<string, JsonValue | undefined>>;
    rawTextValues: Readonly<Record<string, string>>;
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
    prepareOrigin?: PendingStart['prepareOrigin'];
    onStarted: (result: WorkflowRunStartResultV1, serverId: string) => void;
}>): (workflow: string | WorkflowPluginSourceV1 | WorkflowStartSelection, options?: Readonly<{ retainedDraft?: string }>) => void {
    const [pending, setPending] = React.useState<PendingStart | null>(null);
    const pendingRef = React.useRef(pending);
    pendingRef.current = pending;
    const runNow = useWorkflowRunNowController(pending?.lifetime ?? params.accountLifetime);
    const { clearRefusal } = runNow;
    const mounted = useMountedRef();
    // One press is one admission: a retry after a lost response reuses the same Run id.
    const pendingRunIdRef = React.useRef<string | null>(null);
    const onStartedRef = React.useRef(params.onStarted);
    onStartedRef.current = params.onStarted;
    const machineId = params.project?.machineId ?? null;
    const directory = params.project?.directory ?? null;

    const admit = React.useCallback(async (
        selected: PendingStart,
        inputs: Readonly<Record<string, JsonValue>> | undefined,
        roleOverrides?: readonly RoleOverrideV1[],
    ) => {
        const isCurrent = () => mounted.current && selected.lifetime.isCurrent() && pendingRef.current === selected;
        if (!isCurrent()) return;
        const { entry } = selected;
        const runId = pendingRunIdRef.current ?? randomUUID();
        pendingRunIdRef.current = runId;
        const submittedDraft = selected.mainInputName === null ? selected.retainedDraft : inputs?.[selected.mainInputName];
        const prepared: WorkflowRunNowRequest = {
            source: entry.source,
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
                    submittedDraft: typeof submittedDraft === 'string' ? submittedDraft : '' }) }) } : prepared),
            isInvocationCurrent: isCurrent,
            // The start form stays open and says why beside Start, with its inputs and draft kept (lab T4-ST).
            refusal: 'inline',
        });
        if (admitted === null || !isCurrent()) return;
        pendingRunIdRef.current = null;
        setPending(null);
        onStartedRef.current(admitted, selected.lifetime.scope.serverId);
    }, [mounted, runNow]);

    const start = React.useCallback((
        workflow: string | WorkflowPluginSourceV1 | WorkflowStartSelection,
        options?: Readonly<{ retainedDraft?: string }>,
    ) => {
        const lifetime = params.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : params.accountLifetime;
        if (lifetime === null || !lifetime.isCurrent() || !machineId || !directory || params.project === null) return;
        let entry: PendingStart['entry'];
        if (typeof workflow === 'string') {
            const builtin = SESSION_STARTABLE_BUILTIN_WORKFLOWS.find((candidate) => candidate.id === workflow);
            if (!builtin) return;
            entry = { definition: builtin.definition, title: tLoose(builtin.titleKey), description: tLoose(builtin.descriptionKey),
                source: { kind: 'catalog', workflow: builtin.id } };
        } else if ('source' in workflow) {
            // A Run… picker choice (built-in, saved or plugin) already names its exact start source.
            entry = { definition: workflow.definition, title: workflow.name, description: workflow.description, source: workflow.source };
        } else {
            entry = { definition: workflow.definition, title: workflow.title, description: workflow.description ?? '',
                source: { kind: 'catalog', workflow: workflow.workflow, pluginVersion: workflow.version } };
        }
        pendingRunIdRef.current = null;
        clearRefusal();
        // The composer's retained draft is the question: it prefills the first text input, as New does.
        const text = options?.retainedDraft ?? '';
        const main = findWorkflowMainInput(entry.definition.inputs);
        const draft = main && text.trim() ? { [main.name]: text } : {};
        const next = { entry, lifetime, values: draft, rawTextValues: draft, project: params.project,
            origin: params.origin, originSession: params.originSession, onComplete: params.onComplete,
            retainedDraft: text, mainInputName: main?.name ?? null, prepareOrigin: params.prepareOrigin };
        pendingRef.current = next;
        setPending(next);
    }, [clearRefusal, directory, machineId, params.accountLifetime, params.onComplete, params.origin, params.originSession, params.prepareOrigin, params.project]);

    const cancel = React.useCallback(() => {
        pendingRef.current = null;
        clearRefusal();
        setPending(null);
    }, [clearRefusal]);
    const changeValues = React.useCallback((values: PendingStart['values']) => {
        setPending((current) => current ? { ...current, values } : current);
    }, []);
    const changeRawTextValues = React.useCallback((rawTextValues: PendingStart['rawTextValues']) => {
        setPending((current) => current ? { ...current, rawTextValues } : current);
    }, []);
    // The review of an unknown outcome is the request this selection already sent. A new selection
    // resets the id, so it never shows another selection's request; Try again keeps this one.
    const retainedRequest = runNow.retainedRequest?.unresolved === true && runNow.retainedRequest.input.runId === pendingRunIdRef.current
        ? runNow.retainedRequest : null;
    const modalProps = React.useMemo<WorkflowRunComposerModalProps | null>(() => pending === null ? null : {
        // The composer asks only for person inputs; host-bound ones keep their defaults in the submission.
        inputs: pending.entry.definition.inputs,
        definition: pending.entry.definition,
        optionsConsumer: pending.entry.source.kind === 'catalog' ? { kind: 'workflow', workflow: pending.entry.source.workflow }
            : pending.entry.source.kind === 'saved' ? { kind: 'workflow', workflow: pending.entry.source.definitionId } : undefined,
        values: pending.values,
        onChangeValues: changeValues,
        rawTextValues: pending.rawTextValues,
        onChangeRawTextValues: changeRawTextValues,
        workflowName: pending.entry.title,
        preview: pending.entry.description,
        machineId: pending.project.machineId,
        serverId: pending.lifetime.scope.serverId,
        originSession: pending.originSession ? { serverId: pending.originSession.serverId ?? pending.lifetime.scope.serverId,
            sessionId: pending.originSession.sessionId } : undefined,
        onRun: (inputs, roleOverrides) => { void admit(pending, inputs, roleOverrides); },
        onCancel: cancel,
        retainedRequest,
        pending: runNow.isPending(pendingRunIdRef.current ?? ''),
        reconciling: runNow.stateFor(pendingRunIdRef.current ?? '') === 'reconciling',
        startProblem: runNow.refusal,
    }, [admit, cancel, changeRawTextValues, changeValues, pending, retainedRequest, runNow]);
    React.useEffect(() => pending?.lifetime.onRetire(cancel).dispose, [cancel, pending?.lifetime]);
    useWorkflowRunComposerModal({ open: pending !== null, props: modalProps, accountLifetime: pending?.lifetime });

    return start;
}

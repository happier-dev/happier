import * as React from 'react';
import { BUILTIN_WORKFLOW_CATALOG_V1, type JsonValue, type RoleOverrideV1, type WorkflowPluginSourceV1, type WorkflowRunStartRequestV1 } from '@happier-dev/protocol';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useWorkflowRunComposerModal, type WorkflowRunComposerModalProps } from '@/components/workflows/run/useWorkflowRunComposerModal';
import { useWorkflowRunNowController } from '@/components/workflows/run/useWorkflowRunNowController';
import { randomUUID } from '@/platform/randomUUID';
import { tLoose } from '@/text';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useMountedRef } from '@/hooks/ui/useMountedRef';

type BuiltinWorkflowEntry = (typeof BUILTIN_WORKFLOW_CATALOG_V1)[number];

/**
 * The built-ins a session's "+" can start: those that run on their own beside it. A built-in that
 * runs inside a session (Keep going, Review & converge) needs that session as its run's origin;
 * the start below carries it, and offering those built-ins here is INT's decision.
 */
export const SESSION_STARTABLE_BUILTIN_WORKFLOWS: readonly BuiltinWorkflowEntry[] = BUILTIN_WORKFLOW_CATALOG_V1;

type PendingStart = Readonly<{
    entry: Readonly<{ definition: WorkflowPluginSourceV1['definition']; title: string; description: string; source: WorkflowRunStartRequestV1['source'] }>;
    lifetime: ActiveServerAccountScopeLifetime;
    values: Readonly<Record<string, JsonValue | undefined>>;
    rawTextValues: Readonly<Record<string, string>>;
}>;

/**
 * Starts a catalog workflow from a session through FIN's run start (`workflow.run.start` with a
 * catalog source, on the session's machine and folder): its declared inputs are asked first in
 * the shared start composer, and the admitted Run opens. No second start path and no Run cache.
 */
export function useSessionBuiltinWorkflowStart(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
}>): (workflow: string | WorkflowPluginSourceV1) => void {
    const router = useRouter();
    const target = useSessionMachineTarget(params.sessionId, params.serverId);
    const runNow = useWorkflowRunNowController();
    const mounted = useMountedRef();
    const [pending, setPending] = React.useState<PendingStart | null>(null);
    // One press is one admission: a retry after a lost response reuses the same Run id.
    const pendingRunIdRef = React.useRef<string | null>(null);
    const machineId = target?.machineId ?? null;
    const directory = target?.basePath ?? null;

    const admit = React.useCallback(async (
        selected: PendingStart,
        inputs: Readonly<Record<string, JsonValue>> | undefined,
        roleOverrides?: readonly RoleOverrideV1[],
    ) => {
        const isCurrent = () => mounted.current && selected.lifetime.isCurrent();
        if (!machineId || !directory || !isCurrent()) return;
        const { entry } = selected;
        const runId = pendingRunIdRef.current ?? randomUUID();
        pendingRunIdRef.current = runId;
        const admitted = await runNow.runNow({
            runId,
            source: entry.source,
            metadata: { title: entry.title },
            ...(inputs === undefined ? {} : { inputs: { ...inputs } }),
            ...(roleOverrides === undefined ? {} : { roleOverrides: [...roleOverrides] }),
            project: { machineId, directory },
            originSessionId: params.sessionId,
            isInvocationCurrent: isCurrent,
        });
        if (admitted === null || !isCurrent()) return;
        pendingRunIdRef.current = null;
        setPending(null);
        router.push({ pathname: '/workflows/runs/[runId]', params: { runId: admitted.run.id } } as never);
    }, [directory, machineId, mounted, params.sessionId, router, runNow]);

    const start = React.useCallback((workflow: string | WorkflowPluginSourceV1) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null || !machineId || !directory) return;
        let entry: PendingStart['entry'];
        if (typeof workflow === 'string') {
            const builtin = SESSION_STARTABLE_BUILTIN_WORKFLOWS.find((candidate) => candidate.id === workflow);
            if (!builtin) return;
            entry = { definition: builtin.definition, title: tLoose(builtin.titleKey), description: tLoose(builtin.descriptionKey),
                source: { kind: 'catalog', workflow: builtin.id } };
        } else {
            entry = { definition: workflow.definition, title: workflow.title, description: workflow.description ?? '',
                source: { kind: 'catalog', workflow: workflow.workflow, pluginVersion: workflow.version } };
        }
        pendingRunIdRef.current = null;
        setPending({ entry, lifetime, values: {}, rawTextValues: {} });
    }, [directory, machineId]);

    const cancel = React.useCallback(() => setPending(null), []);
    const changeValues = React.useCallback((values: PendingStart['values']) => {
        setPending((current) => current ? { ...current, values } : current);
    }, []);
    const changeRawTextValues = React.useCallback((rawTextValues: PendingStart['rawTextValues']) => {
        setPending((current) => current ? { ...current, rawTextValues } : current);
    }, []);
    const modalProps = React.useMemo<WorkflowRunComposerModalProps | null>(() => pending === null ? null : {
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
        machineId,
        serverId: params.serverId ?? null,
        onRun: (inputs, roleOverrides) => { void admit(pending, inputs, roleOverrides); },
        onCancel: cancel,
        pending: runNow.isPending(pendingRunIdRef.current ?? ''),
        reconciling: runNow.stateFor(pendingRunIdRef.current ?? '') === 'reconciling',
    }, [admit, cancel, changeRawTextValues, changeValues, machineId, params.serverId, pending, runNow]);
    useWorkflowRunComposerModal({ open: pending !== null, props: modalProps });

    return start;
}

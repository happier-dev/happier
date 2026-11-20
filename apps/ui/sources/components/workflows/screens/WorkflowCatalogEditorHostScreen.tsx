import * as React from 'react';
import { View } from 'react-native';
import { Modal } from '@/modal';
import { getBuiltinWorkflowCatalogV1, type BuiltinWorkflowCatalogEntryV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { RoleOverrideV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';

import { useOpenAppSection, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope, useActiveMachineFacts, useMachineListForServer } from '@/sync/domains/state/storage';
import { exportWorkflowDocumentViaAction } from '@/sync/domains/workflows/workflowInterchange';
import { isWorkflowProjectTarget, type WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t, tLoose } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { buildWorkflowEditorDraftFromDefinition } from '@/sync/domains/workflows/workflowAuthoring';
import { preparePluginWorkflowTemplateDraft, storeWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';

import { confirmWorkflowDocumentExport } from '../actions/confirmWorkflowDocumentExport';
import { createWorkflowStartPlacementChips } from '../run/workflowStartPlacementChips';
import { useWorkflowPluginSource } from '../library/workflowLibraryReads';
import { useWorkflowTriggerSets } from '../triggers/useWorkflowTriggerSets';
import { AccountTriggersReadContent } from '../triggers/AccountTriggersSection';
import { formatTriggerSetSentence } from '../triggers/formatTriggerSummary';
import { useWorkflowRunComposerModal } from '../run/useWorkflowRunComposerModal';
import { useWorkflowRunNowController } from '../run/useWorkflowRunNowController';
import { resolveWorkflowBuiltinInputPresentation } from '../presentation/workflowBuiltinInputPresentation';
import { resolveContextualWorkflowProjectTarget } from './resolveContextualWorkflowTarget';
import { WorkflowMissingDefinitionState } from './WorkflowMissingDefinitionState';
import { WorkflowBuiltinSessionButton } from '../library/WorkflowBuiltinsSection';
import { WorkflowEditorBody, type WorkflowEditorView } from './WorkflowEditorBody';
import { useWorkflowAuthoringHost } from './useWorkflowAuthoringHost';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';
import { useWorkflowEditorAccountMemory } from './useWorkflowEditorAccountMemory';
import { useControlledWorkflowEditorDraftStore } from '../editor/workflowEditorDraftStore';

/** A read-only catalog source, resolved exactly through the shared definition Action owner. */
export function WorkflowPluginEditorHostScreen(props: Readonly<{ workflow: string; intent?: 'run' }>): React.ReactElement {
    const openSection = useOpenAppSection();
    const catalog = useWorkflowPluginSource(props.workflow);
    const focusedScope = useActiveServerAccountScope();
    const accountLifetime = useWorkflowAccountLifetime();
    const scope = accountLifetime === undefined ? focusedScope : accountLifetime?.scope;
    const plugin = catalog.source;
    if (plugin === null) {
        if (catalog.status === 'failed') return <SurfaceStateCard kind="error"
            title={t('workflows.loadFailedTitle')} reason={t('workflows.loadFailedBody')}
            action={{ label: t('workflows.retry'), onPress: catalog.retry }} />;
        if (catalog.status !== 'missing') return <SurfaceStateCard kind="loading" title={t('workflows.editor.loadingTitle')} />;
        return <WorkflowMissingDefinitionState onOpenCollection={() => openSection('/workflows', true)} />;
    }
    return <CatalogDefinition key={`${scope?.serverId}/${scope?.accountId}/${plugin.workflow}/${plugin.version}`}
        plugin={plugin} serverId={scope?.serverId ?? null} intent={props.intent} />;
}

/** Local built-ins do not depend on the Account library being available. */
export function WorkflowBuiltinEditorHostScreen(props: Readonly<{ workflow: string; intent?: 'run' }>): React.ReactElement {
    const openSection = useOpenAppSection();
    const focusedScope = useActiveServerAccountScope();
    const accountLifetime = useWorkflowAccountLifetime();
    const scope = accountLifetime === undefined ? focusedScope : accountLifetime?.scope;
    const entry = getBuiltinWorkflowCatalogV1().find((item) => item.id === props.workflow);
    if (entry === undefined) return <WorkflowMissingDefinitionState onOpenCollection={() => openSection('/workflows', true)} />;
    return <CatalogDefinition key={`${scope?.serverId}/${scope?.accountId}/${entry.id}/${entry.version}`}
        plugin={entry} serverId={scope?.serverId ?? null} intent={props.intent} />;
}

/** Catalog loading and admission only; the canonical editor owns the document. */
function CatalogDefinition(props: Readonly<{ plugin: WorkflowPluginSourceV1 | BuiltinWorkflowCatalogEntryV1; serverId: string | null; intent?: 'run' }>): React.ReactElement {
    const builtin = 'workflow' in props.plugin ? null : props.plugin;
    const plugin = 'workflow' in props.plugin ? props.plugin : {
        workflow: props.plugin.id, version: props.plugin.version, definition: props.plugin.definition,
        title: tLoose(props.plugin.titleKey), description: tLoose(props.plugin.descriptionKey), pluginId: undefined,
    };
    const prefix = builtin === null ? 'workflow-plugin' : 'workflow-builtin';
    const sessionBound = builtin?.requiresOriginSession === true;
    const catalogSource = 'workflow' in props.plugin
        ? { kind: 'catalog' as const, workflow: props.plugin.workflow, pluginVersion: props.plugin.version }
        : { kind: 'catalog' as const, workflow: props.plugin.id };
    const router = useRouter();
    const accountLifetime = useWorkflowAccountLifetime();
    const focusedMachines = useActiveMachineFacts(accountLifetime === undefined);
    const triggerRequest = React.useMemo(() => ({ workflow: plugin.workflow }), [plugin.workflow]);
    const triggerRead = useWorkflowTriggerSets(triggerRequest, accountLifetime);
    const addressedMachines = useMachineListForServer(accountLifetime?.scope.serverId ?? '', accountLifetime !== undefined);
    const machines = accountLifetime === undefined ? focusedMachines : addressedMachines ?? [];
    const { recentMachinePaths } = useWorkflowEditorAccountMemory(accountLifetime, { workspaceRefs: false });
    const [focusedLifetime] = React.useState(captureActiveServerAccountScopeLifetime);
    const lifetime = accountLifetime === undefined ? focusedLifetime : accountLifetime;
    const [target, setTarget] = React.useState<WorkflowAuthoringTarget | null>(() => resolveContextualWorkflowProjectTarget({ machines, recentMachinePaths,
        scope: lifetime?.isCurrent() ? lifetime.scope : null }));
    const mounted = useMountedRef();
    const isCurrent = React.useCallback(() => mounted.current && lifetime?.isCurrent() === true, [lifetime, mounted]);
    const [open, setOpen] = React.useState(props.intent === 'run' && !sessionBound);
    const [values, setValues] = React.useState<Readonly<Record<string, JsonValue | undefined>>>({});
    const [rawTextValues, setRawTextValues] = React.useState<Readonly<Record<string, string>>>({});
    // Run now anchors its composer under itself, as in the editor (convo-N7).
    const runAnchorRef = React.useRef<View | null>(null);
    const runNow = useWorkflowRunNowController(accountLifetime, `catalog:${plugin.workflow}:${plugin.version}`);
    const machine = machines.find((entry) => entry.id === target?.machineId);
    const draft = React.useMemo(() => buildWorkflowEditorDraftFromDefinition({
        draftId: `catalog:${plugin.workflow}:${plugin.version}`, name: plugin.title, definition: plugin.definition,
    }), [plugin.definition, plugin.title, plugin.version, plugin.workflow]);
    const draftStore = useControlledWorkflowEditorDraftStore(draft);
    const [selectedBlockId, setSelectedBlockId] = React.useState<string | null>(null);
    const [view, setView] = React.useState<WorkflowEditorView>('steps');
    const host = useWorkflowAuthoringHost({ projectTarget: target, serverId: props.serverId });

    const duplicate = async () => {
        if (!isCurrent() || !lifetime) return;
        if ('workflow' in props.plugin) {
            const route = await preparePluginWorkflowTemplateDraft({ source: props.plugin, accountLifetime: lifetime,
                name: t('workflows.copyName', { name: plugin.title }) });
            if (route && isCurrent()) router.push(route as never);
            return;
        }
        const definitionDraftSeedId = storeWorkflowDefinitionDraftSeed({ definition: plugin.definition,
            name: t('workflows.copyName', { name: plugin.title }),
            ...(plugin.description === undefined ? {} : { description: plugin.description }) }, accountLifetime);
        router.push({ pathname: '/workflows/new', params: { definitionDraftSeedId,
            ...(accountLifetime ? { serverId: accountLifetime.scope.serverId } : {}) } } as never);
    };
    const admit = async (inputs: Readonly<Record<string, JsonValue>> | undefined, roleOverrides?: readonly RoleOverrideV1[]) => {
        if (!isCurrent() || sessionBound || target === null || !isWorkflowProjectTarget(target) || target.directory.trim().length === 0) return;
        const accepted = await runNow.runNow({
            source: catalogSource,
            metadata: { title: plugin.title }, ...(inputs === undefined ? {} : { inputs: { ...inputs } }),
            ...(roleOverrides === undefined ? {} : { roleOverrides: [...roleOverrides] }), project: target, isInvocationCurrent: isCurrent,
            refusal: 'inline' });
        if (accepted !== null && isCurrent()) {
            setOpen(false);
            router.push(createWorkflowRunRoute(accepted.run.id, lifetime?.scope.serverId) as never);
        }
    };
    const inputPresentation = resolveWorkflowBuiltinInputPresentation(builtin?.id);
    // While a start is unsettled, the review shows the Where it already sent, without a setter.
    const retained = runNow.retainedRequest;
    const shownTarget = retained?.project ?? target;
    const shownMachine = machines.find((entry) => entry.id === shownTarget?.machineId);
    const runComposer = useWorkflowRunComposerModal({ open, anchorRef: runAnchorRef, props: {
        inputs: plugin.definition.inputs, definition: plugin.definition, workflowName: plugin.title,
        ...(inputPresentation === undefined ? {} : { inputPresentation }),
        preview: plugin.description ?? '', values, onChangeValues: setValues, rawTextValues, onChangeRawTextValues: setRawTextValues,
        machineId: shownTarget?.machineId ?? null, directory: shownTarget && isWorkflowProjectTarget(shownTarget) ? shownTarget.directory : null, serverId: props.serverId,
        retainedRequest: retained,
        extraActionChips: createWorkflowStartPlacementChips({ target: shownTarget, machines,
            machineName: shownMachine ? getMachineDisplayName(shownMachine) : null,
            ...(retained?.project ? {} : { onChange: setTarget }),
            testID: `${prefix}:run-where`, testIDPrefix: `${prefix}:run` }),
        onRun: (inputs, overrides) => { void admit(inputs, overrides); }, onCancel: () => { runNow.clearRefusal(); setOpen(false); },
        pending: runNow.isPending(runNow.pendingRunId ?? ''),
        startProblem: runNow.refusal,
        reconciling: runNow.stateFor(runNow.pendingRunId ?? '') === 'reconciling',
        startDisabled: target === null || !isWorkflowProjectTarget(target) || target.directory.trim().length === 0,
    } });
    const exportSource = async () => {
        if (!isCurrent()) return;
        try {
            const result = await exportWorkflowDocumentViaAction({ definition: plugin.definition, accountLifetime: lifetime });
            if (isCurrent()) await confirmWorkflowDocumentExport({ name: plugin.title, json: result.json, isCurrent });
        } catch {
            if (isCurrent()) Modal.alert(t('workflows.destination.exportFailedTitle'), t('workflows.loadFailedBody'));
        }
    };
    return <>
        {runComposer}
        <WorkflowEditorBody
            draftStore={draftStore} onChange={() => {}} documentPresentation={{ editable: false,
                note: builtin === null ? t('workflows.plugins.readOnly') : t('workflows.examples.builtInDescription') }}
            machineName={machine ? getMachineDisplayName(machine) : null}
            projectTarget={target} projectMachines={machines}
            selectedBlockId={selectedBlockId} onSelectBlock={setSelectedBlockId} onCustomizeBlock={() => {}}
            view={view} onChangeView={setView}
            {...(sessionBound && builtin !== null
                ? { runNowAction: <WorkflowBuiltinSessionButton entry={builtin} primary testID={`${prefix}-run-now`} /> }
                : { onRunNow: () => setOpen(true), runNowAnchorRef: runAnchorRef })}
            onDuplicate={duplicate} onExportJson={() => { void exportSource(); }}
            menuActions={[{ id: 'export', title: t('workflows.exportJson'), onSelect: () => { void exportSource(); } }]}
            description={plugin.description}
            headerMeta={[{ key: 'catalog', text: builtin === null ? `${plugin.pluginId} · ${plugin.version}` : t('workflows.page.blocks.builtin') }]}
            authoringFacts={host.authoringFacts} composerScope={host.composerScope}
            triggersSummary={formatTriggerSetSentence(triggerRead.sets.flatMap(set => set.triggers))}
            triggersSection={<AccountTriggersReadContent first read={triggerRead} accountLifetime={accountLifetime} />}
            currentWorkflowRef={plugin.workflow} testIDPrefix={prefix}
        />
    </>;
}

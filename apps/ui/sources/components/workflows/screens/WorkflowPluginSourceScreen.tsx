import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { getBuiltinWorkflowCatalogV1, type BuiltinWorkflowCatalogEntryV1, type JsonValue, type RoleOverrideV1, type WorkflowPluginSourceV1 } from '@happier-dev/protocol';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { randomUUID } from '@/platform/randomUUID';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope, useAllMachines, useAuthoringMemoryField } from '@/sync/domains/state/storage';
import { exportWorkflowDefinition } from '@/sync/domains/workflows/workflowInterchange';
import { isWorkflowProjectTarget, type WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t, tLoose } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { useWorkflowAuthoringComposerCustody } from '@/components/sessions/authoring/authoringComposerCustody';
import { buildWorkflowEditorDraftFromDefinition, validateWorkflowEditorDraft } from '@/sync/domains/workflows/workflowAuthoring';
import { storeWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

import { confirmWorkflowDocumentExport } from '../actions/confirmWorkflowDocumentExport';
import { formatWorkflowWhereSummary, WorkflowProjectTargetControl } from '../editor/WorkflowProjectTargetControl';
import { createExecutionRunStartContentChip } from '@/components/sessions/runs/launcher/executionRunStartChips';
import { WorkflowFlowView } from '../flow/WorkflowFlowView';
import { projectWorkflowFlow } from '../flow/workflowFlowProjection';
import { useWorkflowDefinitionLibrary } from '../library/workflowLibraryReads';
import { useWorkflowRunComposerModal } from '../run/useWorkflowRunComposerModal';
import { useWorkflowRunNowController } from '../run/useWorkflowRunNowController';
import { resolveWorkflowBuiltinInputPresentation } from '../presentation/workflowBuiltinInputPresentation';
import { resolveContextualWorkflowProjectTarget } from './resolveContextualWorkflowTarget';
import { WorkflowMissingDefinitionState } from './WorkflowMissingDefinitionState';
import { WorkflowBuiltinSessionButton } from '../library/WorkflowBuiltinsSection';
import { WorkflowBlockListEditor } from '../editor/WorkflowBlockListEditor';

/** A read-only catalog source, read through the same paged library owner as every picker. */
export function WorkflowPluginSourceScreen(props: Readonly<{ workflow: string; intent?: 'run' }>): React.ReactElement {
    const library = useWorkflowDefinitionLibrary();
    const scope = useActiveServerAccountScope();
    const router = useRouter();
    const plugin = library.pluginWorkflows.find((entry) => entry.workflow === props.workflow);
    React.useEffect(() => {
        if (plugin === undefined && library.status === 'loaded' && library.hasMore && !library.loadingMore && !library.loadMoreFailed) library.loadMore();
    }, [plugin, library.status, library.hasMore, library.loadingMore, library.loadMoreFailed, library.loadMore]);
    if (plugin === undefined) {
        if (library.status === 'failed' || library.loadMoreFailed) return <SurfaceStateCard kind="error"
            title={t('workflows.loadFailedTitle')} reason={t('workflows.loadFailedBody')}
            action={{ label: t('workflows.retry'), onPress: library.loadMoreFailed ? library.loadMore : library.retry }} />;
        if (library.status !== 'loaded' || library.hasMore) return <SurfaceStateCard kind="loading" title={t('workflows.editor.loadingTitle')} />;
        return <WorkflowMissingDefinitionState onOpenCollection={() => router.replace('/workflows' as never)} />;
    }
    return <CatalogDefinition key={`${scope?.serverId}/${scope?.accountId}/${plugin.workflow}/${plugin.version}`}
        plugin={plugin} serverId={scope?.serverId ?? null} intent={props.intent} />;
}

/** Local built-ins do not depend on the Account library being available. */
export function WorkflowBuiltinSourceScreen(props: Readonly<{ workflow: string; intent?: 'run' }>): React.ReactElement {
    const scope = useActiveServerAccountScope();
    const router = useRouter();
    const entry = getBuiltinWorkflowCatalogV1().find((item) => item.id === props.workflow);
    if (entry === undefined) return <WorkflowMissingDefinitionState onOpenCollection={() => router.replace('/workflows' as never)} />;
    return <CatalogDefinition key={`${scope?.serverId}/${scope?.accountId}/${entry.id}/${entry.version}`}
        plugin={entry} serverId={scope?.serverId ?? null} intent={props.intent} />;
}

/** One read-only source viewer and one composer admission for plugin and built-in catalogs. */
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
    const machines = useAllMachines();
    const recentMachinePaths = useAuthoringMemoryField('recentMachinePaths');
    const [target, setTarget] = React.useState<WorkflowAuthoringTarget | null>(() => resolveContextualWorkflowProjectTarget({ machines, recentMachinePaths }));
    const [lifetime] = React.useState(captureActiveServerAccountScopeLifetime);
    const mounted = useMountedRef();
    const isCurrent = React.useCallback(() => mounted.current && lifetime?.isCurrent() === true, [lifetime, mounted]);
    const [open, setOpen] = React.useState(props.intent === 'run' && !sessionBound);
    const [values, setValues] = React.useState<Readonly<Record<string, JsonValue | undefined>>>({});
    const [rawTextValues, setRawTextValues] = React.useState<Readonly<Record<string, string>>>({});
    const runId = React.useRef<string | null>(null);
    // Run now anchors its composer under itself, as in the editor (convo-N7).
    const runAnchorRef = React.useRef<View | null>(null);
    const runNow = useWorkflowRunNowController();
    const projection = React.useMemo(() => projectWorkflowFlow(plugin.definition), [plugin.definition]);
    const machine = machines.find((entry) => entry.id === target?.machineId);
    const draft = React.useMemo(() => buildWorkflowEditorDraftFromDefinition({
        draftId: `catalog:${plugin.workflow}:${plugin.version}`, name: plugin.title, definition: plugin.definition,
    }), [plugin.definition, plugin.title, plugin.version, plugin.workflow]);
    const blockIds = React.useMemo(() => walkWorkflowBlocks(draft.blocks).map((block) => block.id), [draft.blocks]);
    const custody = useWorkflowAuthoringComposerCustody({ draftId: draft.draftId, blockIds });
    const validation = React.useMemo(() => validateWorkflowEditorDraft(draft), [draft]);
    const [selectedBlockId, setSelectedBlockId] = React.useState<string | null>(null);

    const duplicate = () => {
        if (!isCurrent()) return;
        const definitionDraftSeedId = storeWorkflowDefinitionDraftSeed({ definition: plugin.definition,
            name: t('workflows.copyName', { name: plugin.title }),
            ...(plugin.description === undefined ? {} : { description: plugin.description }) });
        router.push({ pathname: '/workflows/new', params: { definitionDraftSeedId } } as never);
    };
    const admit = async (inputs: Readonly<Record<string, JsonValue>> | undefined, roleOverrides?: readonly RoleOverrideV1[]) => {
        if (!isCurrent() || sessionBound || target === null || !isWorkflowProjectTarget(target) || target.directory.trim().length === 0) return;
        runId.current ??= randomUUID();
        const accepted = await runNow.runNow({ runId: runId.current,
            source: catalogSource,
            metadata: { title: plugin.title }, ...(inputs === undefined ? {} : { inputs: { ...inputs } }),
            ...(roleOverrides === undefined ? {} : { roleOverrides: [...roleOverrides] }), project: target, isInvocationCurrent: isCurrent });
        if (accepted !== null && isCurrent()) {
            setOpen(false);
            runId.current = null;
            router.push(createWorkflowRunRoute(accepted.run.id) as never);
        }
    };
    const inputPresentation = resolveWorkflowBuiltinInputPresentation(builtin?.id);
    const runComposer = useWorkflowRunComposerModal({ open, anchorRef: runAnchorRef, props: {
        inputs: plugin.definition.inputs, definition: plugin.definition, workflowName: plugin.title,
        ...(inputPresentation === undefined ? {} : { inputPresentation }),
        preview: plugin.description ?? '', values, onChangeValues: setValues, rawTextValues, onChangeRawTextValues: setRawTextValues,
        machineId: target?.machineId ?? null, serverId: props.serverId,
        extraActionChips: [{ ...createExecutionRunStartContentChip({
            key: 'workflow-start-where', icon: 'folder', title: t('workflows.page.where.label'),
            label: formatWorkflowWhereSummary({ target, machineName: machine ? getMachineDisplayName(machine) : null }) ?? t('workflows.page.where.choose'),
            testID: `${prefix}:run-where`,
            renderContent: <WorkflowProjectTargetControl target={target} machines={machines} onChange={setTarget}
                machineName={machine ? getMachineDisplayName(machine) : null} testIDPrefix={`${prefix}:run`} />,
        }), controlId: 'path' }],
        onRun: (inputs, overrides) => { void admit(inputs, overrides); }, onCancel: () => setOpen(false),
        pending: runNow.stateFor(runId.current ?? '') === 'submitting',
        startDisabled: target === null || !isWorkflowProjectTarget(target) || target.directory.trim().length === 0,
    } });
    const exportSource = async () => {
        if (!isCurrent()) return;
        const result = exportWorkflowDefinition({ definition: plugin.definition });
        if (result.ok) await confirmWorkflowDocumentExport({ name: plugin.title, json: result.json, isCurrent });
    };
    return <ItemList>
        {runComposer}
        <PageHeader title={plugin.title} description={plugin.description} meta={[{ key: 'catalog', text: builtin === null ? `${plugin.pluginId} · ${plugin.version}` : t('workflows.page.blocks.builtin') }]}
            actions={<View style={styles.actions}>
                <RoundButton testID={`${prefix}:export`} title={t('workflows.exportJson')} size="small" display="inverted" onPress={() => { void exportSource(); }} />
                <RoundButton testID={`${prefix}:duplicate`} title={t('common.duplicate')} size="small" display="inverted" onPress={duplicate} />
                {sessionBound && builtin !== null ? <WorkflowBuiltinSessionButton entry={builtin} testID={`${prefix}:session`} />
                    : <View ref={runAnchorRef} collapsable={false}>
                        <RoundButton testID={`${prefix}:run`} title={t('workflows.destination.rowMenu.runNow')} size="small" onPress={() => { runId.current = null; setOpen(true); }} />
                    </View>}
            </View>} />
        <ItemGroup>
            <SectionContentRow>
                <Text testID={`${prefix}:read-only`}>{builtin === null ? t('workflows.plugins.readOnly') : t('workflows.examples.builtInDescription')}</Text>
            </SectionContentRow>
            {/* Where it runs: the Where owner's one field row ("Machine and project"), never a nested tile. */}
            {!sessionBound ? <WorkflowProjectTargetControl presentation="field" target={target} machines={machines} onChange={setTarget}
                machineName={machine ? getMachineDisplayName(machine) : null} testIDPrefix={prefix} /> : null}
            <SectionContentRow><View style={styles.body}>
                <WorkflowBlockListEditor
                    draft={draft} list={{ kind: 'root' }} blocks={draft.blocks} depth={0}
                    selectedBlockId={selectedBlockId} validation={validation}
                    composerScope={{ kind: 'machine', machineId: target?.machineId ?? null, serverId: props.serverId,
                        directory: typeof target?.directory === 'string' ? target.directory : null,
                        machineHomeDir: machine?.metadata?.homeDir ?? null }}
                    composerCustody={custody} presentation={{ editable: false }}
                    onChange={() => {}} onCustomize={() => {}} onSelect={setSelectedBlockId}
                    currentWorkflowRef={plugin.workflow} testIDPrefix={`${prefix}:document`}
                />
            </View></SectionContentRow>
            <SectionContentRow><View style={styles.body}>
                <WorkflowFlowView projection={projection} selectedNodeId={null} testIDPrefix={`${prefix}:flow`} />
            </View></SectionContentRow>
        </ItemGroup>
    </ItemList>;
}

const styles = StyleSheet.create((theme) => ({
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.margins.sm },
    body: { gap: theme.margins.md },
}));

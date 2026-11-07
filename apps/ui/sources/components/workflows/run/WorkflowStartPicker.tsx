import * as React from 'react';
import { BUILTIN_WORKFLOW_CATALOG_V1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { workflowInputTitle, type WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { SelectionList, type SelectionListDynamicSectionResolveResult, type SelectionListStep } from '@/components/ui/selectionList';
import { SelectionListSectionFailure } from '@/components/ui/selectionList/selectionListSectionFailure';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { t, tLoose } from '@/text';
import { getWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useWorkflowDefinitionLibrary, type WorkflowLibraryDefinition } from '../library/workflowLibraryReads';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle, resolveWorkflowProblemPresentation } from '../presentation/workflowProblemPresentation';
import { listWorkflowPersonInputs, resolveWorkflowBuiltinInputPresentation } from '../presentation/workflowBuiltinInputPresentation';
import { WorkflowPurposeGlyph } from '../presentation/WorkflowPurposeGlyph';
import { formatTriggerSetSummary } from '../triggers/formatTriggerSummary';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkflowStartSource } from './workflowStartDetailsModel';

/**
 * Two panes (lab T4-R): the list, and beside it what the highlighted pattern does and asks for. The Run…
 * chip (`createWorkflowRunActionChip`) gives the popover the width; narrower, the list stands alone.
 */
const PICKER_DETAIL_PANE = Object.freeze({ minListWidthPx: 560, widthPx: 320 });

/** Holds a library read open until the section's next resolver (a library state change) aborts it. */
function untilAborted(signal: AbortSignal): Promise<SelectionListDynamicSectionResolveResult> {
    return new Promise((resolve) => {
        if (signal.aborted) resolve({ options: [] });
        else signal.addEventListener('abort', () => resolve({ options: [] }), { once: true });
    });
}

const styles = StyleSheet.create((theme) => ({
    preview: { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12, gap: theme.space.s12 },
    previewHead: { gap: theme.space.s4 },
    previewTitle: { ...Typography.variant('heading'), color: theme.colors.text.primary },
    previewBody: { ...Typography.variant('body'), color: theme.colors.text.secondary },
    previewLabel: { ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.secondary },
    previewSection: { gap: theme.space.s4 },
    previewStep: { flexDirection: 'row', gap: theme.space.s8 },
    previewOrdinal: { ...Typography.variant('meta'), ...Typography.tabular(), color: theme.colors.text.tertiary, minWidth: theme.space.s12 },
    previewStepName: { ...Typography.variant('body'), color: theme.colors.text.primary, flexShrink: 1 },
    previewMeta: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
}));

/** The highlighted pattern itself: what it does, the steps it takes, and what it asks for. */
function WorkflowStartPreview(props: Readonly<{ selection: WorkflowStartSelection }>) {
    const { definition } = props.selection;
    const presentation = resolveWorkflowBuiltinInputPresentation(props.selection.id);
    const inputs = listWorkflowPersonInputs(definition.inputs)
        .map((input) => presentation?.[input.name]?.title ?? workflowInputTitle(input));
    return <ScrollView testID={`workflow-start-preview:${props.selection.id}`} contentContainerStyle={styles.preview}>
        <View style={styles.previewHead}>
            <Text style={styles.previewTitle}>{props.selection.name}</Text>
            {props.selection.description ? <Text style={styles.previewBody}>{props.selection.description}</Text> : null}
        </View>
        {definition.blocks.length === 0 ? null : <View style={styles.previewSection}>
            <Text style={styles.previewLabel}>{t('workflows.tabs.steps')}</Text>
            {definition.blocks.map((block, index) => <View key={block.id} style={styles.previewStep}>
                <Text style={styles.previewOrdinal}>{index + 1}</Text>
                <Text style={styles.previewStepName}>{workflowBlockReferenceLabel(block, t('workflows.start.workflow'))}</Text>
            </View>)}
        </View>}
        {inputs.length === 0 ? <Text style={styles.previewMeta}>{t('workflows.start.noInputs')}</Text> : <View style={styles.previewSection}>
            <Text style={styles.previewLabel}>{t('workflows.start.inputs')}</Text>
            <Text style={styles.previewStepName}>{inputs.join(' · ')}</Text>
        </View>}
    </ScrollView>;
}

export type WorkflowStartSelection = Readonly<{
    id: string;
    name: string;
    description: string;
    definition: WorkflowDefinitionV1;
    source: WorkflowStartSource;
}>;
export type WorkflowStartReference = Readonly<{ source: WorkflowStartSource; name: string }>;

type SavedWorkflowHeader = Extract<WorkflowLibraryDefinition, { contentStatus: 'available' }>;
type ReadSavedSelection = (header: SavedWorkflowHeader) => Promise<WorkflowStartSelection>;

/** Mounted only by the highlighted row's detail pane; listing and filtering never open bodies. */
function SavedWorkflowStartPreview(props: Readonly<{ header: SavedWorkflowHeader; readSelection: ReadSavedSelection }>) {
    const [selection, setSelection] = React.useState<WorkflowStartSelection | null>(null);
    const [failure, setFailure] = React.useState<string | null>(null);
    React.useEffect(() => {
        let active = true;
        void props.readSelection(props.header).then(value => {
            if (active) setSelection(value);
        }, error => {
            if (active) setFailure(resolveWorkflowProblemPresentation(error).message);
        });
        return () => { active = false; };
    }, [props.header, props.readSelection]);
    if (selection) return <WorkflowStartPreview selection={selection} />;
    return <View style={styles.preview}><Text style={styles.previewBody} accessibilityRole={failure ? 'alert' : undefined}>
        {failure ?? t('common.loading')}
    </Text></View>;
}

type WorkflowStartPickerProps = Readonly<{
    onRequestClose: () => void;
    maxHeight: number;
    currentUiContextCommandScope?: string;
    /** Opened inside a Session: built-ins that run in their origin Session become startable. */
    hasOriginSession?: boolean;
    accountLifetime?: ServerAccountScopeLifetime | null;
}> & (
    | Readonly<{ onSelect: (selection: WorkflowStartSelection) => void; onSelectReference?: never }>
    | Readonly<{ onSelect?: never; onSelectReference: (reference: WorkflowStartReference) => void }>
);

/** Only mounted while the Workflow chip is open; FIN owns the Account library and exact reads. */
export function WorkflowStartPicker(props: WorkflowStartPickerProps): React.ReactElement {
    const { theme } = useUnistyles();
    const accountLifetime = useWorkflowAccountLifetime(props.accountLifetime);
    const library = useWorkflowDefinitionLibrary({ accountLifetime });
    // "Load more" belongs under rows the person has seen, never under the first page's skeletons.
    const [libraryShown, setLibraryShown] = React.useState(false);
    // "Your library" is always a section: skeletons while the first page reads, its own failure line with
    // Retry, or the empty sentence. A Retry on that line re-reads the library, never only this section.
    const libraryRef = React.useRef(library);
    libraryRef.current = library;
    const shownFailureRef = React.useRef<typeof library.failure>(null);
    const libraryPhase = library.definitions.length > 0 ? 'rows' : library.status;
    const [selectionFailure, setSelectionFailure] = React.useState<string | null>(null);
    // One mounted picker's highlighted/chosen read, shared when a click follows a pending preview.
    const savedRead = React.useRef<Readonly<{
        key: string;
        lifetime: ServerAccountScopeLifetime;
        controller: AbortController;
        promise: Promise<WorkflowStartSelection>;
    }> | null>(null);
    const readController = React.useRef<AbortController | null>(null);
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; readController.current?.abort(); };
    }, []);
    const readSavedSelection = React.useCallback<ReadSavedSelection>((header) => {
        const lifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
        if (lifetime === null || !lifetime.isCurrent()) return Promise.reject(new Error('workflow_account_retired'));
        const key = JSON.stringify([header.definitionId, header.revision]);
        if (savedRead.current?.key === key && savedRead.current.lifetime === lifetime) return savedRead.current.promise;
        // A later hover must not cancel the definition the person has already chosen.
        // All reads still retire together when this picker unmounts.
        if (readController.current === null || readController.current.signal.aborted) readController.current = new AbortController();
        const controller = readController.current;
        const promise = getWorkflowDefinition({ definitionId: header.definitionId, signal: controller.signal, accountLifetime: lifetime })
            .then((result): WorkflowStartSelection => ({
                id: result.definitionId, name: result.metadata.title, description: result.metadata.description ?? '',
                definition: result.definition,
                source: { kind: 'saved', definitionId: result.definitionId, revision: result.revision },
            }));
        savedRead.current = { key, lifetime, controller, promise };
        void promise.catch(() => {
            if (savedRead.current?.promise === promise) savedRead.current = null;
        });
        return promise;
    }, [accountLifetime]);
    const builtinSelections = React.useMemo(() => BUILTIN_WORKFLOW_CATALOG_V1.map((entry): WorkflowStartSelection => ({
        id: entry.id, name: tLoose(entry.titleKey), description: tLoose(entry.descriptionKey),
        definition: entry.definition, source: { kind: 'catalog', workflow: entry.id },
    })), []);
    const pluginSelections = React.useMemo(() => library.pluginWorkflows.map((entry): WorkflowStartSelection => ({
        id: entry.workflow, name: entry.title, description: entry.description ?? '', definition: entry.definition,
        source: { kind: 'catalog', workflow: entry.workflow, pluginVersion: entry.version },
    })), [library.pluginWorkflows]);
    const asks = React.useCallback((definition: WorkflowDefinitionV1, workflowRef?: string) => {
        const presentation = resolveWorkflowBuiltinInputPresentation(workflowRef);
        const asked = listWorkflowPersonInputs(definition.inputs);
        return asked.length === 0 ? t('workflows.start.noInputs')
            : t('workflows.start.asksFor', { names: asked
                .map(input => presentation?.[input.name]?.title ?? workflowInputTitle(input)).join(', ') });
    }, []);
    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'workflow-start-picker', inputPlaceholder: t('workflows.start.search'),
        sections: [
            { kind: 'static', id: 'builtins', title: t('workflows.start.builtin'), options: builtinSelections.map((entry) => {
            // What it does helps choose; what it asks for is shown once it is chosen.
            const builtin = BUILTIN_WORKFLOW_CATALOG_V1.find((candidate) => candidate.id === entry.id);
            const needsSession = props.hasOriginSession !== true
                && builtin?.requiresOriginSession === true;
            return {
                // An unavailable pattern says why in place of what it does; the reason is the line that matters here.
                id: entry.id, label: entry.name,
                icon: builtin ? <WorkflowPurposeGlyph purpose={builtin.purpose} size={ICON_SIZE.md} color={theme.colors.text.secondary} /> : undefined,
                subtitle: needsSession ? t('workflows.start.needsSession') : entry.description || asks(entry.definition, entry.id),
                testID: `workflow-choice:${entry.id}`,
                detailContent: () => <WorkflowStartPreview selection={entry} />,
                disabled: needsSession,
            }; }) },
            { kind: 'dynamic', id: 'library', title: t('workflows.start.library'),
                resolverKey: JSON.stringify([libraryPhase, ...library.definitions.map((entry) => [entry.definitionId, entry.revision, entry.contentStatus,
                    entry.contentStatus === 'unavailable' ? entry.contentUnavailableReason : null])]),
                showSkeletonsOnFirstLoad: true,
                loadingSkeletonRows: 2,
                retryLabel: t('common.retry'),
                resolve: async (query, signal) => {
                    const lifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
                    if (lifetime === null || !lifetime.isCurrent()) return { options: [] };
                    const current = libraryRef.current;
                    if (current.definitions.length === 0 && current.status === 'failed' && current.failure) {
                        if (shownFailureRef.current !== current.failure) {
                            shownFailureRef.current = current.failure;
                            throw new SelectionListSectionFailure({ hint: current.failure.message });
                        }
                        // Retry pressed on the failure line already shown: read the library again.
                        current.retry();
                        return untilAborted(signal);
                    }
                    if (current.definitions.length === 0 && current.status !== 'loaded') return untilAborted(signal);
                    if (current.definitions.length === 0) return { options: [], emptyHint: t('workflows.destination.libraryEmpty') };
                    // Header pages own list identity and search; only the preview/choice demands a body.
                    const rows = current.definitions.filter((entry) =>
                        formatWorkflowDefinitionLibraryTitle(entry).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                    ).map((header) => {
                        if (header.contentStatus === 'unavailable') return {
                            id: header.definitionId, label: formatWorkflowDefinitionLibraryTitle(header),
                            icon: <Icon name="tree-structure" size={ICON_SIZE.md} color={theme.colors.text.secondary} />,
                            subtitle: formatWorkflowDefinitionContentUnavailableReason(header.contentUnavailableReason), disabled: true,
                        };
                        return { id: header.definitionId, label: formatWorkflowDefinitionLibraryTitle(header),
                            icon: <Icon name="tree-structure" size={ICON_SIZE.md} color={theme.colors.text.secondary} />,
                            subtitle: [t('workflows.examples.stepCount', { count: header.stepCount }),
                                header.triggerSummaryErrorCode === undefined ? formatTriggerSetSummary(header.triggers) : t('common.unavailable')].join(' · '),
                            detailContent: () => <SavedWorkflowStartPreview key={JSON.stringify([header.definitionId, header.revision])}
                                header={header} readSelection={readSavedSelection} /> };
                    });
                    if (signal.aborted || !lifetime.isCurrent()) return { options: [] };
                    setLibraryShown(true);
                    return { options: rows };
                },
            },
            { kind: 'static', id: 'plugins', title: t('workflows.plugins.fromPlugins'), options: pluginSelections.map((entry) => ({
                id: entry.id, label: entry.name, subtitle: entry.description || asks(entry.definition, entry.id), testID: `workflow-choice:${entry.id}`,
                icon: <Icon name="tree-structure" size={ICON_SIZE.md} color={theme.colors.text.secondary} />,
                detailContent: () => <WorkflowStartPreview selection={entry} />,
            })) },
        ],
    }), [accountLifetime, asks, builtinSelections, library.definitions, libraryPhase, pluginSelections, props.hasOriginSession, readSavedSelection, theme.colors.text.secondary]);
    return <View>
        {/* A fixed viewport: the library landing never moves the popover or its search field (lab T4-R). */}
        <SelectionList rootStep={rootStep} maxHeight={props.maxHeight} heightBehavior="fixedToMaxHeight" autoFocusInputOnWeb
            currentUiContextCommandScope={props.currentUiContextCommandScope}
            detailPane={PICKER_DETAIL_PANE}
            onSelect={async (id) => {
                setSelectionFailure(null);
                let selection = builtinSelections.find((entry) => entry.id === id)
                    ?? pluginSelections.find((entry) => entry.id === id);
                const header = selection ? undefined : libraryRef.current.definitions.find((entry): entry is SavedWorkflowHeader =>
                    entry.definitionId === id && entry.contentStatus === 'available');
                if (props.onSelectReference !== undefined) {
                    let reference: WorkflowStartReference;
                    if (selection) reference = { source: selection.source, name: selection.name };
                    else if (header) {
                        const lifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
                        if (lifetime === null || !lifetime.isCurrent()) return;
                        reference = { name: formatWorkflowDefinitionLibraryTitle(header),
                            source: { kind: 'saved', definitionId: header.definitionId, revision: header.revision } };
                    } else return;
                    props.onSelectReference(reference);
                    props.onRequestClose();
                    return;
                }
                if (!selection) {
                    if (!header) return;
                    const pending = readSavedSelection(header);
                    const request = savedRead.current;
                    try {
                        selection = await pending;
                    } catch (error) {
                        if (mounted.current && request?.lifetime.isCurrent() && !request.controller.signal.aborted) {
                            setSelectionFailure(resolveWorkflowProblemPresentation(error).message);
                        }
                        return;
                    }
                    if (!mounted.current || !request?.lifetime.isCurrent()
                        || request.controller.signal.aborted || !libraryRef.current.definitions.some(entry =>
                            entry.definitionId === id && entry.contentStatus === 'available')) return;
                }
                if (!selection) return;
                props.onSelect(selection);
                props.onRequestClose();
            }} onRequestClose={props.onRequestClose} />
        {selectionFailure ? <Text accessibilityRole="alert" style={styles.previewBody}>{selectionFailure}</Text> : null}
        {library.hasMore && libraryShown ? <RoundButton size="small" display="inverted" title={t('workflows.destination.loadMoreWorkflows')}
            loading={library.loadingMore} onPress={library.loadMore} /> : null}
    </View>;
}

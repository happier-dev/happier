import { useSession } from '@/sync/domains/state/storage';
import { SessionDraftHydrationBoundary } from '@/components/sessions/drafts/SessionDraftHydrationBoundary';
// Load the canonical read projection before a cold editor publishes a delete acknowledgement.
import { affectsSelectedWorkflowDefinition } from '../library/workflowLibraryReads';
import * as React from 'react';
import { readWorkflowEngineChoiceV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { createWorkflowDefinitionRoute, createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { Platform, ScrollView, View } from 'react-native';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useNavigation, useOpenAppSection, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { randomUUID } from '@/platform/randomUUID';
import { WorkflowEventValueContext } from '../editor/WorkflowEventValueContext';
import { StyleSheet } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope, useActiveServerAccountScopeLifetime, useActiveMachineFacts, useSetting } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t, tLoose } from '@/text';
import { getWorkflowContextChipDefinition } from '../workflowComposerControlPlacements';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import { matchesWorkflowAcceptedDefinitionV1 } from '@happier-dev/protocol/workflows/workflowValidationV1';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { readDeviceTimeZone, type TriggerWhenValue } from '../triggers/sessionTriggerForm';
import { addWorkflowTriggerWhen } from '../triggers/workflowTriggerStarts';
import { WORKFLOW_STARTER_EXAMPLES_V1, materializeWorkflowStarterExample, workflowStarterRequiresSession } from '@happier-dev/protocol/workflows/builtins/examples';
import { getBuiltinWorkflowCatalogV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import type { ArtifactCallerAccessV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { projectNativeJsonValueForTransport, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { isWorkflowProjectTarget, type WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import type { WorkflowArtifactRevisionV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';

import {
    deleteWorkflowDefinition,
    getWorkflowDefinition,
    isWorkflowDefinitionConflictError,
} from '@/sync/domains/workflows/workflowDefinitionActions';
import {
    buildWorkflowDefinitionCandidate,
    buildWorkflowEditorDraftFromDefinition,
    validateWorkflowEditorDraft,
} from '@/sync/domains/workflows/workflowAuthoring';
import { createWorkflowTriggerIncompleteSeed, type WorkflowTriggerDraftSeedIntent } from '../triggers/workflowTriggerStarts';
import { readWorkflowDefinitionDraftSeed, storeWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { useWorkflowEditorDraftSeed } from '@/sync/domains/workflows/workflowEditorDraftSeed';
import {
    createWorkflowEditorDraft,
    selectWorkflowBlock,
    setWorkflowInspectorGroupExpanded,
    EMPTY_WORKFLOW_EDITOR_VIEW_STATE,
    type WorkflowEditorDraft,
    type WorkflowEditorViewState,
} from '@/sync/domains/workflows/workflowEditorDraft';
import type { WorkflowStarterSessionTarget } from '@happier-dev/protocol/workflows/builtins/examples';
import { applyWorkflowDefinitionEditsV1, countWorkflowStepsV1, setWorkflowDefaultField, setWorkflowStepExecutionField, walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WorkflowDraftEditInputV1Schema, WorkflowMountedDraftV1Schema, type WorkflowDraftEditInputV1, type WorkflowDraftMutationResultV1 } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import type { WorkflowMountedDraftActions } from '@/sync/ops/actions/workflowAuthoringAction';
import type { WorkflowActionCallerContext } from '@/sync/domains/workflows/callWorkflowAction';
import { EMPTY_WORKFLOW_ANNOUNCEMENT_STATE, selectWorkflowAnnouncement } from '../accessibility/workflowAnnouncementSelection';
import { formatWorkflowAnnouncement } from '../accessibility/useWorkflowAnnouncements';
import { useWorkflowRunNowController } from '../run/useWorkflowRunNowController';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import {
    resolveAdmittedWorkflowExecutionTarget,
    resolveWorkflowRunAsTargets,
    type WorkflowRunAsTargetKind,
} from '../run/workflowRunAsTargets';
import { useWorkflowDetachedRunSupport } from '../run/useWorkflowDetachedRunSupport';
import { resolveContextualWorkflowProjectTarget } from './resolveContextualWorkflowTarget';
import { readWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { deriveWorkflowPlanRunId, readWorkflowPlanResult, startWorkflowPlanReview } from '@/sync/domains/workflows/workflowPlanReview';
import { createWorkflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { Switch } from '@/components/ui/forms/Switch';
import { readNewSessionAutomationHandoffSeed } from '@/sync/domains/workflows/newSessionAutomationHandoffSeed';
import { readTriggerWorkflowSeed, retargetTriggerToWorkflow } from '../triggers/triggerWorkflowSeed';
import {
    useWorkflowRunComposerModal,
    type WorkflowRunComposerModalProps,
} from '../run/useWorkflowRunComposerModal';
import { WorkflowEditorBody, type WorkflowEditorCommands, type WorkflowEditorView } from './WorkflowEditorBody';
import { WorkflowDefaultEngineControls } from '../editor/WorkflowDefaultEngineControls';
import { useWorkflowAuthoringHost } from './useWorkflowAuthoringHost';
import type { WorkflowSaveConflict, WorkflowSaveStatusState } from '../editor/WorkflowSaveStatus';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { WorkflowMissingDefinitionState } from './WorkflowMissingDefinitionState';
import { WorkflowEditorCurrentContext } from './WorkflowEditorCurrentContext';
import { WorkflowExamplesSection } from '../library/WorkflowExamplesSection';
import { WorkflowTriggerSection } from '../triggers/WorkflowTriggerSection';
import { useWorkflowTriggerEditing } from '../triggers/useWorkflowTriggerEditing';
import { editWorkflowTriggerDraft, EMPTY_WORKFLOW_TRIGGER_DRAFT, projectWorkflowTriggerRows, WorkflowTriggerSnapshotRestoreError, type WorkflowTriggerSnapshot } from '../triggers/workflowTriggerDraft';
import { formatTriggerResultDecides } from '../triggers/formatTriggerSummary';
import { useWorkflowEditorHistory, useWorkflowEditorHistoryLabels, workflowEditorSnapshotsEqual } from '../editor/useWorkflowEditorHistory';
import { createWorkflowEditorReadable, useWorkflowEditorSelector, type WorkflowEditorDraftStore } from '../editor/workflowEditorDraftStore';
import { saveWorkflowEditorDefinition, type PendingWorkflowDefinitionCreate } from '../editor/saveWorkflowEditorDefinition';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { formatWorkflowWhereSummary } from '../editor/WorkflowProjectTargetControl';
import { createExecutionRunStartContentChip } from '@/components/sessions/runs/launcher/executionRunStartChips';
import { createWorkflowStartPlacementChips } from '../run/workflowStartPlacementChips';
import { useActionFieldOptionsForMachine } from '@/components/sessions/actions/useSessionActionFieldOptions';
import { readWorkflowActionFieldRequests } from '@/components/workflows/presentation/workflowActionFieldRequests';
import { formatWorkflowProblemMessage, resolveWorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { exportWorkflowDocumentViaAction, importWorkflowDocumentViaAction, type WorkflowImportResult } from '@/sync/domains/workflows/workflowInterchange';
import {
    pickWorkflowDocumentText,
} from '@/sync/domains/workflows/workflowDocumentFile';
import { confirmWorkflowDocumentExport } from '../actions/confirmWorkflowDocumentExport';
import { WorkflowImportReview } from '../editor/WorkflowImportReview';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import { readWorkflowAgentRevision, type WorkflowAgentRevision } from '@/sync/domains/workflows/workflowAgentRevision';
import { seedWorkflowAgentDraft, useWorkflowAgentAuthoring } from '../authoring/useWorkflowAgentAuthoring';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { useWorkflowAgentRevision } from '../authoring/useWorkflowAgentRevision';
import { useWorkflowTestRunPresentation } from '../editor/useWorkflowTestRunPresentation';
import { buildWorkflowAgentAuthoringSeed } from '@/sync/domains/workflows/workflowAgentAuthoringSeed';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useWorkflowEditorAccountMemory } from './useWorkflowEditorAccountMemory';
import { WorkflowAccountLifetimeProvider } from '../workflowAccountScope';
import { useEntityComposerMention } from '@/components/ui/treeDragDrop/useEntityComposerMention';

const styles = StyleSheet.create((theme) => ({
    // The page's paper, as the editor body paints it (its loading and missing states included).
    root: {
        flex: 1,
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.base, 'content', true),
    },
}));

type WorkflowEditorSnapshot = Readonly<{
    draft: WorkflowEditorDraft;
    description: string;
    projectTarget: WorkflowProjectTargetV1 | null;
    executionTarget: WorkflowRunAsTargetKind;
    triggers: WorkflowTriggerSnapshot;
}>;

/**
 * Route host for the neutral workflow editor.
 *
 * It owns draft identity, hydration, Account currentness and the two explicit
 * effects — Run now and Save workflow. Save writes the Account Artifact, then
 * this Account's trigger delta through `workflow.trigger.*` (04 §5.4); Run now
 * freezes the displayed draft through run admission without saving it. Neither
 * is a mode of the other.
 */

/**
 * What a saved-row entry asked for besides opening the definition.
 *
 * Edit, Run now and Schedule are three intents over one editor, not one route:
 * a saved definition carries no reviewed Machine or page-level **Run as**
 * choice, so the collection cannot admit a Run by itself; Schedule reveals the
 * editor's Runs automatically section.
 * It opens the exact Artifact revision here and names the intent; this host
 * then presses its own canonical action once that revision is hydrated.
 */
export type WorkflowSavedEntryIntent = 'run' | 'schedule';

export type WorkflowEditorSource =
    | Readonly<{
        kind: 'new';
        /** A public, read-only catalog selection; Save is the only persistence effect. */
        exampleKey?: string;
        builtinId?: string;
        requestImport?: boolean;
        /**
         * Opaque handle to an accepted definition a person chose to review as a
         * new Run after in-place recovery proved impossible. It seeds the draft
         * and its placement; nothing is admitted until Run now is pressed.
         */
        reviewedRunSeedId?: string;
        /**
         * Opaque handle to New Session's composed prompt ("Make this prompt a workflow…", 04 §5.5):
         * it seeds the draft, its placement and the first step's exact composer document. Nothing is
         * written until Save; the editor opens on Runs automatically.
         */
        newSessionDraftSeedId?: string;
        /**
         * Opaque handle to a trigger's own steps opened through Save as workflow (F1): the draft, and
         * the trigger its first Save points at the new workflow.
         */
        triggerWorkflowSeedId?: string;
        /** An unsaved portable copy; the handle carries no Artifact authority. */
        definitionDraftSeedId?: string;
    }>
    | Readonly<{
        kind: 'saved';
        definitionId: string;
        /**
         * What the opening surface asked for once this revision is reviewed.
         * Omitted means Edit: open the definition and change nothing.
         */
        intent?: WorkflowSavedEntryIntent;
        agentRevision?: WorkflowAgentRevision;
        agentRevisionSeedId?: string;
        authoringSessionId?: string;
    }>;

type SavedRevision = Readonly<{ definitionId: string; revision: WorkflowArtifactRevisionV1 }>;


const NO_WORKFLOW_INPUTS: WorkflowEditorDraft['inputs'] = [];
/** One empty identity, so clearing highlights that are already clear does not re-render the editor. */
const NO_HIGHLIGHTED_BLOCKS: readonly string[] = [];
const identityDraft = <T,>(value: T): T => value;

/** Read Roles beside the trigger controls without subscribing the editor host to step typing. */
function WorkflowEditorTriggerSection(props: React.ComponentProps<typeof WorkflowTriggerSection> & Readonly<{
    draftStore: WorkflowEditorDraftStore;
}>) {
    const { draftStore, ...section } = props;
    const definition = useWorkflowEditorSelector(draftStore, identityDraft);
    return <WorkflowTriggerSection {...section} definition={definition} />;
}
/** While the Run review is closed it keeps the draft it last showed. */
const keepShownDraft = (): boolean => true;
/** Equal content keeps the previous value (and identity). */
const sameRetainedValue = <T,>(left: T, right: T): boolean => retainDeep(left, right) === left;

/**
 * The stable semantic identity of an editor source.
 *
 * Route hosts build `source` inline, so its object identity changes on every
 * render and can never decide whether this is the same logical draft. Keying on
 * kind plus the ids that actually select content is what lets a rerender keep
 * the prompt text, caret, steps, scroll position and dirty state, while a
 * genuinely different source still initializes from scratch.
 *
 * New-entry intents are distinct sources when they select different reviewed
 * bytes or ask to replace the draft through Import. The current reviewed seed
 * is retained as source-local state after its committed temp-store intake.
 */
function workflowEditorSourceKey(source: WorkflowEditorSource): string {
    switch (source.kind) {
        case 'new':
            return [
                'new',
                source.reviewedRunSeedId ?? '',
                source.newSessionDraftSeedId ?? '',
                source.triggerWorkflowSeedId ?? '',
                source.definitionDraftSeedId ?? '',
                source.exampleKey ?? '',
                source.builtinId ?? '',
                source.requestImport === true ? 'import' : 'author',
            ].join('\u0000');
        case 'saved':
            return `saved\u0000${source.definitionId}\u0000${source.agentRevisionSeedId ?? ''}`;
    }
}

export function WorkflowEditorHostScreen(props: Readonly<{ source: WorkflowEditorSource; accountLifetime?: ServerAccountScopeLifetime | null }>): React.ReactElement {
    // Workflow definition drafts/seeds are local to this editor; its embedded
    // New Session composer admits its own repository address separately.
    return <WorkflowAccountLifetimeProvider value={props.accountLifetime}><SessionDraftHydrationBoundary addresses={[]}>
        <WorkflowEditorHostScreenReady {...props} /></SessionDraftHydrationBoundary></WorkflowAccountLifetimeProvider>;
}

function WorkflowEditorHostScreenReady(props: Readonly<{
    source: WorkflowEditorSource;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): React.ReactElement {
    const mountedRef = useMountedRef();
    const router = useRouter();
    const openSection = useOpenAppSection();
    const destinationInstanceKey = useDestinationInstanceKey();
    const nativeEditorRoute = Platform.OS !== 'web' && destinationInstanceKey === null;
    const navigation = useNavigation();
    // A retained editor tab behind another tab parks its Machine inventory and reads the current one when shown.
    const presented = useLayoutPresentationActive();
    const focusedMachines = useActiveMachineFacts(props.accountLifetime === undefined, presented);
    const focusedAccountScope = useActiveServerAccountScope();
    const focusedAccountLifetime = useActiveServerAccountScopeLifetime();
    const accountLifetime = props.accountLifetime === undefined ? focusedAccountLifetime : props.accountLifetime;
    const workflowRunDetailActions = React.useMemo(() => createWorkflowRunDetailActions({ accountLifetime }), [accountLifetime]);
    const activeAccountScope = accountLifetime?.scope ?? null;
    const mention = useEntityComposerMention();
    const addressedMachines = useMachineListForServer(activeAccountScope?.serverId ?? '', props.accountLifetime !== undefined, presented);
    const machines = props.accountLifetime === undefined ? focusedMachines : addressedMachines ?? [];
    const accountScopeKey = activeAccountScope === null
        ? null
        : serverAccountScopeKeySuffix(activeAccountScope);
    const runNow = useWorkflowRunNowController(accountLifetime,
        props.source.kind === 'saved' || destinationInstanceKey !== null
            ? `editor:${destinationInstanceKey ?? ''}:${workflowEditorSourceKey(props.source)}` : undefined);
    const agentSeedId = props.source.kind === 'saved' ? props.source.agentRevisionSeedId ?? null : null;
    const [agentSeedState, setAgentSeedState] = React.useState(() => ({
        id: agentSeedId, seed: agentSeedId === null ? null : readWorkflowAgentRevision(agentSeedId),
        lifetime: accountLifetime,
    }));
    if (agentSeedState.id !== agentSeedId) {
        setAgentSeedState({ id: agentSeedId, seed: agentSeedId === null ? null : readWorkflowAgentRevision(agentSeedId),
            lifetime: accountLifetime });
    }
    const agentSeed = agentSeedState.id === agentSeedId && agentSeedState.seed?.lifetime?.isCurrent()
        ? agentSeedState.seed : null;
    React.useEffect(() => {
        const lifetime = agentSeedState.seed?.lifetime;
        if (!lifetime) return;
        const subscription = lifetime.onRetire(() => setAgentSeedState((current) => ({ ...current, seed: null })));
        return () => subscription.dispose();
    }, [agentSeedState.seed]);
    const [highlightedBlockIds, setHighlightedBlockIds] = React.useState<readonly string[]>(NO_HIGHLIGHTED_BLOCKS);
    const [savedByAgent, setSavedByAgent] = React.useState(false);
    const observedAgentRevisionRef = React.useRef<string | null>(null);

    const reviewedRunSeedId = props.source.kind === 'new'
        ? props.source.reviewedRunSeedId ?? null
        : null;
    // Render can be replayed before commit. Read non-destructively and retain
    // only the seed for this logical source; the committed editor consumes it.
    const reviewedRunSeedState = useWorkflowEditorDraftSeed(reviewedRunSeedId, readWorkflowReviewedRunSeed, props.accountLifetime);
    const reviewedRunSeed = reviewedRunSeedState.seed;

    /**
     * A private seed belongs to the exact server and Account that opened it.
     *
     * A reviewed Run copy and a captured Session both arrive as already-decrypted
     * Account-private bytes held in memory, not as an id another Account could
     * re-open. Re-initialization is keyed on the Account, so without this the
     * Account-only change re-adopted those same bytes and stamped them with the
     * new scope — presenting, and offering to save, one Account's private
     * workflow as another's. There is nothing to re-read, so the honest outcome
     * is to withdraw the seed and say so.
     */
    // All unsaved handoffs are render-safe and retained only for their original
    // Account lifetime; the committed editor consumes their route handles.
    const newSessionDraftSeedId = props.source.kind === 'new' ? props.source.newSessionDraftSeedId ?? null : null;
    const newSessionSeedState = useWorkflowEditorDraftSeed(newSessionDraftSeedId, readNewSessionAutomationHandoffSeed, props.accountLifetime);
    const newSessionSeed = newSessionSeedState.seed;
    const triggerWorkflowSeedId = props.source.kind === 'new' ? props.source.triggerWorkflowSeedId ?? null : null;
    const triggerSeedState = useWorkflowEditorDraftSeed(triggerWorkflowSeedId, readTriggerWorkflowSeed, props.accountLifetime);
    const triggerSeed = triggerSeedState.seed;
    const definitionDraftSeedId = props.source.kind === 'new' ? props.source.definitionDraftSeedId ?? null : null;
    const definitionDraftSeedState = useWorkflowEditorDraftSeed(definitionDraftSeedId, readWorkflowDefinitionDraftSeed, props.accountLifetime);
    const definitionDraftSeed = definitionDraftSeedState.seed;
    const privateDraftSeedUnavailable = [reviewedRunSeedState, definitionDraftSeedState, newSessionSeedState, triggerSeedState]
        .some(({ id, seed }) => id !== null && seed === null);
    const newCatalogSource = props.source.kind === 'new' ? props.source : null;
    const catalogSeed = newCatalogSource !== null
        ? WORKFLOW_STARTER_EXAMPLES_V1.find((entry) => entry.key === newCatalogSource.exampleKey)
            ?? getBuiltinWorkflowCatalogV1().find((entry) => entry.id === newCatalogSource.builtinId)
        : undefined;
    // The trigger still to point at this workflow once it is saved; cleared when that write lands.
    const pendingRetargetRef = React.useRef(triggerSeed?.retarget ?? null);
    const [retargetFailed, setRetargetFailed] = React.useState(false);
    const createDraftForSource = (
        seed: typeof reviewedRunSeed,
    ): WorkflowEditorDraft | null => (
        privateDraftSeedUnavailable ? null : seed !== null
            ? buildWorkflowEditorDraftFromDefinition({
                draftId: randomUUID(),
                name: seed.name,
                definition: seed.definition,
                captureProvenance: seed.captureProvenance,
            })
            : definitionDraftSeed !== null
                ? definitionDraftSeed.draft ?? (definitionDraftSeed.definition === undefined
                    ? createWorkflowEditorDraft({ draftId: randomUUID(), name: definitionDraftSeed.name, blocks: [] })
                    : buildWorkflowEditorDraftFromDefinition({ draftId: randomUUID(), ...definitionDraftSeed, definition: definitionDraftSeed.definition }))
            : newSessionSeed !== null
                ? newSessionSeed.draft
                : triggerSeed !== null
                    ? buildWorkflowEditorDraftFromDefinition({ draftId: randomUUID(), name: '', definition: triggerSeed.definition })
                    : catalogSeed !== undefined
                        ? buildWorkflowEditorDraftFromDefinition({ draftId: randomUUID(), name: tLoose(catalogSeed.titleKey), definition: catalogSeed.definition })
                        : createWorkflowEditorDraft({ draftId: randomUUID() })
    );

    /**
     * The draft lives in a store this editor owns, not in its React state: a keystroke re-renders
     * only the fields that read the changed slice (the body's regions and controls), never this
     * whole screen. Readers here subscribe to the facts they decide on; handlers read it when called.
     */
    const [draftStore] = React.useState(() => createWorkflowEditorReadable<WorkflowEditorDraft | null>(
        props.source.kind === 'saved' ? null : createDraftForSource(reviewedRunSeed),
    ));
    /** The accepted snapshot every Save, Action and history entry reads; its draft follows the store. */
    const snapshotRef = React.useRef<WorkflowEditorSnapshot | null>(null);
    const writeDraft = (next: WorkflowEditorDraft | null, write: (value: WorkflowEditorDraft | null) => void) => {
        write(next);
        const current = snapshotRef.current;
        if (next !== null && current !== null && current.draft !== next) snapshotRef.current = { ...current, draft: next };
    };
    const setDraft = (next: WorkflowEditorDraft | null) => writeDraft(next, draftStore.set);
    // Readers re-render with this screen's own render, so a write made while rendering is announced at commit.
    const stageDraftDuringRender = (next: WorkflowEditorDraft | null) => writeDraft(next, draftStore.stage);
    React.useLayoutEffect(() => { draftStore.publish(); });
    const draftId = useWorkflowEditorSelector(draftStore, (value) => value?.draftId ?? null);
    /** The body reads a present draft; between this screen's write and its re-render it keeps the last one. */
    const bodyDraftStore = React.useMemo((): WorkflowEditorDraftStore => {
        let shown: WorkflowEditorDraft | null = null;
        return { subscribe: draftStore.subscribe, get: () => {
            const value = draftStore.get();
            if (value !== null) shown = value;
            return shown!;
        } };
    }, [draftStore]);
    // The pristine baseline is the exact draft this editor started from, not a
    // second construction of it: comparing against a different object with a
    // different draft id would report an untouched editor as dirty.
    const initialDraftBaselineRef = React.useRef<WorkflowEditorDraft | null>(draftStore.get());
    const [contentScopeKey, setContentScopeKey] = React.useState<string | null>(
        props.source.kind === 'saved' ? null : accountScopeKey,
    );
    const [saved, setSaved] = React.useState<SavedRevision | null>(null);
    const [savedRouteId, setSavedRouteId] = React.useState<string | null>(null);
    /** Bumped whenever a different logical source takes over this editor. */
    const sourceGenerationRef = React.useRef(0);
    const [testSource, setTestSource] = React.useState<Awaited<ReturnType<typeof getWorkflowDefinition>> | null>(null);
    const [testSourcePending, setTestSourcePending] = React.useState(false);
    const [testRun, setTestRun] = React.useState<Readonly<{ runId: string; definition: Awaited<ReturnType<typeof getWorkflowDefinition>>['definition'] }> | null>(null);
    const [definitionAccess, setDefinitionAccess] = React.useState<ArtifactCallerAccessV1 | null>(null);
    const accessResolved = (props.source.kind === 'new' && saved === null) || definitionAccess !== null;
    const canEditDefinition = accessResolved && definitionAccess !== 'view';
    // Definition grants do not confer ownership of anyone else's trigger set.
    // Every admitted reader manages only the active Account's personal set.
    const canManagePersonalTriggers = accessResolved;
    // A successful Copy acknowledges a new current Artifact without replacing
    // this route's accepted draft or its pending personal-memory Save.
    const editableDefinitionId = saved?.definitionId ?? (props.source.kind === 'saved' ? props.source.definitionId : null);
    const routeAgentSourceIsCurrent = props.source.kind === 'saved' && props.source.definitionId === editableDefinitionId;
    const sourceKind = props.source.kind;
    const sourceDefinitionId = props.source.kind === 'saved' ? props.source.definitionId : null;
    const privateSeedWithdrawn = reviewedRunSeedState.retired || definitionDraftSeedState.retired
        || newSessionSeedState.retired || triggerSeedState.retired;
    const requestedInitializationKey = `${workflowEditorSourceKey(props.source)}\u0000${accountScopeKey ?? ''}\u0000${privateSeedWithdrawn ? 'withdrawn' : ''}`;
    const [initializedKey, setInitializedKey] = React.useState(requestedInitializationKey);
    // The first Save assigns an Artifact identity to this exact accepted draft.
    // Its URL promotion is not a new document or Account initialization boundary.
    const firstSavePromotion = sourceKind === 'saved'
        && initializedKey.startsWith('new\u0000')
        && saved !== null && sourceDefinitionId === saved.definitionId
        && savedRouteId === sourceDefinitionId
        && contentScopeKey === accountScopeKey
        && agentSeedId === null
        && props.source.kind === 'saved' && props.source.agentRevision === undefined;
    const initializationKey = requestedInitializationKey;
    const authoringSourceKey = String(sourceGenerationRef.current);
    const [agentSession, setAgentSession] = React.useState<Readonly<{ sessionId: string; serverId: string; scopeKey: string | null; definitionId: string; sourceKey: string }> | null>(null);
    const authoringSessionId = agentSession?.scopeKey === accountScopeKey && agentSession.sourceKey === authoringSourceKey && agentSession.definitionId === editableDefinitionId
        ? agentSession.sessionId : routeAgentSourceIsCurrent && props.source.kind === 'saved' ? agentSeed?.sessionId ?? props.source.authoringSessionId ?? null : null;
    const authoringServerId = agentSession?.sessionId === authoringSessionId ? agentSession.serverId : activeAccountScope?.serverId ?? null;
    const authoringHomeIsActive = authoringServerId !== null && focusedAccountScope !== null
        && areServerProfileIdentifiersEquivalent(authoringServerId, focusedAccountScope.serverId);
    const liveAgentRevision = useWorkflowAgentRevision(authoringHomeIsActive ? authoringSessionId : null, editableDefinitionId, `${authoringSourceKey}\u0000${accountScopeKey ?? ''}`);
    const initialAgentRevision = routeAgentSourceIsCurrent && props.source.kind === 'saved' ? props.source.agentRevision ?? agentSeed?.snapshot ?? null : null;
    const agentRevision = liveAgentRevision && (!initialAgentRevision
        || liveAgentRevision.revision.headerVersion > initialAgentRevision.revision.headerVersion
        || liveAgentRevision.revision.bodyVersion > initialAgentRevision.revision.bodyVersion) ? liveAgentRevision : initialAgentRevision;
    const onAgentSessionCreated = React.useCallback((target: Readonly<{ sessionId: string; serverId: string }>) => {
        if (editableDefinitionId === null || authoringSourceKey !== String(sourceGenerationRef.current)) return;
        setAgentSession({ ...target, scopeKey: accountScopeKey, definitionId: editableDefinitionId, sourceKey: authoringSourceKey });
    }, [accountScopeKey, authoringSourceKey, editableDefinitionId]);
    const openAgentAuthoring = useWorkflowAgentAuthoring(onAgentSessionCreated, t('workflows.authoring.edit'));
    // Edit with an agent opens in the details pane's Agent tab where the pane exists (04 §4.6,
    // §4.7; 07 S22): the seeded ordinary composer shows there, and its Session replaces it once sent.
    const detailsPaneAvailable = useDetailsPaneAvailable();
    const [agentDraft, setAgentDraft] = React.useState<Readonly<{
        draftId: string; serverId: string; isCurrent: () => boolean; scopeKey: string | null; definitionId: string; sourceKey: string;
    }> | null>(null);
    const authoringDraft = agentDraft !== null && agentDraft.scopeKey === accountScopeKey && agentDraft.sourceKey === authoringSourceKey
        && agentDraft.definitionId === editableDefinitionId && authoringSessionId === null ? agentDraft : null;
    const openAgentEdit = React.useCallback((seed: ReturnType<typeof buildWorkflowAgentAuthoringSeed>) => {
        if (!detailsPaneAvailable || editableDefinitionId === null) {
            openAgentAuthoring(seed);
            return;
        }
        const definitionId = editableDefinitionId;
        seedWorkflowAgentDraft(seed, (draft) => {
            if (authoringSourceKey !== String(sourceGenerationRef.current)) return;
            setAgentDraft({ ...draft, scopeKey: accountScopeKey, definitionId, sourceKey: authoringSourceKey });
        }, props.accountLifetime);
    }, [accountLifetime, accountScopeKey, authoringSourceKey, detailsPaneAvailable, editableDefinitionId, openAgentAuthoring]);
    const onAgentDraftSessionCreated = React.useCallback((_destination: string, target: Readonly<{ sessionId: string; serverId: string }>) => {
        if (agentDraft === null || !agentDraft.isCurrent() || agentDraft.sourceKey !== String(sourceGenerationRef.current)) return;
        setAgentDraft(null);
        onAgentSessionCreated(target);
    }, [agentDraft, onAgentSessionCreated]);
    const [hydrationFailure, setHydrationFailure] = React.useState<Readonly<{ error: unknown }> | null>(null);
    const hydrationRefreshRef = React.useRef<(() => void) | null>(null);
    const [view, setView] = React.useState<WorkflowEditorView>(definitionDraftSeed?.initialView ?? 'steps');
    const [selection, setSelection] = React.useState<WorkflowEditorViewState>(EMPTY_WORKFLOW_EDITOR_VIEW_STATE);
    const [inputValues, setInputValues] = React.useState<Readonly<Record<string, JsonValue | undefined>>>(reviewedRunSeed?.inputs ?? {});
    const [inputRawTextValues, setInputRawTextValues] = React.useState<Readonly<Record<string, string>>>({});
    const [inputSheetOpen, setInputSheetOpen] = React.useState(reviewedRunSeed?.planReview !== undefined);
    const [planEditingAccepted, setPlanEditingAccepted] = React.useState(false);
    const planReview = planEditingAccepted ? undefined : reviewedRunSeed?.planReview;
    const planOriginReadable = props.accountLifetime === undefined || accountLifetime?.isCurrent() === true;
    const planOrigin = useSession(planOriginReadable ? planReview?.originSessionId ?? '' : '', props.accountLifetime?.scope.serverId);
    const ownedPlanOriginId = planOrigin && isSessionAccessOwner(planOrigin.access, planOrigin.accessLevel) ? planOrigin.id : null;
    const planOriginName = planOrigin?.metadata?.summary?.text ?? t('agentStart.reportToSession');
    const [reportBack, setReportBack] = React.useState(true);
    const [planPending, setPlanPending] = React.useState(false);
    const planPendingRef = React.useRef(false);
    const [savePending, setSavePending] = React.useState(false);
    // A failed create may already be committed. Save and a deliberate Copy are
    // distinct intents; each retries its original id and content until readback.
    const pendingDefinitionCreatesRef = React.useRef<{ save: PendingWorkflowDefinitionCreate | null; copy: PendingWorkflowDefinitionCreate | null }>({ save: null, copy: null });
    const [deletePending, setDeletePending] = React.useState(false);
    const deletePendingRef = React.useRef(false);
    const deleteAbortRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => deleteAbortRef.current?.abort(), []);
    const [saveConflict, setSaveConflict] = React.useState<WorkflowSaveConflict | null>(null);
    /**
     * The description is Artifact metadata beside the name, outside the portable
     * definition: hydrated from the opened revision (or a reviewed copy's seed)
     * and written with the title on Save.
     */
    const [description, setDescription] = React.useState<string>(reviewedRunSeed?.description ?? definitionDraftSeed?.description ?? newSessionSeed?.description
        ?? (catalogSeed === undefined ? '' : tLoose(catalogSeed.descriptionKey)));
    const savedDescriptionRef = React.useRef<string>(description);
    /** When this editor last saved (for "Saved just now"); `null` after opening a revision. */
    const [savedAtMs, setSavedAtMs] = React.useState<number | null>(null);
    /** The last explicit Save's failure, stated in the save status until the next Save. */
    const [saveFailure, setSaveFailure] = React.useState<string | null | undefined>(undefined);
    // Every host-carried intent goes through the page's own command gate, so
    // it can never bypass the reason the page shows beside the visible action.
    const editorCommandsRef = React.useRef<WorkflowEditorCommands | null>(null);
    const runNowAnchorRef = React.useRef<View | null>(null);
    /** The header's save line: Run review opens below it rather than over it. */
    const runNowPlacementRef = React.useRef<View | null>(null);
    const testRunAnchorRef = React.useRef<View | null>(null);
    // The contextual default comes from the canonical New Session resolver, and
    // only when it produces a genuinely valid choice (UX §2.3). A reviewed copy
    // keeps its predecessor's accepted target instead.
    const accountMemory = useWorkflowEditorAccountMemory(props.accountLifetime, { workspaceRefs: false });
    const recentMachinePaths = accountMemory.recentMachinePaths as
        | ReadonlyArray<Readonly<{ machineId?: string | null; path?: string | null }>>
        | undefined;
    const rememberedDefinitionId = initializedKey === initializationKey
        ? saved?.definitionId ?? sourceDefinitionId : sourceDefinitionId;
    const rememberedProject = rememberedDefinitionId === null ? null
        : accountMemory.workflowProjectTargetsByDefinitionId[rememberedDefinitionId] ?? null;
    const rememberAuthoringMemory = accountMemory.remember;
    const newSessionProject = newSessionSeed?.project && isWorkflowProjectTarget(newSessionSeed.project) ? newSessionSeed.project : null;
    const resolveStarterProject = (target: WorkflowStarterSessionTarget): WorkflowProjectTargetV1 | null => {
        if (activeAccountScope === null) return null;
        const workspace = resolveWorkspaceTargetForSession({ sessionId: target.sessionId, serverId: activeAccountScope.serverId });
        if (workspace === null || workspace.machineId !== target.machineId) return null;
        const project = { machineId: workspace.machineId, directory: workspace.rootPath };
        return isWorkflowProjectTarget(project) ? project : null;
    };
    const starterProject = definitionDraftSeed?.sessionTarget === undefined ? null : resolveStarterProject(definitionDraftSeed.sessionTarget);
    const [projectTarget, setProjectTargetState] = React.useState<WorkflowProjectTargetV1 | null>(
        definitionDraftSeed?.project ?? rememberedProject ?? reviewedRunSeed?.project ?? newSessionProject ?? starterProject,
    );
    const savedProjectTargetRef = React.useRef(projectTarget);
    const authoredProjectTargetRef = React.useRef(false);
    const setProjectTarget = React.useCallback((target: WorkflowProjectTargetV1 | null) => {
        authoredProjectTargetRef.current = true;
        setProjectTargetState(target);
    }, []);
    const seededContextualTargetRef = React.useRef(definitionDraftSeed?.project !== undefined || reviewedRunSeed?.project !== undefined || newSessionProject !== null
        || definitionDraftSeed?.sessionTarget !== undefined || rememberedProject !== null);
    /** Whether this logical source has already been offered the contextual Agent. */
    const seededContextualAgentRef = React.useRef(false);
    React.useEffect(() => {
        // A delayed Account projection may replace only the contextual seed,
        // never a Machine/path the person or a mounted Action already authored.
        if (definitionDraftSeed?.project !== undefined || rememberedProject === null || authoredProjectTargetRef.current) return;
        savedProjectTargetRef.current = rememberedProject;
        seededContextualTargetRef.current = true;
        setProjectTargetState(rememberedProject);
    }, [definitionDraftSeed?.project, rememberedProject]);
    React.useEffect(() => {
        if (seededContextualTargetRef.current) return;
        const contextual = resolveContextualWorkflowProjectTarget({
            machines,
            scope: accountLifetime?.isCurrent() ? activeAccountScope : null,
            recentMachinePaths: recentMachinePaths ?? [],
        });
        // Nothing valid yet is not a reason to fabricate one; the control stays
        // visibly unresolved and Run now states that as its blocking reason.
        if (contextual === null) return;
        seededContextualTargetRef.current = true;
        savedProjectTargetRef.current = contextual;
        setProjectTargetState((current) => current ?? contextual);
    }, [accountLifetime, activeAccountScope, initializationKey, machines, recentMachinePaths]);
    // Run as is one page-level, Run-scoped choice. A reviewed copy keeps the
    // runtime its predecessor actually accepted rather than silently reverting
    // to the protocol default. Which runtimes are offered is projected from the
    // canonical Execution Run capability owner for the exact selected machine,
    // never from a standing policy constant.
    const detachedRunSupport = useWorkflowDetachedRunSupport(
        projectTarget?.machineId ?? null,
        activeAccountScope?.serverId ?? null,
    );
    const runAsTargets = React.useMemo(
        () => resolveWorkflowRunAsTargets({ detachedExecutionRun: detachedRunSupport }),
        [detachedRunSupport],
    );
    const [executionTarget, setExecutionTarget] = React.useState<WorkflowRunAsTargetKind>(
        definitionDraftSeed?.executionTarget ?? reviewedRunSeed?.executionTarget.kind ?? 'session',
    );

    // Explicit Plan identities and an unsaved draft's first-save promotion keep
    // their existing handle; route-stable pending custody stays in runNow.
    const pendingRunIdRef = React.useRef<string | null>(null);
    const pendingRunId = runNow.pendingRunId ?? pendingRunIdRef.current;
    /** The draft exactly as loaded at `saved.revision`, for edited-since-save detection. */
    const savedDraftRef = React.useRef<WorkflowEditorDraft | null>(null);
    /** Whether this source already consumed its one-shot "open in import" request. */
    const importRequestedRef = React.useRef(false);
    /** Which saved-row entry intent this source already pressed. */
    const consumedEntryIntentKeyRef = React.useRef<string | null>(null);

    /**
     * One logical source initializes exactly once.
     *
     * Route hosts rebuild `source` on every render, so an effect keyed on it
     * re-created the draft continuously: every keystroke was followed by a fresh
     * draft id, which discarded the prompt text and caret and made an untouched
     * editor read as dirty against a baseline it no longer matched. The key
     * below is semantic, and re-initialization happens during render so the
     * next paint already shows the new source — Account-private Artifact content
     * is retired before another Account's same opaque id can resolve.
     */
    if (firstSavePromotion && initializedKey !== initializationKey) {
        setInitializedKey(initializationKey);
        setSavedRouteId(null);
    }
    if (initializedKey !== initializationKey && !firstSavePromotion) {
        // A withdrawn private seed has no bytes to re-adopt; it must not fall
        // back to an empty draft that looks like the reviewed copy opened fine.
        const withdrawn = privateSeedWithdrawn;
        const nextReviewedRunSeed = reviewedRunSeed;
        const next = sourceKind === 'saved' || withdrawn
            ? null
            : createDraftForSource(nextReviewedRunSeed);
        // Everything source-local is reset in this one place, and the generation
        // it stamps is what a slower publication is checked against. Collected
        // Run inputs, an open input sheet, a pending Run id, a save in flight or
        // the page-level Run as choice left behind are how a source-A save or
        // import used to land in source B's editor.
        sourceGenerationRef.current += 1;
        setInitializedKey(initializationKey);
        pendingRetargetRef.current = withdrawn ? null : triggerSeed?.retarget ?? null;
        setRetargetFailed(false);
        stageDraftDuringRender(next);
        initialDraftBaselineRef.current = next;
        savedDraftRef.current = null;
        setSaved(null);
        setTestSource(null);
        setTestSourcePending(false);
        setTestRun(null);
        setDefinitionAccess(null);
        setSaveConflict(null);
        setSavedAtMs(null);
        setSavedByAgent(false);
        setHighlightedBlockIds(NO_HIGHLIGHTED_BLOCKS);
        observedAgentRevisionRef.current = null;
        setSaveFailure(undefined);
        const nextDescription = withdrawn ? '' : nextReviewedRunSeed?.description ?? definitionDraftSeed?.description ?? newSessionSeed?.description
            ?? (catalogSeed === undefined ? '' : tLoose(catalogSeed.descriptionKey));
        setDescription(nextDescription);
        savedDescriptionRef.current = nextDescription;
        setSavePending(false);
        pendingDefinitionCreatesRef.current = { save: null, copy: null };
        setDeletePending(false);
        deleteAbortRef.current?.abort();
        deleteAbortRef.current = null;
        deletePendingRef.current = false;
        setSavedRouteId(null);
        setHydrationFailure(null);
        setSelection(EMPTY_WORKFLOW_EDITOR_VIEW_STATE);
        setView(withdrawn ? 'steps' : definitionDraftSeed?.initialView ?? 'steps');
        setInputValues(withdrawn ? {} : nextReviewedRunSeed?.inputs ?? {});
        setInputRawTextValues({});
        setInputSheetOpen(!withdrawn && nextReviewedRunSeed?.planReview !== undefined);
        setPlanEditingAccepted(false);
        setReportBack(true);
        setPlanPending(false);
        planPendingRef.current = false;
        setExecutionTarget(withdrawn ? 'session' : definitionDraftSeed?.executionTarget ?? nextReviewedRunSeed?.executionTarget.kind ?? 'session');
        pendingRunIdRef.current = null;
        importRequestedRef.current = false;
        consumedEntryIntentKeyRef.current = null;
        setContentScopeKey(sourceKind === 'saved' ? null : accountScopeKey);
        // A different logical source is a different pristine draft, so the
        // contextual Agent is offered to it again rather than being consumed
        // for the whole mount.
        seededContextualAgentRef.current = false;
        const nextProjectTarget = withdrawn ? null : definitionDraftSeed?.project ?? rememberedProject ?? nextReviewedRunSeed?.project ?? newSessionProject ?? starterProject;
        setProjectTargetState(nextProjectTarget);
        savedProjectTargetRef.current = nextProjectTarget;
        authoredProjectTargetRef.current = false;
        seededContextualTargetRef.current = nextProjectTarget !== null || (!withdrawn && definitionDraftSeed?.sessionTarget !== undefined);
    }

    /**
     * Whether the source this work started under is still the one on screen.
     *
     * The Account lifetime answers "is this still the same Account"; it cannot
     * answer "is this still the same workflow", which is the question a save, an
     * import or a Run admission that outlives a navigation actually needs.
     */
    const captureSourceGeneration = React.useCallback(() => {
        const generation = sourceGenerationRef.current;
        return () => mountedRef.current && sourceGenerationRef.current === generation;
    }, [mountedRef]);

    const retryHydration = React.useCallback(() => {
        setHydrationFailure(null);
        hydrationRefreshRef.current?.();
    }, []);

    const machineName = React.useMemo(() => {
        const machineId = projectTarget?.machineId ?? null;
        if (machineId === null) return null;
        const machine = machines.find((candidate) => candidate.id === machineId);
        return machine === undefined ? machineId : getMachineDisplayName(machine);
    }, [machines, projectTarget?.machineId]);
    // Folders read home-relative wherever this editor says where it runs (07 copy rules).
    const machineHomeDir = machines.find((candidate) => candidate.id === projectTarget?.machineId)?.metadata?.homeDir ?? null;
    // Trigger edits are part of the draft (04 §5.4): written after the definition on Save.
    const initialIncomplete = React.useMemo(() => {
        if (definitionDraftSeed?.incompleteTriggers !== undefined) return definitionDraftSeed.incompleteTriggers;
        return createWorkflowTriggerIncompleteSeed(definitionDraftSeed ?? undefined);
    }, [authoringSourceKey, definitionDraftSeed?.eventSeed, definitionDraftSeed?.nativeEvent, definitionDraftSeed?.incompleteTriggers]);
    const triggers = useWorkflowTriggerEditing({ definitionId: saved?.definitionId ?? null, sourceKey: authoringSourceKey, projectTarget,
        ...(definitionDraftSeed?.lifetimeSession === undefined ? {} : { lifetimeSession: definitionDraftSeed.lifetimeSession }),
        accountLifetime, initialIncomplete });
    const eventValueContext = React.useMemo(() => ({ triggerEvents: triggers.triggerEvents }), [triggers.triggerEvents]);
    const triggerInputs = useWorkflowEditorSelector(draftStore, (value) => value?.inputs ?? NO_WORKFLOW_INPUTS);
    React.useEffect(() => {
        if (privateSeedWithdrawn || saved !== null) return;
        if (definitionDraftSeed?.triggers !== undefined) {
            triggers.restoreSnapshot(definitionDraftSeed.triggers);
            return;
        }
        // A deep link to a schedule template arrives with its schedule too, like one opened from the library.
        const catalogSelection = catalogSeed !== undefined && 'triggerSeed' in catalogSeed && !workflowStarterRequiresSession(catalogSeed)
            ? materializeWorkflowStarterExample(catalogSeed, { timezone: readDeviceTimeZone() }) : null;
        const trigger = definitionDraftSeed?.trigger ?? (catalogSelection?.status === 'ready' ? catalogSelection.example.trigger : undefined);
        if (trigger === undefined) return;
        triggers.setDraft(editWorkflowTriggerDraft(EMPTY_WORKFLOW_TRIGGER_DRAFT, { kind: 'add', clientId: randomUUID(), trigger,
            ...(definitionDraftSeed?.payloadSchema === undefined ? {} : { payloadSchema: definitionDraftSeed.payloadSchema }) }));
    }, [initializationKey, definitionDraftSeed?.trigger, definitionDraftSeed?.payloadSchema, definitionDraftSeed?.triggers,
        catalogSeed, privateSeedWithdrawn, saved?.definitionId, triggers.setDraft, triggers.restoreSnapshot]);
    {
        const current = draftStore.get();
        snapshotRef.current = current === null ? null : { draft: current, description, projectTarget, executionTarget, triggers: triggers.captureSnapshot() };
    }
    // Import opens a fresh review document with a new draft id; it is an
    // initialization boundary, not a change to the prior document's history.
    const history = useWorkflowEditorHistory<WorkflowEditorSnapshot>(`${sourceGenerationRef.current}\u0000${draftId ?? ''}`, (snapshot) => {
        // Restore the semantic trigger intent before changing any other field:
        // inaccessible private trigger configuration cannot be fabricated.
        triggers.restoreSnapshot(snapshot.triggers);
        snapshotRef.current = snapshot;
        setDraft(snapshot.draft);
        setDescription(snapshot.description);
        setProjectTarget(snapshot.projectTarget);
        setExecutionTarget(snapshot.executionTarget);
        setHighlightedBlockIds(NO_HIGHLIGHTED_BLOCKS);
        setSavedByAgent(false);
    });
    const changeSnapshot = (patch: Partial<WorkflowEditorSnapshot>, label: string, committed = true) => {
        const before = snapshotRef.current;
        if (before === null) return false;
        const after = { ...before, ...patch };
        if (!history.record(before, after, label, committed)) return false;
        snapshotRef.current = after;
        setHighlightedBlockIds(NO_HIGHLIGHTED_BLOCKS);
        setSavedByAgent(false);
        return true;
    };
    const historyControls = React.useMemo((): typeof history.controls => {
        const controls = history.controls;
        return {
            get undoLabel() { return controls.undoLabel; },
            get redoLabel() { return controls.redoLabel; },
            ...(controls.subscribe === undefined ? {} : { subscribe: controls.subscribe }),
            undo: () => {
                try { controls.undo(); }
                catch (error) { void Modal.alert(t('workflows.editor.undo'), error instanceof WorkflowTriggerSnapshotRestoreError
                    ? t('workflows.editor.historyRestoreRequiresSetup') : formatWorkflowProblemMessage(error)); }
            },
            redo: () => {
                try { controls.redo(); }
                catch (error) { void Modal.alert(t('workflows.editor.redo'), error instanceof WorkflowTriggerSnapshotRestoreError
                    ? t('workflows.editor.historyRestoreRequiresSetup') : formatWorkflowProblemMessage(error)); }
            },
        };
    }, [history.controls]);

    // The controlled editor resolves no catalog of its own, so the Agent options
    // and every step prompt's reference scope come from this one host adapter —
    // the same one the Automation wrappers consume.
    const authoringHost = useWorkflowAuthoringHost({
        projectTarget,
        serverId: activeAccountScope?.serverId ?? null,
    });

    /**
     * A pristine neutral draft adopts the contextual Agent, once.
     *
     * UX §2.3/J1: a new workflow starts from the same Agent New Session would
     * start from — but only when that resolver produces a genuinely available
     * choice for this exact Machine, which is why this waits for the host
     * adapter's projected default instead of picking the bundled fallback.
     *
     * Only a blank `new` source may adopt context, and only while the draft is
     * still byte-identical to the one this editor started from. Authored seeds
     * (including captures, copies and catalog templates) and imported documents
     * preserve their defaults, including an omitted Agent.
     * Because this is initialization rather than an edit, the pristine baseline
     * moves with it and the editor does not report itself dirty.
     */
    const contextualAgentTarget = authoringHost.authoringFacts.contextualDefaultAgentTarget ?? null;
    const isBlankNewDraftSource = props.source.kind === 'new'
        && props.source.reviewedRunSeedId === undefined
        && props.source.definitionDraftSeedId === undefined
        && props.source.newSessionDraftSeedId === undefined
        && props.source.triggerWorkflowSeedId === undefined
        && props.source.exampleKey === undefined
        && props.source.builtinId === undefined
        && props.source.requestImport !== true;
    const draftIsPristine = useWorkflowEditorSelector(draftStore, (value) => value !== null && value === initialDraftBaselineRef.current);
    React.useEffect(() => {
        if (seededContextualAgentRef.current) return;
        if (!isBlankNewDraftSource) return;
        const draft = draftStore.get();
        if (contextualAgentTarget === null || draft === null || !draftIsPristine) return;
        if (draft !== initialDraftBaselineRef.current) return;
        if (readWorkflowEngineChoiceV1(draft.defaults) !== undefined || draft.defaults.agentTarget) return;
        seededContextualAgentRef.current = true;
        const seeded = setWorkflowDefaultField(draft, 'agentTarget', contextualAgentTarget);
        initialDraftBaselineRef.current = seeded;
        setDraft(seeded);
    }, [contextualAgentTarget, draftIsPristine, draftStore, isBlankNewDraftSource]);

    const startRun = React.useCallback(async (
        inputs: Readonly<Record<string, JsonValue>> | undefined,
        roleOverrides?: WorkflowRunComposerModalProps['roleOverrides'],
        visibleTeamId?: string,
    ): Promise<void> => {
        const draft = draftStore.get();
        if (planPendingRef.current || draft === null) return;
        const retained = runNow.retainedRequest;
        if (retained === null && (projectTarget === null || projectTarget.directory.trim().length === 0)) return;
        const validation = validateWorkflowEditorDraft(testSource === null ? draft : buildWorkflowEditorDraftFromDefinition({
            draftId: draft.draftId, name: testSource.metadata.title, definition: testSource.definition,
        }));
        // Authoring edits and runtime availability describe the next start. Recovery
        // belongs to the controller's already-reviewed snapshot, including Plan comparison.
        const normalizedDefinition = retained?.input.source.kind === 'inline'
            ? WorkflowDefinitionV1Schema.parse(retained.input.source.definition) : validation.normalizedDefinition;
        if (retained === null && (!validation.valid || normalizedDefinition === undefined)) return;
        // An unavailable runtime is refused rather than downgraded: quietly
        // running effectful work under different execution semantics is exactly
        // what the page-level choice exists to prevent.
        const admittedTarget = retained !== null ? retained.input.executionTarget ?? { kind: 'session' as const } : resolveAdmittedWorkflowExecutionTarget({
            selected: executionTarget,
            targets: runAsTargets,
        });
        if (admittedTarget === null) return;
        const source = retained?.input.source ?? (normalizedDefinition === undefined ? null : testSource === null ? {
            kind: 'inline' as const,
            ...(saved?.definitionId ? { sourceArtifactId: saved.definitionId } : {}),
            ...(visibleTeamId === undefined ? {} : { visibleTeamId }),
            definition: { ...normalizedDefinition, inputs: [...normalizedDefinition.inputs], blocks: [...normalizedDefinition.blocks] },
        } : { kind: 'saved' as const, definitionId: testSource.definitionId, revision: testSource.revision,
            ...(visibleTeamId === undefined ? {} : { visibleTeamId }) });
        if (source === null) return;
        const runId = pendingRunId ?? (testSource === null && planReview && reviewedRunSeed
            ? planReview.runId ?? deriveWorkflowPlanRunId(reviewedRunSeed.sourceRunId, planReview.invocationId) : randomUUID());
        pendingRunIdRef.current = runId;
        const sourceGenerationIsCurrent = captureSourceGeneration();
        const lifetime = accountLifetime;
        if (lifetime === null) return;
        const sourceIsCurrent = () => lifetime.isCurrent() && sourceGenerationIsCurrent();
        // One prompt is a workflow and Run now needs no name (UX §2.2 J1). The
        // admitted title is `min(1)` at its Protocol owner, so an unnamed draft
        // admits with no metadata rather than an empty title the schema refuses.
        const title = (testSource?.metadata.title ?? draft.name).trim();
        const captureProvenance = testSource === null ? draft.captureProvenance : testSource.metadata.captureProvenance;
        // The review's text travels with the request, so the review keeps reading it while the start settles.
        const reviewedDescription = (testSource === null ? snapshotRef.current?.description ?? '' : testSource.metadata.description ?? '').trim();
        const start = () => runNow.runNow({
            runId,
            ...(retained !== null ? {
                ...retained.input,
                ...(retained.project === undefined ? {} : { project: retained.project }),
            } : {
                ...(title.length === 0 ? {} : { metadata: { title,
                    ...(reviewedDescription.length === 0 ? {} : { description: reviewedDescription }),
                    ...(captureProvenance === undefined ? {} : { captureProvenance }),
                } }),
                executionTarget: admittedTarget,
                source,
                ...(inputs === undefined ? {} : { inputs }),
                ...(roleOverrides === undefined ? {} : { roleOverrides: [...roleOverrides] }),
                ...(projectTarget === null ? {} : { project: projectTarget }),
                ...(ownedPlanOriginId && reportBack ? { onComplete: { kind: 'originating_session' as const } } : {}),
                // A saved revision is sent by reference; its reviewed contents stay with this admission so a
                // later review shows that revision, never one saved since.
                ...(testSource === null ? {} : { reviewedDefinition: testSource.definition }),
            }),
            ...(ownedPlanOriginId ? { originSessionId: ownedPlanOriginId } : {}),
            isInvocationCurrent: sourceIsCurrent,
            // The composer stays open with the refusal's reason (04 §4.8).
            refusal: 'inline',
        });
        let admitted: Awaited<ReturnType<typeof runNow.runNow>>;
        try {
            if (testSource === null && planReview && reviewedRunSeed && normalizedDefinition !== undefined) {
                planPendingRef.current = true;
                setPlanPending(true);
                // The draft may stay open after Cancel. Re-read the canonical live
                // access fact before admission instead of trusting its old seed.
                const source = await workflowRunDetailActions.getRun(reviewedRunSeed.sourceRunId);
                if (!sourceIsCurrent()) return;
                if (!source.callerAccess.canEdit) throw new WorkflowActionError({ message: 'run_access_denied', rawCode: 'run_access_denied' });
                if (planReview.completeReview) {
                    // Cancel deliberately retains an editable draft. A changed
                    // authored source is Edit first, not the original Plan Run:
                    // resolve that human decision before any effectful admission.
                    if (!matchesWorkflowAcceptedDefinitionV1(normalizedDefinition, readWorkflowPlanResult(planReview.value)?.proposal)) {
                        const accepted = await Modal.confirm(t('workflows.review.editPlan'), t('workflows.review.editedPlanBody'), {
                            confirmText: t('workflows.review.editPlan'), cancelText: t('common.cancel'),
                        });
                        if (!accepted || !sourceIsCurrent()) return;
                        await workflowRunDetailActions.completeReview({ runId: reviewedRunSeed.sourceRunId,
                            invocation: { recordId: planReview.invocationId }, expectedContentRevision: planReview.expectedContentRevision,
                            mode: 'use_result', value: planReview.value, followUp: { kind: 'editing' } });
                        if (!sourceIsCurrent()) return;
                        setPlanEditingAccepted(true);
                        pendingRunIdRef.current = null;
                        setInputSheetOpen(false);
                        return;
                    }
                    const result = await startWorkflowPlanReview({ runId: reviewedRunSeed.sourceRunId,
                        planRunId: runId,
                        invocationId: planReview.invocationId, expectedContentRevision: planReview.expectedContentRevision,
                        value: planReview.value }, { start, completeReview: (request) => {
                            if (!sourceIsCurrent()) throw new Error(t('errors.operationFailed'));
                            return workflowRunDetailActions.completeReview(request);
                        } });
                    admitted = result?.started ?? null;
                } else admitted = await start();
            } else admitted = await start();
        } catch (cause) {
            if (sourceIsCurrent()) Modal.alert(t('common.error'), formatWorkflowProblemMessage(cause));
            return;
        } finally {
            if (sourceIsCurrent()) {
                planPendingRef.current = false;
                setPlanPending(false);
            }
        }
        // `null` means nothing was admitted by this call, so the caller-allocated
        // id stays pending and a retry reuses it rather than starting a second Run.
        if (admitted === null) return;
        // The Run really was admitted, so it is never discarded; but if this
        // editor has since moved to another workflow, taking over that page with
        // the previous source's navigation is not this call's decision.
        if (!sourceIsCurrent()) return;
        pendingRunIdRef.current = null;
        setInputSheetOpen(false);
        const testedDefinition = retained !== null
            ? retained.input.source.kind === 'saved' ? retained.reviewedDefinition : undefined
            : testSource?.definition;
        if (testedDefinition !== undefined) {
            setTestRun({ runId: admitted.run.id, definition: testedDefinition });
            return;
        }
        router.pushRetainingCurrent(createWorkflowRunRoute(admitted.run.id, lifetime.scope.serverId) as never);
    }, [accountLifetime, captureSourceGeneration, draftStore, executionTarget, pendingRunId, projectTarget, router, runAsTargets, runNow, planReview, reviewedRunSeed, ownedPlanOriginId, reportBack, saved?.definitionId, testSource]);

    const handleRunNow = React.useCallback(() => {
        if (draftStore.get() === null || testSourcePending || runNow.isPending(pendingRunId ?? '')) return;
        if (runNow.hasUnsettledAdmission(pendingRunId ?? '')) {
            setInputSheetOpen(true);
            return;
        }
        // Every Run is reviewed in the composer, including a no-input recipe.
        setTestSource(null);
        setInputSheetOpen(true);
    }, [draftStore, pendingRunId, runNow, testSourcePending]);

    const handleTestRun = React.useCallback(() => {
        if (saved === null || testSourcePending || runNow.isPending(pendingRunId ?? '')) return;
        if (runNow.hasUnsettledAdmission(pendingRunId ?? '')) {
            setInputSheetOpen(true);
            return;
        }
        const lifetime = accountLifetime;
        if (lifetime === null) return;
        const sourceIsCurrent = captureSourceGeneration();
        setTestSourcePending(true);
        void getWorkflowDefinition({ definitionId: saved.definitionId, accountLifetime }).then((result) => {
            if (!lifetime.isCurrent() || !sourceIsCurrent()) return;
            setTestSource(result);
            setInputValues({});
            setInputRawTextValues({});
            setInputSheetOpen(true);
        }).catch((error: unknown) => {
            if (lifetime.isCurrent() && sourceIsCurrent()) void Modal.alert(t('common.error'), formatWorkflowProblemMessage(error));
        }).finally(() => {
            if (lifetime.isCurrent() && sourceIsCurrent()) setTestSourcePending(false);
        });
    }, [accountLifetime, captureSourceGeneration, pendingRunId, runNow, saved, testSourcePending]);

    const { clearRefusal } = runNow;
    // While a start is unsettled, the review is the request it already sent: Start re-sends that
    // request (its graph, inputs and Where), never the draft as it is now.
    const runRetained = runNow.retainedRequest;
    const retainedDefinition = React.useMemo(() => {
        const source = runRetained?.input.source;
        if (source?.kind === 'saved') return runRetained?.reviewedDefinition ?? null;
        if (source?.kind !== 'inline') return null;
        const parsed = WorkflowDefinitionV1Schema.safeParse(source.definition);
        return parsed.success ? parsed.data : null;
    }, [runRetained]);
    const retainedMachine = runRetained?.project ? machines.find((candidate) => candidate.id === runRetained.project?.machineId) : undefined;
    const whereMachineName = runRetained?.project ? retainedMachine ? getMachineDisplayName(retainedMachine) : runRetained.project.machineId : machineName;
    const whereHomeDir = runRetained?.project ? retainedMachine?.metadata?.homeDir ?? null : machineHomeDir;
    const retainedTest = runRetained?.input.source.kind === 'saved';
    const reportShown = runRetained !== null ? runRetained.input.onComplete?.kind === 'originating_session' : reportBack;
    const dismissInputSheet = React.useCallback(() => {
        if (planPendingRef.current) return;
        clearRefusal();
        setInputSheetOpen(false);
    }, [clearRefusal]);

    // Draft updates are immutable. The exact accepted snapshot is clean even
    // when an optional editor field is explicitly undefined (not strict JSON).
    const definitionHasChanges = (candidate: WorkflowEditorDraft | null) => candidate !== null && candidate !== (savedDraftRef.current ?? initialDraftBaselineRef.current)
        && !workflowEditorSnapshotsEqual(candidate, savedDraftRef.current ?? initialDraftBaselineRef.current);
    const definitionDraftDirty = useWorkflowEditorSelector(draftStore, definitionHasChanges);
    const descriptionDraftDirty = description !== savedDescriptionRef.current;
    const projectTargetDirty = saved !== null && !pluginJsonValuesEqual(projectTarget, savedProjectTargetRef.current);

    // The Run review reads the draft only while it is open: typing never rebuilds a closed sheet.
    const runReviewDraft = useWorkflowEditorSelector(draftStore, identityDraft, inputSheetOpen ? Object.is : keepShownDraft);
    // The review's Agent choice is an edit of the draft, recorded like any other.
    const changeReviewedEngine = useEventCallback((next: WorkflowEditorDraft) => {
        changeSnapshot({ draft: next }, t('workflows.editor.history.edited'));
        setDraft(next);
    });
    const inputModalProps = React.useMemo<WorkflowRunComposerModalProps | null>(() => runReviewDraft === null ? null : ({
        definition: retainedDefinition ?? testSource?.definition ?? validateWorkflowEditorDraft(runReviewDraft).normalizedDefinition,
        sourceArtifactId: saved?.definitionId ?? null,
        ...(saved?.definitionId ? { optionsConsumer: { kind: 'workflow' as const, workflow: saved.definitionId } } : {}),
        inputs: retainedDefinition?.inputs ?? testSource?.definition.inputs ?? runReviewDraft.inputs,
        retainedRequest: runRetained,
        values: inputValues,
        onChangeValues: setInputValues,
        rawTextValues: inputRawTextValues,
        onChangeRawTextValues: setInputRawTextValues,
        workflowName: runRetained?.input.metadata?.title ?? testSource?.metadata.title ?? runReviewDraft.name,
        preview: (runRetained !== null ? runRetained.input.metadata?.description ?? '' : testSource?.metadata.description ?? (testSource === null ? description : '')) || (retainedDefinition?.blocks ?? testSource?.definition.blocks ?? runReviewDraft.blocks).map((block) => workflowBlockReferenceLabel(block)).join('\n'),
        ...(planReview ? { preview: readWorkflowPlanResult(planReview.value)?.document, notice: t('workflows.review.planRunNotice') } : {}),
        ...(testSource === null && !retainedTest ? {} : { notice: t('workflows.testRun.savedNotice') }),
        // A retained request is described by what it sent, not by how the draft compares now.
        includesUnsavedEdits: runRetained === null && testSource === null && (definitionDraftDirty || descriptionDraftDirty),
        machineId: (runRetained?.project ?? projectTarget)?.machineId ?? null,
        directory: (runRetained?.project ?? projectTarget)?.directory ?? null,
        machineName: whereMachineName,
        machineHomeDir: whereHomeDir,
        executionTarget: runRetained !== null ? runRetained.input.executionTarget : { kind: executionTarget },
        serverId: activeAccountScope?.serverId ?? null,
        ...(ownedPlanOriginId && activeAccountScope ? { originSession: {
            serverId: activeAccountScope.serverId, sessionId: ownedPlanOriginId,
        } } : {}),
        extraActionChips: [...createWorkflowStartPlacementChips({
            target: runRetained?.project ?? projectTarget, machineName: whereMachineName, machineHomeDir: whereHomeDir,
            machines, accountLifetime: props.accountLifetime,
            // The sent Where is shown without a setter; only a new start chooses again.
            ...(runRetained?.project ? {} : { onChange: (target: WorkflowAuthoringTarget) => { if (isWorkflowProjectTarget(target)) setProjectTarget(target); } }),
            testID: 'workflow-start-where-chip', testIDPrefix: 'workflow-start-where',
        }),
        // The page's Run as belongs to the next start; the review's "Each step runs in" row already names what a
        // sent request runs in (the composer's reviewed target), so Start adds no second chip saying it again.
        ...(ownedPlanOriginId ? [{ ...createExecutionRunStartContentChip({ ...getWorkflowContextChipDefinition('planReport'), pending: true,
            label: t('workflows.review.reportBackTitle', { session: planOriginName }), title: t('workflows.review.reportBackTitle', { session: planOriginName }),
            testID: 'workflow-plan-report-chip', revision: String([reportShown, runRetained !== null]), renderContent: <Item
                title={t('workflows.review.reportBackTitle', { session: planOriginName })} subtitle={t('workflows.review.reportBackBody', { session: planOriginName })}
                showChevron={false} rightElementOutsidePressable
                // A sent request's completion choice is fixed; the switch shows it and only a new start changes it.
                rightElement={<Switch testID="workflow-plan-report-switch" value={reportShown} onValueChange={setReportBack}
                    disabled={planPending || runRetained !== null} />} /> }),
            }] : [])],
        // An editable draft's Run review changes its Agent with the editor's own picker, editing the draft itself.
        ...(canEditDefinition && runRetained === null && testSource === null && !retainedTest ? { agentControl: <WorkflowDefaultEngineControls
            defaults={runReviewDraft.defaults} roles={runReviewDraft.roles} readDraft={bodyDraftStore.get} editable
            onChange={changeReviewedEngine}
            facts={authoringHost.authoringFacts} testIDPrefix="workflow-run-inputs-review-engine" /> } : {}),
        onRun: (inputs, roleOverrides, visibleTeamId) => { void startRun(inputs, roleOverrides, visibleTeamId); },
        onCancel: dismissInputSheet,
        pending: planPending || runNow.isPending(pendingRunId ?? ''),
        reconciling: runNow.stateFor(pendingRunId ?? '') === 'reconciling',
        startProblem: runNow.refusal,
    }), [activeAccountScope?.serverId, definitionDraftDirty, descriptionDraftDirty, description, dismissInputSheet, executionTarget, runReviewDraft, inputRawTextValues, inputValues, machineName, machines, pendingRunId, projectTarget, retainedDefinition, whereHomeDir, whereMachineName, runNow, runRetained, saved?.definitionId, startRun, planReview, ownedPlanOriginId, planOriginName, reportShown, planPending, retainedTest, testSource, canEditDefinition, bodyDraftStore, changeReviewedEngine, authoringHost.authoringFacts]);

    const runComposer = useWorkflowRunComposerModal({ open: inputSheetOpen, props: inputModalProps,
        anchorRef: testSource === null && !retainedTest ? runNowAnchorRef : testRunAnchorRef,
        ...(testSource === null && !retainedTest ? { placementRef: runNowPlacementRef } : {}) });
    const testRunPresentation = useWorkflowTestRunPresentation({ runId: testRun?.runId ?? null, definition: testRun?.definition ?? null, editable: canEditDefinition });

    const handleSave = React.useCallback(async (caller?: WorkflowActionCallerContext, asCopy = false): Promise<WorkflowDraftMutationResultV1> => {
        const draft = snapshotRef.current?.draft ?? null;
        const description = snapshotRef.current?.description ?? '';
        const project = snapshotRef.current?.projectTarget ?? null;
        // Try again on a failed Copy keeps that Copy, rather than saving back
        // into the source Artifact. Once acknowledged, Copy starts a new intent.
        const copying = asCopy || pendingDefinitionCreatesRef.current.copy !== null;
        if (!canManagePersonalTriggers || (copying && !canEditDefinition)) return { status: 'refused', reason: 'workflow_draft_read_only' };
        if (draft === null) return { status: 'unavailable' };
        if (savePending) return { status: 'refused', reason: 'save_pending' };
        history.commit();
        const definitionChanged = canEditDefinition && (copying || saved === null
            || definitionHasChanges(draft) || description !== savedDescriptionRef.current);
        const validation = validateWorkflowEditorDraft(draft, { triggerEvents: triggers.triggerEvents });
        if (definitionChanged && (!validation.valid || validation.normalizedDefinition === undefined)) return { status: 'refused', reason: 'invalid_workflow' };
        const lifetime = accountLifetime;
        if (!lifetime?.isCurrent()) return { status: 'unavailable' };
        // Same Account is not the same workflow: a save that resolves after this
        // editor moved to another source must not stamp that source's revision.
        let sourceIsCurrent = captureSourceGeneration();
        const isCurrent = () => lifetime.isCurrent() && sourceIsCurrent();
        setSavePending(true);
        setSaveFailure(undefined);
        return (async (): Promise<WorkflowDraftMutationResultV1> => {
            let persisted = saved;
            try {
                if (definitionChanged && validation.normalizedDefinition !== undefined) {
                    const createIntent = copying ? 'copy' : 'save';
                    persisted = await saveWorkflowEditorDefinition({ draft, description, definition: validation.normalizedDefinition,
                        ...(triggers.intendedTriggers === undefined ? {} : { intendedTriggers: triggers.intendedTriggers }),
                        saved: persisted, baseline: { draft: savedDraftRef.current ?? initialDraftBaselineRef.current, description: savedDescriptionRef.current },
                        pendingCreate: pendingDefinitionCreatesRef.current[createIntent],
                        retainCreate: (pending) => { pendingDefinitionCreatesRef.current[createIntent] = pending; },
                        copying, accountLifetime: lifetime, ...(caller === undefined ? {} : { caller }), isCurrent,
                        acknowledge: (result, acceptedDraft, acceptedDescription, kind) => {
                            savedDraftRef.current = acceptedDraft;
                            savedDescriptionRef.current = acceptedDescription;
                            persisted = { definitionId: result.definitionId, revision: result.revision };
                            setSaved(persisted);
                            setDefinitionAccess(result.access);
                            setSavedAtMs(Date.now());
                            setSavedByAgent(false);
                            setSaveConflict(null);
                            if (copying && kind === 'created') {
                                // Copy changes document identity at the existing source boundary.
                                sourceGenerationRef.current += 1;
                                sourceIsCurrent = captureSourceGeneration();
                                setAgentSession(null);
                                setAgentDraft(null);
                                setAgentSeedState((current) => ({ ...current, seed: null }));
                                observedAgentRevisionRef.current = null;
                                setHighlightedBlockIds(NO_HIGHLIGHTED_BLOCKS);
                                pendingRetargetRef.current = null;
                                setRetargetFailed(false);
                                setTestSourcePending(false);
                                setTestSource(null);
                                setTestRun(null);
                                pendingRunIdRef.current = null;
                                history.reset();
                                pendingDefinitionCreatesRef.current = { save: null, copy: null };
                            }
                        },
                    });
                }
                if (persisted === null || !isCurrent()) return { status: 'refused', reason: 'draft_retired' };
                if (project !== null || rememberedProject !== null) {
                    rememberAuthoringMemory({ workflowProjectTargetsByDefinitionId: { [persisted.definitionId]: project } });
                    if (!isCurrent()) return { status: 'refused', reason: 'draft_retired' };
                    savedProjectTargetRef.current = project;
                    setSavedAtMs(Date.now());
                }
                // Copy saves the portable definition and personal placement;
                // it does not duplicate or retarget the original trigger set.
                if (copying) return { status: 'applied' };
                // Then the trigger delta; a failure here reads "Workflow saved · Triggers not
                // updated" and keeps the pending trigger edits for Try again (07 S4).
                const triggerOutcome = await triggers.save(persisted.definitionId, isCurrent, caller);
                if (!isCurrent()) return { status: 'refused', reason: 'draft_retired' };
                if (triggerOutcome === 'failed') setSaveFailure(t('workflows.triggers.editor.partialSave'));
                // Save as workflow: point the originating trigger at this workflow (04 §5.4). Until
                // that write lands the trigger keeps its own steps and the status says so.
                const retarget = pendingRetargetRef.current;
                if (retarget !== null && isCurrent()) {
                    try {
                        await retargetTriggerToWorkflow(retarget, persisted.definitionId, caller, accountLifetime);
                        if (!isCurrent()) return { status: 'refused', reason: 'draft_retired' };
                        pendingRetargetRef.current = null;
                        setRetargetFailed(false);
                    } catch {
                        if (!isCurrent()) return { status: 'refused', reason: 'draft_retired' };
                        setRetargetFailed(true);
                        setSaveFailure(t('workflows.triggers.editor.retargetFailed'));
                        return { status: 'refused', reason: 'trigger_retarget_failed' };
                    }
                }
                if (sourceKind === 'new' && triggerOutcome !== 'failed') {
                    setSavedRouteId(persisted.definitionId);
                }
                return triggerOutcome === 'failed' ? { status: 'refused', reason: 'trigger_save_failed' } : { status: 'applied' };
            } catch (error) {
                if (!isCurrent()) return { status: 'refused', reason: 'draft_retired' };
                // A concurrent save keeps the local document and says so; it is
                // never resolved by last-writer-wins or a silent merge.
                if (isWorkflowDefinitionConflictError(error) && persisted !== null && pendingDefinitionCreatesRef.current.copy === null) {
                    try {
                        const current = await getWorkflowDefinition({ definitionId: persisted.definitionId, accountLifetime });
                        if (!isCurrent()) return { status: 'refused', reason: 'draft_retired' };
                        setDefinitionAccess(current.access);
                        setSaveConflict({
                            currentDraft: buildWorkflowEditorDraftFromDefinition({
                                draftId: randomUUID(),
                                name: current.metadata.title,
                                definition: current.definition,
                                captureProvenance: current.metadata.captureProvenance,
                            }),
                            currentRevision: current.revision,
                        });
                    } catch {
                        if (isCurrent()) setSaveConflict({ currentDraft: null, currentRevision: null });
                    }
                    return { status: 'refused', reason: 'save_conflict' };
                }
                // The closed code says which save failed and why — no access, a
                // definition that needs repair, private content this device
                // cannot open. It stays in the save status (no alert, no toast),
                // with the edits kept and Try again beside it.
                const failure = `${formatWorkflowProblemMessage(error)} ${t('workflows.save.failedBody')}`;
                setSaveFailure(failure);
                if (asCopy) await Modal.alert(t('workflows.save.failedTitle'), failure);
                return { status: 'refused', reason: error instanceof WorkflowActionError && error.code ? error.code : 'save_failed' };
            } finally {
                if (isCurrent()) setSavePending(false);
            }
        })();
    }, [accountLifetime, canEditDefinition, canManagePersonalTriggers, captureSourceGeneration, definitionDraftDirty, descriptionDraftDirty, description, saved, savePending, sourceKind, triggers, rememberAuthoringMemory, rememberedProject]);

    const saveFromUi = React.useCallback(() => { void handleSave(); }, [handleSave]);

    const handleSaveAsCopy = React.useCallback(() => {
        void handleSave(undefined, true);
    }, [handleSave]);


    /**
     * A saved-row Run now or Schedule presses this page's own action.
     *
     * The intent is consumed exactly once, after the exact Artifact revision is
     * hydrated under the current Account, and it calls the same handler as the
     * visible button — so Run now still freezes the reviewed draft through the
     * run-admission owner (collecting declared inputs first) and Schedule
     * reveals Runs automatically, where triggers are added. It never replaces the
     * hydrated draft, and when the action cannot proceed the person lands on the
     * reviewed definition with that action's blocking reason already visible.
     */
    const savedEntryIntent = props.source.kind === 'saved' ? props.source.intent : undefined;
    const savedEntryIntentKey = props.source.kind === 'saved' && savedEntryIntent !== undefined
        ? `${props.source.definitionId}\u0000${savedEntryIntent}`
        : null;
    React.useEffect(() => {
        if (
            savedEntryIntent === undefined
            || savedEntryIntentKey === null
            || consumedEntryIntentKeyRef.current === savedEntryIntentKey
        ) return;
        if (draftId === null || saved === null || definitionAccess === null || contentScopeKey !== accountScopeKey) return;
        const commands = editorCommandsRef.current;
        if (commands === null) return;
        consumedEntryIntentKeyRef.current = savedEntryIntentKey;
        if (savedEntryIntent === 'run') commands.runNow();
        else if (canManagePersonalTriggers) commands.schedule();
    }, [
        accountScopeKey,
        contentScopeKey,
        canManagePersonalTriggers,
        definitionAccess,
        draftId,
        saved,
        savedEntryIntent,
        savedEntryIntentKey,
    ]);

    /**
     * A neutral new workflow starts with its first prompt focused (UX §2.2
     * J1). The intent belongs to this source: it is consumed once through the
     * page's one focus owner, which waits for that prompt to mount, and it is
     * never replayed by a rerender, a hydrated saved definition, an imported or
     * reviewed document, or an Account change.
     */
    const initialPromptFocusConsumedRef = React.useRef(false);
    React.useEffect(() => {
        if (initialPromptFocusConsumedRef.current) return;
        if (props.source.kind !== 'new' || reviewedRunSeed !== null || props.source.requestImport === true) return;
        const draft = draftStore.get();
        if (draft === null) return;
        const first = draft.blocks[0];
        if (first?.kind !== 'step') return;
        const commands = editorCommandsRef.current;
        if (commands === null) return;
        initialPromptFocusConsumedRef.current = true;
        commands.focusPrompt(first.id);
    }, [draftId, draftStore, props.source, reviewedRunSeed]);

    const handleImportJson = React.useCallback(() => {
        const draft = draftStore.get();
        if (!canEditDefinition || draft === null) return;
        // Picking a document is a platform round trip the person can leave. The
        // imported document replaces the draft it was opened against, never
        // whichever workflow happens to be on screen when the picker returns.
        const sourceIsCurrent = captureSourceGeneration();
        void (async () => {
            let importedSource: string | null;
            try {
                importedSource = await pickWorkflowDocumentText();
            } catch {
                if (!sourceIsCurrent()) return;
                await Modal.alert(
                    t('workflows.interchange.importFailedTitle'),
                    t('workflows.interchange.importFailedInvalidDocument'),
                );
                return;
            }
            if (importedSource === null || !sourceIsCurrent()) return;
            let imported: WorkflowImportResult;
            try {
                imported = await importWorkflowDocumentViaAction({ source: importedSource, currentDraft: draft, draftId: randomUUID() });
            } catch {
                if (sourceIsCurrent()) await Modal.alert(t('workflows.interchange.importFailedTitle'),
                    t('workflows.interchange.importFailedInvalidDocument'));
                return;
            }
            if (!sourceIsCurrent()) return;
            if (!imported.ok) {
                if (imported.messageKey !== null || imported.issues.length === 0) {
                    await Modal.alert(
                        t('workflows.interchange.importFailedTitle'),
                        t(imported.messageKey ?? 'workflows.interchange.importFailedInvalidDocument'),
                    );
                    return;
                }
                Modal.show({
                    component: WorkflowImportReview,
                    props: {
                        issues: imported.issues,
                        ...(imported.repairDraft === undefined ? {} : { repairDraft: imported.repairDraft }),
                        onOpenRepair: (repairDraft) => {
                            if (!sourceIsCurrent()) return;
                            savedDraftRef.current = null;
                            setSaved(null);
                            setSelection(EMPTY_WORKFLOW_EDITOR_VIEW_STATE);
                            setDraft(repairDraft);
                        },
                    },
                    closeOnBackdrop: true,
                    chrome: {
                        kind: 'card',
                        title: t('workflows.interchange.importIssuesTitle'),
                        testID: 'workflow-import-review-modal',
                        bodyScroll: 'auto',
                        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.92, size: 'md' },
                    },
                });
                return;
            }
            savedDraftRef.current = null;
            setSaved(null);
            setSelection(EMPTY_WORKFLOW_EDITOR_VIEW_STATE);
            setDraft(imported.draft);
        })();
    }, [canEditDefinition, captureSourceGeneration, draftStore]);

    const handleExportJson = React.useCallback(() => {
        const draft = draftStore.get();
        if (draft === null) return;
        const sourceIsCurrent = captureSourceGeneration();
        void (async () => {
            try {
                const exported = await exportWorkflowDocumentViaAction({ draft });
                if (sourceIsCurrent()) await confirmWorkflowDocumentExport({ name: draft.name, json: exported.json });
            } catch (error) {
                if (sourceIsCurrent()) await Modal.alert(t('common.error'), formatWorkflowProblemMessage(error));
            }
        })();
    }, [captureSourceGeneration, draftStore]);

    // Action-step field options are read for the Where Machine only while an
    // Action step exists, so an editor without one issues no capabilities read.
    // The requests change only with an Action step's literal inputs, so a prompt keystroke keeps them.
    const actionFieldRequests = useWorkflowEditorSelector(draftStore, readWorkflowActionFieldRequests, sameRetainedValue);
    const resolveActionFieldOptions = useActionFieldOptionsForMachine({
        machineId: projectTarget?.machineId ?? null,
        serverId: activeAccountScope?.serverId ?? null,
        enabled: actionFieldRequests.hasActionBlocks,
        requests: actionFieldRequests.requests,
    });

    const readDraftDirty = (documentDraft: WorkflowEditorDraft | null, documentDescription: string) => documentDraft !== null
        && (projectTargetDirty || saveFailure !== undefined || (canEditDefinition && (definitionHasChanges(documentDraft) || documentDescription !== savedDescriptionRef.current || retargetFailed))
            || (canManagePersonalTriggers && triggers.dirty));
    const routeDraftDirty = useWorkflowEditorSelector(draftStore, (value) => readDraftDirty(value, description));
    // Initial hydration, pushed saved content and Agent snapshots share one
    // adoption decision. Read dirty state when the read settles, not when it starts.
    const acceptSavedRevision = useEventCallback((revision: Pick<Awaited<ReturnType<typeof getWorkflowDefinition>>,
        'definitionId' | 'revision' | 'metadata' | 'definition'>, changedBlockIds: readonly string[] | null = null) => {
        const accepted = saved?.definitionId === revision.definitionId && contentScopeKey === accountScopeKey;
        if (accepted && (revision.revision.headerVersion < saved.revision.headerVersion
                || revision.revision.bodyVersion < saved.revision.bodyVersion)) return;
        if (accepted && pluginJsonValuesEqual(revision.revision, saved.revision)) {
            // Home can publish the saved bytes before the Session receipt arrives.
            // Adoption already recorded their history; the receipt adds attribution only.
            if (changedBlockIds !== null) {
                setSavedByAgent(true);
                setHighlightedBlockIds(changedBlockIds);
            }
            return;
        }
        const draft = draftStore.get();
        const incoming = buildWorkflowEditorDraftFromDefinition({
            draftId: draft?.draftId ?? randomUUID(),
            name: revision.metadata.title,
            definition: revision.definition,
            captureProvenance: revision.metadata.captureProvenance,
        });
        if (accepted && draft !== null && (readDraftDirty(draft, description) || savePending)) {
            setSaveConflict({ currentDraft: incoming, currentRevision: revision.revision });
            return;
        }
        const nextDescription = revision.metadata.description ?? '';
        const before = snapshotRef.current;
        if (before !== null) {
            const after = { ...before, draft: incoming, description: nextDescription };
            if (accepted || changedBlockIds !== null) history.record(before, after,
                t(changedBlockIds === null ? 'workflows.editor.history.edited' : 'workflows.editor.history.agent'));
            snapshotRef.current = after;
        }
        savedDraftRef.current = incoming;
        initialDraftBaselineRef.current = incoming;
        savedDescriptionRef.current = nextDescription;
        setDraft(incoming);
        setDescription(nextDescription);
        setSaved({ definitionId: revision.definitionId, revision: revision.revision });
        setSaveConflict(null);
        setSaveFailure(undefined);
        if (accepted || changedBlockIds !== null) setSavedAtMs(Date.now());
        setSavedByAgent(changedBlockIds !== null);
        setHighlightedBlockIds(changedBlockIds ?? NO_HIGHLIGHTED_BLOCKS);
        setContentScopeKey(accountScopeKey);
    });
    const hydrationWasPresented = React.useRef(presented);
    React.useEffect(() => {
        const resumed = presented && !hydrationWasPresented.current;
        hydrationWasPresented.current = presented;
        if (!presented || sourceKind !== 'saved' || sourceDefinitionId === null) return;
        // A saved copy owns its new identity; never rehydrate the route's original.
        const accepted = saved !== null && contentScopeKey === accountScopeKey;
        if (accepted && saved.definitionId !== sourceDefinitionId) return;
        const lifetime = accountLifetime;
        if (lifetime === null) return;
        let controller: AbortController | null = null;
        let cancelled = false;
        const refresh = () => {
            controller?.abort();
            const attempt = new AbortController();
            controller = attempt;
            void (async () => {
                try {
                    const result = await getWorkflowDefinition({ definitionId: sourceDefinitionId, accountLifetime: lifetime, signal: attempt.signal });
                    if (cancelled || attempt.signal.aborted || !lifetime.isCurrent()) return;
                    setHydrationFailure(null);
                    setDefinitionAccess(result.access);
                    // Exact reviewed Agent snapshots retain their bytes; this read supplies access only.
                    if (agentRevision !== null || agentSeedId !== null) return;
                    acceptSavedRevision(result);
                } catch (error) {
                    if (cancelled || attempt.signal.aborted || !lifetime.isCurrent()) return;
                    setHydrationFailure({ error });
                }
            })();
        };
        hydrationRefreshRef.current = refresh;
        const unsubscribe = accepted ? subscribeHomeAccountChange(event => {
            if (affectsSelectedWorkflowDefinition(event, lifetime, sourceDefinitionId)) refresh();
        }, { serverIds: [lifetime.scope.serverId], reconnect: 'refresh' }) : () => {};
        if (!accepted || agentRevision !== null || agentSeedId !== null || resumed) refresh();
        return () => {
            cancelled = true;
            controller?.abort();
            unsubscribe();
            if (hydrationRefreshRef.current === refresh) hydrationRefreshRef.current = null;
        };
    }, [accountLifetime, accountScopeKey, agentRevision, agentSeedId, contentScopeKey, presented, saved?.definitionId, sourceDefinitionId, sourceKind]);
    React.useEffect(() => {
        if (!agentRevision || !activeAccountScope || agentRevision.definitionId !== editableDefinitionId) return;
        const key = `${accountScopeKey}:${agentRevision.definitionId}:${agentRevision.revision.headerVersion}:${agentRevision.revision.bodyVersion}`;
        if (observedAgentRevisionRef.current === key) return;
        observedAgentRevisionRef.current = key;
        acceptSavedRevision(agentRevision, agentRevision.changedBlockIds);
    }, [accountScopeKey, activeAccountScope, agentRevision, description, draftStore, editableDefinitionId, routeDraftDirty, savePending, saved]);
    /**
     * The one save status (B1): the host's save owner is the only thing that
     * knows whether this draft is kept. Only an empty new draft is "Not saved yet";
     * seeded content also needs its first Save, even without a local edit.
     * The receipt reflects the accepted snapshot, so an edit made while saving
     * is not marked saved.
     */
    const { undoLabel: discardUndoLabel } = useWorkflowEditorHistoryLabels(history.controls);
    // Contextual Agent defaults alone do not populate the empty editor.
    // Compare content, not seed kinds: imports and plugin copies use this same owner.
    const draftIsEmpty = useWorkflowEditorSelector(draftStore, (value) => value === null || (description.trim().length === 0
        && workflowEditorSnapshotsEqual(value, createWorkflowEditorDraft({ draftId: value.draftId, defaults: value.defaults }))));
    const saveStatus = React.useMemo((): WorkflowSaveStatusState => {
        if (savePending) return { kind: 'saving' };
        if (saveFailure !== undefined && routeDraftDirty) return { kind: 'failed', reason: saveFailure };
        if (routeDraftDirty) return { kind: 'unsaved' };
        if (saved === null) return { kind: draftIsEmpty ? 'notSaved' : 'unsaved' };
        // Discard asks no confirmation; while its history entry is the one Undo would reverse, the
        // status says the edits went (DESIGN-9 N44) so the Undo beside it is plainly the way back.
        const discarded = discardUndoLabel !== null && discardUndoLabel === t('common.discardChanges');
        return { kind: 'saved', savedAtMs, ...(savedByAgent ? { byAgent: true } : {}), ...(discarded ? { discarded: true } : {}) };
    }, [discardUndoLabel, draftIsEmpty, routeDraftDirty, saveFailure, savePending, saved, savedAtMs, savedByAgent]);

    const requestPageSave = React.useCallback(async (): Promise<boolean> => {
        editorCommandsRef.current?.save();
        return false;
    }, []);
    const leaveEditor = React.useCallback(() => {
        if (router.canGoBack()) router.back();
        else router.replace('/workflows' as never);
    }, [router]);
    const { reset: resetHistory } = history;
    const { captureSnapshot: captureTriggerSnapshot, setDraft: setTriggerDraft } = triggers;
    const discardDepartingDraft = React.useCallback(() => {
        const baseline = savedDraftRef.current ?? initialDraftBaselineRef.current;
        const before = snapshotRef.current;
        if (baseline === null || before === null) return;
        // A retained workspace tab outlives its departure. Discard must retire
        // the host's edits and recovery history, not only the guard's dirty ref.
        snapshotRef.current = { ...before, draft: baseline, description: savedDescriptionRef.current,
            projectTarget: savedProjectTargetRef.current,
            triggers: captureTriggerSnapshot(EMPTY_WORKFLOW_TRIGGER_DRAFT) };
        setDraft(baseline);
        setDescription(savedDescriptionRef.current);
        setProjectTarget(savedProjectTargetRef.current);
        setTriggerDraft(EMPTY_WORKFLOW_TRIGGER_DRAFT);
        resetHistory();
        setSelection(EMPTY_WORKFLOW_EDITOR_VIEW_STATE);
        setHighlightedBlockIds(NO_HIGHLIGHTED_BLOCKS);
        setSaveConflict(null);
        setSaveFailure(undefined);
        setRetargetFailed(false);
    }, [captureTriggerSnapshot, resetHistory, setTriggerDraft]);
    const captureDraftDecisionCurrentness = React.useCallback(() => {
        const lifetime = accountLifetime;
        const sourceIsCurrent = captureSourceGeneration();
        const draftId = snapshotRef.current?.draft.draftId;
        return () => (lifetime?.isCurrent() ?? true) && sourceIsCurrent()
            && snapshotRef.current?.draft.draftId === draftId;
    }, [accountLifetime, captureSourceGeneration]);
    // The Artifact can be acknowledged before placement/triggers finish. A
    // pending Save still owns the draft even when its definition looks clean.
    // Discard and ordinary Back share the host's unsaved-draft decision.
    const draftNavigation = useUnsavedDraftNavigationGuard({
        navigation,
        isDirty: routeDraftDirty || savePending,
        onSave: requestPageSave,
        onDiscard: discardDepartingDraft,
        onLeave: leaveEditor,
        captureDecisionCurrentness: captureDraftDecisionCurrentness,
        tag: 'WorkflowEditorHostScreen.beforeRemove',
    });
    const handleDelete = React.useCallback(async () => {
        if (!canEditDefinition || saved === null || deletePendingRef.current) return;
        const lifetime = accountLifetime;
        if (lifetime === null) return;
        const sourceIsCurrent = captureSourceGeneration();
        const savedTitle = savedDraftRef.current?.name;
        deletePendingRef.current = true;
        const controller = new AbortController();
        deleteAbortRef.current = controller;
        const retirement = lifetime.onRetire(() => {
            controller.abort();
            if (!sourceIsCurrent()) return;
            deletePendingRef.current = false;
            setDeletePending(false);
        });
        try {
            // The delete Action owns the order (this workflow's triggers first, 03 §5.5).
            await deleteWorkflowDefinition({ definitionId: saved.definitionId,
                ...(savedTitle === undefined ? {} : { title: savedTitle }),
                signal: controller.signal, accountLifetime,
                onTransportIssued: () => {
                    if (lifetime.isCurrent() && sourceIsCurrent()) setDeletePending(true);
                } });
            if (!lifetime.isCurrent() || !sourceIsCurrent()) return;
            // Nothing is left to keep: leave without the unsaved-draft prompt.
            draftNavigation.allowSavedNavigation();
            savedDraftRef.current = null;
            initialDraftBaselineRef.current = null;
            setDraft(null);
            router.replace('/workflows' as never);
        } catch (error) {
            if (lifetime.isCurrent() && sourceIsCurrent()) {
                if (error instanceof WorkflowActionError && isActionApprovalDeclinedErrorCode(error.rawCode)) return;
                await Modal.alert(t('workflows.page.deleteFailedTitle'), formatWorkflowProblemMessage(error));
            }
        } finally {
            retirement.dispose();
            if (deleteAbortRef.current === controller) deleteAbortRef.current = null;
            if (lifetime.isCurrent() && sourceIsCurrent()) {
                deletePendingRef.current = false;
                setDeletePending(false);
            }
        }
    }, [accountLifetime, canEditDefinition, captureSourceGeneration, draftNavigation.allowSavedNavigation, router, saved]);

    /**
     * Discard changes on a saved workflow (DESIGN-9 N44): the edits go, the saved version comes back
     * and the page stays. It is one labelled history entry, so Undo brings the edits back.
     */
    const { record: recordHistory } = history;
    const handleDiscardChanges = React.useCallback(async (): Promise<WorkflowDraftMutationResultV1> => {
        const savedDraft = savedDraftRef.current;
        if (!canEditDefinition) return { status: 'refused', reason: 'workflow_draft_read_only' };
        if (saved === null || savedDraft === null) return { status: 'unavailable' };
        const lifetime = accountLifetime;
        if (!lifetime?.isCurrent()) return { status: 'unavailable' };
        const before = snapshotRef.current;
        if (before === null) return { status: 'refused', reason: 'draft_retired' };
        const after = {
            ...before,
            draft: savedDraft,
            description: savedDescriptionRef.current,
            projectTarget: savedProjectTargetRef.current,
            triggers: captureTriggerSnapshot(EMPTY_WORKFLOW_TRIGGER_DRAFT),
        };
        recordHistory(before, after, t('common.discardChanges'));
        snapshotRef.current = after;
        setTriggerDraft(EMPTY_WORKFLOW_TRIGGER_DRAFT);
        setDraft(savedDraft);
        setDescription(savedDescriptionRef.current);
        setProjectTarget(savedProjectTargetRef.current);
        setHighlightedBlockIds(NO_HIGHLIGHTED_BLOCKS);
        setSaveFailure(undefined);
        return { status: 'applied', draftRevision: history.getRevision() };
    }, [accountLifetime, canEditDefinition, captureTriggerSnapshot, recordHistory, saved, setTriggerDraft]);

    // Both native settings controls and admitted Actions author one revisioned snapshot.
    const editMountedDraft = (edit: Readonly<{
        expectedDraftRevision: number;
        ops?: WorkflowDraftEditInputV1['ops'];
        settings?: Partial<Omit<WorkflowEditorSnapshot, 'draft'>>;
    }>, label: string, committed = true): WorkflowDraftMutationResultV1 => {
        if (!canManagePersonalTriggers || (!canEditDefinition
            && ((edit.ops?.length ?? 0) > 0 || edit.settings?.description !== undefined))) {
            return { status: 'refused', reason: 'workflow_draft_read_only' };
        }
        const current = snapshotRef.current;
        if (!current) return { status: 'unavailable' };
        const revision = history.getRevision();
        if (edit.expectedDraftRevision !== revision) return { status: 'refused', reason: 'stale_draft_revision', draftRevision: revision };
        const result = applyWorkflowDefinitionEditsV1(current.draft, edit.ops ?? []);
        if (!result.ok) return { status: 'refused', reason: result.issue.code, draftRevision: revision };
        let settings = edit.settings;
        // Restore validates unavailable private trigger content before recording history
        // or applying the definition and other settings, preserving atomic rejection.
        try {
            if (settings?.triggers !== undefined) {
                const restored = triggers.restoreSnapshot(settings.triggers);
                if (restored === null) return { status: 'refused', reason: 'draft_retired', draftRevision: revision };
                settings = { ...settings, triggers: restored };
            }
        } catch (error) {
            return { status: 'refused', reason: error instanceof WorkflowTriggerSnapshotRestoreError
                ? error.code : 'invalid_trigger_snapshot', draftRevision: revision };
        }
        if (!changeSnapshot({ draft: result.draft, ...settings }, label, committed)) {
            return { status: 'unchanged', draftRevision: revision };
        }
        setDraft(result.draft);
        if (settings?.description !== undefined) setDescription(settings.description);
        if (settings?.projectTarget !== undefined) setProjectTarget(settings.projectTarget);
        if (settings?.executionTarget !== undefined) setExecutionTarget(settings.executionTarget);
        setHighlightedBlockIds(result.changedBlockIds);
        return { status: 'applied', draftRevision: history.getRevision(), changedBlockIds: [...result.changedBlockIds] };
    };

    const mountedDraftActions: WorkflowMountedDraftActions = {
        getSnapshot: () => {
            const current = snapshotRef.current;
            const scope = authoringHost.sessionBindingScope;
            if (!current || !scope) return null;
            const validation = validateWorkflowEditorDraft(current.draft, { triggerEvents: triggers.triggerEvents });
            return WorkflowMountedDraftV1Schema.parse({ scope, draftId: current.draft.draftId, name: current.draft.name,
                definition: projectNativeJsonValueForTransport(buildWorkflowDefinitionCandidate(current.draft)),
                blockLabels: walkWorkflowBlocks(current.draft.blocks).map(block => ({ id: block.id, label: workflowBlockReferenceLabel(block) })),
                settings: { description: current.description, projectTarget: current.projectTarget,
                    executionTarget: current.executionTarget, triggers: projectNativeJsonValueForTransport(current.triggers) },
                validationIssues: validation.issues, dirty: readDraftDirty(current.draft, current.description), draftRevision: history.getRevision() });
        },
        execute: async (actionId, input, signal, caller) => {
            if (signal?.aborted) return { status: 'refused', reason: 'cancelled' };
            if (actionId === 'workflow.authoring.draft.save') return await handleSave(caller);
            if (actionId === 'workflow.authoring.draft.discard') {
                if (!canEditDefinition) return { status: 'refused', reason: 'workflow_draft_read_only' };
                return saved !== null ? await handleDiscardChanges()
                    : await draftNavigation.requestLeaveAndWait() ? { status: 'applied' } : { status: 'refused', reason: 'cancelled' };
            }
            const current = snapshotRef.current;
            if (!current) return { status: 'unavailable' };
            const revision = history.getRevision();
            if (actionId === 'workflow.authoring.draft.edit') {
                const parsed = WorkflowDraftEditInputV1Schema.safeParse(input);
                if (!parsed.success) return { status: 'refused', reason: 'invalid_parameters' };
                return editMountedDraft(parsed.data, t('workflows.editor.history.agent'));
            }
            if (!canEditDefinition) return { status: 'refused', reason: 'workflow_draft_read_only' };
            try {
                if (actionId === 'workflow.authoring.draft.undo') history.controls.undo();
                else if (actionId === 'workflow.authoring.draft.redo') history.controls.redo();
                else return { status: 'unavailable' };
            } catch (error) {
                return { status: 'refused', reason: error instanceof WorkflowTriggerSnapshotRestoreError
                    ? error.code : 'history_restore_failed', draftRevision: history.getRevision() };
            }
            return { status: history.getRevision() === revision ? 'unchanged' : 'applied', draftRevision: history.getRevision() };
        },
    };
    /** The name the menu shares, read when chosen: a rename does not rebuild the menu. */
    const readShareName = React.useCallback(() => draftStore.get()?.name.trim() ?? '', [draftStore]);
    const editWithAgent = React.useCallback(() => {
        if (!canEditDefinition || saved === null) return;
        openAgentEdit(buildWorkflowAgentAuthoringSeed({
            kind: 'edit',
            name: savedDraftRef.current?.name ?? readShareName(),
            definitionId: saved.definitionId,
            revision: saved.revision,
        }));
    }, [canEditDefinition, openAgentEdit, readShareName, saved]);
    React.useEffect(() => {
        // The guard must receive the accepted draft and trigger snapshot before
        // replacement. Edits made during Save stay here until they are saved.
        if (savedRouteId === null || sourceKind !== 'new' || savePending) return;
        if (routeDraftDirty) {
            // Later edits did not join this accepted Save. Only a subsequent
            // clean Save may authorize its in-place route promotion.
            setSavedRouteId(null);
            return;
        }
        // Create and saved URLs share one dynamic native screen. Change its
        // parameter, not its screen key, so the accepted editor stays mounted.
        if (nativeEditorRoute) router.setParams({ id: savedRouteId });
        else router.replace(createWorkflowDefinitionRoute(savedRouteId, props.accountLifetime?.scope.serverId) as never);
    }, [nativeEditorRoute, routeDraftDirty, router, savePending, savedRouteId, sourceKind, accountLifetime]);
    const handleDuplicate = React.useCallback(() => {
        const draft = draftStore.get();
        if (!accessResolved || draft === null || savePending) return;
        const definition = validateWorkflowEditorDraft(draft).normalizedDefinition;
        if (definition === undefined) return;
        const lifetime = accountLifetime;
        if (!lifetime?.isCurrent()) return;
        const definitionDraftSeedId = storeWorkflowDefinitionDraftSeed({
            name: t('workflows.copyName', { name: draft.name }), description, definition,
        }, props.accountLifetime);
        router.push({ pathname: '/workflows/new', params: { definitionDraftSeedId,
            ...(props.accountLifetime ? { serverId: props.accountLifetime.scope.serverId } : {}) } } as never);
    }, [accountLifetime, accessResolved, description, draftStore, router, savePending]);
    // Duplicate needs a valid definition; the menu reads that fact, not every keystroke.
    const draftDuplicable = useWorkflowEditorSelector(draftStore, (value) => value !== null
        && validateWorkflowEditorDraft(value).normalizedDefinition !== undefined);
    const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => {
        const actions: PageHeaderMenuAction[] = [];
        if (saved !== null && activeAccountScope) actions.push({ id: 'mentionInComposer', title: t('entityDragDrop.composer.mentionInComposer'),
            testID: 'workflow-editor-menu-mention-in-composer',
            onSelect: async () => { await mention({ kind: 'workflow', scope: activeAccountScope, workflowId: saved.definitionId }, readShareName() || t('workflows.page.untitled')); } });
        if (saved !== null && accessResolved) actions.push({ id: 'duplicate', title: t('common.duplicate'),
            testID: 'workflow-editor-menu-duplicate', disabled: savePending || !draftDuplicable,
            onSelect: handleDuplicate });
        // A saved workflow is an Artifact; Share opens the one document share sheet (07 S7/S8, INT I2).
        if (saved !== null) {
            // Wide layouts carry Edit with an agent as the header's quiet action instead (07 §3).
            if (canEditDefinition && !detailsPaneAvailable) actions.push({ id: 'agent', title: t('workflows.authoring.edit'), testID: 'workflow-editor-menu-agent',
                onSelect: editWithAgent });
            actions.push({
                id: 'share',
                title: t('workflows.destination.rowMenu.share'),
                testID: 'workflow-editor-menu-share',
                onSelect: (intent) => showDocumentShareSheet({
                    anchor: intent?.anchor,
                    kind: 'workflow-definition.v1',
                    ...(activeAccountScope ? { scope: activeAccountScope } : {}),
                    artifactId: saved.definitionId,
                    name: readShareName() || t('workflows.page.untitled'),
                    subtitle: savedDraftRef.current
                        ? t('workflows.examples.stepCount', { count: countWorkflowStepsV1(savedDraftRef.current.blocks) }) : undefined,
                    linkPath: createWorkflowDefinitionRoute(saved.definitionId, props.accountLifetime?.scope.serverId),
                    // "Send a copy instead" is the existing JSON export (INT I2).
                    onSendCopy: () => editorCommandsRef.current?.exportJson(),
                }),
            });
        }
        actions.push({
            id: 'export',
            title: t('workflows.exportJson'),
            testID: 'workflow-editor-menu-export',
            onSelect: () => editorCommandsRef.current?.exportJson(),
        });
        // Destructive operations close the menu, never open it (DESIGN-9 N46).
        if (saved === null && canEditDefinition) actions.push({ id: 'discard', title: t('common.discard'),
            testID: 'workflow-editor-menu-discard', disabled: savePending, destructive: true,
            onSelect: draftNavigation.requestLeave });
        if (canEditDefinition && saved !== null && routeDraftDirty) actions.push({ id: 'discardChanges',
            title: t('common.discardChanges'), testID: 'workflow-editor-menu-discard-changes', disabled: savePending,
            destructive: true, onSelect: () => { void handleDiscardChanges(); } });
        if (canEditDefinition && saved !== null) {
            actions.push({
                id: 'delete',
                title: t('workflows.page.deleteWorkflow'),
                testID: 'workflow-editor-menu-delete',
                destructive: true,
                disabled: deletePending,
                onSelect: () => handleDelete(),
            });
        }
        return actions;
    }, [accountLifetime, activeAccountScope, accessResolved, canEditDefinition, detailsPaneAvailable, draftDuplicable, draftNavigation.requestLeave, editWithAgent,
        handleDelete, handleDiscardChanges, handleDuplicate, mention, readShareName, routeDraftDirty, savePending, deletePending, saved]);

    React.useEffect(() => {
        if (props.source.kind !== 'new' || props.source.requestImport !== true || importRequestedRef.current) return;
        importRequestedRef.current = true;
        handleImportJson();
    }, [handleImportJson, props.source]);

    // The private seed this editor opened belongs to another Account now. There
    // is no id to re-open it under this one and no honest way to keep showing
    // it, so the editor states that rather than presenting the previous
    // Account's prompts with this Account's Save.
    if (privateSeedWithdrawn || (routeAgentSourceIsCurrent && agentSeedId !== null && agentSeedState.lifetime !== null
        && !agentSeedState.lifetime.isCurrent())) {
        return (
            <SurfaceStateCard
                testID="workflow-editor-account-changed"
                kind="unavailable"
                title={t('workflows.editor.accountChangedTitle')}
                reason={t('workflows.editor.accountChangedBody')}
                accessibilitySemantics="status"
            />
        );
    }
    // Reload loses a temporary handle without changing the Account. Keep that
    // missing source unavailable rather than substituting a blank editable draft.
    if (privateDraftSeedUnavailable || (routeAgentSourceIsCurrent && agentSeedId !== null && agentSeed === null)) {
        return <WorkflowMissingDefinitionState testID="workflow-editor-draft-unavailable"
            source={privateDraftSeedUnavailable ? 'unsaved-copy' : 'definition'}
            onOpenCollection={() => openSection('/workflows', true)} />;
    }
    if (props.source.kind === 'new' && definitionDraftSeed === null && catalogSeed !== undefined
        && 'triggerSeed' in catalogSeed && workflowStarterRequiresSession(catalogSeed)) {
        return <ScrollView style={styles.root}>
            <SurfaceStateCard testID="workflow-editor-starter-context" kind="empty"
                title={t('workflows.examples.chooseSession')} reason={tLoose(catalogSeed.descriptionKey)}
                accessibilitySemantics="status" />
            <WorkflowExamplesSection />
        </ScrollView>;
    }
    // Preserve the owner's typed reason; a transport failure alone is not
    // proof the definition is unavailable or deleted.
    if (hydrationFailure !== null) {
        const problem = resolveWorkflowProblemPresentation(hydrationFailure.error);
        if (problem.missingDefinition) {
            return <WorkflowMissingDefinitionState onOpenCollection={() => openSection('/workflows', true)} />;
        }
        return (
            <SurfaceStateCard
                testID="workflow-editor-error"
                kind={problem.code === 'content_unavailable' ? 'unavailable' : 'error'}
                title={problem.title}
                reason={problem.message}
                action={problem.repairLabel === null ? undefined : { label: problem.repairLabel, onPress: retryHydration }}
                accessibilitySemantics={problem.accessibilitySemantics}
            />
        );
    }
    // A reviewed copy is single-use. Returning here through history must say the
    // copy is gone rather than silently presenting an empty draft as if it were
    // the Run the person asked to review.
    if (props.source.kind === 'new'
        && props.source.reviewedRunSeedId !== undefined
        && reviewedRunSeed === null) {
        return <WorkflowMissingDefinitionState testID="workflow-editor-reviewed-run-missing" />;
    }
    if (draftId === null || !accessResolved || contentScopeKey !== accountScopeKey) {
        // Account-private content cannot be held over as last-known-good across
        // an Account change, so this states that the workflow is opening rather
        // than showing a blank page with no explanation.
        return (
            <SurfaceStateCard
                testID="workflow-editor-loading"
                kind="loading"
                title={t('workflows.editor.loadingTitle')}
                accessibilitySemantics="status"
            />
        );
    }

    return (
        <WorkflowEventValueContext.Provider value={eventValueContext}>
        <View style={styles.root}>
            {presented ? <WorkflowEditorCurrentContext draftStore={bodyDraftStore} scope={authoringHost.sessionBindingScope}
                workflowId={saved?.definitionId} /> : null}
            {deletePending ? <SurfaceStateCard testID="workflow-editor-deleting" size="line" kind="loading"
                title={t('status.working')} reason={t('workflows.page.deleteWorkflow')} accessibilitySemantics="status" /> : null}
            {/* The editor body owns this page's one scroll, because it also owns
                the pinned command surface that must stay on screen while the
                authored document scrolls beneath it. */}
            <WorkflowEditorBody
                triggerEvents={triggers.triggerEvents}
                accountLifetime={props.accountLifetime}
                draftStore={bodyDraftStore}
                onBack={draftNavigation.requestBack}
                focusNameOnMount={catalogSeed !== undefined && props.source.kind === 'new'}
                documentPresentation={testRunPresentation}
                authoringSessionId={canEditDefinition ? authoringSessionId : null}
                authoringServerId={authoringServerId}
                {...(!canEditDefinition || authoringDraft === null ? {} : { authoringDraft: {
                    draftId: authoringDraft.draftId,
                    serverId: authoringDraft.serverId,
                    isCurrent: authoringDraft.isCurrent,
                    onSessionCreated: onAgentDraftSessionCreated,
                } })}
                {...(!canEditDefinition || saved === null || !detailsPaneAvailable ? {} : { onEditWithAgent: editWithAgent })}
                {...(reviewedRunSeed === null ? {} : {
                    reviewNotice: (
                        <ItemGroup>
                            <Item
                                testID="workflow-editor-reviewed-copy-notice"
                                title={t('workflows.page.reviewedCopyTitle')}
                                subtitle={t('workflows.page.reviewedCopyBody')}
                                subtitleLines={0}
                                showChevron={false}
                            />
                        </ItemGroup>
                    ),
                    onBackToRun: () => {
                        if (!reviewedRunSeedState.lifetime?.isCurrent()) return;
                        router.push(createWorkflowRunRoute(reviewedRunSeed.sourceRunId, reviewedRunSeedState.lifetime.scope.serverId) as never);
                    },
                })}
                authoringFacts={authoringHost.authoringFacts}
                existingSessions={authoringHost.existingSessions}
                sessionOptionsStatus={authoringHost.sessionOptionsStatus}
                onRetrySessionOptions={authoringHost.retrySessionOptions}
                sessionDropCandidates={authoringHost.sessionDropCandidates}
                sessionBindingScope={authoringHost.sessionBindingScope}
                onSessionOptionsDemandChange={authoringHost.onSessionOptionsDemandChange}
                mountedDraftActions={mountedDraftActions}
                composerScope={authoringHost.composerScope}
                commandsRef={editorCommandsRef}
                onChange={(next, label, committed) => {
                    if (!canEditDefinition) return;
                    let editLabel = label;
                    if (editLabel === undefined) {
                        const previousBlocks = walkWorkflowBlocks(bodyDraftStore.get().blocks);
                        const nextBlocks = walkWorkflowBlocks(next.blocks);
                        const edit = selectWorkflowAnnouncement(
                            { ...EMPTY_WORKFLOW_ANNOUNCEMENT_STATE, blockIds: previousBlocks.map((block) => block.id) },
                            { ...EMPTY_WORKFLOW_ANNOUNCEMENT_STATE, blockIds: nextBlocks.map((block) => block.id) },
                        );
                        editLabel = edit === null ? t('workflows.editor.history.edited') : formatWorkflowAnnouncement(edit, (id) => {
                            const block = nextBlocks.find((entry) => entry.id === id) ?? previousBlocks.find((entry) => entry.id === id);
                            return block === undefined ? id : workflowBlockReferenceLabel(block);
                        });
                    }
                    changeSnapshot({ draft: next }, editLabel, committed);
                    setDraft(next);
                }}
                onUseExample={(insertion) => {
                    if (!canEditDefinition) return;
                    const nextTriggerDraft = insertion.trigger === undefined ? triggers.draft
                        : editWorkflowTriggerDraft(triggers.draft, { kind: 'add', clientId: randomUUID(), trigger: insertion.trigger });
                    const nextProject = insertion.sessionTarget === undefined ? projectTarget : resolveStarterProject(insertion.sessionTarget);
                    changeSnapshot({ draft: insertion.draft, projectTarget: nextProject,
                        triggers: triggers.captureSnapshot(nextTriggerDraft) }, t('workflows.editor.history.example'));
                    setDraft(insertion.draft);
                    setProjectTarget(nextProject);
                    triggers.setDraft(nextTriggerDraft);
                    if (insertion.sessionTarget !== undefined) seededContextualTargetRef.current = true;
                }}
                {...(canEditDefinition ? { history: historyControls, onCommitChange: history.commit } : {})}
                highlightedBlockIds={highlightedBlockIds}
                {...(newSessionSeed?.composer === undefined ? {} : { composerSeeds: [newSessionSeed.composer] })}
                machineName={machineName}
                projectTarget={projectTarget}
                projectMachines={machines}
                onChangeProjectTarget={(target) => {
                    if (!isWorkflowProjectTarget(target)) return;
                    editMountedDraft({ expectedDraftRevision: history.getRevision(), settings: { projectTarget: target } }, t('workflows.editor.history.where'));
                }}
                selectedBlockId={selection.selectedBlockId}
                onSelectBlock={(blockId) => { setHighlightedBlockIds(NO_HIGHLIGHTED_BLOCKS); setSelection((current) => selectWorkflowBlock(current, blockId)); }}
                onCustomizeBlock={(blockId) => { setHighlightedBlockIds(NO_HIGHLIGHTED_BLOCKS); setSelection((current) => selectWorkflowBlock(current, blockId)); }}
                inspectorGroupDisclosure={selection.inspectorGroupDisclosure}
                onChangeInspectorGroup={(groupId, expanded) => setSelection((current) => (
                    setWorkflowInspectorGroupExpanded(current, groupId, expanded)
                ))}
                view={view}
                onChangeView={setView}
                executionTarget={executionTarget}
                runAsTargets={runAsTargets}
                onChangeExecutionTarget={(next) => {
                    editMountedDraft({ expectedDraftRevision: history.getRevision(), settings: { executionTarget: next } }, t('workflows.editor.history.target'));
                }}
                onRunNow={handleRunNow}
                {...(saved === null ? {} : { onTestRun: handleTestRun, testRunPending: testSourcePending })}
                runNowAnchorRef={runNowAnchorRef}
                runNowPlacementRef={runNowPlacementRef}
                testRunAnchorRef={testRunAnchorRef}
                runPending={testSourcePending || runNow.isPending(pendingRunId ?? '')}
                {...(canManagePersonalTriggers ? (() => {
                    // One trigger owner, two presentations: the When card (Steps) and the When clause (Sentence).
                    const section = {
                        accountLifetime: props.accountLifetime,
                        testIDPrefix: 'workflow-editor',
                        workflowDefinitionId: saved?.definitionId,
                        set: triggers.set,
                        draft: triggers.draft,
                        onEditSeedApplied: (trigger: Parameters<NonNullable<React.ComponentProps<typeof WorkflowTriggerSection>['onEditSeedApplied']>>[0],
                            seed: Parameters<NonNullable<React.ComponentProps<typeof WorkflowTriggerSection>['onEditSeedApplied']>>[1]) => {
                            const current = snapshotRef.current;
                            if (current) snapshotRef.current = { ...current, triggers: triggers.captureSnapshot(undefined, {
                                triggerId: seed.triggerId, revision: seed.expectedTriggerRevision, trigger,
                            }) };
                        },
                        onChangeDraft: (next: React.ComponentProps<typeof WorkflowTriggerSection>['draft']) => {
                            editMountedDraft({ expectedDraftRevision: history.getRevision(), settings: { triggers: triggers.captureSnapshot(next) } }, t('workflows.editor.history.triggers'));
                        },
                        status: triggers.status,
                        onRetry: triggers.retry,
                        whereTarget: projectTarget,
                        whereSummary: formatWorkflowWhereSummary({ target: projectTarget, machineName, machineHomeDir }),
                        inputs: triggerInputs,
                        stepsUnsaved: definitionDraftDirty,
                        incomplete: { state: triggers.incomplete, onChange: triggers.updateIncomplete },
                    } satisfies React.ComponentProps<typeof WorkflowTriggerSection>;
                    return { onSave: saveFromUi, triggersSummary: triggers.summary,
                        onAddTriggerWhen: (when: TriggerWhenValue, seed?: WorkflowTriggerDraftSeedIntent) => addWorkflowTriggerWhen({ draft: triggers.draft, when, seed,
                            onChangeDraft: section.onChangeDraft, updateIncomplete: triggers.updateIncomplete }),
                        resultDecides: formatTriggerResultDecides(projectWorkflowTriggerRows(triggers.set, triggers.draft).map((row) => row.trigger)),
                        triggersSection: <WorkflowEditorTriggerSection draftStore={bodyDraftStore} {...section} />,
                        triggersSentence: <WorkflowTriggerSection {...section} presentation="sentence" /> };
                })() : {})}
                savePending={savePending}
                saveStatus={saveStatus}
                resolveActionFieldOptions={resolveActionFieldOptions}
                currentWorkflowRef={saved?.definitionId ?? null}
                description={description}
                {...(canEditDefinition ? { onChangeDescription: (next: string) => {
                    editMountedDraft({ expectedDraftRevision: history.getRevision(), settings: { description: next } }, t('workflows.editor.history.description'), false);
                } } : {})}
                saveConflict={canEditDefinition ? saveConflict : null}
                menuActions={menuActions}
                {...(canEditDefinition ? { onSaveAsCopy: handleSaveAsCopy, onImportJson: handleImportJson } : {})}
                onExportJson={handleExportJson}
            />
            {runComposer}
        </View>
        </WorkflowEventValueContext.Provider>
    );
}

/** Re-exported so a host can clear an override without importing the draft owner. */
export { setWorkflowStepExecutionField };

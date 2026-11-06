import { getWorkflowContextChipDefinition } from '../workflowComposerControlPlacements';
import { useSession } from '@/sync/domains/state/storage';
import { SessionDraftHydrationBoundary } from '@/components/sessions/drafts/SessionDraftHydrationBoundary';
// Load the canonical read projection before a cold editor publishes a delete acknowledgement.
import '../library/workflowLibraryReads';
import * as React from 'react';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { createWorkflowDefinitionRoute, createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { Platform, ScrollView, View } from 'react-native';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { randomUUID } from 'expo-crypto';
import { StyleSheet } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope, useActiveServerAccountScopeLifetime, useAllMachines, useSetting } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t, tLoose } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { useMountedRef } from '@/hooks/ui/useMountedRef';

import { matchesWorkflowAcceptedDefinitionV1 } from '@happier-dev/protocol/workflows/workflowValidationV1';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { WORKFLOW_STARTER_EXAMPLES_V1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { getBuiltinWorkflowCatalogV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import type { ArtifactCallerAccessV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { projectNativeJsonValueForTransport, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { isWorkflowProjectTarget, type WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import type { WorkflowArtifactRevisionV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';

import {
    createWorkflowDefinition,
    deleteWorkflowDefinition,
    getWorkflowDefinition,
    isWorkflowDefinitionConflictError,
    updateWorkflowDefinition,
} from '@/sync/domains/workflows/workflowDefinitionActions';
import {
    buildWorkflowDefinitionCandidate,
    buildWorkflowEditorDraftFromDefinition,
    validateWorkflowEditorDraft,
} from '@/sync/domains/workflows/workflowAuthoring';
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
import { useWorkflowAuthoringHost } from './useWorkflowAuthoringHost';
import type { WorkflowSaveConflict, WorkflowSaveStatusState } from '../editor/WorkflowSaveStatus';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { WorkflowMissingDefinitionState } from './WorkflowMissingDefinitionState';
import { WorkflowExamplesSection } from '../library/WorkflowExamplesSection';
import { WorkflowTriggerSection } from '../triggers/WorkflowTriggerSection';
import { useWorkflowTriggerEditing } from '../triggers/useWorkflowTriggerEditing';
import { editWorkflowTriggerDraft, EMPTY_WORKFLOW_TRIGGER_DRAFT, WorkflowTriggerSnapshotRestoreError, type WorkflowTriggerSnapshot } from '../triggers/workflowTriggerDraft';
import { useWorkflowEditorHistory, workflowEditorSnapshotsEqual } from '../editor/useWorkflowEditorHistory';
import { formatWorkflowWhereSummary } from '../editor/WorkflowProjectTargetControl';
import { createExecutionRunStartContentChip } from '@/components/sessions/runs/launcher/executionRunStartChips';
import { createWorkflowStartWhereChip } from '../run/workflowStartWhereChip';
import { useActionFieldOptionsForMachine } from '@/components/sessions/actions/useSessionActionFieldOptions';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { findWorkflowActionSpec } from '@/components/workflows/presentation/workflowActionCatalog';
import { formatWorkflowProblemMessage, resolveWorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { exportWorkflowDocument, importWorkflowDocumentViaAction, type WorkflowImportResult } from '@/sync/domains/workflows/workflowInterchange';
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
type PendingDefinitionCreate = Readonly<{
    input: Pick<Parameters<typeof createWorkflowDefinition>[0], 'definitionId' | 'definition' | 'metadata'>;
    draft: WorkflowEditorDraft;
    description: string;
}>;

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
    const destinationInstanceKey = useDestinationInstanceKey();
    const nativeEditorRoute = Platform.OS !== 'web' && destinationInstanceKey === null;
    const navigation = useNavigation();
    const focusedMachines = useAllMachines();
    const focusedAccountScope = useActiveServerAccountScope();
    const focusedAccountLifetime = useActiveServerAccountScopeLifetime();
    const accountLifetime = props.accountLifetime === undefined ? focusedAccountLifetime : props.accountLifetime;
    const workflowRunDetailActions = React.useMemo(() => createWorkflowRunDetailActions({ accountLifetime }), [accountLifetime]);
    const activeAccountScope = accountLifetime?.scope ?? null;
    const mention = useEntityComposerMention();
    const addressedMachines = useMachineListForServer(activeAccountScope?.serverId ?? '');
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
    const [highlightedBlockIds, setHighlightedBlockIds] = React.useState<readonly string[]>([]);
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
                ? buildWorkflowEditorDraftFromDefinition({ draftId: randomUUID(), ...definitionDraftSeed })
            : newSessionSeed !== null
                ? newSessionSeed.draft
                : triggerSeed !== null
                    ? buildWorkflowEditorDraftFromDefinition({ draftId: randomUUID(), name: '', definition: triggerSeed.definition })
                    : catalogSeed !== undefined
                        ? buildWorkflowEditorDraftFromDefinition({ draftId: randomUUID(), name: tLoose(catalogSeed.titleKey), definition: catalogSeed.definition })
                        : createWorkflowEditorDraft({ draftId: randomUUID() })
    );

    const [draft, setDraft] = React.useState<WorkflowEditorDraft | null>(
        props.source.kind === 'saved' ? null : createDraftForSource(reviewedRunSeed),
    );
    // The pristine baseline is the exact draft this editor started from, not a
    // second construction of it: comparing against a different object with a
    // different draft id would report an untouched editor as dirty.
    const initialDraftBaselineRef = React.useRef<WorkflowEditorDraft | null>(draft);
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
    const [hydrationAttempt, setHydrationAttempt] = React.useState(0);
    const [view, setView] = React.useState<WorkflowEditorView>('steps');
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
    const pendingDefinitionCreatesRef = React.useRef<{ save: PendingDefinitionCreate | null; copy: PendingDefinitionCreate | null }>({ save: null, copy: null });
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
    const testRunAnchorRef = React.useRef<View | null>(null);
    // The contextual default comes from the canonical New Session resolver, and
    // only when it produces a genuinely valid choice (UX §2.3). A reviewed copy
    // keeps its predecessor's accepted target instead.
    const accountMemory = useWorkflowEditorAccountMemory(props.accountLifetime);
    const recentMachinePaths = accountMemory.recentMachinePaths as
        | ReadonlyArray<Readonly<{ machineId?: string | null; path?: string | null }>>
        | undefined;
    const rememberedDefinitionId = initializedKey === initializationKey
        ? saved?.definitionId ?? sourceDefinitionId : sourceDefinitionId;
    const rememberedProject = rememberedDefinitionId === null ? null
        : accountMemory.workflowProjectTargetsByDefinitionId[rememberedDefinitionId] ?? null;
    const persistAuthoringMemory = accountMemory.apply;
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
        rememberedProject ?? reviewedRunSeed?.project ?? newSessionProject ?? starterProject,
    );
    const savedProjectTargetRef = React.useRef(projectTarget);
    const authoredProjectTargetRef = React.useRef(false);
    const setProjectTarget = React.useCallback((target: WorkflowProjectTargetV1 | null) => {
        authoredProjectTargetRef.current = true;
        setProjectTargetState(target);
    }, []);
    const seededContextualTargetRef = React.useRef(reviewedRunSeed?.project !== undefined || newSessionProject !== null
        || definitionDraftSeed?.sessionTarget !== undefined || rememberedProject !== null);
    /** Whether this logical source has already been offered the contextual Agent. */
    const seededContextualAgentRef = React.useRef(false);
    React.useEffect(() => {
        // A delayed Account projection may replace only the contextual seed,
        // never a Machine/path the person or a mounted Action already authored.
        if (rememberedProject === null || authoredProjectTargetRef.current) return;
        savedProjectTargetRef.current = rememberedProject;
        seededContextualTargetRef.current = true;
        setProjectTargetState(rememberedProject);
    }, [rememberedProject]);
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
        reviewedRunSeed?.executionTarget.kind ?? 'session',
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
        setDraft(next);
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
        setHighlightedBlockIds([]);
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
        setView('steps');
        setInputValues(withdrawn ? {} : nextReviewedRunSeed?.inputs ?? {});
        setInputRawTextValues({});
        setInputSheetOpen(!withdrawn && nextReviewedRunSeed?.planReview !== undefined);
        setPlanEditingAccepted(false);
        setReportBack(true);
        setPlanPending(false);
        planPendingRef.current = false;
        setExecutionTarget(nextReviewedRunSeed?.executionTarget.kind ?? 'session');
        pendingRunIdRef.current = null;
        importRequestedRef.current = false;
        consumedEntryIntentKeyRef.current = null;
        setContentScopeKey(sourceKind === 'saved' ? null : accountScopeKey);
        // A different logical source is a different pristine draft, so the
        // contextual Agent is offered to it again rather than being consumed
        // for the whole mount.
        seededContextualAgentRef.current = false;
        const nextProjectTarget = withdrawn ? null : rememberedProject ?? nextReviewedRunSeed?.project ?? newSessionProject ?? starterProject;
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

    React.useEffect(() => {
        if (sourceKind !== 'saved' || sourceDefinitionId === null) return;
        // This logical source already has accepted content, including a saved copy.
        // Refetching the route's original Artifact would replace that copy's
        // identity and redirect a partial Save retry to the original definition.
        if (saved !== null && contentScopeKey === accountScopeKey
            && (saved.definitionId !== sourceDefinitionId || agentRevision === null && agentSeedId === null)) return;
        const lifetime = accountLifetime;
        if (lifetime === null) return;
        const requestScopeKey = accountScopeKey;
        let cancelled = false;
        void (async () => {
            try {
                const result = await getWorkflowDefinition({ definitionId: sourceDefinitionId, accountLifetime });
                if (cancelled || !lifetime.isCurrent()) return;
                setDefinitionAccess(result.access);
                // Agent snapshots carry exact reviewed bytes, not authority for
                // the current caller. Read access without replacing that snapshot.
                if (agentRevision !== null || agentSeedId !== null) return;
                const hydrated = buildWorkflowEditorDraftFromDefinition({
                    draftId: randomUUID(),
                    name: result.metadata.title,
                    definition: result.definition,
                    captureProvenance: result.metadata.captureProvenance,
                });
                savedDescriptionRef.current = result.metadata.description ?? '';
                setDescription(result.metadata.description ?? '');
                savedDraftRef.current = hydrated;
                initialDraftBaselineRef.current = hydrated;
                setDraft(hydrated);
                setSaved({ definitionId: result.definitionId, revision: result.revision });
                setContentScopeKey(requestScopeKey);
            } catch (error) {
                if (cancelled || !lifetime.isCurrent()) return;
                setHydrationFailure({ error });
            }
        })();
        return () => { cancelled = true; };
    }, [accountLifetime, accountScopeKey, agentRevision, agentSeedId, contentScopeKey, hydrationAttempt, saved?.definitionId, sourceDefinitionId, sourceKind]);

    const retryHydration = React.useCallback(() => {
        setHydrationFailure(null);
        setHydrationAttempt((attempt) => attempt + 1);
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
    const triggers = useWorkflowTriggerEditing({ definitionId: saved?.definitionId ?? null, sourceKey: authoringSourceKey, projectTarget, accountLifetime });
    React.useEffect(() => {
        const trigger = definitionDraftSeed?.trigger;
        if (trigger === undefined || privateSeedWithdrawn || saved !== null) return;
        triggers.setDraft(editWorkflowTriggerDraft(EMPTY_WORKFLOW_TRIGGER_DRAFT, { kind: 'add', clientId: randomUUID(), trigger }));
    }, [initializationKey, definitionDraftSeed?.trigger, privateSeedWithdrawn, saved?.definitionId, triggers.setDraft]);
    const snapshotRef = React.useRef<WorkflowEditorSnapshot | null>(null);
    snapshotRef.current = draft === null ? null : { draft, description, projectTarget, executionTarget, triggers: triggers.captureSnapshot() };
    // Import opens a fresh review document with a new draft id; it is an
    // initialization boundary, not a change to the prior document's history.
    const history = useWorkflowEditorHistory<WorkflowEditorSnapshot>(`${sourceGenerationRef.current}\u0000${draft?.draftId ?? ''}`, (snapshot) => {
        // Restore the semantic trigger intent before changing any other field:
        // inaccessible private trigger configuration cannot be fabricated.
        triggers.restoreSnapshot(snapshot.triggers);
        snapshotRef.current = snapshot;
        setDraft(snapshot.draft);
        setDescription(snapshot.description);
        setProjectTarget(snapshot.projectTarget);
        setExecutionTarget(snapshot.executionTarget);
        setHighlightedBlockIds([]);
        setSavedByAgent(false);
    });
    const changeSnapshot = (patch: Partial<WorkflowEditorSnapshot>, label: string, committed = true) => {
        const before = snapshotRef.current;
        if (before === null) return false;
        const after = { ...before, ...patch };
        if (!history.record(before, after, label, committed)) return false;
        snapshotRef.current = after;
        setHighlightedBlockIds([]);
        setSavedByAgent(false);
        return true;
    };
    const historyControls = {
        ...history.controls,
        undo: () => {
            try { history.controls.undo(); }
            catch (error) { void Modal.alert(t('workflows.editor.undo'), error instanceof WorkflowTriggerSnapshotRestoreError
                ? t('workflows.editor.historyRestoreRequiresSetup') : formatWorkflowProblemMessage(error)); }
        },
        redo: () => {
            try { history.controls.redo(); }
            catch (error) { void Modal.alert(t('workflows.editor.redo'), error instanceof WorkflowTriggerSnapshotRestoreError
                ? t('workflows.editor.historyRestoreRequiresSetup') : formatWorkflowProblemMessage(error)); }
        },
    };

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
     * "Pristine" is the strict reading: only a neutral `new` source with no
     * reviewed copy, and only while the draft is still byte-identical to the
     * one this editor started from. A captured Session, a hydrated Artifact, a
     * reviewed Run copy, an imported document and anything the person has
     * already touched all name their own Agent, and none of them is re-seeded.
     * Because this is initialization rather than an edit, the pristine baseline
     * moves with it and the editor does not report itself dirty.
     */
    const contextualAgentTarget = authoringHost.authoringFacts.contextualDefaultAgentTarget ?? null;
    React.useEffect(() => {
        if (seededContextualAgentRef.current) return;
        if (sourceKind !== 'new' || reviewedRunSeed !== null) return;
        if (contextualAgentTarget === null || draft === null) return;
        if (draft !== initialDraftBaselineRef.current) return;
        if (draft.defaults.engine !== undefined || draft.defaults.agentTarget) return;
        seededContextualAgentRef.current = true;
        const seeded = setWorkflowDefaultField(draft, 'agentTarget', contextualAgentTarget);
        initialDraftBaselineRef.current = seeded;
        setDraft(seeded);
    }, [contextualAgentTarget, draft, reviewedRunSeed, sourceKind]);

    const startRun = React.useCallback(async (
        inputs: Readonly<Record<string, JsonValue>> | undefined,
        roleOverrides?: WorkflowRunComposerModalProps['roleOverrides'],
        visibleTeamId?: string,
    ): Promise<void> => {
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
        const start = () => runNow.runNow({
            runId,
            ...(retained !== null ? {
                ...retained.input,
                ...(retained.project === undefined ? {} : { project: retained.project }),
            } : {
                ...(title.length === 0 ? {} : { metadata: { title,
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
    }, [accountLifetime, captureSourceGeneration, draft, executionTarget, pendingRunId, projectTarget, router, runAsTargets, runNow, planReview, reviewedRunSeed, ownedPlanOriginId, reportBack, saved?.definitionId, testSource]);

    const handleRunNow = React.useCallback(() => {
        if (draft === null || testSourcePending || runNow.isPending(pendingRunId ?? '')) return;
        if (runNow.hasUnsettledAdmission(pendingRunId ?? '')) {
            setInputSheetOpen(true);
            return;
        }
        // Every Run is reviewed in the composer, including a no-input recipe.
        setTestSource(null);
        setInputSheetOpen(true);
    }, [draft, pendingRunId, runNow, testSourcePending]);

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
    const definitionDraftDirty = definitionHasChanges(draft);
    const descriptionDraftDirty = description !== savedDescriptionRef.current;
    const projectTargetDirty = saved !== null && !pluginJsonValuesEqual(projectTarget, savedProjectTargetRef.current);

    const inputModalProps = React.useMemo<WorkflowRunComposerModalProps | null>(() => draft === null ? null : ({
        definition: retainedDefinition ?? testSource?.definition ?? validateWorkflowEditorDraft(draft).normalizedDefinition,
        sourceArtifactId: saved?.definitionId ?? null,
        ...(saved?.definitionId ? { optionsConsumer: { kind: 'workflow' as const, workflow: saved.definitionId } } : {}),
        inputs: retainedDefinition?.inputs ?? testSource?.definition.inputs ?? draft.inputs,
        retainedRequest: runRetained,
        values: inputValues,
        onChangeValues: setInputValues,
        rawTextValues: inputRawTextValues,
        onChangeRawTextValues: setInputRawTextValues,
        workflowName: runRetained?.input.metadata?.title ?? testSource?.metadata.title ?? draft.name,
        preview: (runRetained !== null ? '' : testSource?.metadata.description ?? (testSource === null ? description : '')) || (retainedDefinition?.blocks ?? testSource?.definition.blocks ?? draft.blocks).map((block) => workflowBlockReferenceLabel(block)).join('\n'),
        ...(planReview ? { preview: readWorkflowPlanResult(planReview.value)?.document, notice: t('workflows.review.planRunNotice') } : {}),
        ...(testSource === null && !retainedTest ? {} : { notice: t('workflows.testRun.savedNotice') }),
        // A retained request is described by what it sent, not by how the draft compares now.
        includesUnsavedEdits: runRetained === null && testSource === null && (definitionDraftDirty || descriptionDraftDirty),
        machineId: (runRetained?.project ?? projectTarget)?.machineId ?? null,
        directory: (runRetained?.project ?? projectTarget)?.directory ?? null,
        serverId: activeAccountScope?.serverId ?? null,
        ...(ownedPlanOriginId && activeAccountScope ? { originSession: {
            serverId: activeAccountScope.serverId, sessionId: ownedPlanOriginId,
        } } : {}),
        extraActionChips: [createWorkflowStartWhereChip({
            target: runRetained?.project ?? projectTarget, machineName: whereMachineName, machineHomeDir: whereHomeDir,
            machines, accountLifetime: props.accountLifetime,
            // The sent Where is shown without a setter; only a new start chooses again.
            ...(runRetained?.project ? {} : { onChange: (target: WorkflowAuthoringTarget) => { if (isWorkflowProjectTarget(target)) setProjectTarget(target); } }),
            testID: 'workflow-start-where-chip', testIDPrefix: 'workflow-start-where',
        }), ...(runRetained === null ? [] : [{ ...createExecutionRunStartContentChip({
            // The page's Run as belongs to the next start; the review names what this request runs in.
            ...getWorkflowContextChipDefinition('runAs'), pending: true, icon: 'stack', title: t('workflows.start.targetsTitle'),
            label: runRetained.input.executionTarget?.kind === 'detached_run' ? t('workflows.start.targetsBackground') : t('workflows.start.targetsSessions'),
            testID: 'workflow-start-run-as-chip', revision: runRetained.input.executionTarget?.kind ?? 'session',
            renderContent: <Item title={t('workflows.start.targetsTitle')} showChevron={false}
                subtitle={runRetained.input.executionTarget?.kind === 'detached_run' ? t('workflows.page.sections.aBackgroundRun') : t('workflows.page.sections.aSession')} />,
        }), controlId: 'workflowTargets' as const }]), ...(ownedPlanOriginId ? [{ ...createExecutionRunStartContentChip({ ...getWorkflowContextChipDefinition('planReport'), pending: true, icon: 'arrow-elbow-down-right',
            label: t('workflows.review.reportBackTitle', { session: planOriginName }), title: t('workflows.review.reportBackTitle', { session: planOriginName }),
            testID: 'workflow-plan-report-chip', revision: String([reportShown, runRetained !== null]), renderContent: <Item
                title={t('workflows.review.reportBackTitle', { session: planOriginName })} subtitle={t('workflows.review.reportBackBody', { session: planOriginName })}
                showChevron={false} rightElementOutsidePressable
                // A sent request's completion choice is fixed; the switch shows it and only a new start changes it.
                rightElement={<Switch testID="workflow-plan-report-switch" value={reportShown} onValueChange={setReportBack}
                    disabled={planPending || runRetained !== null} />} /> }),
            controlId: 'delivery' as const }] : [])],
        onRun: (inputs, roleOverrides, visibleTeamId) => { void startRun(inputs, roleOverrides, visibleTeamId); },
        onCancel: dismissInputSheet,
        pending: planPending || runNow.isPending(pendingRunId ?? ''),
        reconciling: runNow.stateFor(pendingRunId ?? '') === 'reconciling',
        startProblem: runNow.refusal,
    }), [activeAccountScope?.serverId, definitionDraftDirty, descriptionDraftDirty, description, dismissInputSheet, draft, inputRawTextValues, inputValues, machineName, machines, pendingRunId, projectTarget, retainedDefinition, whereHomeDir, whereMachineName, runNow, runRetained, saved?.definitionId, startRun, planReview, ownedPlanOriginId, planOriginName, reportShown, planPending, retainedTest, testSource]);

    const runComposer = useWorkflowRunComposerModal({ open: inputSheetOpen, props: inputModalProps,
        anchorRef: testSource === null && !retainedTest ? runNowAnchorRef : testRunAnchorRef });
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
        const validation = validateWorkflowEditorDraft(draft);
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
                    const savedDescription = description.trim();
                    const metadata = {
                        title: draft.name.trim(),
                        ...(savedDescription.length === 0 ? {} : { description: savedDescription }),
                        ...(draft.captureProvenance === undefined ? {} : { captureProvenance: draft.captureProvenance }),
                    };
                    const acknowledge = (result: Awaited<ReturnType<typeof createWorkflowDefinition>>, acceptedDraft: WorkflowEditorDraft, acceptedDescription: string) => {
                        savedDraftRef.current = acceptedDraft;
                        savedDescriptionRef.current = acceptedDescription;
                        persisted = { definitionId: result.definitionId, revision: result.revision };
                        setSaved(persisted);
                        setDefinitionAccess(result.access);
                        setSavedAtMs(Date.now());
                        setSavedByAgent(false);
                        setSaveConflict(null);
                    };
                    const createIntent = copying ? 'copy' : 'save';
                    const pendingCreate = pendingDefinitionCreatesRef.current[createIntent];
                    if (copying || persisted === null || pendingCreate !== null) {
                        const retained = pendingCreate ?? {
                            input: { definitionId: randomUUID(), definition: validation.normalizedDefinition, metadata },
                            draft, description,
                        };
                        pendingDefinitionCreatesRef.current[createIntent] = retained;
                        const result = await createWorkflowDefinition({ ...retained.input, accountLifetime,
                            ...(caller === undefined ? {} : { context: caller, signal: caller.signal }),
                        });
                        if (!isCurrent()) return { status: 'refused', reason: 'draft_retired' };
                        acknowledge(result, retained.draft, retained.description);
                        pendingDefinitionCreatesRef.current[createIntent] = null;
                    }
                    if (copying) {
                        // Copy is a document-identity transition. Retire A's
                        // producers and history at the existing source boundary,
                        // while this Save continues persisting B's captured Where.
                        sourceGenerationRef.current += 1;
                        sourceIsCurrent = captureSourceGeneration();
                        setAgentSession(null);
                        setAgentDraft(null);
                        setAgentSeedState((current) => ({ ...current, seed: null }));
                        observedAgentRevisionRef.current = null;
                        setHighlightedBlockIds([]);
                        pendingRetargetRef.current = null;
                        setRetargetFailed(false);
                        setTestSourcePending(false);
                        setTestSource(null);
                        setTestRun(null);
                        pendingRunIdRef.current = null;
                        history.reset();
                        pendingDefinitionCreatesRef.current = { save: null, copy: null };
                    }
                    // Rejoin with the retained bytes first. Edits made while its
                    // outcome was unknown then use the ordinary revision owner,
                    // never different content under the unresolved create id.
                    if (persisted !== null && (definitionHasChanges(draft) || description !== savedDescriptionRef.current)) {
                        const result = await updateWorkflowDefinition({
                            definitionId: persisted.definitionId,
                            expectedRevision: persisted.revision,
                            definition: validation.normalizedDefinition,
                            metadata, accountLifetime,
                            ...(caller === undefined ? {} : { context: caller, signal: caller.signal }),
                        });
                        if (!isCurrent()) return { status: 'refused', reason: 'draft_retired' };
                        acknowledge(result, draft, description);
                    }
                }
                if (persisted === null || !isCurrent()) return { status: 'refused', reason: 'draft_retired' };
                if (project !== null || rememberedProject !== null) {
                    await persistAuthoringMemory({ workflowProjectTargetsByDefinitionId: { [persisted.definitionId]: project } });
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
                return { status: 'refused', reason: 'save_failed' };
            } finally {
                if (isCurrent()) setSavePending(false);
            }
        })();
    }, [accountLifetime, canEditDefinition, canManagePersonalTriggers, captureSourceGeneration, definitionDraftDirty, descriptionDraftDirty, description, draft, saved, savePending, sourceKind, triggers, persistAuthoringMemory, rememberedProject]);

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
        if (draft === null || saved === null || definitionAccess === null || contentScopeKey !== accountScopeKey) return;
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
        draft,
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
        if (draft === null) return;
        const first = draft.blocks[0];
        if (first?.kind !== 'step') return;
        const commands = editorCommandsRef.current;
        if (commands === null) return;
        initialPromptFocusConsumedRef.current = true;
        commands.focusPrompt(first.id);
    }, [draft, props.source, reviewedRunSeed]);

    const handleImportJson = React.useCallback(() => {
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
    }, [canEditDefinition, captureSourceGeneration, draft]);

    const handleExportJson = React.useCallback(() => {
        if (draft === null) return;
        const exported = exportWorkflowDocument({ draft });
        if (!exported.ok) return;
        void (async () => {
            await confirmWorkflowDocumentExport({ name: draft.name, json: exported.json });
        })();
    }, [draft]);

    // Action-step field options are read for the Where Machine only while an
    // Action step exists, so an editor without one issues no capabilities read.
    const draftHasActionBlocks = React.useMemo(
        () => draft !== null && walkWorkflowBlocks(draft.blocks).some((block) => block.kind === 'action'),
        [draft],
    );
    const resolveActionFieldOptions = useActionFieldOptionsForMachine({
        machineId: projectTarget?.machineId ?? null,
        serverId: activeAccountScope?.serverId ?? null,
        enabled: draftHasActionBlocks,
        requests: (draft === null ? [] : walkWorkflowBlocks(draft.blocks)).flatMap((block) => {
            if (block.kind !== 'action') return [];
            const spec = findWorkflowActionSpec(block.actionId);
            if (!spec) return [];
            const input = Object.fromEntries(Object.entries(block.input).flatMap(([path, binding]) =>
                binding.kind === 'literal' ? [[path, binding.value]] : []));
            return resolveEffectiveActionInputFields(spec, input).map((field) => ({ field, actionId: spec.id, draftInput: input }));
        }),
    });

    const readDraftDirty = (documentDraft: WorkflowEditorDraft | null, documentDescription: string) => documentDraft !== null
        && (projectTargetDirty || saveFailure !== undefined || (canEditDefinition && (definitionHasChanges(documentDraft) || documentDescription !== savedDescriptionRef.current || retargetFailed))
            || (canManagePersonalTriggers && triggers.dirty));
    const routeDraftDirty = readDraftDirty(draft, description);
    React.useEffect(() => {
        if (!agentRevision || !activeAccountScope || agentRevision.definitionId !== editableDefinitionId) return;
        const key = `${accountScopeKey}:${agentRevision.definitionId}:${agentRevision.revision.headerVersion}:${agentRevision.revision.bodyVersion}`;
        if (observedAgentRevisionRef.current === key) return;
        observedAgentRevisionRef.current = key;
        if (saved && (agentRevision.revision.headerVersion < saved.revision.headerVersion
            || agentRevision.revision.bodyVersion < saved.revision.bodyVersion
            || pluginJsonValuesEqual(agentRevision.revision, saved.revision))) return;
        const incoming = buildWorkflowEditorDraftFromDefinition({
            draftId: draft?.draftId ?? randomUUID(),
            name: agentRevision.metadata.title,
            definition: agentRevision.definition,
            captureProvenance: agentRevision.metadata.captureProvenance,
        });
        if (draft !== null && (routeDraftDirty || savePending)) {
            setSaveConflict({ currentDraft: incoming, currentRevision: agentRevision.revision });
            return;
        }
        const nextDescription = agentRevision.metadata.description ?? '';
        const before = snapshotRef.current;
        if (before !== null) {
            const after = { ...before, draft: incoming, description: nextDescription };
            history.record(before, after, t('workflows.editor.history.agent'));
            snapshotRef.current = after;
        }
        savedDraftRef.current = incoming;
        initialDraftBaselineRef.current = incoming;
        savedDescriptionRef.current = nextDescription;
        setDraft(incoming);
        setDescription(nextDescription);
        setSaved({ definitionId: agentRevision.definitionId, revision: agentRevision.revision });
        setSaveConflict(null);
        setSaveFailure(undefined);
        setSavedAtMs(Date.now());
        setSavedByAgent(true);
        setHighlightedBlockIds(agentRevision.changedBlockIds);
        setContentScopeKey(accountScopeKey);
    }, [accountScopeKey, activeAccountScope, agentRevision, description, draft, editableDefinitionId, routeDraftDirty, savePending, saved]);
    /**
     * The one save status (B1): the host's save owner is the only thing that
     * knows whether this draft is kept. A pristine new draft is "Not saved yet";
     * any change is "Unsaved changes" with Save; the receipt reflects the
     * accepted snapshot, so an edit made while saving is not marked saved.
     */
    const saveStatus = React.useMemo((): WorkflowSaveStatusState => {
        if (savePending) return { kind: 'saving' };
        if (saveFailure !== undefined && routeDraftDirty) return { kind: 'failed', reason: saveFailure };
        if (routeDraftDirty) return { kind: 'unsaved' };
        if (saved === null) return { kind: 'notSaved' };
        return { kind: 'saved', savedAtMs, ...(savedByAgent ? { byAgent: true } : {}) };
    }, [routeDraftDirty, saveFailure, savePending, saved, savedAtMs, savedByAgent]);

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
        setHighlightedBlockIds([]);
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
            await deleteWorkflowDefinition({ definitionId: saved.definitionId, signal: controller.signal, accountLifetime,
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
        if (!lifetime) return { status: 'unavailable' };
        const draftDecisionIsCurrent = captureDraftDecisionCurrentness();
        const confirmed = await Modal.confirm(
            t('common.discardChanges'),
            t('workflows.page.discardChangesBody'),
            { cancelText: t('common.keepEditing'), confirmText: t('common.discard'), destructive: true },
        );
        const before = snapshotRef.current;
        if (!confirmed) return { status: 'refused', reason: 'cancelled' };
        if (!draftDecisionIsCurrent() || before === null) return { status: 'refused', reason: 'draft_retired' };
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
        setHighlightedBlockIds([]);
        setSaveFailure(undefined);
        return { status: 'applied', draftRevision: history.getRevision() };
    }, [canEditDefinition, captureDraftDecisionCurrentness, captureTriggerSnapshot, recordHistory, saved, setTriggerDraft]);

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
            const validation = validateWorkflowEditorDraft(current.draft);
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
    const shareName = draft?.name.trim() ?? '';
    const editWithAgent = React.useCallback(() => {
        if (!canEditDefinition || saved === null) return;
        openAgentEdit(buildWorkflowAgentAuthoringSeed({
            kind: 'edit',
            name: savedDraftRef.current?.name ?? shareName,
            definitionId: saved.definitionId,
            revision: saved.revision,
        }));
    }, [canEditDefinition, openAgentEdit, saved, shareName]);
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
    }, [accountLifetime, accessResolved, description, draft, router, savePending]);
    const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => {
        const actions: PageHeaderMenuAction[] = [];
        if (saved !== null && activeAccountScope) actions.push({ id: 'mentionInComposer', title: t('entityDragDrop.composer.mentionInComposer'),
            testID: 'workflow-editor-menu-mention-in-composer',
            onSelect: async () => { await mention({ kind: 'workflow', scope: activeAccountScope, workflowId: saved.definitionId }, shareName || t('workflows.page.untitled')); } });
        if (saved !== null && accessResolved) actions.push({ id: 'duplicate', title: t('common.duplicate'),
            testID: 'workflow-editor-menu-duplicate', disabled: savePending || draft === null || validateWorkflowEditorDraft(draft).normalizedDefinition === undefined,
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
                onSelect: () => showDocumentShareSheet({
                    kind: 'workflow-definition.v1',
                    ...(activeAccountScope ? { scope: activeAccountScope } : {}),
                    artifactId: saved.definitionId,
                    name: shareName || t('workflows.page.untitled'),
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
    }, [accountLifetime, activeAccountScope, accessResolved, canEditDefinition, detailsPaneAvailable, draft, draftNavigation.requestLeave, editWithAgent,
        handleDelete, handleDiscardChanges, handleDuplicate, mention, routeDraftDirty, savePending, deletePending, saved, shareName]);

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
            onOpenCollection={() => router.replace('/workflows')} />;
    }
    if (props.source.kind === 'new' && definitionDraftSeed === null && catalogSeed !== undefined
        && 'triggerSeed' in catalogSeed && catalogSeed.triggerSeed !== undefined) {
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
    if (draft === null || !accessResolved || contentScopeKey !== accountScopeKey) {
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
        <View style={styles.root}>
            {deletePending ? <SurfaceStateCard testID="workflow-editor-deleting" size="line" kind="loading"
                title={t('status.working')} reason={t('workflows.page.deleteWorkflow')} accessibilitySemantics="status" /> : null}
            {/* The editor body owns this page's one scroll, because it also owns
                the pinned command surface that must stay on screen while the
                authored document scrolls beneath it. */}
            <WorkflowEditorBody
                accountLifetime={props.accountLifetime}
                draft={draft}
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
                        const previousBlocks = walkWorkflowBlocks(draft.blocks);
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
                onSelectBlock={(blockId) => { setHighlightedBlockIds([]); setSelection((current) => selectWorkflowBlock(current, blockId)); }}
                onCustomizeBlock={(blockId) => { setHighlightedBlockIds([]); setSelection((current) => selectWorkflowBlock(current, blockId)); }}
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
                testRunAnchorRef={testRunAnchorRef}
                runPending={testSourcePending || runNow.isPending(pendingRunId ?? '')}
                {...(canManagePersonalTriggers ? { onSave: saveFromUi, triggersSummary: triggers.summary,
                triggersSection: (
                    <WorkflowTriggerSection
                        accountLifetime={props.accountLifetime}
                        testIDPrefix="workflow-editor"
                        set={triggers.set}
                        draft={triggers.draft}
                        onChangeDraft={(next) => {
                            editMountedDraft({ expectedDraftRevision: history.getRevision(), settings: { triggers: triggers.captureSnapshot(next) } }, t('workflows.editor.history.triggers'));
                        }}
                        status={triggers.status}
                        onRetry={triggers.retry}
                        whereTarget={projectTarget}
                        whereSummary={formatWorkflowWhereSummary({ target: projectTarget, machineName, machineHomeDir })}
                        inputs={draft?.inputs ?? []}
                        stepsUnsaved={definitionDraftDirty}
                    />
                ) } : {})}
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
    );
}

/** Re-exported so a host can clear an override without importing the draft owner. */
export { setWorkflowStepExecutionField };

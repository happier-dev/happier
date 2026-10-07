import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View, type TextInput } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { AppPaneScopeHost, type AppPaneDestinationDetails } from '@/components/appShell/panes/AppPaneScopeHost';
import { DEFAULT_MAIN_MIN_PX } from '@/components/ui/panels/paneBreakpoints';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover/Popover';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import type { PaneBuiltinAdapter } from '@/components/appShell/panes/types';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { KeyboardAwareScrollView } from '@/components/ui/keyboardAvoidance/KeyboardAwareScrollView';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { SessionAuthoringControls, useSessionAuthoringEngineSummary } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import type { SessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import {
    useWorkflowAuthoringComposerCustody,
    type AuthoringComposerSeed,
} from '@/components/sessions/authoring/authoringComposerCustody';
import { Typography } from '@/constants/Typography';
import { useKeyboardShortcutHandlers } from '@/keyboard';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { t, tLoose } from '@/text';
import type { WorkflowStarterExampleV1 } from '@happier-dev/protocol';

import {
    firstBlockingWorkflowIssue,
    resolveWorkflowExportBlockedReason,
    resolveEffectiveWorkflowStepExecution,
    resolveWorkflowIssueBlockId,
    resolveWorkflowRunBlockedReason,
    resolveWorkflowSaveBlockedReason,
    validateWorkflowEditorDraft,
    type WorkflowCommandBlockedReason,
    type WorkflowDraftValidation,
    type WorkflowExistingSessionOption,
} from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowValidationIssue } from '@happier-dev/protocol/workflows/workflowV1';
import { withWorkflowAuthoringEngine, withWorkflowAuthoringEngineFields } from '@/sync/domains/workflows/workflowAuthoringEngineSelection';
import { resolveWorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import type { WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import type { Machine } from '@/sync/domains/state/storageTypes';

import {
    findWorkflowBlock,
    setWorkflowDefaultField,
    setWorkflowStepExecutionField,
    walkWorkflowBlocks,
} from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { insertWorkflowEditorBlock, insertWorkflowStarterExample, type WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import type { WorkflowEditorHistoryControls } from '../editor/useWorkflowEditorHistory';
import {
    resolveSessionAuthoringRuntimeDescriptorAvailability,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';

import { EMPTY_WORKFLOW_ANNOUNCEMENT_STATE } from '../accessibility/workflowAnnouncementSelection';
import { announceWorkflowCommandRefused, useWorkflowAnnouncements } from '../accessibility/useWorkflowAnnouncements';
import { WorkflowBlockListEditor, type WorkflowDocumentPresentation } from '../editor/WorkflowBlockListEditor';
import type { ResolveSessionActionFieldOptions } from '@/components/sessions/actions/sessionActionFieldOptions';
import { WorkflowInspector } from '../editor/WorkflowInspector';
import { WorkflowAddBlockMenu } from '../editor/WorkflowAddBlockMenu';
import { useWorkflowSessionBinding } from '../editor/useWorkflowSessionBinding';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import {
    WorkflowProjectTargetControl,
    formatWorkflowWhereSummary,
    type WorkflowProjectTargetControlHandle,
} from '../editor/WorkflowProjectTargetControl';
import {
    WorkflowSaveStatus,
    type WorkflowSaveConflict,
    type WorkflowSaveStatusState,
} from '../editor/WorkflowSaveStatus';
import { WorkflowFlowView } from '../flow/WorkflowFlowView';
import { projectWorkflowFlow, resolveWorkflowFlowEditTarget, type WorkflowFlowEditTarget } from '../flow/workflowFlowProjection';
import { useWorkflowFlowChildren } from '../flow/useWorkflowFlowChildren';
import { describeWorkflowCommandBlockedReason } from '../presentation/workflowBlockedReasonText';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import type { WorkflowRunAsTarget, WorkflowRunAsTargetKind } from '../run/workflowRunAsTargets';
import { WorkflowAuthoringSessionPane } from '../authoring/WorkflowAuthoringSessionPane';
import { WorkflowAgentAuthoringDraft, type WorkflowAgentAuthoringDraftProps } from '../authoring/useWorkflowAgentAuthoring';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

/**
 * The workflow editor page (04 §4, lab `editor-E1`).
 *
 * Identity first: the glyph mark, the name and description edited in place,
 * one primary **Run now**, and under it the save status that is its own
 * receipt. The header chips (Where, Agent & model) and the Workflow settings
 * sections render one owner each. The document is the execution order.
 *
 * Panes are the one pane primitive's slots (INT §3.1 #5): **Flow** is the
 * editor scope's right pane, rendered through `rightPaneBuiltinAdapter`;
 * **Workflow settings** is the destination-owned details pane. Where each docks
 * or overlays is `resolvePaneLayout`'s decision — this page passes no Details
 * opener and adds no placement rule of its own. On a phone there are no side
 * slots: Flow is the **Steps | Flow** switch and settings open in `@/modal`.
 *
 * It owns no route, no persistence and no admission: the host supplies the
 * draft and the explicit Run now / Save effects.
 */

/**
 * The editor's own pane scope: Flow's open state and width persist across
 * workflows like a preference, and the App scope's plugin tabs are not shared.
 */
export const WORKFLOW_EDITOR_PANE_SCOPE_ID = 'workflow-editor';
const WORKFLOW_FLOW_PANE_DESTINATION_ID = 'workflow-flow';

/** The Agent & model chips the header shows; every field is in Workflow settings. */
const HEADER_ENGINE_FIELDS = ['agentTarget', 'modelSelection'] as const;

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    pageScroll: {
        flexGrow: 1,
    },
    pageContent: {
        alignSelf: 'center',
        width: '100%',
        paddingBottom: theme.margins.xl,
    },
    headerActions: {
        alignItems: 'flex-end',
        gap: theme.margins.xs,
    },
    headerActionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.xs,
    },
    keyHint: {
        ...Typography.keyHint(),
        color: theme.colors.button.primary.tint,
        opacity: 0.7,
    },
    chipsHistory: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 'auto',
    },
    chipsLine: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.margins.sm,
        paddingHorizontal: theme.margins.lg,
        paddingBottom: theme.margins.md,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    document: {
        paddingHorizontal: theme.margins.lg,
        paddingTop: theme.margins.lg,
        gap: theme.margins.lg,
    },
    validity: {
        alignSelf: 'flex-end',
        paddingHorizontal: theme.margins.xs,
        borderRadius: theme.borderRadius.sm,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    validityText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    undoRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
        flexWrap: 'wrap',
    },
    reason: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    action: {
        paddingHorizontal: theme.margins.xs,
        borderRadius: theme.borderRadius.sm,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    actionLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    phoneViewSwitch: {
        paddingHorizontal: theme.margins.lg,
        paddingTop: theme.margins.md,
    },
    phoneBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
        paddingHorizontal: theme.margins.lg,
        paddingVertical: theme.margins.sm,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.background.canvas,
    },
    phoneBarSpacer: {
        flex: 1,
    },
    paneBody: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    flowBody: {
        padding: theme.margins.md,
    },
    /** Settings | Agent, with the open-in-Sessions control beside it while a Session exists. */
    detailsTabs: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
        paddingHorizontal: theme.margins.md,
        paddingBottom: theme.margins.sm,
    },
    /** The seeded composer at the foot of the Agent tab, where the Session's own composer will sit. */
    agentDraft: {
        flex: 1,
        justifyContent: 'flex-end',
        padding: theme.margins.md,
    },
    statusLine: {
        paddingHorizontal: theme.margins.lg,
        paddingBottom: theme.margins.sm,
        alignItems: 'flex-start',
    },
}));

/**
 * The page commands, reachable by a host for an intent it carries into the
 * page (a saved row's Run now, the unsaved-changes guard's Save). Each goes
 * through exactly the same eligibility as the visible action and the keyboard
 * shortcut, so a host can never bypass the reason the page shows.
 */
export type WorkflowEditorCommands = Readonly<{
    runNow: () => void;
    save: () => void;
    /** Reveals Runs automatically in Workflow settings (a saved row's "add a trigger" intent, 04 §5.4). */
    schedule: () => void;
    exportJson: () => void;
    /** Focuses a step's prompt through the page's one focus owner, once that prompt is mounted. */
    focusPrompt: (blockId: string) => void;
}>;

/** Step options on a phone: the same inspector content, in `@/modal`. */
function WorkflowStepOptionsModal(props: WorkflowSettingsModalProps & CustomModalInjectedProps): React.ReactElement {
    return (
        <ItemList>
            <WorkflowInspector {...props.inspector} />
        </ItemList>
    );
}

type WorkflowSettingsModalProps = Readonly<{
    inspector: React.ComponentProps<typeof WorkflowInspector>;
}>;

/** Workflow settings on a phone: the same inspector content, in `@/modal`. */
function WorkflowSettingsModal(props: WorkflowSettingsModalProps & CustomModalInjectedProps): React.ReactElement {
    return (
        <ItemList>
            <WorkflowInspector {...props.inspector} />
        </ItemList>
    );
}

/**
 * The document column's floor (07 §3 width contract): the composer's minimum.
 * The composer has no intrinsic width of its own (its chips wrap, its field
 * flexes); its established floor is the Session main column it is built for,
 * `DEFAULT_MAIN_MIN_PX`. Passing it keeps that floor when Flow and Settings are
 * both docked, where the pane host would otherwise allow its narrower
 * three-pane default. Placement stays the resolver's.
 */
const WORKFLOW_EDITOR_MAIN_MIN_WIDTH_PX = DEFAULT_MAIN_MIN_PX;

/** Step options popover: the lab `E1o` card's width, capped by the space beside the anchor. */
const STEP_OPTIONS_MAX_WIDTH_PX = 420;
const STEP_OPTIONS_MAX_HEIGHT_PX = 640;

export type WorkflowEditorView = 'steps' | 'flow';

export type WorkflowEditorBodyProps = Readonly<{
    draft: WorkflowEditorDraft;
    highlightedBlockIds?: readonly string[];
    authoringSessionId?: string | null;
    authoringServerId?: string | null;
    /**
     * Edit with an agent before its Session exists (04 §4.7): the seeded ordinary composer the
     * details pane's Agent tab shows until Send creates the Session.
     */
    authoringDraft?: Omit<WorkflowAgentAuthoringDraftProps, 'onClose'>;
    /** The header's quiet **Edit with an agent** (07 §3); absent where the editor cannot offer it. */
    onEditWithAgent?: () => void;
    onChange: (next: WorkflowEditorDraft, label?: string, committed?: boolean) => void;
    history?: WorkflowEditorHistoryControls;
    onCommitChange?: () => void;
    /** The one exact Machine this workflow runs on; `null` stays visibly unresolved. */
    machineName: string | null;
    /**
     * Host placement is deliberately separate from the portable definition.
     * Supplying the Machines and a change handler makes it editable through
     * the canonical Where owner; otherwise it is shown read-only.
     */
    projectTarget?: WorkflowAuthoringTarget | null;
    projectMachines?: readonly Machine[];
    onChangeProjectTarget?: (target: WorkflowAuthoringTarget) => void;
    selectedBlockId: string | null;
    onSelectBlock: (blockId: string | null) => void;
    onCustomizeBlock: (blockId: string) => void;
    /** The person's open/closed settings groups (`WorkflowEditorViewState.inspectorGroupDisclosure`). */
    inspectorGroupDisclosure?: ReadonlyMap<string, boolean>;
    onChangeInspectorGroup?: (groupId: string, expanded: boolean) => void;
    /** The phone's Steps | Flow switch. Wide layouts show Flow as a pane instead. */
    view: WorkflowEditorView;
    onChangeView: (view: WorkflowEditorView) => void;
    /** "Each step runs in": the run default and each class's availability. Supply both or neither. */
    executionTarget?: WorkflowRunAsTargetKind;
    runAsTargets?: readonly WorkflowRunAsTarget[];
    onChangeExecutionTarget?: (kind: WorkflowRunAsTargetKind) => void;
    /** Explicit, separate effects. Omit one to hide it in a host that cannot offer it. */
    onRunNow?: () => void;
    /** A catalog's Session-scoped Run action uses the canonical Session chooser. */
    runNowAction?: React.ReactNode;
    runNowAnchorRef?: React.RefObject<View | null>;
    onSave?: () => void;
    /** Read-only catalog documents duplicate through the host's definition seed owner. */
    onDuplicate?: () => void;
    headerMeta?: React.ComponentProps<typeof PageHeader>['meta'];
    onImportJson?: () => void;
    onExportJson?: () => void;
    /**
     * The workflow's description: Artifact metadata the host owns beside the
     * name, outside the portable definition. Absent change handler: read-only.
     */
    description?: string;
    onChangeDescription?: (next: string) => void;
    /** A draft opened from a Run (Save as workflow) returns to it (07 S20). */
    onBackToRun?: () => void;
    /** Review context and portability disclosures inside this page's one scroll. */
    reviewNotice?: React.ReactNode;
    /** Rare operations for the header `⋯`, in order (Delete workflow last). */
    menuActions?: readonly PageHeaderMenuAction[];
    /** True while the matching command is in flight, so it cannot be submitted twice. */
    runPending?: boolean;
    savePending?: boolean;
    /** Where the explicit Save stands (the host's save owner decides it). */
    saveStatus?: WorkflowSaveStatusState;
    saveConflict?: WorkflowSaveConflict | null;
    onSaveAsCopy?: () => void;
    /**
     * Automation metadata owns the wrapper's visible name. The copied workflow
     * definition still uses this body, but suppresses its otherwise duplicate
     * identity rather than introducing a second recipe editor.
     */
    showNameField?: boolean;
    focusNameOnMount?: boolean;
    /** Host-owned catalogs and target facts consumed by the shared Session controls. */
    authoringFacts?: SessionAuthoringControlFacts;
    /**
     * Existing Sessions a step may continue, as the host's canonical Session
     * candidacy and machine-target owners project them.
     */
    existingSessions?: readonly WorkflowExistingSessionOption[];
    /** Every continuable Session on any Machine (the authoring host's): enables the web Session drop onto a step. */
    sessionDropCandidates?: readonly WorkflowExistingSessionOption[];
    sessionBindingScope?: EntityDragScopeV1 | null;
    /**
     * Where every step prompt addresses reference/file search and portable
     * attachment pickers.
     */
    composerScope: AuthoringComposerScope;
    /**
     * Exact live documents handed over with the draft — the New Session chip's
     * composer — adopted once by their steps' composer custody.
     */
    composerSeeds?: readonly AuthoringComposerSeed[];
    /** The page's canonical validation, including the facts only its live composers hold. */
    onValidationChange?: (validation: WorkflowDraftValidation) => void;
    /** Lets a host invoke a page command under the page's own eligibility. */
    commandsRef?: React.Ref<WorkflowEditorCommands | null>;
    /**
     * The workflow's triggers (04 §5.4): the one summary the header chip shows, and the Runs
     * automatically section Workflow settings opens with. The chip reveals that section.
     */
    triggersSummary?: string;
    triggersSection?: React.ReactNode;
    /** The document's reading presentation (04 §4.11), for a read-only workflow. */
    documentPresentation?: WorkflowDocumentPresentation;
    /** Options for Action-step fields with an `optionsSourceId`, for the workflow's Where Machine. */
    resolveActionFieldOptions?: ResolveSessionActionFieldOptions;
    /** This workflow's saved reference, which a Run a workflow step cannot call. */
    currentWorkflowRef?: string | null;
    testIDPrefix?: string;
}>;

export function WorkflowEditorBody(props: WorkflowEditorBodyProps): React.ReactElement {
    const dragRuntime = useEntityDragDropRuntime();
    const refreshDropMeasurements = React.useCallback(() => { void dragRuntime.refreshMeasurements(); }, [dragRuntime]);
    const testIDPrefix = props.testIDPrefix ?? 'workflow-editor';
    const { draft, onChange, onRunNow, onSave, onExportJson, runPending, savePending } = props;
    const documentEditable = props.documentPresentation?.editable !== false;
    const defaultAuthoringValues = React.useMemo(() => resolveWorkflowStepSelectionV1({ defaults: draft.defaults, purpose: 'authoring' }).selection, [draft.defaults]);
    const canOpenSettings = true;
    const engineSummary = useSessionAuthoringEngineSummary({
        values: defaultAuthoringValues, engine: draft.defaults.engine, workflowRoles: draft.roles,
        ...(props.authoringFacts === undefined ? {} : { facts: props.authoringFacts }),
    });
    const sessionDrop = useWorkflowSessionBinding({
        context: { scope: props.sessionBindingScope ?? null, draft, editable: documentEditable,
            whereMachineId: props.projectTarget?.machineId ?? null, candidates: props.sessionDropCandidates ?? props.existingSessions ?? [] },
        onChange, whereName: props.machineName,
        machineName: machineId => {
            const machine = props.projectMachines?.find(candidate => candidate.id === machineId);
            return machine ? getMachineDisplayName(machine) : machineId;
        },
    });
    /**
     * Whether this composition owns page commands at all.
     *
     * It is derived from the effects the host actually offers rather than from a
     * separate mode flag, so the two cannot disagree: the neutral editor routes
     * offer Run now / Save / Schedule and get the pinned surface plus this page's
     * scroll, while the Automation wrappers offer none, keep their own single
     * scroll owner, and receive the authored document alone.
     */
    const hasPageCommands = onRunNow !== undefined
        || onSave !== undefined
        || props.onImportJson !== undefined
        || onExportJson !== undefined;
    const maxWidthStyle = useLayoutMaxWidthStyle();
    // Placement follows the pane host, not the window: a phone has no side
    // slots, so its panes become `@/modal` and the Steps | Flow switch.
    const detailsPaneAvailable = useDetailsPaneAvailable();
    const compactLayout = !detailsPaneAvailable;
    const whereRef = React.useRef<WorkflowProjectTargetControlHandle | null>(null);
    const [settingsOpen, setSettingsOpen] = React.useState(false);
    const [detailsTab, setDetailsTab] = React.useState<'settings' | 'agent'>('settings');
    const router = useRouter();
    const authoringDraftId = props.authoringDraft?.draftId ?? null;
    const hasAgentTab = Boolean(props.authoringSessionId) || authoringDraftId !== null;
    React.useEffect(() => {
        if ((!props.authoringSessionId && authoringDraftId === null) || compactLayout) return;
        setDetailsTab('agent');
        setSettingsOpen(true);
    }, [authoringDraftId, compactLayout, props.authoringSessionId]);
    const editWithAgent = React.useCallback(() => {
        // A live agent conversation is reopened, never replaced by a second one.
        if (hasAgentTab) {
            setDetailsTab('agent');
            setSettingsOpen(true);
            return;
        }
        props.onEditWithAgent?.();
    }, [hasAgentTab, props.onEditWithAgent]);
    const settingsModalRef = React.useRef<string | null>(null);
    /** Field-level issues stay silent until an explicit Run or Save is refused (B3). */
    const [issuesRevealed, setIssuesRevealed] = React.useState(false);
    const stepOptionsModalRef = React.useRef<{ id: string; blockId: string } | null>(null);
    /** Step options open as an anchored popover beside the step's Customize control (wide layouts). */
    const [stepOptionsPopover, setStepOptionsPopover] = React.useState<Readonly<{
        blockId: string;
        anchorRef: React.RefObject<View | null>;
    }> | null>(null);
    const promptFocusByBlockId = React.useRef(new Map<string, () => void>());
    const pendingPromptFocusId = React.useRef<string | null>(null);
    const registerPromptRef = React.useCallback((blockId: string, focus: (() => void) | null) => {
        if (focus === null) {
            promptFocusByBlockId.current.delete(blockId);
            return;
        }
        promptFocusByBlockId.current.set(blockId, focus);
        if (pendingPromptFocusId.current === blockId) {
            pendingPromptFocusId.current = null;
            focus();
        }
    }, []);
    const requestPromptFocus = React.useCallback((blockId: string) => {
        const focus = promptFocusByBlockId.current.get(blockId);
        if (focus !== undefined) {
            focus();
            return;
        }
        pendingPromptFocusId.current = blockId;
    }, []);

    const blockIds = React.useMemo(
        () => walkWorkflowBlocks(draft.blocks).map((block) => block.id),
        [draft.blocks],
    );
    /**
     * Custody of every step's live prompt document, held here rather than in the
     * recursive list that re-parents the rows. Moving a block between parents is
     * then pure presentation, and only deleting it ends its document.
     */
    const composerCustody = useWorkflowAuthoringComposerCustody({
        draftId: draft.draftId,
        blockIds,
        ...(props.composerSeeds === undefined ? {} : { seeds: props.composerSeeds }),
    });
    const stagedAttachmentKey = React.useSyncExternalStore(
        composerCustody.observe,
        composerCustody.readStagedAttachmentKey,
        composerCustody.readStagedAttachmentKey,
    );

    const validation = React.useMemo(() => {
        const targetIssues: WorkflowValidationIssue[] = [];
        // Device-local staged bytes cannot reach a stored definition, and the
        // portable document cannot carry them either. Rather than letting Save
        // drop them, the host reads the live composers it owns and raises the
        // canonical issue the save owner already refuses on.
        for (const staged of composerCustody.readStagedAttachments()) {
            targetIssues.push({
                code: 'unsupported_persisted_attachment' as const,
                path: `/blocks/${staged.blockId}/document/attachments/${staged.index}/content`,
                blockId: staged.blockId,
                message: t('workflows.issue.unsupported_persisted_attachment'),
                severity: 'error' as const,
            });
        }
        if (resolveSessionAuthoringRuntimeDescriptorAvailability({
            values: draft.defaults,
            facts: props.authoringFacts,
        }) === 'unavailable') {
            targetIssues.push({
                code: 'target_unavailable' as const,
                path: '/defaults/runtimeDescriptorV1',
                message: t('workflows.issue.target_unavailable'),
                severity: 'error' as const,
            });
        }
        for (const block of walkWorkflowBlocks(draft.blocks)) {
            if (block.kind !== 'step') continue;
            if (resolveSessionAuthoringRuntimeDescriptorAvailability({
                values: resolveEffectiveWorkflowStepExecution(draft, block),
                facts: props.authoringFacts,
            }) !== 'unavailable') continue;
            targetIssues.push({
                code: 'target_unavailable' as const,
                path: `/blocks/${block.id}/execution/runtimeDescriptorV1`,
                blockId: block.id,
                message: t('workflows.issue.target_unavailable'),
                severity: 'error' as const,
            });
        }
        return validateWorkflowEditorDraft(draft, {
            targetValidation: props.authoringFacts === undefined ? 'unavailable' : 'checked',
            targetIssues,
        });
    }, [composerCustody, draft, props.authoringFacts, stagedAttachmentKey]);
    const { onValidationChange } = props;
    // Published before paint, so a host gating on it never shows a stale answer.
    React.useLayoutEffect(() => {
        onValidationChange?.(validation);
    }, [onValidationChange, validation]);
    const blockingIssue = React.useMemo(() => firstBlockingWorkflowIssue(validation), [validation]);
    const saveBlockedReason = React.useMemo(
        () => documentEditable ? resolveWorkflowSaveBlockedReason({ draft, validation }) : null,
        [documentEditable, draft, validation],
    );
    const resolveBlockLabel = React.useCallback((blockId: string): string => {
        const block = findWorkflowBlock(draft, blockId);
        return block === null ? blockId : workflowBlockReferenceLabel(block);
    }, [draft]);

    useWorkflowAnnouncements({
        state: React.useMemo(() => ({
            // Defaults come from the canonical empty state, so the editor never
            // restates run-window fields it does not own.
            ...EMPTY_WORKFLOW_ANNOUNCEMENT_STATE,
            blockIds,
            selectedBlockId: props.selectedBlockId,
            blockingIssue: blockingIssue === null
                ? null
                : (() => {
                    const blockId = resolveWorkflowIssueBlockId(draft, blockingIssue);
                    return blockId === null
                        ? { code: blockingIssue.code }
                        : { code: blockingIssue.code, blockId };
                })(),
        }), [blockIds, blockingIssue, draft, props.selectedBlockId]),
        resolveBlockLabel,
    });

    const projectUnresolved = props.projectTarget === null
        || (props.projectTarget !== undefined && typeof props.projectTarget.directory === 'string' && props.projectTarget.directory.trim().length === 0);
    // Every page command answers the same owner, so a disabled control can name
    // its cause instead of going silently inert.
    const runBlockedReason = React.useMemo(() => resolveWorkflowRunBlockedReason({
        validation,
        targetResolved: !projectUnresolved || !documentEditable,
        ...(runPending === undefined ? {} : { pending: runPending }),
    }), [documentEditable, projectUnresolved, runPending, validation]);
    const exportBlockedReason = React.useMemo(
        () => resolveWorkflowExportBlockedReason({ validation }),
        [validation],
    );
    const describeBlockedReason = React.useCallback((
        reason: WorkflowCommandBlockedReason | null,
    ): string | null => describeWorkflowCommandBlockedReason({ reason, blockingIssue }), [blockingIssue]);
    const runDisabled = runBlockedReason !== null;
    const saveDisabled = savePending === true || saveBlockedReason !== null;
    const exportDisabled = exportBlockedReason !== null;
    const runReason = describeBlockedReason(runBlockedReason);
    const saveReason = describeBlockedReason(saveBlockedReason);
    const exportReason = describeBlockedReason(exportBlockedReason);

    // Eligibility is enforced at the handler, not only on the pressable, so a
    // command that cannot make progress stays inert however it is reached —
    // press, keyboard shortcut or a host-supplied action. A refused command is
    // not a silent no-op: it announces the same repairable reason the page
    // already shows beside the control.
    const refuse = React.useCallback((reason: string | null) => {
        if (reason === null) return;
        setIssuesRevealed(true);
        announceWorkflowCommandRefused(reason);
        // When the cause lives in a step, focus lands on that step's prompt so
        // the repair is where the person already is, not somewhere to search for.
        const blockId = blockingIssue === null ? null : resolveWorkflowIssueBlockId(draft, blockingIssue);
        if (blockId !== null && findWorkflowBlock(draft, blockId)?.kind === 'step') {
            props.onSelectBlock(blockId);
            requestPromptFocus(blockId);
        }
    }, [blockingIssue, draft, props.onSelectBlock, requestPromptFocus]);
    const openSettings = React.useCallback(() => {
        if (canOpenSettings) setSettingsOpen(true);
    }, [canOpenSettings]);
    const submitRun = React.useCallback(() => {
        // Run now is never a dead end for a missing machine: it opens the Where
        // owner's picker (the settings on a phone), and choosing continues here.
        if (documentEditable && projectUnresolved && props.onChangeProjectTarget !== undefined && runPending !== true) {
            if (compactLayout) openSettings();
            else whereRef.current?.openPicker();
            return;
        }
        if (runDisabled) { refuse(runReason); return; }
        onRunNow?.();
    }, [compactLayout, documentEditable, onRunNow, openSettings, projectUnresolved, props.onChangeProjectTarget, refuse, runDisabled, runPending, runReason]);
    const submitSave = React.useCallback(() => {
        if (saveDisabled) { refuse(saveReason); return; }
        onSave?.();
    }, [onSave, refuse, saveDisabled, saveReason]);
    // Triggers are part of this page's draft (04 §5.4): "schedule" reveals them, never a handoff.
    const submitSchedule = openSettings;
    const submitExport = React.useCallback(() => {
        if (exportDisabled) { refuse(exportReason); return; }
        onExportJson?.();
    }, [exportDisabled, exportReason, onExportJson, refuse]);

    React.useImperativeHandle(props.commandsRef, () => ({
        runNow: submitRun,
        save: submitSave,
        schedule: submitSchedule,
        exportJson: submitExport,
        focusPrompt: requestPromptFocus,
    }), [requestPromptFocus, submitExport, submitRun, submitSave, submitSchedule]);

    // Both shortcuts call the same gated owners as the visible actions: a
    // repeat while the command is pending is ignored, and a shortcut pressed
    // while the command is blocked announces the reason instead of vanishing.
    useKeyboardShortcutHandlers(React.useMemo(() => {
        const handlers: Partial<Record<'workflow.save' | 'workflow.run', () => void>> = {};
        if (onSave !== undefined) handlers['workflow.save'] = submitSave;
        if (onRunNow !== undefined) handlers['workflow.run'] = submitRun;
        return handlers;
    }, [onRunNow, onSave, submitRun, submitSave]));

    const nameInputRef = React.useRef<TextInput | null>(null);
    React.useEffect(() => {
        if (props.focusNameOnMount === true) nameInputRef.current?.focus();
    }, [props.focusNameOnMount, draft.draftId]);
    const useExample = React.useCallback((example: WorkflowStarterExampleV1) => {
        const insertion = insertWorkflowStarterExample(draft, example, tLoose(example.titleKey));
        onChange(insertion.draft, t('workflows.editor.history.example'));
        props.onSelectBlock(insertion.rootIds[0] ?? null);
        nameInputRef.current?.focus();
    }, [draft, onChange, props.onSelectBlock]);

    const { theme } = useUnistyles();
    const runKeyHint = useKeyboardShortcutLabel('workflow.run');
    const pane = useAppPaneScope(WORKFLOW_EDITOR_PANE_SCOPE_ID);
    const flowOpen = pane.scopeState?.right.isOpen === true;
    const flowChildren = useWorkflowFlowChildren(validation.normalizedDefinition ?? null, flowOpen || props.view === 'flow');
    const flowProjection = React.useMemo(
        () => (validation.normalizedDefinition === undefined
            ? null
            : projectWorkflowFlow(validation.normalizedDefinition, flowChildren.children)),
        [flowChildren.children, validation.normalizedDefinition],
    );
    const closeSettings = React.useCallback(() => setSettingsOpen(false), []);

    const errorCount = React.useMemo(
        () => validation.issues.filter((issue) => issue.severity === 'error').length,
        [validation.issues],
    );
    // Once every issue is repaired the readout goes quiet again.
    React.useEffect(() => {
        if (errorCount === 0) setIssuesRevealed(false);
    }, [errorCount]);
    const focusFirstIssue = React.useCallback(() => {
        const blockId = blockingIssue === null ? null : resolveWorkflowIssueBlockId(draft, blockingIssue);
        if (blockId === null) return;
        props.onSelectBlock(blockId);
        requestPromptFocus(blockId);
    }, [blockingIssue, draft, props.onSelectBlock, requestPromptFocus]);

    // One inspector content for both subjects; only the subject and its
    // presentation differ (04 §5.2). Issues keep a group open only once the
    // page reveals them, so a pristine draft stays quiet.
    const inspectorBaseProps = React.useMemo(() => ({
        draft,
        onChange,
        documentEditable,
        ...(hasPageCommands && !issuesRevealed ? {} : { validation }),
        ...(props.inspectorGroupDisclosure === undefined ? {} : { groupDisclosure: props.inspectorGroupDisclosure }),
        ...(props.onChangeInspectorGroup === undefined ? {} : { onChangeGroupDisclosure: props.onChangeInspectorGroup }),
        ...(props.authoringFacts === undefined ? {} : { authoringFacts: props.authoringFacts }),
        ...(props.existingSessions === undefined ? {} : { existingSessions: props.existingSessions }),
        ...(sessionDrop === undefined ? {} : { bindExistingSession: sessionDrop.bind }),
        ...(props.projectTarget === undefined ? {} : { projectTarget: props.projectTarget }),
        machineName: props.machineName,
        ...(props.projectMachines === undefined ? {} : { projectMachines: props.projectMachines }),
        ...(props.onChangeProjectTarget === undefined ? {} : { onChangeProjectTarget: props.onChangeProjectTarget }),
        ...(props.executionTarget === undefined ? {} : { executionTarget: props.executionTarget }),
        ...(props.runAsTargets === undefined ? {} : { runAsTargets: props.runAsTargets }),
        ...(props.onChangeExecutionTarget === undefined ? {} : { onChangeExecutionTarget: props.onChangeExecutionTarget }),
        ...(props.triggersSection === undefined ? {} : { runsAutomatically: props.triggersSection }),
    }), [
        props.triggersSection,
        documentEditable,
        draft,
        hasPageCommands,
        issuesRevealed,
        onChange,
        props.authoringFacts,
        props.existingSessions,
        sessionDrop,
        props.executionTarget,
        props.inspectorGroupDisclosure,
        props.machineName,
        props.onChangeExecutionTarget,
        props.onChangeInspectorGroup,
        props.onChangeProjectTarget,
        props.projectMachines,
        props.projectTarget,
        props.runAsTargets,
        validation,
    ]);
    const inspectorProps = React.useMemo((): React.ComponentProps<typeof WorkflowInspector> => ({
        ...inspectorBaseProps,
        subject: { kind: 'workflow' },
        presentation: 'pane',
        testIDPrefix,
    }), [inspectorBaseProps, testIDPrefix]);
    const buildStepOptionsProps = React.useCallback((blockId: string): React.ComponentProps<typeof WorkflowInspector> => ({
        ...inspectorBaseProps,
        subject: { kind: 'block', blockId },
        presentation: 'popover',
        testIDPrefix: `${testIDPrefix}-inspector`,
    }), [inspectorBaseProps, testIDPrefix]);

    const closeStepOptions = React.useCallback(() => setStepOptionsPopover(null), []);
    // Step options: an anchored popover beside the step's Customize control on
    // wide layouts, `@/modal` on a phone — one content either way.
    const openInspector = React.useCallback((blockId: string, anchorRef: React.RefObject<View | null>) => {
        props.onCustomizeBlock(blockId);
        // Every block kind has Step options (04 §5.2): a step's, a leaf's or a container's.
        if (findWorkflowBlock(draft, blockId) === null) return;
        if (!compactLayout) {
            setStepOptionsPopover({ blockId, anchorRef });
            return;
        }
        const id = Modal.show({
            component: WorkflowStepOptionsModal,
            props: { inspector: buildStepOptionsProps(blockId) },
            focusReturnRef: { current: { focus: () => requestPromptFocus(blockId) } },
            onRequestClose: () => {
                stepOptionsModalRef.current = null;
            },
            closeOnBackdrop: true,
            chrome: {
                kind: 'card',
                title: t('workflows.page.inspector.stepOptions'),
                testID: `${testIDPrefix}-inspector-modal`,
                bodyScroll: 'auto',
                dimensions: { width: 520, maxHeightRatio: 0.92, size: 'md' },
            },
        });
        stepOptionsModalRef.current = { id, blockId };
    }, [buildStepOptionsProps, compactLayout, documentEditable, draft, props.onCustomizeBlock, requestPromptFocus, testIDPrefix]);

    // Keep an open Step options current with the draft; close it when its step is gone.
    React.useEffect(() => {
        const open = stepOptionsModalRef.current;
        if (open === null) return;
        if (findWorkflowBlock(draft, open.blockId) === null) {
            Modal.hide(open.id);
            stepOptionsModalRef.current = null;
            return;
        }
        Modal.update(open.id, { inspector: buildStepOptionsProps(open.blockId) });
    }, [buildStepOptionsProps, documentEditable, draft]);
    React.useEffect(() => () => {
        const open = stepOptionsModalRef.current;
        if (open !== null) Modal.hide(open.id);
    }, []);
    const stepOptionsPopoverBlockId = stepOptionsPopover !== null
        && !compactLayout
        && findWorkflowBlock(draft, stepOptionsPopover.blockId) !== null
        ? stepOptionsPopover.blockId
        : null;

    // Phone: Workflow settings is the same content in `@/modal`, kept current
    // while open and closed with the page.
    React.useEffect(() => {
        if (!compactLayout || !canOpenSettings) {
            if (settingsModalRef.current !== null) {
                Modal.hide(settingsModalRef.current);
                settingsModalRef.current = null;
            }
            return;
        }
        if (!settingsOpen) return;
        if (settingsModalRef.current === null) {
            settingsModalRef.current = Modal.show({
                component: WorkflowSettingsModal,
                props: { inspector: inspectorProps },
                onRequestClose: () => {
                    settingsModalRef.current = null;
                    setSettingsOpen(false);
                },
                closeOnBackdrop: true,
                chrome: {
                    kind: 'card',
                    title: t('workflows.page.settings'),
                    testID: `${testIDPrefix}-settings-modal`,
                    bodyScroll: 'auto',
                    dimensions: { width: 560, maxHeightRatio: 0.92, size: 'md' },
                },
            });
            return;
        }
        Modal.update(settingsModalRef.current, { inspector: inspectorProps });
    }, [compactLayout, canOpenSettings, inspectorProps, settingsOpen, testIDPrefix]);
    React.useEffect(() => () => {
        if (settingsModalRef.current !== null) Modal.hide(settingsModalRef.current);
    }, []);

    // Wide: Undo and Redo are icon buttons at the end of the chip line (04 §4.1). The phone and
    // the commandless composition keep the labelled pair at the document foot.
    const historyIcons = props.history === undefined || (props.history.undoLabel === null && props.history.redoLabel === null) ? null : (
        <View style={styles.chipsHistory}>
            <IconButton
                testID={`${testIDPrefix}-undo`}
                accessibilityLabel={props.history.undoLabel === null ? t('workflows.editor.undo') : t('workflows.editor.undoAction', { change: props.history.undoLabel })}
                tooltip={props.history.undoLabel === null ? t('workflows.editor.undo') : t('workflows.editor.undoAction', { change: props.history.undoLabel })}
                iconName="arrow-arc-left"
                variant="plain"
                disabled={props.history.undoLabel === null}
                onPress={props.history.undo}
            />
            <IconButton
                testID={`${testIDPrefix}-redo`}
                accessibilityLabel={props.history.redoLabel === null ? t('workflows.editor.redo') : t('workflows.editor.redoAction', { change: props.history.redoLabel })}
                tooltip={props.history.redoLabel === null ? t('workflows.editor.redo') : t('workflows.editor.redoAction', { change: props.history.redoLabel })}
                iconName="arrow-arc-right"
                variant="plain"
                disabled={props.history.redoLabel === null}
                onPress={props.history.redo}
            />
        </View>
    );
    const historyActions = props.history === undefined || (props.history.undoLabel === null && props.history.redoLabel === null) ? null : (
        <View style={styles.undoRow}>
            <RoundButton testID={`${testIDPrefix}-undo`} size="small" display="inverted"
                title={props.history.undoLabel === null ? t('workflows.editor.undo') : t('workflows.editor.undoAction', { change: props.history.undoLabel })}
                disabled={props.history.undoLabel === null} onPress={props.history.undo} />
            <RoundButton testID={`${testIDPrefix}-redo`} size="small" display="inverted"
                title={props.history.redoLabel === null ? t('workflows.editor.redo') : t('workflows.editor.redoAction', { change: props.history.redoLabel })}
                disabled={props.history.redoLabel === null} onPress={props.history.redo} />
        </View>
    );

    const stepOptionsPopoverNode = stepOptionsPopover === null || stepOptionsPopoverBlockId === null ? null : (
        <Popover
            open
            anchorRef={stepOptionsPopover.anchorRef}
            focusReturnRef={stepOptionsPopover.anchorRef}
            boundaryRef={null}
            placement="auto-horizontal"
            edgePadding={{ horizontal: 12, vertical: 12 }}
            portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false }}
            maxWidthCap={STEP_OPTIONS_MAX_WIDTH_PX}
            maxHeightCap={STEP_OPTIONS_MAX_HEIGHT_PX}
            onRequestClose={closeStepOptions}
        >
            {({ maxHeight, maxWidth }) => (
                <FloatingOverlay
                    maxHeight={Math.min(maxHeight, STEP_OPTIONS_MAX_HEIGHT_PX)}
                    surfaceChrome="theme"
                    containerStyle={{ width: Math.min(maxWidth, STEP_OPTIONS_MAX_WIDTH_PX) }}
                >
                    <WorkflowInspector
                        {...buildStepOptionsProps(stepOptionsPopoverBlockId)}
                        onDone={closeStepOptions}
                    />
                </FloatingOverlay>
            )}
        </Popover>
    );

    const blockList = (
        <WorkflowBlockListEditor
            draft={draft}
            highlightedBlockIds={props.highlightedBlockIds}
            list={{ kind: 'root' }}
            blocks={draft.blocks}
            depth={0}
            selectedBlockId={props.selectedBlockId}
            composerScope={props.composerScope}
            composerCustody={composerCustody}
            validation={validation}
            onChange={onChange}
            onSelect={props.onSelectBlock}
            onCustomize={openInspector}
            onCommitChange={props.onCommitChange}
            onUseExample={useExample}
            rootAddRow={!compactLayout}
            registerPromptRef={registerPromptRef}
            requestPromptFocus={requestPromptFocus}
            {...(props.documentPresentation === undefined ? {} : { presentation: props.documentPresentation })}
            // The page's commands own when issues speak; a composition without
            // them (the Automation wrapper) keeps its incumbent always-on text.
            revealIssues={!hasPageCommands || issuesRevealed}
            {...(props.resolveActionFieldOptions === undefined ? {} : { resolveActionFieldOptions: props.resolveActionFieldOptions })}
            {...(props.authoringFacts === undefined ? {} : { authoringFacts: props.authoringFacts })}
            {...(sessionDrop === undefined ? {} : { sessionDrop })}
            {...(props.currentWorkflowRef === undefined ? {} : { currentWorkflowRef: props.currentWorkflowRef })}
            testIDPrefix={testIDPrefix}
        />
    );

    const flowContent = flowProjection === null ? (
        <Text testID={`${testIDPrefix}-flow-unavailable`} style={styles.reason}>
            {blockingIssue === null ? '' : t(`workflows.issue.${blockingIssue.code}`)}
        </Text>
    ) : (
        <>
            {flowChildren.problem === null ? null : (
                <View>
                    <Text accessibilityRole="alert" style={styles.reason} testID={`${testIDPrefix}-flow-child-error`}>
                        {flowChildren.problem.message}
                    </Text>
                    <RoundButton size="small" onPress={flowChildren.retry} title={t('common.retry')} testID={`${testIDPrefix}-flow-child-retry`} />
                </View>
            )}
            {flowChildren.loading ? <Text accessibilityLiveRegion="polite" role="status" style={styles.reason}>{t('common.loading')}</Text> : null}
            <WorkflowFlowView
                projection={flowProjection}
                selectedNodeId={props.selectedBlockId}
                // Selection is the editor's: a branch frame has no block of its
                // own, so the projection resolves it to the group it belongs to.
                onSelectNode={(nodeId) => props.onSelectBlock(
                    resolveWorkflowFlowEditTarget(flowProjection, nodeId)?.blockId ?? nodeId,
                )}
                {...(documentEditable ? { onEditStep: (target: WorkflowFlowEditTarget) => {
                    props.onSelectBlock(target.blockId);
                    props.onChangeView('steps');
                    if (target.kind === 'prompt') requestPromptFocus(target.blockId);
                } } : {})}
                testIDPrefix={`${testIDPrefix}-flow`}
            />
        </>
    );

    const saveStatusNode = props.onDuplicate !== undefined ? (
        <RoundButton testID={`${testIDPrefix}-duplicate`} size="small" display="inverted"
            title={t('common.duplicate')} onPress={props.onDuplicate} />
    ) : (
        <WorkflowSaveStatus
            state={props.saveConflict ? { kind: 'conflict', conflict: props.saveConflict } : (props.saveStatus ?? { kind: 'notSaved' })}
            localDraft={draft}
            {...(onSave === undefined ? {} : { onSave: submitSave })}
            onSaveAsCopy={props.onSaveAsCopy ?? (() => {})}
            testIDPrefix={testIDPrefix}
        />
    );
    const validityNode = !issuesRevealed || errorCount === 0 ? null : (
        <HappierPressable
            testID={`${testIDPrefix}-validity`}
            accessibilityRole="button"
            accessibilityLabel={t('workflows.page.issuesToFix', { count: errorCount })}
            onPress={focusFirstIssue}
            style={(state) => [styles.validity, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
        >
            <Text style={styles.validityText}>{t('workflows.page.issuesToFix', { count: errorCount })}</Text>
        </HappierPressable>
    );

    const backToRun = props.onBackToRun === undefined ? null : (
        <HappierPressable
            testID={`${testIDPrefix}-back-to-run`}
            accessibilityRole="button"
            accessibilityLabel={t('workflows.page.backToRun')}
            onPress={props.onBackToRun}
            style={(state) => [styles.action, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
        >
            <Text style={styles.actionLabel}>{t('workflows.page.backToRun')}</Text>
        </HappierPressable>
    );
    const pageMenu = props.menuActions === undefined || props.menuActions.length === 0 ? null : (
        <PageHeaderMenu testID={`${testIDPrefix}-menu`} actions={props.menuActions} />
    );
    const menu = backToRun === null ? pageMenu : <>{backToRun}{pageMenu}</>;
    const runNowButton = props.runNowAction ?? (onRunNow === undefined ? null : (
        <View ref={props.runNowAnchorRef} collapsable={false}>
        <RoundButton
            testID={`${testIDPrefix}-run-now`}
            size="small"
            title={t('workflows.editor.runNow')}
            accessibilityLabel={t('workflows.editor.runNow')}
            {...(runReason === null ? {} : { accessibilityHint: runReason })}
            loading={runPending === true}
            leading={<Icon name="play" size={14} color={theme.colors.button.primary.tint} />}
            {...(runKeyHint === undefined ? {} : { trailing: <Text style={styles.keyHint}>{runKeyHint}</Text> })}
            onPress={submitRun}
        />
        </View>
    ));

    const identity = (
        <PageHeader
            testID={`${testIDPrefix}-header`}
            title={draft.name.trim().length > 0 ? draft.name : t('workflows.page.untitled')}
            alwaysShowTitle
            meta={props.headerMeta}
            leading={(
                <PageHeaderMarkSlot>
                    <Icon name="tree-structure" size={22} color={theme.colors.text.secondary} />
                </PageHeaderMarkSlot>
            )}
            {...(!documentEditable ? { description: props.description } : {})}
            {...(props.showNameField === false || !documentEditable ? {} : {
                titleEditor: {
                    controlRef: nameInputRef,
                    value: draft.name,
                    placeholder: t('workflows.page.untitled'),
                    accessibilityLabel: t('workflows.page.nameLabel'),
                    onChangeText: (name: string) => onChange({ ...draft, name }, t('workflows.page.nameLabel'), false),
                    onCommit: props.onCommitChange,
                    testID: `${testIDPrefix}-name`,
                },
                ...(props.onChangeDescription === undefined && props.description === undefined ? {} : {
                    descriptionEditor: {
                        value: props.description ?? '',
                        placeholder: t('workflows.page.descriptionPlaceholder'),
                        accessibilityLabel: t('workflows.page.descriptionLabel'),
                        onChangeText: (description: string) => props.onChangeDescription?.(description),
                        onCommit: props.onCommitChange,
                        editable: props.onChangeDescription !== undefined,
                        testID: `${testIDPrefix}-description`,
                    },
                }),
            })}
            actions={!hasPageCommands || compactLayout ? menu : (
                <View style={styles.headerActions}>
                    <View style={styles.headerActionRow}>
                        {props.onEditWithAgent === undefined ? null : (
                            <RoundButton
                                testID={`${testIDPrefix}-edit-with-agent`}
                                size="small"
                                display="inverted"
                                title={t('workflows.authoring.edit')}
                                leading={<Icon name="sparkle" size={14} color={theme.colors.text.secondary} />}
                                onPress={editWithAgent}
                            />
                        )}
                        {menu}
                        <IconButton
                            testID={`${testIDPrefix}-flow-toggle`}
                            accessibilityLabel={t('workflows.page.flow')}
                            tooltip={t('workflows.page.flow')}
                            iconName="graph"
                            variant="plain"
                            selected={flowOpen}
                            onPress={() => (flowOpen ? pane.closeRight() : pane.openRight())}
                        />
                        {!canOpenSettings ? null : <IconButton
                            testID={`${testIDPrefix}-settings-toggle`}
                            accessibilityLabel={t('workflows.page.settings')}
                            tooltip={t('workflows.page.settings')}
                            iconName="sidebar-right-open"
                            variant="plain"
                            selected={settingsOpen}
                            onPress={() => setSettingsOpen((open) => !open)}
                        />}
                        {runNowButton}
                    </View>
                    {saveStatusNode}
                    {validityNode}
                </View>
            )}
        />
    );

    // A composition without page commands (the authored Automation wrapper,
    // retired with U-16) keeps its own single scroll owner and receives the
    // identity, the settings and the document without a page or panes.
    if (!hasPageCommands) {
        return (
            <View testID={testIDPrefix} style={{ gap: theme.margins.lg }}>
                {props.showNameField === false && props.onBackToRun === undefined ? null : identity}
                <ItemList scrollEnabled={false}>
                    {!canOpenSettings ? null : <WorkflowInspector {...inspectorProps} />}
                </ItemList>
                {blockList}
                {historyActions}
                {stepOptionsPopoverNode}
            </View>
        );
    }

    const whereSummary = formatWorkflowWhereSummary({
        target: props.projectTarget,
        machineName: props.machineName,
        machineHomeDir: props.projectMachines?.find((machine) => machine.id === props.projectTarget?.machineId)
            ?.metadata?.homeDir ?? null,
    });

    if (compactLayout) {
        // Phone (lab `editor-P1`, corrected): the name stays in the page, the
        // chips recompose as stacked value rows, the save status sits under
        // them, Steps | Flow switches the document, and one bar above the safe
        // area holds Add, Save and the primary Run now.
        return (
            <View testID={testIDPrefix} style={styles.root}>
                <KeyboardAwareScrollView
                    testID={`${testIDPrefix}-scroll`}
                    onScroll={refreshDropMeasurements}
                    onLayout={refreshDropMeasurements}
                    style={styles.pageScroll}
                    contentContainerStyle={[styles.pageContent, maxWidthStyle]}
                    contentInsetAdjustmentBehavior="automatic"
                    automaticallyAdjustKeyboardInsets
                    keyboardShouldPersistTaps="handled"
                >
                    {identity}
                    {props.reviewNotice}
                    <ItemGroup>
                        <Item
                            testID={`${testIDPrefix}-where-row`}
                            title={t('workflows.page.where.label')}
                            subtitle={whereSummary ?? t('workflows.page.where.choose')}
                            showChevron
                            onPress={documentEditable ? openSettings : submitRun}
                        />
                        {props.triggersSummary === undefined ? null : (
                            <Item
                                testID={`${testIDPrefix}-triggers-row`}
                                title={t('workflows.triggers.section.title')}
                                subtitle={props.triggersSummary}
                                showChevron
                                onPress={openSettings}
                            />
                        )}
                        {/* A value row like Where and Triggers (04 §4.10): its value is the chip's own
                            summary, and it opens the settings where the Agent and model field is. */}
                        <Item
                            testID={`${testIDPrefix}-agent-row`}
                            title={t('workflows.page.sections.agentTitle')}
                            subtitle={engineSummary}
                            showChevron={canOpenSettings}
                            {...(canOpenSettings ? { onPress: openSettings } : { mode: 'info' as const })}
                        />
                    </ItemGroup>
                    <View style={styles.statusLine}>
                        {saveStatusNode}
                        {validityNode}
                    </View>
                    <View style={styles.phoneViewSwitch}>
                        <SegmentedTabBar<WorkflowEditorView>
                            testIDPrefix={`${testIDPrefix}-view`}
                            accessibilityLabel={t('workflows.tabsAccessibility.stepsFlow')}
                            tabs={[
                                { id: 'steps', label: t('workflows.tabs.steps') },
                                { id: 'flow', label: t('workflows.tabs.flow') },
                            ]}
                            activeTabId={props.view}
                            onSelectTab={props.onChangeView}
                        />
                    </View>
                    <View style={styles.document}>
                        {/*
                          * Steps stays mounted across the switch so every composer keeps its
                          * caret, selection and any live IME or dictation binding; Flow holds
                          * no editing state and mounts on demand.
                          */}
                        <View
                            testID={`${testIDPrefix}-steps-presentation`}
                            style={props.view === 'steps' ? undefined : { display: 'none' }}
                            {...(props.view === 'steps' ? {} : {
                                accessibilityElementsHidden: true,
                                importantForAccessibility: 'no-hide-descendants' as const,
                                pointerEvents: 'none' as const,
                            })}
                        >
                            {blockList}
                            {historyActions}
                        </View>
                        {props.view === 'flow' ? flowContent : null}
                    </View>
                </KeyboardAwareScrollView>
                <View testID={`${testIDPrefix}-phone-bar`} style={styles.phoneBar}>
                    {!documentEditable ? null : <WorkflowAddBlockMenu
                        testID={`${testIDPrefix}-phone-add`}
                        composerScope={props.composerScope}
                        scopeLabel={t('workflows.a11y.blockList')}
                        {...(props.currentWorkflowRef === undefined ? {} : { currentWorkflowRef: props.currentWorkflowRef })}
                        onAdd={(request) => {
                            const lastBlock = draft.blocks.at(-1);
                            const insertion = insertWorkflowEditorBlock(draft, {
                                request, list: { kind: 'root' },
                                ...(lastBlock === undefined ? {} : { afterBlockId: lastBlock.id }),
                            });
                            onChange(insertion.draft);
                            props.onSelectBlock(insertion.block.id);
                            if (insertion.block.kind === 'step' || insertion.block.kind === 'wait') requestPromptFocus(insertion.block.id);
                        }}
                    />}
                    {!canOpenSettings ? null : <HappierPressable
                        testID={`${testIDPrefix}-phone-settings`}
                        accessibilityRole="button"
                        accessibilityLabel={t('workflows.page.settings')}
                        onPress={openSettings}
                        style={(state) => [styles.action, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Icon name="sidebar-right-open" size={20} color={theme.colors.text.secondary} />
                    </HappierPressable>}
                    <View style={styles.phoneBarSpacer} />
                    {onSave === undefined || !documentEditable || (props.saveStatus !== undefined && !['notSaved', 'unsaved', 'failed'].includes(props.saveStatus.kind)) ? null : (
                        <RoundButton
                            testID={`${testIDPrefix}-phone-save`}
                            size="small"
                            display="secondary"
                            title={t('workflows.page.save')}
                            onPress={submitSave}
                        />
                    )}
                    {runNowButton}
                </View>
            </View>
        );
    }

    const page = (
        <KeyboardAwareScrollView
            testID={`${testIDPrefix}-scroll`}
            onScroll={refreshDropMeasurements}
            onLayout={refreshDropMeasurements}
            style={styles.pageScroll}
            contentContainerStyle={[styles.pageContent, maxWidthStyle]}
            contentInsetAdjustmentBehavior="automatic"
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
        >
            {identity}
            {props.reviewNotice}
            <View testID={`${testIDPrefix}-chips`} style={styles.chipsLine}>
                <WorkflowProjectTargetControl
                    ref={whereRef}
                    presentation="chip"
                    target={props.projectTarget}
                    machineName={props.machineName}
                    {...(props.projectMachines === undefined ? {} : { machines: props.projectMachines })}
                    {...(props.onChangeProjectTarget === undefined ? {} : { onChange: props.onChangeProjectTarget })}
                    testIDPrefix={testIDPrefix}
                />
                <SessionAuthoringControls
                    disabled={!documentEditable}
                    fields={HEADER_ENGINE_FIELDS}
                    values={defaultAuthoringValues} engine={draft.defaults.engine} workflowRoles={draft.roles}
                    onChangeEngine={(engine) => { if (documentEditable) onChange({ ...draft, defaults: withWorkflowAuthoringEngine(draft.defaults, engine) }); }}
                    onChangeFields={(fields) => { if (documentEditable) onChange({ ...draft, defaults: withWorkflowAuthoringEngineFields(draft.defaults, fields) }); }}
                    overriddenFields="all"
                    onChangeField={(field, value) => onChange(setWorkflowDefaultField(draft, field, value))}
                    {...(props.authoringFacts === undefined ? {} : { facts: props.authoringFacts })}
                    testIDPrefix={`${testIDPrefix}-header-engine`}
                />
                {props.triggersSummary === undefined ? null : (
                    <SelectionListFilterChip
                        filter={{
                            id: 'triggers',
                            testID: `${testIDPrefix}-triggers-chip`,
                            label: t('workflows.triggers.section.title'),
                            valueLabel: props.triggersSummary,
                            icon: <Icon name="lightning" size={16} />,
                            // The chip reveals Runs automatically in Workflow settings, never a popover of its own.
                            open: false,
                            onOpenChange: (next) => { if (next) openSettings(); },
                            renderPopoverContent: () => null,
                        }}
                    />
                )}
                {historyIcons}
            </View>
            <View testID={`${testIDPrefix}-steps-presentation`} style={styles.document}>
                {blockList}
            </View>
            {stepOptionsPopoverNode}
        </KeyboardAwareScrollView>
    );

    const flowAdapter: PaneBuiltinAdapter = {
        destinationIds: [WORKFLOW_FLOW_PANE_DESTINATION_ID],
        defaultDestinationId: WORKFLOW_FLOW_PANE_DESTINATION_ID,
        render: () => (
            <View testID={`${testIDPrefix}-flow-pane`} style={styles.paneBody}>
                <PaneHeader
                    testID={`${testIDPrefix}-flow-pane-header`}
                    title={t('workflows.page.flow')}
                    subtitle={t('workflows.page.flowSubtitle')}
                    onClose={pane.closeRight}
                />
                <ItemList>
                    <View style={styles.flowBody}>{flowContent}</View>
                </ItemList>
            </View>
        ),
    };
    const settingsDetails: AppPaneDestinationDetails | null = !canOpenSettings || !settingsOpen ? null : {
        pane: (
            <View testID={`${testIDPrefix}-settings-pane`} style={styles.paneBody}>
                <PaneHeader
                    testID={`${testIDPrefix}-settings-pane-header`}
                    title={t('workflows.page.settings')}
                    subtitle={t('workflows.page.settingsSubtitle')}
                    onClose={closeSettings}
                />
                {hasAgentTab ? <>
                    <View style={styles.detailsTabs}>
                        <SegmentedTabBar tabs={[{ id: 'settings', label: t('workflows.page.settings') }, { id: 'agent', label: t('workflows.authoring.agent') }]}
                            activeTabId={detailsTab} onSelectTab={setDetailsTab} testIDPrefix={`${testIDPrefix}-details-tabs`} />
                        {detailsTab === 'agent' && props.authoringSessionId ? <IconButton
                            testID={`${testIDPrefix}-agent-open-session`}
                            accessibilityLabel={t('workflows.authoring.openSession')}
                            tooltip={t('workflows.authoring.openSession')}
                            iconName="arrows-out"
                            variant="plain"
                            onPress={() => router.push(buildScopedSessionRouteHref({ sessionId: props.authoringSessionId!, serverId: props.authoringServerId }) as never)} /> : null}
                    </View>
                    {props.authoringSessionId ? (
                        <WorkflowAuthoringSessionPane sessionId={props.authoringSessionId} serverId={props.authoringServerId}
                            active={detailsTab === 'agent'} composer />
                    ) : props.authoringDraft !== undefined && detailsTab === 'agent' ? (
                        <View testID={`${testIDPrefix}-agent-draft`} style={styles.agentDraft}>
                            <WorkflowAgentAuthoringDraft {...props.authoringDraft} />
                        </View>
                    ) : null}
                </> : null}
                {detailsTab === 'settings' || !hasAgentTab ? <ItemList>
                    <WorkflowInspector {...inspectorProps} />
                </ItemList> : null}
            </View>
        ),
        onClose: closeSettings,
    };

    return (
        <View testID={testIDPrefix} style={styles.root}>
            <AppPaneScopeHost
                scopeId={WORKFLOW_EDITOR_PANE_SCOPE_ID}
                main={page}
                rightPaneBuiltinAdapter={flowAdapter}
                destinationDetails={settingsDetails}
                mainMinWidthPx={WORKFLOW_EDITOR_MAIN_MIN_WIDTH_PX}
            />
        </View>
    );
}

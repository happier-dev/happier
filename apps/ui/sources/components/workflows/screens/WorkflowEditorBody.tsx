import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { useWorkflowNavigation, selectWorkflowNavigationItem } from '../navigation/workflowNavigation';
import { WorkflowPageNavigation, WorkflowCompanionNavigation } from '../navigation/WorkflowNavigationViews';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import * as React from 'react';
import { View, type TextInput } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PAGE_METRICS, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { AppPaneScopeHost, type AppPaneDestinationDetails } from '@/components/appShell/panes/AppPaneScopeHost';
import { DEFAULT_MAIN_MIN_PX, DEFAULT_SESSION_WIDTH_PX } from '@/components/ui/panels/paneBreakpoints';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover/Popover';
import { POPOVER_PREFERRED_ROOM_PX } from '@/components/ui/popover/popoverPreferredRoom';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import type { PaneBuiltinAdapter } from '@/components/appShell/panes/types';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { KeyboardAwareScrollView } from '@/components/ui/keyboardAvoidance/KeyboardAwareScrollView';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { useRunSessionModels } from '@/components/sessions/runs/useRunSessionModels';
import { resolveSessionModelLabel } from '@/sync/domains/models/modelOptions';
import { useSessionSelector } from '@/sync/store/hooks';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { NavigationBackChromeProvider, useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { usePageBackControl } from '@/components/ui/layout/usePageBackControl';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import type { SessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import {
    type AuthoringComposerSeed,
} from '@/components/sessions/authoring/authoringComposerCustody';
import { Typography } from '@/constants/Typography';
import { useKeyboardShortcutHandlers } from '@/keyboard';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t, tLoose } from '@/text';

import {
    firstBlockingWorkflowIssue,
    readWorkflowBlockShape,
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
import { WorkflowHowAndWhereCard } from '../editor/WorkflowHowAndWhereCard';
import { WorkflowWhenItRunsCard } from '../editor/WorkflowWhenItRunsCard';
import { NO_DISCLOSURE, resolveWorkflowInspectorGroupExpanded } from '../editor/workflowInspectorGroup';
import { formatWorkflowSummaryLine } from '../presentation/workflowSummaryLine';
import type { WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import type { Machine } from '@/sync/domains/state/storageTypes';

import {
    findWorkflowBlock,
    walkWorkflowBlocks,
} from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { insertWorkflowStarterExample, type WorkflowEditorDraft, type WorkflowStarterExampleInsertion } from '@/sync/domains/workflows/workflowEditorDraft';
import type { WorkflowStarterExampleSelection } from '@happier-dev/protocol/workflows/builtins/examples';
import { useWorkflowEditorHistoryLabels, type WorkflowEditorHistoryControls } from '../editor/useWorkflowEditorHistory';
import { useWorkflowEditorSelector, type WorkflowEditorDraftStore } from '../editor/workflowEditorDraftStore';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import {
    resolveSessionAuthoringRuntimeDescriptorAvailability,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';

import { EMPTY_WORKFLOW_ANNOUNCEMENT_STATE } from '../accessibility/workflowAnnouncementSelection';
import { announceWorkflowCommandRefused, useWorkflowAnnouncements } from '../accessibility/useWorkflowAnnouncements';
import { WorkflowBlockListEditor, type WorkflowDocumentPresentation } from '../editor/WorkflowBlockListEditor';
import { useWorkflowEditorComposerCustody } from '../editor/useWorkflowEditorComposerCustody';
import type { ResolveSessionActionFieldOptions } from '@/components/sessions/actions/sessionActionFieldOptions';
import { WorkflowInspector } from '../editor/WorkflowInspector';
import { useWorkflowSessionBinding } from '../editor/useWorkflowSessionBinding';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import type { WorkflowProjectTargetControlHandle } from '../editor/WorkflowProjectTargetControl';
import {
    WorkflowSaveStatus,
    WorkflowStatusReadout,
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
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Stack } from '@/components/appShell/workspace/destinationRoute';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { formatWorkflowIssueText } from '../editor/workflowIssueText';
import { WORKFLOW_DOCUMENT_INSET_PX, WORKFLOW_PAGE_MARK_EDGE_PX, WorkflowDocumentGridContext } from '../editor/workflowEditorStyles';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

/**
 * The workflow editor page (04 §4, lab `editor-E1`, round 1115 r16).
 *
 * Identity first: the glyph mark, the name edited in place with the line the
 * workflow generates under it, one primary **Run now**, and under it the save
 * status that is its own receipt. The document opens with two cards — **When it
 * runs** (triggers) and **How and where it runs** (Where, the workflow's Agent,
 * what each step runs in, what a run asks for) — then the steps in execution order.
 *
 * Workflow settings and Step options are one settings popover in two scopes,
 * anchored beside the control that opened it (a sheet on a phone); there is no
 * settings sidebar (owner 2026-11-15). **Flow** is the editor scope's right
 * pane (`rightPaneBuiltinAdapter`) and Edit with an agent its details companion;
 * where each docks or overlays is `resolvePaneLayout`'s decision. On a phone
 * Flow is the **Steps | Flow** switch.
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

/** Starting from an example replaces nothing only while there is nothing to replace. */
function documentIsUntouched(draft: WorkflowEditorDraft): boolean {
    const [only, ...rest] = draft.blocks;
    if (only === undefined) return true;
    return rest.length === 0 && only.kind === 'step' && (only.name?.trim() ?? '') === '' && only.document.text.trim().length === 0;
}

const styles = StyleSheet.create((theme) => ({
    /**
     * The editor is a page: it sits on the paper (`surface.base`, the content material) like every
     * `ItemList` page, never on the navigation's grey canvas (lab `editor-E1`: a white page).
     */
    root: {
        flex: 1,
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.base, 'content', true),
    },
    pageScroll: {
        flexGrow: 1,
    },
    pageContent: {
        alignSelf: 'center',
        width: '100%',
        paddingBottom: theme.space.s20,
    },
    bodyColumn: {
        alignSelf: 'center',
        width: '100%',
    },
    headerActionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    keyHint: {
        ...({ ...Typography.variant('micro', 'regular'), ...Typography.mono(), ...Typography.tabular() }),
        color: theme.colors.button.primary.tint,
        opacity: 0.7,
    },
    chipsHistory: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 'auto',
    },
    /** The view switch belongs to neither the header above it nor the steps below it. */
    pageTabs: {
        paddingTop: HAPPIER_PAGE_METRICS.pageTabsGapPx,
        paddingBottom: HAPPIER_PAGE_METRICS.pageTabsGapPx,
        paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
    },
    /** Steps | Flow with Undo and Redo at the row's end. */
    pageTabsRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    /** The page's first cards above the steps, one block gap apart. */
    firstCards: {
        gap: theme.space.s16,
    },
    /** Wide: the tabs start on the mark edge, under the header's mark (owner 2026-11-06). */
    pageTabsOnMark: {
        paddingLeft: WORKFLOW_PAGE_MARK_EDGE_PX,
    },
    /**
     * The steps share the header's column (lab round 1105 P1), so a card ends where the header's actions
     * do. The column itself is capped by the layout width, so a card never stretches across a wide window.
     */
    document: {
        width: '100%',
        paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
        paddingTop: theme.space.s16,
        gap: theme.space.s16,
    },
    /** Wide: the root list's name column on the title's edge, so its ordinals hang under the mark's gutter. */
    documentUnderTitle: {
        paddingLeft: WORKFLOW_DOCUMENT_INSET_PX,
    },
    undoRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        flexWrap: 'wrap',
    },
    reason: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    action: {
        paddingHorizontal: theme.space.s4,
        borderRadius: theme.borderRadius.sm,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    actionLabel: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    paneBody: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    flowBody: {
        padding: theme.space.s12,
    },
    /** The seeded composer at the foot of the Agent tab, where the Session's own composer will sit. */
    agentDraft: {
        flex: 1,
        justifyContent: 'flex-end',
        padding: theme.space.s12,
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
/** An If's options are its one rule: wide enough to read as a sentence on one line (lab round 1105 C1). */
const IF_OPTIONS_MAX_WIDTH_PX = 520;
const STEP_OPTIONS_MAX_HEIGHT_PX = 640;

export type WorkflowEditorView = 'steps' | 'flow';

type WorkflowEditorCompanion = 'agent';

/** The page's first cards' disclosure ids, in the editor view state's disclosure map. */
const WORKFLOW_WHEN_CARD_ID = 'card:when';
const WORKFLOW_HOW_WHERE_CARD_ID = 'card:howWhere';
type WorkflowFirstCardId = typeof WORKFLOW_WHEN_CARD_ID | typeof WORKFLOW_HOW_WHERE_CARD_ID;

export type WorkflowEditorBodyProps = Readonly<{
    accountLifetime?: import('@/sync/domains/scope/serverAccountScope').ServerAccountScopeLifetime | null;
    /**
     * The draft, read by slice: each part of the page subscribes to what it shows, so a keystroke
     * re-renders that field and its real dependants only. Edits go out through `onChange`.
     */
    draftStore: WorkflowEditorDraftStore;
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
    /** The Host commits the inserted definition, source trigger and placement in one history edit. */
    onUseExample?: (insertion: WorkflowStarterExampleInsertion) => void;
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
    /** Runs the saved revision for real without replacing or saving this draft. */
    onTestRun?: () => void;
    testRunPending?: boolean;
    /** A catalog's Session-scoped Run action uses the canonical Session chooser. */
    runNowAction?: React.ReactNode;
    runNowAnchorRef?: React.RefObject<View | null>;
    /** The save line under the header's actions: what Run review opens below, so it never covers it. */
    runNowPlacementRef?: React.RefObject<View | null>;
    testRunAnchorRef?: React.RefObject<View | null>;
    onSave?: () => void;
    /** The host's guarded exit, shared with its menu and surrounding navigation. */
    onBack?: () => void;
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
    sessionOptionsStatus?: React.ComponentProps<typeof WorkflowInspector>['sessionOptionsStatus'];
    onRetrySessionOptions?: () => void;
    /** Every continuable Session on any Machine (the authoring host's): enables the web Session drop onto a step. */
    sessionDropCandidates?: readonly WorkflowExistingSessionOption[];
    sessionBindingScope?: EntityDragScopeV1 | null;
    onSessionOptionsDemandChange?: (demanded: boolean) => void;
    mountedDraftActions?: import('@/sync/ops/actions/workflowAuthoringAction').WorkflowMountedDraftActions;
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

/**
 * A read-only page's purpose and its facts ("· Built-in") as one sentence. Each "·" is held to the
 * words on both sides, so a fact wraps with the last word before it and never sits alone on a line
 * (DESIGN-9 M4).
 */
function joinReadOnlyDescription(parts: readonly (string | undefined)[]): string {
    return parts.filter((part): part is string => part !== undefined && part.length > 0).join('\u00A0·\u00A0');
}

/** Undo and Redo as icon buttons. They subscribe to the history's labels, so an edit re-renders only them. */
function WorkflowEditorHistoryIcons(props: Readonly<{ testIDPrefix: string; history: WorkflowEditorHistoryControls | undefined }>): React.ReactElement | null {
    const labels = useWorkflowEditorHistoryLabels(props.history);
    if (props.history === undefined || (labels.undoLabel === null && labels.redoLabel === null)) return null;
    const undoLabel = labels.undoLabel === null ? t('workflows.editor.undo') : t('workflows.editor.undoAction', { change: labels.undoLabel });
    const redoLabel = labels.redoLabel === null ? t('workflows.editor.redo') : t('workflows.editor.redoAction', { change: labels.redoLabel });
    return (
        <View style={styles.chipsHistory}>
            <IconButton testID={`${props.testIDPrefix}-undo`} accessibilityLabel={undoLabel} tooltip={undoLabel}
                iconName="arrow-arc-left" variant="plain" disabled={labels.undoLabel === null} onPress={props.history.undo} />
            <IconButton testID={`${props.testIDPrefix}-redo`} accessibilityLabel={redoLabel} tooltip={redoLabel}
                iconName="arrow-arc-right" variant="plain" disabled={labels.redoLabel === null} onPress={props.history.redo} />
        </View>
    );
}

/** The commandless composition's labelled Undo / Redo pair, subscribed like the icons. */
function WorkflowEditorHistoryActions(props: Readonly<{ testIDPrefix: string; history: WorkflowEditorHistoryControls | undefined }>): React.ReactElement | null {
    const labels = useWorkflowEditorHistoryLabels(props.history);
    if (props.history === undefined || (labels.undoLabel === null && labels.redoLabel === null)) return null;
    return (
        <View style={styles.undoRow}>
            <RoundButton testID={`${props.testIDPrefix}-undo`} size="small" display="inverted"
                title={labels.undoLabel === null ? t('workflows.editor.undo') : t('workflows.editor.undoAction', { change: labels.undoLabel })}
                disabled={labels.undoLabel === null} onPress={props.history.undo} />
            <RoundButton testID={`${props.testIDPrefix}-redo`} size="small" display="inverted"
                title={labels.redoLabel === null ? t('workflows.editor.redo') : t('workflows.editor.redoAction', { change: labels.redoLabel })}
                disabled={labels.redoLabel === null} onPress={props.history.redo} />
        </View>
    );
}

const readDraftId = (draft: WorkflowEditorDraft) => draft.draftId;
const readDraftName = (draft: WorkflowEditorDraft) => draft.name;
const readWholeDraft = (draft: WorkflowEditorDraft) => draft;
/** While its fact is not shown, a reader keeps the value it last showed. */
const keepShownValue = (): boolean => true;
/** Equal content keeps the previous value (and identity). */
const sameRetainedValue = <T,>(left: T, right: T): boolean => retainDeep(left, right) === left;

/** One validation per draft, shared by every reader of that draft (commands, list, settings, Flow). */
type ReadWorkflowEditorValidation = (draft: WorkflowEditorDraft) => WorkflowDraftValidation;

/**
 * The page's validation for one draft: the canonical owner, plus the facts only this page holds —
 * staged composer bytes a stored definition cannot carry, and targets its catalogs cannot run.
 */
function validateWorkflowEditorPage(draft: WorkflowEditorDraft, input: Readonly<{
    stagedAttachments: ReturnType<ReturnType<typeof useWorkflowEditorComposerCustody>['readStagedAttachments']>;
    authoringFacts: SessionAuthoringControlFacts | undefined;
}>): WorkflowDraftValidation {
    const targetIssues: WorkflowValidationIssue[] = [];
    // Device-local staged bytes cannot reach a stored definition, and the
    // portable document cannot carry them either. Rather than letting Save
    // drop them, the host reads the live composers it owns and raises the
    // canonical issue the save owner already refuses on.
    for (const staged of input.stagedAttachments) {
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
        facts: input.authoringFacts,
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
            facts: input.authoringFacts,
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
        targetValidation: input.authoringFacts === undefined ? 'unavailable' : 'checked',
        targetIssues,
    });
}

/** The page commands' readiness, as the facts the header and its controls show. */
function readWorkflowCommandFacts(draft: WorkflowEditorDraft, validation: WorkflowDraftValidation, input: Readonly<{
    documentEditable: boolean; targetResolved: boolean; runPending: boolean | undefined;
}>) {
    const blockingIssue = firstBlockingWorkflowIssue(validation);
    const describe = (reason: WorkflowCommandBlockedReason | null) => describeWorkflowCommandBlockedReason({ reason, blockingIssue, draft });
    const runBlockedReason = resolveWorkflowRunBlockedReason({
        validation, targetResolved: input.targetResolved,
        ...(input.runPending === undefined ? {} : { pending: input.runPending }),
    });
    const saveBlockedReason = input.documentEditable ? resolveWorkflowSaveBlockedReason({ draft, validation }) : null;
    const exportBlockedReason = resolveWorkflowExportBlockedReason({ validation });
    return {
        errorCount: validation.issues.filter((issue) => issue.severity === 'error').length,
        blockingIssue,
        blockingIssueBlockId: blockingIssue === null ? null : resolveWorkflowIssueBlockId(draft, blockingIssue),
        // The announcer and Flow say the issue as the step says it (DESIGN-5 P3).
        blockingIssueText: blockingIssue === null ? null : formatWorkflowIssueText(blockingIssue, draft),
        runBlockedReason, saveBlockedReason, exportBlockedReason,
        runReason: describe(runBlockedReason), saveReason: describe(saveBlockedReason), exportReason: describe(exportBlockedReason),
    };
}

/** The document: the one region that reads the whole draft, so its rows resolve their own edits. */
function WorkflowEditorBlockList(props: Omit<React.ComponentProps<typeof WorkflowBlockListEditor>, 'draft' | 'blocks' | 'validation' | 'onUseExample'> & Readonly<{
    draftStore: WorkflowEditorDraftStore;
    readValidation: ReadWorkflowEditorValidation;
    onUseExample: React.ComponentProps<typeof WorkflowBlockListEditor>['onUseExample'];
}>) {
    const { draftStore, readValidation, onUseExample, ...list } = props;
    const draft = useWorkflowEditorSelector(draftStore, readWholeDraft);
    return <WorkflowBlockListEditor {...list} draft={draft} readDraft={draftStore.get} blocks={draft.blocks} validation={readValidation(draft)}
        {...(documentIsUntouched(draft) && onUseExample !== undefined ? { onUseExample } : {})} />;
}

type WorkflowEditorInspectorProps = Omit<React.ComponentProps<typeof WorkflowInspector>, 'draft' | 'validation'> & Readonly<{
    draftStore: WorkflowEditorDraftStore;
    readValidation: ReadWorkflowEditorValidation;
    /** Issues keep a group open only once the page reveals them. */
    revealValidation: boolean;
}>;

/** Workflow settings and Step options read the whole draft only while they are shown. */
function WorkflowEditorInspector(props: WorkflowEditorInspectorProps) {
    const { draftStore, readValidation, revealValidation, ...inspector } = props;
    const draft = useWorkflowEditorSelector(draftStore, readWholeDraft);
    return <WorkflowInspector {...inspector} draft={draft} {...(revealValidation ? { validation: readValidation(draft) } : {})} />;
}

/** The page's identity: the editable name and the header around it. Only it reads the name. */
function WorkflowEditorIdentity(props: Readonly<{
    draftStore: WorkflowEditorDraftStore;
    testIDPrefix: string;
    hasPageCommands: boolean;
    chromeOptions: Readonly<{ headerTitle: string }>;
    backControl: React.ComponentProps<typeof NavigationBackChromeProvider>['control'];
    entityItem: React.ComponentProps<typeof WorkspaceDestinationRow>['entityItem'];
    header: Omit<React.ComponentProps<typeof PageHeader>, 'title' | 'titleEditor' | 'description' | 'descriptionEditor'>;
    titleEditor: Omit<NonNullable<React.ComponentProps<typeof PageHeader>['titleEditor']>, 'value'> | null;
    /** When it runs, as the summary line's first part; `null` when nothing starts it automatically. */
    summaryTrigger: string | null;
    /** A read-only page's facts ("Built-in"), after the summary line. */
    readOnlyFacts: readonly string[] | null;
}>) {
    const name = useWorkflowEditorSelector(props.draftStore, readDraftName);
    const { summaryTrigger } = props;
    const trigger = summaryTrigger === null || summaryTrigger === t('workflows.triggers.summary.manual') ? null : summaryTrigger;
    const summary = useWorkflowEditorSelector(props.draftStore, (draft) => formatWorkflowSummaryLine(draft, { trigger }));
    const description = joinReadOnlyDescription([summary ?? undefined, ...(props.readOnlyFacts ?? [])]);
    return (
        <>
        {props.hasPageCommands ? <Stack.Screen options={props.chromeOptions} /> : null}
        <NavigationBackChromeProvider control={props.backControl}>
        <WorkspaceDestinationRow href={null} existingMenu entityTitle={name} entityItem={props.entityItem}>
        <PageHeader
            {...props.header}
            title={name.trim().length > 0 ? name : t('workflows.page.untitled')}
            {...(description.length === 0 ? {} : { description })}
            {...(props.titleEditor === null ? {} : { titleEditor: { ...props.titleEditor, value: name } })}
        />
        </WorkspaceDestinationRow>
        </NavigationBackChromeProvider>
        </>
    );
}

/**
 * Reads the pane host's fit for Flow beside a details companion. When Flow was just opened beside one
 * and the host folds it to the rail (three columns do not fit), the details companion closes so Flow
 * shows: the newer companion replaces the older and the document never yields its column.
 */
function WorkflowEditorCompanionFit(props: Readonly<{
    flowOpen: boolean;
    foldedRef: React.MutableRefObject<boolean>;
    requestedRef: React.MutableRefObject<boolean>;
    onFlowFolded: () => void;
}>) {
    const right = useOptionalAppPaneScopeLayout()?.layout.right ?? null;
    const folded = props.flowOpen && right === 'hidden';
    const { foldedRef, requestedRef, onFlowFolded } = props;
    React.useEffect(() => {
        foldedRef.current = folded;
        if (!requestedRef.current || !props.flowOpen) return;
        requestedRef.current = false;
        if (folded) onFlowFolded();
    }, [folded, foldedRef, onFlowFolded, props.flowOpen, requestedRef]);
    return null;
}

/**
 * Edit with an agent's pane header (07 S22): what the pane is for, then which conversation does the
 * editing and on which model ("{session} · {model}"), read through the Session's own name and model owners.
 */
function WorkflowAgentCompanionHeader(props: Readonly<{
    sessionId: string | null;
    serverId?: string | null;
    actions?: React.ReactNode;
    onClose: () => void;
    testID: string;
}>) {
    const sessionId = props.sessionId ?? '';
    const addresses = React.useMemo(() => [{ sessionId, serverId: props.serverId ?? null }], [sessionId, props.serverId]);
    const [sessionName] = useSessionDisplayTitles(addresses);
    const models = useRunSessionModels(props.sessionId, props.serverId);
    const modelId = useSessionSelector(sessionId, props.serverId, (session) => session?.modelMode ?? null);
    const modelLabel = models && modelId && modelId !== 'default'
        ? resolveSessionModelLabel(models.agentId, models.metadata, modelId) ?? modelId : null;
    const subtitle = props.sessionId === null ? null
        : [sessionName, modelLabel].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ');
    return (
        <PaneHeader
            testID={props.testID}
            title={t('workflows.authoring.edit')}
            {...(subtitle ? { subtitle } : {})}
            {...(props.actions === undefined ? {} : { actions: props.actions })}
            onClose={props.onClose}
        />
    );
}

/** The pane host names the workflow beside a hidden main column; only this shell reads the name for it. */
function WorkflowEditorPaneScopeHost(props: Omit<React.ComponentProps<typeof AppPaneScopeHost>, 'mainColumn'> & Readonly<{
    draftStore: WorkflowEditorDraftStore;
}>) {
    const { draftStore, ...host } = props;
    const { theme } = useUnistyles();
    const name = useWorkflowEditorSelector(draftStore, readDraftName);
    const workflowName = name.trim().length > 0 ? name : t('workflows.page.untitled');
    const hideLabel = t('panes.mainColumn.hideWorkflow');
    const showLabel = t('panes.mainColumn.showWorkflow');
    const markColor = theme.colors.text.secondary;
    // Pane identity is shared with every mounted composer. A prompt or selection
    // change must not publish another identity for the unchanged workflow.
    const mainColumn = React.useMemo(() => ({
        hideLabel, showLabel,
        identity: { mark: <Icon name="tree-structure" size={ICON_SIZE.sm} color={markColor} />, name: workflowName },
    }), [hideLabel, markColor, showLabel, workflowName]);
    return <AppPaneScopeHost {...host} mainColumn={mainColumn} />;
}

/** Flow: mounted only while shown, it reads the normalized definition and its nested children. */
function WorkflowEditorFlowContent(props: Readonly<{
    draftStore: WorkflowEditorDraftStore;
    readValidation: ReadWorkflowEditorValidation;
    testIDPrefix: string;
    selectedBlockId: string | null;
    documentEditable: boolean;
    onSelectBlock: (blockId: string | null) => void;
    onChangeView: (view: WorkflowEditorView) => void;
    requestPromptFocus: (blockId: string) => void;
}>) {
    const { testIDPrefix } = props;
    const facts = useWorkflowEditorSelector(props.draftStore, (draft) => {
        const validation = props.readValidation(draft);
        const blockingIssue = firstBlockingWorkflowIssue(validation);
        return { definition: validation.normalizedDefinition ?? null,
            blockingIssueText: blockingIssue === null ? '' : formatWorkflowIssueText(blockingIssue, draft) };
    }, sameFlowFacts);
    const flowChildren = useWorkflowFlowChildren(facts.definition, true);
    const flowProjection = React.useMemo(
        () => (facts.definition === null ? null : projectWorkflowFlow(facts.definition, flowChildren.children)),
        [facts.definition, flowChildren.children],
    );
    if (flowProjection === null) {
        return <Text testID={`${testIDPrefix}-flow-unavailable`} style={styles.reason}>{facts.blockingIssueText}</Text>;
    }
    return (
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
                {...(props.documentEditable ? { onEditStep: (target: WorkflowFlowEditTarget) => {
                    props.onSelectBlock(target.blockId);
                    props.onChangeView('steps');
                    if (target.kind === 'prompt') props.requestPromptFocus(target.blockId);
                } } : {})}
                testIDPrefix={`${testIDPrefix}-flow`}
            />
        </>
    );
}
const sameFlowFacts = (left: Readonly<{ definition: unknown; blockingIssueText: string }>, right: Readonly<{ definition: unknown; blockingIssueText: string }>) =>
    left.blockingIssueText === right.blockingIssueText && retainDeep(left.definition, right.definition) === left.definition;

/** The save line reads the local draft only to show it beside a conflicting save. */
function WorkflowEditorSaveStatus(props: Omit<React.ComponentProps<typeof WorkflowSaveStatus>, 'localDraft'> & Readonly<{ draftStore: WorkflowEditorDraftStore }>) {
    const { draftStore, ...status } = props;
    const localDraft = useWorkflowEditorSelector(draftStore, readWholeDraft, status.state.kind === 'conflict' ? Object.is : keepShownValue);
    return <WorkflowSaveStatus {...status} localDraft={localDraft} />;
}

/** The Step companion's header names the selected step, reading only that step's label. */
/** A host that gates on validation hears each change before paint. */
function WorkflowEditorValidationPublisher(props: Readonly<{
    draftStore: WorkflowEditorDraftStore; readValidation: ReadWorkflowEditorValidation; onValidationChange: (validation: WorkflowDraftValidation) => void;
}>) {
    const validation = useWorkflowEditorSelector(props.draftStore, props.readValidation);
    const { onValidationChange } = props;
    React.useLayoutEffect(() => { onValidationChange(validation); }, [onValidationChange, validation]);
    return null;
}

export function WorkflowEditorBody(props: WorkflowEditorBodyProps): React.ReactElement {
    const dragRuntime = useEntityDragDropRuntime();
    const refreshDropMeasurements = React.useCallback(() => { void dragRuntime.refreshMeasurements(); }, [dragRuntime]);
    const testIDPrefix = props.testIDPrefix ?? 'workflow-editor';
    const { draftStore, onChange, onRunNow, onSave, onExportJson, runPending, savePending } = props;
    // The page itself reads only the facts it decides on; handlers read the draft when they run.
    const readDraft = draftStore.get;
    const draftId = useWorkflowEditorSelector(draftStore, readDraftId);
    const documentEditable = props.documentPresentation?.editable !== false;
    const sessionDrop = useWorkflowSessionBinding({
        draftActions: props.mountedDraftActions,
        context: { scope: props.sessionBindingScope ?? null, get draft() { return readDraft(); }, editable: documentEditable,
            whereMachineId: props.projectTarget?.machineId ?? null, candidates: props.sessionDropCandidates ?? props.existingSessions ?? [] },
        onChange, whereName: props.machineName,
        machineName: machineId => {
            const machine = props.projectMachines?.find(candidate => candidate.id === machineId);
            return machine ? getMachineDisplayName(machine) : machineId;
        },
    });
    // Demand can admit an unopened Session while the pointer/keyboard target is
    // stationary. Refresh its existing admission when that projection arrives.
    React.useEffect(() => { dragRuntime.refresh(); }, [dragRuntime, props.sessionDropCandidates, props.existingSessions]);
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
    const hostedDestination = useDestinationInstanceKey() !== null;
    // The editable name lives in the page; navigation chrome names the kind only ("Workflow", P12).
    // Declared here, its route leaf, so the retained phone bar and the Expo stack read the same title.
    const chromeTitle = t('workflows.page.chromeTitle');
    const chromeOptions = React.useMemo(() => ({ headerTitle: chromeTitle }), [chromeTitle]);
    const inheritedBackControl = useNavigationBackControl();
    const { present: appShellPresent, columnVisible } = useAppShellColumn();
    // Hosted destinations have no Expo header; their existing Back belongs in the page-header slot.
    const router = useRouter();
    const backNavigation = useNavigation();
    const { onBack: onEditorBack } = props;
    const pageBackControl = usePageBackControl('workflow-back', () => onEditorBack
        ? onEditorBack()
        : safeRouterBack({ router, navigation: backNavigation, fallbackHref: '/workflows' }));
    const whereRef = React.useRef<WorkflowProjectTargetControlHandle | null>(null);
    /** "How and where it runs"'s Workflow settings control: the workflow-scope settings sit beside it. */
    const workflowSettingsAnchorRef = React.useRef<View | null>(null);
    // One details companion beside the page: the authoring agent (Plan T U5). Workflow settings and
    // Step options are the one settings popover, never a sidebar (owner 2026-11-15).
    const [detailsCompanion, setDetailsCompanion] = React.useState<WorkflowEditorCompanion | null>(null);
    const authoringDraftId = props.authoringDraft?.draftId ?? null;
    const hasAgentTab = Boolean(props.authoringSessionId) || authoringDraftId !== null;
    // A new conversation opens its pane once, when a pane can show it; a viewport change never reopens one the
    // person closed.
    const agentConversation = props.authoringSessionId || authoringDraftId;
    const openedAgentConversationRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!agentConversation || compactLayout || openedAgentConversationRef.current === agentConversation) return;
        openedAgentConversationRef.current = agentConversation;
        setDetailsCompanion('agent');
    }, [agentConversation, compactLayout]);
    const editWithAgent = React.useCallback(() => {
        // A live agent conversation is reopened, never replaced by a second one.
        if (hasAgentTab) {
            setDetailsCompanion('agent');
            return;
        }
        props.onEditWithAgent?.();
    }, [hasAgentTab, props.onEditWithAgent]);
    /** Field-level issues stay silent until an explicit Run or Save is refused (B3). */
    const [issuesRevealed, setIssuesRevealed] = React.useState(false);
    /**
     * The one settings popover (owner 2026-11-15), in two scopes: the workflow's (Workflow settings)
     * or a block's (Step options). Anchored beside the control that opened it; a phone shows the
     * shared sheet.
     */
    const [settingsPopover, setSettingsPopover] = React.useState<Readonly<{
        /** `null`: the workflow scope. */
        blockId: string | null;
        /** The control that opened it: focus returns here. */
        anchorRef: React.RefObject<View | null>;
        /** What the panel sits beside: the step's card when it has one, else the control. */
        placementRef: React.RefObject<View | null>;
    }> | null>(null);
    // The inspector survives the phone/wide document remount. Its placement refs
    // must survive too, so the new list attaches its live cards to the same refs.
    const stepCardRefs = React.useRef(new Map<string, React.RefObject<View | null>>());
    const promptFocusByBlockId = React.useRef(new Map<string, () => void>());
    /**
     * The one prompt being edited. Every other prompt is its static picture, so a long workflow
     * mounts one live composer, not one per step; pressing, tabbing into or focusing a prompt
     * (Add, Edit step, the first issue) makes it this one. Custody keeps each document, its
     * exact references and caret across the switch.
     */
    const [editingBlockId, setEditingBlockId] = React.useState<string | null>(null);
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

    const { blockIds, showsWorkflowAgent } = useWorkflowEditorSelector(draftStore, readWorkflowBlockShape, sameRetainedValue);
    /**
     * Custody of every step's live prompt document, held here rather than in the
     * recursive list that re-parents the rows. Moving a block between parents is
     * then pure presentation, and only deleting it ends its document.
     */
    const composerCustody = useWorkflowEditorComposerCustody({
        readDraft, draftId, blockIds, scope: props.composerScope,
        editable: documentEditable, onChange: props.onChange, onSelect: props.onSelectBlock,
        focusPrompt: requestPromptFocus,
        ...(props.composerSeeds === undefined ? {} : { seeds: props.composerSeeds }),
    });
    const stagedAttachmentKey = React.useSyncExternalStore(
        composerCustody.observe,
        composerCustody.readStagedAttachmentKey,
        composerCustody.readStagedAttachmentKey,
    );
    // One validation per draft for every reader; a new staged attachment or catalog re-validates.
    const readValidation = React.useMemo((): ReadWorkflowEditorValidation => {
        let last: Readonly<{ draft: WorkflowEditorDraft; validation: WorkflowDraftValidation }> | null = null;
        return (draft) => {
            if (last?.draft === draft) return last.validation;
            const validation = validateWorkflowEditorPage(draft, {
                stagedAttachments: composerCustody.readStagedAttachments(), authoringFacts: props.authoringFacts,
            });
            last = { draft, validation };
            return validation;
        };
        // The staged key is the custody's change signal for `readStagedAttachments`.
    }, [composerCustody, props.authoringFacts, stagedAttachmentKey]);
    const resolveBlockLabel = React.useCallback((blockId: string): string => {
        const block = findWorkflowBlock(readDraft(), blockId);
        return block === null ? blockId : workflowBlockReferenceLabel(block);
    }, [readDraft]);

    const projectUnresolved = props.projectTarget === null
        || (props.projectTarget !== undefined && typeof props.projectTarget.directory === 'string' && props.projectTarget.directory.trim().length === 0);
    // Every page command answers the same owner, so a disabled control can name
    // its cause instead of going silently inert. The page reads these facts, not the draft.
    const targetResolved = !projectUnresolved || !documentEditable;
    const commandFacts = useWorkflowEditorSelector(draftStore, (draft) => readWorkflowCommandFacts(draft, readValidation(draft), {
        documentEditable, targetResolved, runPending,
    }), sameRetainedValue);
    const { blockingIssue, blockingIssueBlockId, runBlockedReason, errorCount, runReason, saveReason, exportReason } = commandFacts;
    const runDisabled = runBlockedReason !== null;
    const saveDisabled = savePending === true || commandFacts.saveBlockedReason !== null;
    const exportDisabled = commandFacts.exportBlockedReason !== null;

    useWorkflowAnnouncements({
        state: React.useMemo(() => ({
            // Defaults come from the canonical empty state, so the editor never
            // restates run-window fields it does not own.
            ...EMPTY_WORKFLOW_ANNOUNCEMENT_STATE,
            blockIds,
            selectedBlockId: props.selectedBlockId,
            blockingIssue: blockingIssue === null ? null : blockingIssueBlockId === null
                ? { code: blockingIssue.code, reason: commandFacts.blockingIssueText ?? '' }
                : { code: blockingIssue.code, blockId: blockingIssueBlockId, reason: commandFacts.blockingIssueText ?? '' },
        }), [blockIds, blockingIssue, blockingIssueBlockId, commandFacts.blockingIssueText, props.selectedBlockId]),
        resolveBlockLabel,
    });

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
        const blockId = blockingIssueBlockId;
        if (blockId !== null && findWorkflowBlock(readDraft(), blockId)?.kind === 'step') {
            props.onSelectBlock(blockId);
            requestPromptFocus(blockId);
        }
    }, [blockingIssueBlockId, props.onSelectBlock, readDraft, requestPromptFocus]);
    /**
     * The page's first cards (owner 2026-11-15): open for a new workflow, closed once it is saved, and
     * otherwise as the person left them (the editor view state's disclosure, like settings groups). A
     * Where the workflow still needs keeps its card open.
     */
    const [localCardDisclosure, setLocalCardDisclosure] = React.useState<ReadonlyMap<string, boolean>>(NO_DISCLOSURE);
    const cardDisclosure = props.onChangeInspectorGroup === undefined ? localCardDisclosure : props.inspectorGroupDisclosure ?? NO_DISCLOSURE;
    const { onChangeInspectorGroup } = props;
    const setCardExpanded = React.useCallback((cardId: WorkflowFirstCardId, expanded: boolean) => {
        if (onChangeInspectorGroup !== undefined) onChangeInspectorGroup(cardId, expanded);
        else setLocalCardDisclosure((current) => new Map(current).set(cardId, expanded));
    }, [onChangeInspectorGroup]);
    const newWorkflow = props.currentWorkflowRef === null || props.currentWorkflowRef === undefined;
    const whenExpanded = resolveWorkflowInspectorGroupExpanded({
        attention: false, recorded: cardDisclosure.get(WORKFLOW_WHEN_CARD_ID), initialValueSet: newWorkflow,
    });
    const howWhereExpanded = resolveWorkflowInspectorGroupExpanded({
        attention: documentEditable && projectUnresolved && props.onChangeProjectTarget !== undefined,
        recorded: cardDisclosure.get(WORKFLOW_HOW_WHERE_CARD_ID), initialValueSet: newWorkflow,
    });
    const openWorkflowSettings = React.useCallback(() => {
        setSettingsPopover({ blockId: null, anchorRef: workflowSettingsAnchorRef, placementRef: workflowSettingsAnchorRef });
    }, []);
    // Run now with no Machine opens the Where picker; a closed card opens first, then its picker.
    const pendingWherePickerRef = React.useRef(false);
    React.useEffect(() => {
        if (!howWhereExpanded || !pendingWherePickerRef.current || whereRef.current === null) return;
        pendingWherePickerRef.current = false;
        whereRef.current.openPicker();
    }, [howWhereExpanded]);
    const submitRun = React.useCallback(() => {
        // Run now is never a dead end for a missing machine: it opens the Where
        // owner's picker in How and where it runs, and choosing continues here.
        if (documentEditable && projectUnresolved && props.onChangeProjectTarget !== undefined && runPending !== true) {
            if (whereRef.current !== null) whereRef.current.openPicker();
            else {
                pendingWherePickerRef.current = true;
                setCardExpanded(WORKFLOW_HOW_WHERE_CARD_ID, true);
            }
            return;
        }
        if (runDisabled) { refuse(runReason); return; }
        onRunNow?.();
    }, [documentEditable, onRunNow, projectUnresolved, props.onChangeProjectTarget, refuse, runDisabled, runPending, runReason, setCardExpanded]);
    const submitSave = React.useCallback(() => {
        if (saveDisabled) { refuse(saveReason); return; }
        onSave?.();
    }, [onSave, refuse, saveDisabled, saveReason]);
    // Triggers are part of this page's draft (04 §5.4): "schedule" opens When it runs, never a handoff.
    const submitSchedule = React.useCallback(() => setCardExpanded(WORKFLOW_WHEN_CARD_ID, true), [setCardExpanded]);
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
    }, [props.focusNameOnMount, draftId]);
    const useExample = React.useCallback((example: WorkflowStarterExampleSelection) => {
        const insertion = insertWorkflowStarterExample(readDraft(), example, tLoose(example.titleKey));
        if (props.onUseExample) props.onUseExample(insertion);
        else {
            if (insertion.trigger !== undefined) throw new Error('workflow_starter_trigger_host_required');
            onChange(insertion.draft, t('workflows.editor.history.example'));
        }
        props.onSelectBlock(insertion.rootIds[0] ?? null);
        nameInputRef.current?.focus();
    }, [onChange, props.onSelectBlock, props.onUseExample, readDraft]);
    const renameWorkflow = React.useCallback((name: string) => {
        onChange({ ...readDraft(), name }, t('workflows.editor.history.renameWorkflow'), false);
    }, [onChange, readDraft]);

    const { theme } = useUnistyles();
    // The page ends above the phone's floating tab bar instead of under it.
    const chromeClearance = useFloatingChromeClearance();
    const runKeyHint = useKeyboardShortcutLabel('workflow.run');
    const pane = useAppPaneScope(WORKFLOW_EDITOR_PANE_SCOPE_ID);
    const flowOpen = pane.scopeState?.right.isOpen === true;
    // A phone has no side slots: Flow is the Steps | Flow switch there, so a Flow pane left
    // open at a wide width closes when the page recomposes for a phone.
    const closeFlowPane = pane.closeRight;
    React.useEffect(() => { if (compactLayout && flowOpen) closeFlowPane(); }, [closeFlowPane, compactLayout, flowOpen]);
    const closeSettings = React.useCallback(() => setDetailsCompanion(null), []);
    const shownCompanion = detailsCompanion;
    const settingsOpen = shownCompanion !== null;
    const agentCompanionAvailable = hasAgentTab && (!compactLayout || Boolean(props.authoringSessionId));
    const phoneNavigation = useDeviceType() === 'phone';
    const activeScope = useActiveServerAccountScope();
    const navigationScope = props.accountLifetime === undefined ? activeScope : props.accountLifetime?.scope ?? null;
    const selectPage = React.useCallback((id: string) => {
        if (id === 'steps' || id === 'flow') props.onChangeView(id);
    }, [props.onChangeView]);
    // Reads the step-options opener declared below at press time, never during render.
    // Below three-column width the newer companion replaces the older (F3): a details companion folds an
    // open Flow to the rail (the pane host's rule), and Flow chosen then closes the details companion.
    // The pane host decides what fits; these refs carry its answer to the press that follows.
    const flowFoldedRef = React.useRef(false);
    const flowRequestedBesideRef = React.useRef(false);
    const selectCompanion = useEventCallback((id: string) => {
        if (id === 'flow') {
            if (flowOpen && shownCompanion !== null && flowFoldedRef.current) { setDetailsCompanion(null); return; }
            if (flowOpen) { pane.closeRight(); return; }
            flowRequestedBesideRef.current = shownCompanion !== null;
            pane.openRight();
            return;
        }
        if (id !== 'agent') return;
        // A phone keeps the agent's own Session as its presenter.
        if (compactLayout) {
            if (props.authoringSessionId) router.push(buildScopedSessionRouteHref({ sessionId: props.authoringSessionId, serverId: props.authoringServerId }) as never);
            return;
        }
        setDetailsCompanion((current) => (current === id ? null : id));
    });
    const closeCompanion = React.useCallback(() => {
        if (shownCompanion !== null) closeSettings();
        else pane.closeRight();
    }, [shownCompanion, closeSettings, pane.closeRight]);
    const activeCompanions = React.useMemo(() => [...(shownCompanion !== null ? [shownCompanion] : []), ...(flowOpen ? ['flow'] : [])], [shownCompanion, flowOpen]);
    const navigation = useWorkflowNavigation({ pageKind: 'workflowEditor', identity: draftId, scope: navigationScope,
        activeId: props.view,
        phone: phoneNavigation, presented: hasPageCommands, agentAvailable: agentCompanionAvailable,
        selectPage, companion: { activeId: activeCompanions[0] ?? null, activeIds: activeCompanions, select: selectCompanion, close: closeCompanion } });
    const executeNavigation = useMountedScopeActionCommand(navigationScope);
    const selectNavigation = React.useCallback((id: string) => selectWorkflowNavigationItem(executeNavigation, navigation.model, id),
        [executeNavigation, navigation.model]);

    // Once every issue is repaired the readout goes quiet again.
    React.useEffect(() => {
        if (errorCount === 0) setIssuesRevealed(false);
    }, [errorCount]);
    const focusFirstIssue = React.useCallback(() => {
        const blockId = blockingIssueBlockId;
        if (blockId === null) return;
        props.onSelectBlock(blockId);
        requestPromptFocus(blockId);
    }, [blockingIssueBlockId, props.onSelectBlock, requestPromptFocus]);

    // One inspector content for both subjects; only the subject and its
    // presentation differ (04 §5.2). Issues keep a group open only once the
    // page reveals them, so a pristine draft stays quiet.
    const inspectorBaseProps = React.useMemo(() => ({
        draftStore,
        workflowDefinitionId: props.currentWorkflowRef ?? undefined,
        readValidation,
        revealValidation: !hasPageCommands || issuesRevealed,
        onChange,
        documentEditable,
        ...(props.inspectorGroupDisclosure === undefined ? {} : { groupDisclosure: props.inspectorGroupDisclosure }),
        ...(props.onChangeInspectorGroup === undefined ? {} : { onChangeGroupDisclosure: props.onChangeInspectorGroup }),
        ...(props.authoringFacts === undefined ? {} : { authoringFacts: props.authoringFacts }),
        ...(props.existingSessions === undefined ? {} : { existingSessions: props.existingSessions }),
        onSessionOptionsDemandChange: props.onSessionOptionsDemandChange,
        sessionOptionsStatus: props.sessionOptionsStatus,
        onRetrySessionOptions: props.onRetrySessionOptions,
        ...(sessionDrop === undefined ? {} : { bindExistingSession: sessionDrop.bind }),
        ...(props.executionTarget === undefined ? {} : { executionTarget: props.executionTarget }),
        ...(props.runAsTargets === undefined ? {} : { runAsTargets: props.runAsTargets }),
        ...(props.description === undefined ? {} : { description: props.description }),
        ...(props.onChangeDescription === undefined ? {} : { onChangeDescription: props.onChangeDescription }),
    }), [
        props.currentWorkflowRef,
        props.description,
        props.onChangeDescription,
        documentEditable,
        draftStore,
        readValidation,
        hasPageCommands,
        issuesRevealed,
        onChange,
        props.authoringFacts,
        props.existingSessions,
        props.onSessionOptionsDemandChange,
        props.sessionOptionsStatus,
        props.onRetrySessionOptions,
        sessionDrop,
        props.executionTarget,
        props.inspectorGroupDisclosure,
        props.onChangeInspectorGroup,
        props.runAsTargets,
    ]);
    const buildSettingsProps = React.useCallback((blockId: string | null): WorkflowEditorInspectorProps => ({
        ...inspectorBaseProps,
        subject: blockId === null ? { kind: 'workflow' } : { kind: 'block', blockId },
        presentation: 'popover',
        testIDPrefix: blockId === null ? testIDPrefix : `${testIDPrefix}-inspector`,
    }), [inspectorBaseProps, testIDPrefix]);

    const closeSettingsPopover = React.useCallback(() => setSettingsPopover(null), []);
    // Step options: the one settings popover in a block's scope, anchored beside the step's control.
    // The popover itself presents as the shared bottom sheet on a phone.
    const openInspector = React.useCallback((
        blockId: string,
        anchorRef: React.RefObject<View | null>,
        cardRef?: React.RefObject<View | null>,
    ) => {
        props.onCustomizeBlock(blockId);
        // Every block kind has Step options (04 §5.2): a step's, a leaf's or a container's.
        if (findWorkflowBlock(readDraft(), blockId) === null) return;
        setSettingsPopover({ blockId, anchorRef, placementRef: cardRef ?? anchorRef });
    }, [props.onCustomizeBlock, readDraft]);
    // Step options stay open while their block exists; the page reads that block's kind only.
    const settingsBlockKind = useWorkflowEditorSelector(draftStore, (draft) => settingsPopover === null || settingsPopover.blockId === null ? null
        : findWorkflowBlock(draft, settingsPopover.blockId)?.kind ?? null);
    const settingsPopoverShown = settingsPopover !== null && (settingsPopover.blockId === null || settingsBlockKind !== null);

    // Undo and Redo are icon buttons: at the end of the chip line when wide (04 §4.1), at the document
    // foot on a phone. Only the commandless composition keeps the labelled pair.
    const historyIcons = <WorkflowEditorHistoryIcons testIDPrefix={testIDPrefix} history={props.history} />;
    const historyActions = <WorkflowEditorHistoryActions testIDPrefix={testIDPrefix} history={props.history} />;

    const settingsWidth = settingsBlockKind === 'if' ? IF_OPTIONS_MAX_WIDTH_PX : STEP_OPTIONS_MAX_WIDTH_PX;
    const settingsPopoverNode = settingsPopover === null || !settingsPopoverShown ? null : (
        <Popover
            open
            // Below (or, when there is no room, above) the card or control, so it never covers what it edits.
            anchorRef={settingsPopover.placementRef}
            focusReturnRef={settingsPopover.anchorRef}
            boundaryRef={null}
            placement="auto-vertical"
            placementMinSpace={POPOVER_PREFERRED_ROOM_PX}
            phonePresentation="sheet"
            sheetHeader="none"
            sheetMaterial="solid"
            accessibilityLabel={settingsPopover.blockId === null ? t('workflows.page.settings') : t('workflows.page.inspector.stepOptions')}
            edgePadding={{ horizontal: 12, vertical: 12 }}
            portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false }}
            maxWidthCap={settingsWidth}
            maxHeightCap={STEP_OPTIONS_MAX_HEIGHT_PX}
            onRequestClose={closeSettingsPopover}
        >
            {({ maxHeight, maxWidth }) => (
                <FloatingOverlay
                    maxHeight={Math.min(maxHeight, STEP_OPTIONS_MAX_HEIGHT_PX)}
                    surfaceChrome="theme"
                    // The options own their scroll below a pinned header (Back / title / Done).
                    scrollEnabled={false}
                    scrollViewStyle={{ flexShrink: 1, minHeight: 0 }}
                    containerStyle={{ width: Math.min(maxWidth, settingsWidth) }}
                >
                    <WorkflowEditorInspector
                        // One mounted surface per scope: switching scope starts that scope's pages fresh.
                        key={settingsPopover.blockId ?? 'workflow'}
                        {...buildSettingsProps(settingsPopover.blockId)}
                        onDone={closeSettingsPopover}
                    />
                </FloatingOverlay>
            )}
        </Popover>
    );

    const blockList = (
        <WorkflowEditorBlockList
            draftStore={draftStore}
            readValidation={readValidation}
            cardRefs={stepCardRefs}
            highlightedBlockIds={props.highlightedBlockIds}
            list={{ kind: 'root' }}
            depth={0}
            selectedBlockId={props.selectedBlockId}
            composerScope={props.composerScope}
            composerCustody={composerCustody}
            onChange={onChange}
            onSelect={props.onSelectBlock}
            onCustomize={openInspector}
            onCommitChange={props.onCommitChange}
            onUseExample={useExample}
            rootAddRow
            registerPromptRef={registerPromptRef}
            requestPromptFocus={requestPromptFocus}
            editingBlockId={editingBlockId}
            onRequestEditBlock={setEditingBlockId}
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

    const flowContent = (
        <WorkflowEditorFlowContent draftStore={draftStore} readValidation={readValidation} testIDPrefix={testIDPrefix}
            selectedBlockId={props.selectedBlockId} documentEditable={documentEditable} onSelectBlock={props.onSelectBlock}
            onChangeView={props.onChangeView} requestPromptFocus={requestPromptFocus} />
    );

    const duplicateButton = props.onDuplicate === undefined ? null : (
        <RoundButton testID={`${testIDPrefix}-duplicate`} display="secondary"
            title={t('common.duplicate')} onPress={props.onDuplicate} />
    );
    // 07 "One validity readout": the line names only what is not ready (§2.3 item 11, no "Ready") — once a
    // Run or Save has revealed issues, the count that leads to the first one; untouched issues stay silent.
    const readinessNode = errorCount === 0 && runBlockedReason === null
        ? null
        : issuesRevealed ? validityNodeFor() : null;
    // Run now is the page's one primary and Save is the status line's own action (07 §3 "One primary per view",
    // lab `editor-E1`), at every width. A phone has no bar of its own: the shell's tab bar keeps the bottom (owner 25).
    const saveStatusNode = props.onDuplicate !== undefined ? null : (
        <WorkflowEditorSaveStatus
            draftStore={draftStore}
            readout={readinessNode}
            state={props.saveConflict ? { kind: 'conflict', conflict: props.saveConflict } : (props.saveStatus ?? { kind: 'notSaved' })}
            {...(onSave === undefined ? {} : { onSave: submitSave })}
            {...(props.history === undefined ? {} : { onUndo: props.history.undo })}
            onSaveAsCopy={props.onSaveAsCopy ?? (() => {})}
            testIDPrefix={testIDPrefix}
        />
    );
    function validityNodeFor(): React.ReactElement {
        return <WorkflowStatusReadout testID={`${testIDPrefix}-validity`}
            text={t('workflows.page.issuesToFix', { count: errorCount })} onPress={focusFirstIssue} />;
    }
    const validityNode = !issuesRevealed || errorCount === 0 ? null : validityNodeFor();

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
    // Beside an open pane the header compacts (lab `editor-L1`/`L2`): Edit with an agent keeps its place
    // as its icon, so the title, its actions and the one primary stay on one line.
    const headerCompact = !compactLayout && (settingsOpen || flowOpen);
    const pageMenuActions: readonly PageHeaderMenuAction[] = [
        // Test run is an occasional check: it lives in `⋯` beside the one primary (lab E1's action set),
        // and its launcher anchors to that menu.
        ...(props.onTestRun !== undefined ? [{ id: 'test-run', title: t('workflows.testRun.title'),
            testID: `${testIDPrefix}-test-run`, disabled: props.testRunPending === true || runPending === true,
            onSelect: props.onTestRun }] : []),
        ...(props.menuActions ?? []),
    ];
    const pageMenu = pageMenuActions.length === 0 ? null : props.onTestRun === undefined ? (
        <PageHeaderMenu testID={`${testIDPrefix}-menu`} actions={pageMenuActions} />
    ) : (
        <View ref={props.testRunAnchorRef} collapsable={false}>
            <PageHeaderMenu testID={`${testIDPrefix}-menu`} actions={pageMenuActions} />
        </View>
    );
    const menu = backToRun === null ? pageMenu : <>{backToRun}{pageMenu}</>;
    const runNowButton = props.runNowAction ?? (onRunNow === undefined ? null : (
        <View ref={props.runNowAnchorRef} collapsable={false}>
        <RoundButton
            testID={`${testIDPrefix}-run-now`}
            title={t('workflows.editor.runNow')}
            accessibilityLabel={t('workflows.editor.runNow')}
            {...(runReason === null ? {} : { accessibilityHint: runReason })}
            disabled={runPending === true}
            leading={<Icon name="play" size={14} color={theme.colors.button.primary.tint} />}
            {...(runKeyHint === undefined ? {} : { trailing: <Text style={styles.keyHint}>{runKeyHint}</Text> })}
            onPress={submitRun}
        />
        </View>
    ));

    const phoneRunNowAction = compactLayout && hasPageCommands && onRunNow !== undefined && props.runNowAction === undefined ? {
        title: t('workflows.editor.runNow'), onPress: submitRun, disabled: runPending === true, testID: `${testIDPrefix}-run-now`,
    } : undefined;
    const phonePageControls = compactLayout && (props.runNowAction !== undefined || duplicateButton !== null)
        ? <>{duplicateButton}{props.runNowAction ?? null}</> : null;

    const validationPublisher = props.onValidationChange === undefined ? null : (
        <WorkflowEditorValidationPublisher draftStore={draftStore} readValidation={readValidation} onValidationChange={props.onValidationChange} />
    );
    const nameEditable = props.showNameField !== false && documentEditable;
    const identity = (
        <WorkflowEditorIdentity
            draftStore={draftStore}
            testIDPrefix={testIDPrefix}
            hasPageCommands={hasPageCommands}
            chromeOptions={chromeOptions}
            backControl={columnVisible ? null : hasPageCommands && (hostedDestination || appShellPresent) ? pageBackControl : inheritedBackControl}
            entityItem={props.currentWorkflowRef && props.accountLifetime?.scope ? {
                kind: 'workflow', scope: props.accountLifetime.scope, workflowId: props.currentWorkflowRef,
            } : null}
            header={{
                testID: `${testIDPrefix}-header`,
                // Wide, the controls keep the title's row. A phone recomposes (DESIGN.md "Phones recompose", owner
                // 11-15 H2): the name and its summary keep the full width and the controls the page still draws (a
                // built-in's Duplicate and session chooser) wrap beneath them, as the run page does.
                ...(compactLayout ? {} : { actionsLayout: 'inline' as const }),
                // The save line is the actions' own row, so its changing words never reflow the name
                // (DESIGN-9 N52). A page without a save line (a built-in's Duplicate) still says what to fix.
                // On a phone the actions live in the navigation bar, so the line sits beside the name (owner 25).
                ...(!hasPageCommands ? {} : { status: (saveStatusNode ?? validityNode) === null ? null : (
                    <View ref={props.runNowPlacementRef} collapsable={false}>{saveStatusNode ?? validityNode}</View>
                ) }),
                alwaysShowTitle: true,
                // Beside a companion the header is measured against the main column it shares (F5):
                // the name keeps one line, as the chips keep one row.
                ...(headerCompact ? { titleLines: 1 as const } : {}),
                meta: documentEditable ? props.headerMeta : undefined,
                // A phone's page gives its width to the editable name (lab `editor-P1`: no mark); wide
                // pages lead with the workflow's mark, its steps' ordinals hanging under it.
                ...(compactLayout ? {} : { leading: <PageHeaderMarkIcon name="tree-structure" /> }),
                // A phone's navigation bar carries what it can describe (Run now, the menu); a host-drawn
                // control (a built-in's session chooser) and Duplicate stay on the page's title row.
                ...(phoneRunNowAction === undefined ? {} : { primaryAction: phoneRunNowAction }),
                ...(phonePageControls === null ? {} : { actionsPlacement: 'page' as const }),
                actions: !hasPageCommands ? menu : compactLayout ? (phonePageControls === null ? menu : (
                    <View style={styles.headerActionRow}>{menu}{phonePageControls}</View>
                )) : (
                    <View style={styles.headerActionRow}>
                        {/* Edit with an agent is the labelled secondary (lab editor-E1); beside an open pane it
                            keeps its place as its icon. */}
                        {props.onEditWithAgent === undefined ? null : headerCompact ? (
                            <IconButton
                                testID={`${testIDPrefix}-edit-with-agent`}
                                accessibilityLabel={t('workflows.authoring.edit')}
                                tooltip={t('workflows.authoring.edit')}
                                iconName="sparkle"
                                variant="plain"
                                onPress={editWithAgent}
                            />
                        ) : (
                            <RoundButton
                                testID={`${testIDPrefix}-edit-with-agent`}
                                display="inverted"
                                title={t('workflows.authoring.edit')}
                                leading={<Icon name="sparkle" size={14} color={theme.colors.text.secondary} />}
                                onPress={editWithAgent}
                            />
                        )}
                        {menu}
                        {duplicateButton}
                        {runNowButton}
                    </View>
                ),
            }}
            // The line under the title says what the workflow does, generated from it (owner 2026-11-15);
            // the description itself is edited in Workflow settings.
            summaryTrigger={props.triggersSection === undefined || props.triggersSummary === undefined ? null : props.triggersSummary}
            readOnlyFacts={documentEditable ? null : props.headerMeta?.map((fact) => fact.text) ?? null}
            titleEditor={!nameEditable ? null : {
                controlRef: nameInputRef,
                placeholder: t('workflows.page.untitled'),
                accessibilityLabel: t('workflows.page.nameLabel'),
                onChangeText: renameWorkflow,
                onCommit: props.onCommitChange,
                testID: `${testIDPrefix}-name`,
            }}
        />
    );

    // The page's first cards (owner 2026-11-15): When it runs (the trigger owner's section, where the
    // host has one) and How and where it runs. Both read as one sentence while closed.
    const firstCards = (
        <View style={styles.firstCards}>
            {props.triggersSection === undefined ? null : (
                <WorkflowWhenItRunsCard
                    summary={props.triggersSummary ?? ''}
                    expanded={whenExpanded}
                    onExpandedChange={(expanded) => setCardExpanded(WORKFLOW_WHEN_CARD_ID, expanded)}
                    testIDPrefix={testIDPrefix}
                >
                    {props.triggersSection}
                </WorkflowWhenItRunsCard>
            )}
            <WorkflowHowAndWhereCard
                draftStore={draftStore}
                onChange={onChange}
                documentEditable={documentEditable}
                showsWorkflowAgent={showsWorkflowAgent}
                accountLifetime={props.accountLifetime}
                whereRef={whereRef}
                projectTarget={props.projectTarget}
                machineName={props.machineName}
                projectMachines={props.projectMachines}
                onChangeProjectTarget={props.onChangeProjectTarget}
                executionTarget={props.executionTarget}
                runAsTargets={props.runAsTargets}
                onChangeExecutionTarget={props.onChangeExecutionTarget}
                authoringFacts={props.authoringFacts}
                expanded={howWhereExpanded}
                onExpandedChange={(expanded) => setCardExpanded(WORKFLOW_HOW_WHERE_CARD_ID, expanded)}
                settingsAnchorRef={workflowSettingsAnchorRef}
                // A composition without page commands shows Workflow settings in place, below the cards.
                {...(hasPageCommands ? { onOpenSettings: openWorkflowSettings } : {})}
                testIDPrefix={testIDPrefix}
            />
        </View>
    );

    // A composition without page commands (the authored Automation wrapper,
    // retired with U-16) keeps its own single scroll owner and receives the
    // identity, the first cards and the document without a page or panes.
    if (!hasPageCommands) {
        return (
            <View testID={testIDPrefix} style={{ gap: theme.space.s16 }}>
                {props.showNameField === false && props.onBackToRun === undefined ? null : identity}
                <WorkflowDocumentGridContext.Provider value={compactLayout ? 'compact' : 'wide'}>{firstCards}</WorkflowDocumentGridContext.Provider>
                <ItemList scrollEnabled={false}>
                    <WorkflowEditorInspector {...buildSettingsProps(null)} presentation="pane" />
                </ItemList>
                <WorkflowDocumentGridContext.Provider value={compactLayout ? 'compact' : 'wide'}>{blockList}</WorkflowDocumentGridContext.Provider>
                {historyActions}
                {settingsPopoverNode}
                {validationPublisher}
            </View>
        );
    }

    // Steps stays mounted across the phone's Steps | Flow switch so every composer keeps its
    // caret, selection and any live IME or dictation binding; Flow holds no editing state and
    // mounts on demand. The same Flow can also be opened beside Steps.
    const stepsHidden = props.view !== 'steps';
    const page = (
        <KeyboardAwareScrollView
            testID={`${testIDPrefix}-scroll`}
            onScroll={refreshDropMeasurements}
            onLayout={refreshDropMeasurements}
            style={styles.pageScroll}
            contentContainerStyle={[styles.pageContent, chromeClearance > 0 ? { paddingBottom: theme.space.s20 + chromeClearance } : null]}
            contentInsetAdjustmentBehavior="automatic"
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
        >
            {identity}
            <WorkflowEditorCompanionFit flowOpen={flowOpen} foldedRef={flowFoldedRef} requestedRef={flowRequestedBesideRef}
                onFlowFolded={closeSettings} />
            {/* The header measures the pane for Back's gutter; only the document is column-capped. */}
            <View style={[styles.bodyColumn, maxWidthStyle]}>
            {props.reviewNotice}
            {/* Steps | Flow, with Undo and Redo at the row's end (lab round 1115 r16). */}
            <View style={[styles.pageTabs, styles.pageTabsRow, compactLayout ? null : styles.pageTabsOnMark]}>
                <WorkflowPageNavigation navigation={navigation} phone={phoneNavigation} onSelect={selectNavigation} testIDPrefix={`${testIDPrefix}-view`} />
                {historyIcons}
            </View>
            <View
                testID={`${testIDPrefix}-steps-presentation`}
                style={[styles.document, compactLayout ? null : styles.documentUnderTitle, stepsHidden ? { display: 'none' } : null]}
                {...(stepsHidden ? {
                    accessibilityElementsHidden: true,
                    importantForAccessibility: 'no-hide-descendants' as const,
                    pointerEvents: 'none' as const,
                } : {})}
            >
                {/* A phone's document has no header mark to hang under: its numbers take the mark's place. */}
                <WorkflowDocumentGridContext.Provider value={compactLayout ? 'compact' : 'wide'}>
                    {firstCards}
                    {blockList}
                </WorkflowDocumentGridContext.Provider>
            </View>
            {settingsPopoverNode}
            {props.view === 'flow' ? <View style={styles.document}>{flowContent}</View> : null}
            </View>
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
    const agentSessionPane = props.authoringSessionId ? (
        // Kept mounted while another companion shows, so the conversation keeps its place.
        <WorkflowAuthoringSessionPane sessionId={props.authoringSessionId} serverId={props.authoringServerId}
            active={shownCompanion === 'agent'} composer />
    ) : null;
    const companionHeader = shownCompanion === 'agent' ? (
        <WorkflowAgentCompanionHeader
            testID={`${testIDPrefix}-agent-pane-header`}
            sessionId={props.authoringSessionId ?? null}
            serverId={props.authoringServerId}
            {...(props.authoringSessionId ? { actions: <IconButton
                testID={`${testIDPrefix}-agent-open-session`}
                accessibilityLabel={t('workflows.authoring.openSession')}
                tooltip={t('workflows.authoring.openSession')}
                iconName="arrows-out"
                variant="plain"
                onPress={() => router.push(buildScopedSessionRouteHref({ sessionId: props.authoringSessionId!, serverId: props.authoringServerId }) as never)} /> } : {})}
            onClose={closeSettings}
        />
    ) : null;
    const companionDetails: AppPaneDestinationDetails | null = compactLayout || shownCompanion === null ? null : {
        pane: (
            <View testID={`${testIDPrefix}-${shownCompanion}-pane`} style={styles.paneBody}>
                {companionHeader}
                {agentCompanionAvailable ? agentSessionPane : null}
                {shownCompanion === 'agent' && !props.authoringSessionId && props.authoringDraft !== undefined ? (
                    <View testID={`${testIDPrefix}-agent-draft`} style={styles.agentDraft}>
                        <WorkflowAgentAuthoringDraft {...props.authoringDraft} />
                    </View>
                ) : null}
            </View>
        ),
        onClose: closeSettings,
        companion: true,
    };

    return (
        <View testID={testIDPrefix} style={styles.root}>
            <WorkflowEditorPaneScopeHost
                draftStore={draftStore}
                scopeId={WORKFLOW_EDITOR_PANE_SCOPE_ID}
                onMainColumnControlsChange={navigation.onMainColumnControlsChange}
                rightSidebarAdapter={{ available: true, render: () => null, renderActionRail: () => <WorkflowCompanionNavigation model={navigation.model} onSelect={id => selectWorkflowNavigationItem(executeNavigation, navigation.model, id, 'side')} /> }}
                main={page}
                rightPaneBuiltinAdapter={flowAdapter}
                destinationDetails={companionDetails}
                // A companion beside the document, not the files drawer: the Run's narrower default.
                detailsPreferredWidthPx={DEFAULT_SESSION_WIDTH_PX}
                mainMinWidthPx={WORKFLOW_EDITOR_MAIN_MIN_WIDTH_PX}
            />
            {validationPublisher}
        </View>
    );
}

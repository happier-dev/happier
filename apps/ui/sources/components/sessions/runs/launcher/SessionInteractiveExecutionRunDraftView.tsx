import { ExecutionRunStartResponseSchema, readExecutionRunStartRunCreation } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { resolveExecutionRunImplicitRoleIdV1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { resolveExecutionRunNotifyParentDefaultV1 } from '@happier-dev/protocol/execution/runs/executionRunNotifyParentDefaultV1';
import type { DiscussionSelectionSourceV1 } from '@happier-dev/protocol/discussions/content';
import * as React from 'react';
import { readableMessageText } from '@/components/sessions/transcript/messageDisplayText';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ProviderBoundModelRefSchema, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildRolesRailPickerOption } from '@/components/roles/rail/buildRolesRailPickerOption';
import { ContextualStartComposerBody, useContextualStartComposer, type ContextualStartSource, type ContextualStartAdmissibleSet } from '@/components/sessions/authoring/ContextualStartComposer';
import { ContextualStartLead } from '@/components/sessions/authoring/ContextualStartLead';
import { isWorkflowProjectTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import type { RoleRailItem } from '@/components/roles/rail/rolesRailTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { leafFolderName } from '@/utils/path/pathUtils';
import { useRoleRailCatalog } from '@/components/roles/rail/useRoleRailItems';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { SESSION_EXECUTION_RUN_LAUNCH_UNAVAILABLE_KEYS, useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { extractExecutionRunsBackendsFromMachineCapabilitiesState, resolveExecutionRunsCapabilityRead } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';
import { appendMountedComposerDraft } from '@/sync/ops/actions/appendMountedComposerDraft';
import { createRepositoryComposerDocumentOwner } from '@/components/sessions/composer/repositoryComposerDocumentOwner';
import {
    promoteAcceptedComposerDocument,
    type ComposerDraftFieldCurrentness,
    type MutableComposerDocumentOwner,
} from '@/components/sessions/composer/composerDocumentOwner';
import {
    ParticipantComposerSubmissionHeld,
    SessionParticipantComposer,
    type ParticipantComposerPreparedSubmission,
} from '@/components/sessions/participants/composer/SessionParticipantComposer';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { useExecutionRunMachineName } from '@/components/sessions/runs/details/useExecutionRunMachineName';
import { readActionExecutionFailureRecord, resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolveActionInputValidationError } from '@/sync/domains/actions/resolveActionInputValidationError';
import { Typography } from '@/constants/Typography';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useSessionBrowserContextRuntimeContext } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import {
    getSessionInputFailureLabelKey,
} from '@/components/sessions/pending/pendingMessageVisualState';
import { Text } from '@/components/ui/text/Text';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { randomUUID } from '@/platform/randomUUID';
import {
    sessionExecutionRunList,
} from '@/sync/ops/sessionExecutionRuns';
import { writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { ExecutionRunLauncherOptions } from './ExecutionRunLauncherOptions';
import {
    resolveExecutionRunLaunchTitle,
    resolveExecutionRunLauncherActionId,
    resolveExecutionRunTargetFieldPath,
    type ExecutionRunIntent,
    type ExecutionRunReviewPresentation,
} from './executionRunLauncherModel';
import { createExecutionRunReportChip, createExecutionRunStartContentChip } from './executionRunStartChips';
import { getExecutionRunStartChipDefinition } from './executionRunStartChipPlacements';
import { ExecutionRunRouteChoiceContent } from './ExecutionRunRouteChoiceContent';
import { resolveExecutionRunRouteChoice } from './resolveExecutionRunRouteChoice';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';
import { useExecutionRunTeamCredentialModel } from './useExecutionRunTeamCredentialModel';
import { ExecutionRunDraftSelectionContext } from './ExecutionRunDraftSelectionContext';
import { resolveExecutionRunIntentTitle } from '@/components/sessions/runs/resolveExecutionRunIntentTitle';
import { useExecutionRunLauncherOptionsModel } from './useExecutionRunLauncherOptionsModel';
import { resolveRowlessExecutionRunStartOptions } from './resolveRowlessExecutionRunStartOptions';
import { admitReviewExecutionRunLaunchSelection, useReviewExecutionRunLaunchOptions, type ReviewExecutionRunLaunchSelection } from './useReviewExecutionRunLaunchOptions';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { requestRegisteredComposerFocus } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import { useExecutionRunLaunchContext } from './useExecutionRunLaunchContext';
import { useDetachedExecutionRunProtocolSupport } from './useDetachedExecutionRunProtocolSupport';
import { ExactModelChoicePicker, useExactModelChoice } from '@/components/sessions/modelPicker/useExactModelChoice';
import { useExecutionRunChildChoice } from './useExecutionRunChildChoice';
import {
    applyExecutionRunChildSelection,
    clearExecutionRunChildSelection,
    readExecutionRunChildChoice,
    readExecutionRunFanoutMembers,
    type ExecutionRunChildSelection,
    type ExecutionRunFanoutMember,
} from './executionRunChildChoice';
import { ExecutionRunExactModelRow } from './ExecutionRunExactModelRow';
import { executionRunLauncherDraftKey } from '@/components/sessions/agents/launch/agentStartDrafts';
import { ExecutionRunChildChoiceCard } from './ExecutionRunChildChoiceCard';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { useExecutionRunLauncherDraft } from './useExecutionRunLauncherDraft';
import { useComparisonReviewDraft, type ComparisonReviewDraftInput } from './useComparisonReviewDraft';
import { ComparisonReviewScope, ComparisonWalkthroughChoice } from './ComparisonReviewFields';
import { COMPOSER_CONTENT_HORIZONTAL_INSET } from '@/components/sessions/agentInput/composerContentInset';
import { getValueAtPath } from '@/components/sessions/actions/ActionInputFields';
import { useSessionProjectScmSummarySnapshot, useWorkspaceScmSummarySnapshot } from '@/sync/domains/state/storage';
import { selectScmChangedFileCount } from '@/scm/scmStatusFiles';
import { scmSnapshotLineTotals } from '@/scm/scmLineDelta';
import { DiffStat } from '@/components/workspaces/scm/DiffStat';

/** Review's existing SCM summary subscription stays local to the source facts beneath its lead. */
function ExecutionRunReviewSource(props: Readonly<{
    sessionId: string | null;
    serverId: string | null;
    workspace?: Readonly<{ machineId: string; cwd: string }>;
    workingChanges: boolean;
    scopeLabel: string;
    scopeDetail: string;
}>) {
    const sessionSnapshot = useSessionProjectScmSummarySnapshot(props.workingChanges ? props.sessionId : null, props.serverId);
    const workspaceSnapshot = useWorkspaceScmSummarySnapshot(props.workingChanges && props.sessionId === null
        && props.serverId && props.workspace ? { serverId: props.serverId, machineId: props.workspace.machineId,
            rootPath: props.workspace.cwd } : null);
    const snapshot = sessionSnapshot ?? workspaceSnapshot;
    const totals = snapshot ? scmSnapshotLineTotals(snapshot) : null;
    return <View testID="execution-run-review-source">
        <ComparisonReviewScope scopeLabel={props.scopeLabel} scopeDetail={[
            props.scopeDetail,
            snapshot?.branch.head,
            snapshot ? t('files.repositoryChangedFiles', { count: selectScmChangedFileCount(snapshot) }) : null,
        ].filter(Boolean).join(' · ')} />
        {totals ? <DiffStat added={totals.includedAdded + totals.pendingAdded}
            removed={totals.includedRemoved + totals.pendingRemoved} /> : null}
    </View>;
}

/** Mount the exact Agent's Team demand only while its model detail is open. */
function ExecutionRunAgentModelPicker(props: Readonly<{
    choice: ExecutionRunLauncherBackendChoice;
    sessionId: string | null;
    serverId: string | null;
    machineId: string | null;
    actionInput: Record<string, unknown>;
    selected: ProviderBoundModelRef | null;
    inheritedTeamCredentialModel: TeamCredentialProviderModelSelectionV1 | null;
    selectBackend: (targetKey: string) => void;
    setActionInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
}>) {
    const setSelection = React.useCallback<React.Dispatch<React.SetStateAction<Record<string, unknown>>>>(update => {
        props.selectBackend(props.choice.targetKey);
        props.setActionInput(update);
    }, [props.choice.targetKey, props.selectBackend, props.setActionInput]);
    const team = useExecutionRunTeamCredentialModel({ ...props, selectedBackendChoice: props.choice,
        inheritedSelection: props.inheritedTeamCredentialModel,
        // Browsing another Agent does not normalize or commit the draft.
        hasBackendChoices: false, setActionInput: setSelection });
    return <ExactModelChoicePicker
        agentTargetKey={buildBackendTargetKeyV2(props.choice.backendTarget)}
        agentId={props.choice.agentId}
        machineId={props.machineId}
        serverId={props.serverId}
        selected={props.selected}
        teamModelChoice={team.pickerProps}
        title={t('agentInput.model.title')}
        fallbackLabel={t('runPage.menu.selectionChoose')}
        onSelect={ref => setSelection(previous => ref
            ? applyExecutionRunChildSelection(previous, ref) : clearExecutionRunChildSelection(previous))}
    />;
}

type DraftIdentity = Readonly<{ correlationId: string; inputLocalId: string }>;

function createDraftIdentity(): DraftIdentity {
    return { correlationId: randomUUID(), inputLocalId: randomUUID() };
}

export type ExecutionRunStartedPresentation = ExecutionRunReviewPresentation & Readonly<{
    /** The Run's intent in the person's words — what its tab and header are titled by. */
    title: string | null;
}>;

const UNAVAILABLE_REASON_KEYS = SESSION_EXECUTION_RUN_LAUNCH_UNAVAILABLE_KEYS;
const RUN_SESSION_ADMISSIBLE: ContextualStartAdmissibleSet = { who: ['newAgent'], machine: 'fixed', folder: 'fixed' };
const RUN_DETACHED_ADMISSIBLE: ContextualStartAdmissibleSet = { ...RUN_SESSION_ADMISSIBLE, folder: 'select' };

/**
 * A fresh start of one refused target with its chosen selection. `waiting` are the other refused
 * targets still owed their own question; `startedRunId` is a Run already started by this launch.
 */
type BoundedStartRetry = Readonly<{
    selection: ExecutionRunChildSelection;
    targetKeys: readonly string[];
    waiting: readonly ExecutionRunFanoutMember[];
    startedRunId: string | null;
}>;

/** A review's scope fields: the "Uncommitted · 4 files" chip asks these, Advanced asks the rest. */
function isReviewScopeFieldPath(path: string): boolean {
    return path === 'changeType' || path === 'base' || path.startsWith('base.');
}

/** Whether a backend choice runs the Agent a role's engine names (by canonical target identity). */
function choiceRunsAgent(choice: ExecutionRunLauncherBackendChoice, agentTargetKey: string): boolean {
    return backendTargetKeysMatch(choice.targetKey, agentTargetKey)
        || backendTargetKeysMatch(choice.backendTarget, agentTargetKey);
}

const stylesheet = StyleSheet.create((theme) => ({
    // The view owns its gutter and its one scroll, so the Details pane and the phone Start sheet frame
    // it the same way (lab flRun `review`/`reviewP`): the start reads from the top, under the header.
    scroll: {
        flex: 1,
    },
    root: {
        flexGrow: 1,
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s16,
    },
    // The participant composer brings the transcript column's gutter; inside the form it hangs that
    // gutter so its card shares the one edge with the lead, Who answers and the foot.
    composerHang: {
        marginHorizontal: -COMPOSER_CONTENT_HORIZONTAL_INSET,
    },
    foot: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
}));

export const SessionInteractiveExecutionRunDraftView = React.memo((props: Readonly<{
    sessionId: string | null;
    workspace?: Readonly<{ machineId: string; cwd: string }>;
    serverId?: string | null;
    onRunStarted: (
        runId: string,
        recovery?: Readonly<{ retryInputLocalId: string; initialText?: string }>,
        presentation?: ExecutionRunStartedPresentation,
    ) => void;
    /**
     * Host-provided text. Without a `launchOrigin` it seeds the composer. With a Discussion
     * `launchOrigin` it is the selected messages: shown as the draft's context (never as text the
     * person writes their question around) and sent to the agent ahead of the prompt.
     */
    initialText?: string;
    /** Host context seeds the existing Run draft; retained edits still win on reopen. */
    initialActionInput?: Readonly<Record<string, unknown>>;
    comparisonReview?: ComparisonReviewDraftInput | null;
    /** The plugin chooser returns admitted credentials through this same form. */
    credentialSelectionOnly?: boolean;
    selectionIsCurrent?: () => boolean;
    onLaunchSelection?: (selection: ReviewExecutionRunLaunchSelection) => void;
    launchOrigin?: DiscussionSelectionSourceV1 & Readonly<{ draftCorrelationId: string }>;
    autoFocusComposer?: boolean;
    /**
     * What the first message starts (lab `convo-S1`–`S3`): a review, a plan or a delegated task
     * through their canonical Actions, or — without an intent — a plain conversation that stays
     * open beside the Session. Either way nothing exists until the first Send.
     */
    intent?: ExecutionRunIntent | null;
    /**
     * A role the start begins with (Second opinion: a review run by `second_opinion`). The person
     * can still change it from the start's Role chip or engine popover.
     */
    roleId?: string | null;
    /** What the tab calls this start ("Second opinion"); the heading says the same, never a second name. */
    heading?: string | null;
}>) => {
    const intent = props.intent ?? null;
    const optionsIntent: ExecutionRunIntent = intent ?? 'delegate';
    const styles = stylesheet;
    const selectionContext = props.launchOrigin ? props.initialText?.trim() || null : null;
    const composerInitialText = props.launchOrigin ? undefined : props.initialText;
    const { theme } = useUnistyles();
    const explicitServerId = props.serverId?.trim() || null;
    const preferredServerId = usePreferredServerIdForSession({
        serverId: explicitServerId,
        sessionId: props.sessionId ?? '',
    });
    const serverId = props.sessionId === null ? explicitServerId : preferredServerId;
    const [chosenWorkspace, setChosenWorkspace] = React.useState<typeof props.workspace>();
    const workspace = chosenWorkspace ?? props.workspace;
    const launcher = useExecutionRunLaunchContext(props.sessionId, serverId, workspace);
    const { session, accountBinding, accountLifetime, exactSettings, settings, profileCatalogReady, acpCatalogSnapshot, enabledAgentIds, defaultBackend,
        backendTarget, inheritedModelSelection, inheritedTeamCredentialModel, resolveInheritedModelLabel, inheritedRoutePresentation, inheritedConnectedServicesSelection, machineId, machineReachable, startAction } = launcher;
    const [mountedComposerRef, setMountedComposerRef] = React.useState<Extract<ComposerRefV1, { kind: 'participantMessage' | 'newSession' }> | null>(null);
    const initialComposerFocusApplied = React.useRef(false);
    const sessionLaunchability = useSessionExecutionRunLaunchability(
        props.sessionId ?? '',
        session,
        serverId,
    );
    const { state: machineCapabilitiesState } = useMachineCapabilitiesCache({
        machineId,
        enabled: Boolean(machineId),
        ...(serverId ? { serverId } : {}),
        request: { requests: [{ id: 'tool.executionRuns', ...(props.sessionId ? { params: { sessionId: props.sessionId } } : {}) }] },
    });
    const executionRunsEnabled = useFeatureEnabled('execution.runs', { scopeKind: 'spawn', serverId });
    const detachedProtocol = useDetachedExecutionRunProtocolSupport(
        props.sessionId === null && executionRunsEnabled === true && machineReachable ? machineId : null,
        accountBinding?.scope ?? null,
    );
    const canLaunchExecutionRuns = props.sessionId === null
        ? executionRunsEnabled === true && machineReachable && detachedProtocol?.ok === true
        : sessionLaunchability.canLaunchExecutionRuns;
    const launchUnavailableReason = props.sessionId === null
        ? executionRunsEnabled !== true ? 'notEnabled' : !machineReachable ? 'machineOffline' : null
        : sessionLaunchability.launchUnavailableReason;
    const executionRunsBackends = props.sessionId === null
        ? extractExecutionRunsBackendsFromMachineCapabilitiesState(machineCapabilitiesState) ?? {}
        : sessionLaunchability.executionRunsBackends;
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        sections: DAEMON_AGENT_CATALOG_SECTIONS,
        machineId,
        serverId: serverId ?? null,
        enabled: Boolean(machineId),
    });
    // Which Agents the Machine really has; the New Session picker reads the same inventory.
    const machineAgents = useMachineAgents({ machineId, serverId, load: Boolean(machineId) });
    const browserContextRuntime = useSessionBrowserContextRuntimeContext();
    const [phase, setPhase] = React.useState<'idle' | 'starting' | 'reconciling' | 'unresolved'>('idle');
    const [error, setError] = React.useState<string | null>(null);
    const launcherDraftKey = executionRunLauncherDraftKey({
        intent,
        roleId: props.roleId,
        discussionCorrelationId: props.launchOrigin?.draftCorrelationId,
        comparisonReview: props.comparisonReview ?? undefined,
    });
    const launcherDraft = useExecutionRunLauncherDraft({
        lifetime: accountLifetime,
        sessionId: props.credentialSelectionOnly ? null : props.sessionId,
        draftKey: launcherDraftKey,
        comparisonReview: props.comparisonReview ?? undefined,
        correlationId: props.launchOrigin?.draftCorrelationId,
        createDefaultInput: () => buildExecutionRunActionDraftInputForUi({
            actionId: resolveExecutionRunLauncherActionId(optionsIntent),
            sessionId: props.sessionId,
            // A review asks who reviews; it never silently picks the Session's own Agent.
            defaultBackendTarget: intent === 'review' ? null : backendTarget,
            defaultBackendId: defaultBackend?.defaultBackendId ?? null,
            instructions: '',
            // The Report chip sends the Account's existing default explicitly.
            extra: {
                ...props.initialActionInput,
                ...(props.comparisonReview?.preselectedEngineIds
                    ? { engineIds: [...props.comparisonReview.preselectedEngineIds] } : {}),
                ...(props.sessionId === null && props.workspace ? { cwd: props.workspace.cwd } : {}),
                ...(props.roleId ? { roleId: props.roleId } : {}),
                notifyParentOnCompletion: props.sessionId === null ? false : resolveExecutionRunNotifyParentDefaultV1({
                    runClass: intent ? 'bounded' : 'long_lived',
                    accountDefault: settings.executionRunsNotifyParentOnCompletionDefault,
                }),
            },
        }),
    });
    const { identity, setIdentity, actionInput, setActionInput: setNormalizedActionInput, setUserActionInput: setActionInput } = launcherDraft;
    const comparisonReview = useComparisonReviewDraft({
        sessionId: props.sessionId,
        machineId: machineId ?? undefined,
        serverId,
        comparisonReview: props.comparisonReview ?? null,
        engineIds: Array.isArray(actionInput.engineIds) ? actionInput.engineIds.map(String) : [],
        actionInput,
        setActionInput,
        machineInventory: machineAgents,
        onRetryInventory: machineAgents.refresh,
    });
    const options = useExecutionRunLauncherOptionsModel({
        sessionId: props.sessionId,
        intent: optionsIntent,
        actionInput,
        setActionInput: setNormalizedActionInput,
        setUserActionInput: setActionInput,
        singleTarget: intent !== 'review',
        enabledAgentIds,
        executionRunsBackends,
        acpCatalogSnapshot,
        initialBackendTarget: backendTarget,
        inheritedModelSelection,
        inheritedTeamCredentialModel,
        inheritedRoutePresentation,
        inheritedConnectedServicesSelection,
        fallbackAgentId: defaultBackend?.defaultAgentId ?? null,
        machineCapabilitiesState,
        mergedBackendProjectionById: daemonMergedProjection.inputs?.mergedBackendProjectionById ?? null,
        mergedProviderProjectionById: daemonMergedProjection.inputs?.mergedProviderProjectionById ?? null,
        machineAgents: machineAgents.agents,
    });
    const childChoice = useExecutionRunChildChoice();
    const reviewOptions = useReviewExecutionRunLaunchOptions({
        launcher,
        sessionId: props.sessionId,
        serverId,
        backendChoices: options.backendChoices,
        selectedBackendChoice: options.selectedBackendChoice,
        actionInput,
        setActionInput,
        inheritedSelection: options.inheritedDraftTeamCredentialModel,
        onSelectionChange: () => setError(null),
        modelSelectionEnabled: intent === 'review' && !childChoice.choice,
        credentialSelectionOnly: props.credentialSelectionOnly,
        busy: phase !== 'idle',
    });
    const { teamCredential, secretState: secretOverlayState } = reviewOptions;
    const machine = useExecutionRunMachineName(session, serverId, props.workspace?.machineId);
    const runIdRef = React.useRef<string | null>(null);
    const notifiedRunIdRef = React.useRef<string | null>(null);
    const submitInFlightRef = React.useRef(false);
    const startedTitleRef = React.useRef<string | null>(null);
    const notifyRunStarted = React.useCallback((runId: string, recovery?: Readonly<{ retryInputLocalId: string; initialText?: string }>) => {
        if (notifiedRunIdRef.current === runId) return;
        notifiedRunIdRef.current = runId;
        const presentation: ExecutionRunStartedPresentation = { title: startedTitleRef.current };
        props.onRunStarted(runId, recovery, presentation);
    }, [props.onRunStarted]);

    const findCorrelatedRun = React.useCallback(async (): Promise<string | null> => {
        // Detached external starts carry no Session correlation contract. An unknown
        // outcome remains explicitly unresolved instead of guessing from another Run.
        if (props.sessionId === null) return null;
        setPhase('reconciling');
        const listed = await sessionExecutionRunList(
            props.sessionId,
            {},
            serverId ? { serverId } : undefined,
        );
        if (!('runs' in listed)) return null;
        const matches = listed.runs.filter((run) => {
            const launchOrigin = run.launchOrigin;
            if (
                !launchOrigin
                || launchOrigin.kind === 'external'
                || launchOrigin.draftCorrelationId !== identity.correlationId
            ) {
                return false;
            }
            return props.launchOrigin
                ? launchOrigin.kind === 'discussion'
                    && launchOrigin.serverId === props.launchOrigin.serverId
                    && launchOrigin.discussionId === props.launchOrigin.discussionId
                    && launchOrigin.messageIds.length === props.launchOrigin.messageIds.length
                    && launchOrigin.messageIds.every((messageId, index) => messageId === props.launchOrigin?.messageIds[index])
                : launchOrigin.kind === 'session'
                    && launchOrigin.sessionId === props.sessionId;
        });
        return matches.length === 1 ? matches[0]!.runId : null;
    }, [identity.correlationId, props.launchOrigin, props.sessionId, serverId]);

    /**
     * A review, plan or delegated task: the first message is its instructions, started through the
     * canonical Action (several reviewers fan out there). The captured message is accepted only once
     * the Action returns a Run; a refusal leaves the draft as it was.
     */
    const submitBoundedStartRef = React.useRef<((
        boundedIntent: ExecutionRunIntent,
        submission: ParticipantComposerPreparedSubmission,
        retry?: BoundedStartRetry,
    ) => Promise<void>) | undefined>(undefined);
    const submitBoundedStart = React.useCallback(async (
        boundedIntent: ExecutionRunIntent,
        submission: ParticipantComposerPreparedSubmission,
        retry?: BoundedStartRetry,
    ) => {
        if (submitInFlightRef.current) throw new Error(t('common.loading'));
        const targetFieldPath = resolveExecutionRunTargetFieldPath(boundedIntent);
        const drafted: Record<string, unknown> = {
            ...comparisonReview.launchInput,
            instructions: submission.text,
            ...(secretOverlayState.overlay ? { secretReferenceOverlay: secretOverlayState.overlay } : {}),
        };
        // A chosen default or model is a fresh start of the one refused target it answers (D9).
        const input = retry
            ? applyExecutionRunChildSelection({ ...drafted, [targetFieldPath]: retry.targetKeys }, retry.selection)
            : drafted;
        const selectionCapture = launcherDraft.captureSelection();
        const validationError = resolveActionInputValidationError({
            sessionId: props.sessionId,
            input,
            spec: options.actionSpec as never,
            fields: options.fields as never,
        });
        if (validationError) {
            setError(validationError);
            throw new ParticipantComposerSubmissionHeld();
        }
        if (!accountLifetime?.isCurrent() || !secretOverlayState.readiness.ok || !teamCredential.available) {
            throw new Error(t('common.unavailable'));
        }
        submitInFlightRef.current = true;
        childChoice.begin();
        setError(null);
        setPhase('starting');
        try {
            if (props.credentialSelectionOnly) {
                const selection = await admitReviewExecutionRunLaunchSelection({
                    launcher,
                    draft: input,
                    operationId: identity.correlationId,
                    isCurrent: props.selectionIsCurrent ?? accountLifetime.isCurrent,
                });
                setPhase('idle');
                if (selection) props.onLaunchSelection?.(selection);
                return;
            }
            const comparisonStart = props.comparisonReview && boundedIntent === 'review'
                ? await comparisonReview.submit({ start: startAction, input, instructions: submission.text, operationId: identity.correlationId })
                : null;
            if (comparisonStart && !comparisonStart.actionResult) {
                throw new Error(comparisonStart.comparison.ok ? t('common.requestFailed') : comparisonStart.comparison.error);
            }
            const result = comparisonStart?.actionResult ?? await startAction(options.actionId, input, identity.correlationId);
            const members = readExecutionRunFanoutMembers(result);
            // A target whose Agent can't follow this Session asks D9's question, with host proof that
            // nothing started for it. Members that started keep their Runs and members of unknown
            // outcome stay unknown: the draft keeps only the refused targets, so neither starts again.
            // Each refused target asks its own question, one at a time: a choice is addressed to the one
            // Agent it names, so it resubmits that target alone while the others wait their turn.
            const startedRunId = members.find((member) => member.runId !== null)?.runId ?? retry?.startedRunId ?? null;
            const refused = [...members.filter((member) => member.choice !== null), ...(retry?.waiting ?? [])];
            if (refused.length > 0) {
                const [next, ...waiting] = refused;
                if (retry || refused.length < members.length) {
                    const refusedKeys = refused.map((member) => member.key);
                    setActionInput((previous) => ({ ...previous, [targetFieldPath]: refusedKeys,
                        ...(comparisonStart?.capturedComparisonId ? { comparisonId: comparisonStart.capturedComparisonId } : {}),
                    }));
                }
                childChoice.offer(next!.choice, (selection) => submitBoundedStartRef.current?.(
                    boundedIntent, submission, { selection, targetKeys: [next!.key], waiting, startedRunId }) ?? Promise.resolve());
                throw new ParticipantComposerSubmissionHeld();
            }
            // Several reviewers start as one group (`display.groupId`); its pane shows them all, so
            // any member that started opens it, and the start is accepted. Members that didn't
            // start are said out loud, not dropped; only a start where none did is refused.
            const runId = startedRunId;
            if (!runId) {
                throw Object.assign(new Error(resolveActionExecutionFailureMessage(result, t('common.requestFailed')) ?? t('common.requestFailed')),
                    { code: readActionExecutionFailureRecord(result)?.errorCode });
            }
            const notStarted = members.filter((member) => member.runId === null).map((member) => (
                options.backendChoices.find((choice) => choice.targetKey === member.key || choice.backendId === member.key)?.title ?? member.key
            ));
            launcherDraft.clearAcceptedSelection(selectionCapture, submission.onOutboundHandoff());
            setPhase('idle');
            props.onRunStarted(runId, undefined, {
                title: resolveExecutionRunLaunchTitle({
                    intent: boundedIntent,
                    instructions: submission.displayText ?? submission.text,
                }),
                ...(notStarted.length > 0 ? { reviewersNotStarted: notStarted } : {}),
                ...(comparisonStart?.comparison.ok ? {
                    comparisonId: comparisonStart.comparison.comparisonId,
                    reviewRunIds: comparisonStart.comparison.reviewRunIds,
                    narrationError: comparisonStart.comparison.narrationError,
                    walkthrough: comparisonReview.plan.walkthrough,
                } : {}),
            });
        } catch (cause) {
            setPhase('idle');
            if (cause instanceof ParticipantComposerSubmissionHeld) throw cause;
            const failureLabelKey = getSessionInputFailureLabelKey(cause);
            setError(failureLabelKey
                ? t(failureLabelKey)
                : cause instanceof Error ? cause.message : t('common.requestFailed'));
            throw new ParticipantComposerSubmissionHeld();
        } finally {
            submitInFlightRef.current = false;
        }
    }, [accountLifetime, childChoice.begin, childChoice.offer, comparisonReview.submit, comparisonReview.launchInput, launcher, startAction, identity.correlationId, options.actionId, options.actionSpec, options.backendChoices, options.fields, props.comparisonReview, props.credentialSelectionOnly, props.selectionIsCurrent, props.onLaunchSelection, props.onRunStarted, props.sessionId, secretOverlayState.overlay, secretOverlayState.readiness.ok, teamCredential.available]);

    submitBoundedStartRef.current = submitBoundedStart;

    const submitConversationStartRef = React.useRef<((submission: ParticipantComposerPreparedSubmission, childSelection?: ExecutionRunChildSelection) => Promise<void>) | undefined>(undefined);
    const submitConversationStart = React.useCallback(async (submission: ParticipantComposerPreparedSubmission,
        childSelection?: ExecutionRunChildSelection) => {
        if (submitInFlightRef.current) {
            throw new Error(t('common.loading'));
        }
        const selectionCapture = launcherDraft.captureSelection();
        const startOptions = options.selectedBackendChoice
            ? resolveRowlessExecutionRunStartOptions({
                choice: options.selectedBackendChoice,
                conversation: {
                    sessionId: props.sessionId,
                    text: selectionContext ? `${selectionContext}\n\n${submission.text}` : submission.text,
                    localInputId: identity.inputLocalId,
                },
                input: {
                    ...actionInput,
                    ...(secretOverlayState.overlay
                        ? { secretReferenceOverlay: secretOverlayState.overlay }
                        : {}),
                },
            })
            : { ok: false as const };
        if (!startOptions.ok || !accountLifetime?.isCurrent() || !secretOverlayState.readiness.ok || !teamCredential.available) {
            throw new Error(t('common.unavailable'));
        }
        submitInFlightRef.current = true;
        childChoice.begin();
        setError(null);
        setPhase('starting');
        let handedOff = false;
        let startIssued = false;
        let runDraftPromotion: Readonly<{
            owner: MutableComposerDocumentOwner;
            acceptedCurrentness: ComposerDraftFieldCurrentness;
        }> | null = null;
        try {
            let runId = runIdRef.current;
            if (!runId) {
                const intentTitle = resolveExecutionRunIntentTitle(readableMessageText(submission.displayText ?? submission.text));
                startedTitleRef.current = intentTitle;
                const launchOrigin = props.launchOrigin
                    ? { ...props.launchOrigin, draftCorrelationId: identity.correlationId }
                    : props.sessionId === null ? undefined : { kind: 'session' as const, sessionId: props.sessionId, draftCorrelationId: identity.correlationId };
                const startInput = {
                    ...startOptions.options,
                    ...(intentTitle ? { display: { title: intentTitle } } : {}),
                    // Each attempt carries its own correlation so a lost response can be
                    // reconciled; a Discussion launch keeps its selection provenance.
                    ...(launchOrigin ? { launchOrigin } : {}),
                };
                const started = await startAction('execution.run.start',
                    childSelection ? applyExecutionRunChildSelection(startInput, childSelection) : startInput,
                    identity.correlationId, launchOrigin);
                startIssued = true;
                const parsedStart = started.ok ? ExecutionRunStartResponseSchema.safeParse(started.result) : null;
                if (parsedStart?.success) {
                    runId = parsedStart.data.runId;
                } else if (started.ok || readExecutionRunStartRunCreation(started.details) !== 'noRunCreated') {
                    runId = await findCorrelatedRun();
                }
                if (!runId) {
                    const knownNoRun = !started.ok
                        && readExecutionRunStartRunCreation(started.details) === 'noRunCreated';
                    // The Agent can't follow this Session's route (D9): the draft stays and the
                    // chooser asks for its default or an exact model; that choice is a fresh start.
                    if (knownNoRun && childChoice.offer(readExecutionRunChildChoice(started), (selection) => submitConversationStartRef.current?.(submission, selection) ?? Promise.resolve())) {
                        setPhase('idle');
                        throw new ParticipantComposerSubmissionHeld();
                    }
                    setPhase(knownNoRun ? 'idle' : 'unresolved');
                    // An unknown outcome is not a failure: the Run may already exist, so the copy
                    // says so and warns that another Start may create a second conversation.
                    const message = knownNoRun
                        ? resolveActionExecutionFailureMessage(started, t('common.requestFailed')) ?? t('common.requestFailed')
                        : t('sessionDrafts.executionRunStart.unresolved');
                    setError(message);
                    throw new Error(message);
                }
                runIdRef.current = runId;
            }

            if (props.sessionId === null) {
                if (!accountLifetime.isCurrent()) throw new ParticipantComposerSubmissionHeld();
                handedOff = true;
                launcherDraft.clearAcceptedSelection(selectionCapture, submission.onOutboundHandoff());
                notifyRunStarted(runId);
                setPhase('idle');
                return;
            }

            writeExistingSessionDraft({
                scope: accountLifetime.scope,
                sessionId: props.sessionId,
                runId,
                patch: {
                    text: submission.draft.text,
                    mentions: [...submission.draft.mentions],
                    attachments: [...submission.draft.attachments],
                },
            });
            const runDraftOwner = createRepositoryComposerDocumentOwner({
                scope: accountLifetime.scope,
                scopeLifetime: accountLifetime,
                ref: { kind: 'participantMessage', sessionId: props.sessionId, instanceId: identity.inputLocalId },
                address: { kind: 'run', sessionId: props.sessionId, runId },
                isCurrent: accountLifetime.isCurrent,
            });
            const acceptedCurrentness = runDraftOwner.captureCurrentness();
            runDraftPromotion = { owner: runDraftOwner, acceptedCurrentness };

            // The selected messages travel ahead of the prompt so the agent reads both; the transcript
            // shows only what the person wrote, and the Run header shows the context as its chip.
            const outboundText = selectionContext ? `${selectionContext}\n\n${submission.text}` : submission.text;
            const outboundDisplayText = selectionContext ? submission.displayText ?? submission.text : submission.displayText;
            await sync.submitMessage(
                props.sessionId,
                outboundText,
                outboundDisplayText,
                submission.metaOverrides,
                {
                    ...(serverId ? { serverId } : {}),
                    recipient: { kind: 'execution_run', runId },
                    ...(submission.requestedAction ? { requestedAction: submission.requestedAction } : {}),
                    localId: identity.inputLocalId,
                    callerSurface: 'participant_composer',
                    onOutboundHandoff: () => {
                        handedOff = true;
                        const residual = submission.onOutboundHandoff();
                        launcherDraft.clearAcceptedSelection(selectionCapture, residual);
                        promoteAcceptedComposerDocument({
                            residual: {
                                text: residual.text,
                                structuredInputMentions: residual.mentions,
                                composerAttachments: residual.attachments,
                            },
                            destination: runDraftOwner,
                            destinationAcceptedCurrentness: acceptedCurrentness,
                        });
                    },
                },
            );
            notifyRunStarted(runId);
            setPhase('idle');
        } catch (cause) {
            if (runIdRef.current) {
                if (!handedOff && runDraftPromotion) {
                    const current = submission.readCurrentDraft();
                    promoteAcceptedComposerDocument({
                        residual: {
                            text: current.text,
                            structuredInputMentions: current.mentions,
                            composerAttachments: current.attachments,
                        },
                        destination: runDraftPromotion.owner,
                        destinationAcceptedCurrentness: runDraftPromotion.acceptedCurrentness,
                    });
                }
                notifyRunStarted(runIdRef.current, handedOff ? undefined : { retryInputLocalId: identity.inputLocalId,
                    ...(props.sessionId === null ? { initialText: submission.readCurrentDraft().text } : {}) });
                setPhase('idle');
            } else if (!startIssued) {
                // The refusal happened before any start reached the Home, so nothing can
                // exist to reconcile and the draft stays editable. Only a start that was
                // actually issued keeps the unresolved recovery the try block chose.
                setPhase('idle');
            }
            if (cause instanceof ParticipantComposerSubmissionHeld) throw cause;
            const failureLabelKey = getSessionInputFailureLabelKey(cause);
            const message = failureLabelKey
                ? t(failureLabelKey)
                : cause instanceof Error ? cause.message : t('errors.failedToSendMessage');
            setError(message);
            throw new ParticipantComposerSubmissionHeld();
        } finally {
            submitInFlightRef.current = false;
        }
    }, [accountLifetime, actionInput, childChoice.begin, childChoice.offer, startAction, findCorrelatedRun, identity, notifyRunStarted, options.selectedBackendChoice, props.launchOrigin, props.sessionId, secretOverlayState.overlay, secretOverlayState.readiness.ok, selectionContext, serverId, teamCredential.available]);

    submitConversationStartRef.current = submitConversationStart;

    const submitPreparedMessage = React.useCallback(
        (submission: ParticipantComposerPreparedSubmission) => (intent
            ? submitBoundedStart(intent, submission)
            : submitConversationStart(submission)),
        [intent, submitBoundedStart, submitConversationStart],
    );

    const editable = phase === 'idle';
    const canSendMessages = props.sessionId === null ? accountLifetime?.isCurrent() === true
        : session !== null && deriveTranscriptInteractionFromSession(session).canSendMessages;
    const unavailable = exactSettings === null
        || !profileCatalogReady
        || (props.sessionId !== null && !session)
        || !canSendMessages
        || canLaunchExecutionRuns !== true
        || (props.comparisonReview != null && !comparisonReview.plan.canStart)
        || options.targetRequirement !== null
        || !secretOverlayState.readiness.ok
        || !teamCredential.available
        || (options.selectedProfileId !== '' && (
            options.selectedProfileChoice?.disabled !== false || !options.selectedProfileMatchesSelectedBackend
        ));
    React.useEffect(() => {
        if (!props.autoFocusComposer || !mountedComposerRef || unavailable || !editable || initialComposerFocusApplied.current) return;
        initialComposerFocusApplied.current = requestRegisteredComposerFocus(mountedComposerRef);
    }, [editable, mountedComposerRef, props.autoFocusComposer, unavailable]);
    const appliedHostSeed = React.useRef(composerInitialText);
    const hostSeedTail = React.useRef(Promise.resolve());
    React.useEffect(() => {
        if (appliedHostSeed.current === composerInitialText || !composerInitialText || !editable || !mountedComposerRef || !accountLifetime?.isCurrent()) return;
        hostSeedTail.current = hostSeedTail.current.then(async () => {
            if (appliedHostSeed.current === composerInitialText || !accountLifetime.isCurrent()) return;
            if (await appendMountedComposerDraft({ scope: accountLifetime.scope, ref: mountedComposerRef, text: composerInitialText })) {
                appliedHostSeed.current = composerInitialText;
            } else if (accountLifetime.isCurrent()) setError(t('common.unavailable'));
        });
    }, [accountLifetime, composerInitialText, editable, mountedComposerRef]);

    // The role this start runs (lab `convo-S1/S2`): the one chosen here, else the role the run-start
    // owner gives its intent (a review is the Reviewer's). Only a chosen role travels as `roleId`; the
    // target Session's admission resolves it and stamps its engine.
    const router = useRouter();
    const { items: roles, status: rolesStatus } = useRoleRailCatalog();
    const chosenRoleId = typeof actionInput.roleId === 'string' ? actionInput.roleId : null;
    const roleValue = chosenRoleId ?? resolveExecutionRunImplicitRoleIdV1(intent) ?? null;
    const roleItem = roleValue ? roles.find((item) => item.roleId === roleValue) ?? null : null;
    const chosenRoleAgentTargetKey = chosenRoleId ? roleItem?.agentTargetKey ?? null : null;
    const selectedChoices = React.useMemo(
        () => options.backendChoices.filter((choice) => options.selectedBackendTargetKeys.includes(choice.targetKey)),
        [options.backendChoices, options.selectedBackendTargetKeys],
    );
    const onSelectBackend = options.onSelectBackend;
    /**
     * Who answers. A role with its own engine wins at admission, so picking another Agent (or adding a
     * reviewer on one) leaves that role rather than showing a choice the run would not keep.
     */
    const selectBackend = React.useCallback((targetKey: string) => {
        setError(null);
        const choice = options.backendChoices.find((candidate) => candidate.targetKey === targetKey);
        const adding = !options.selectedBackendTargetKeys.includes(targetKey);
        onSelectBackend(targetKey);
        if (chosenRoleAgentTargetKey && choice && adding && !choiceRunsAgent(choice, chosenRoleAgentTargetKey)) {
            setActionInput((previous) => {
                const { roleId: _roleId, ...next } = previous;
                return next;
            });
        }
    }, [chosenRoleAgentTargetKey, onSelectBackend, options.backendChoices, options.selectedBackendTargetKeys]);
    const chooseRole = React.useCallback((roleId: string) => {
        setError(null);
        const item = roles.find((candidate) => candidate.roleId === roleId);
        // A role on its own Agent moves the shared Who selection to that Agent.
        const roleAgent = item?.agentTargetKey;
        const follow = roleAgent
            ? options.backendChoices.find((choice) => !choice.disabled && choiceRunsAgent(choice, roleAgent))
            : undefined;
        setActionInput((previous) => ({
            ...previous,
            roleId,
            ...(follow
                ? intent === 'review' ? { engineIds: [follow.backendId] } : { backendTargetKeys: [follow.targetKey] }
                : {}),
        }));
    }, [intent, options.backendChoices, roles]);
    const describeRoleConsequence = React.useCallback((item: RoleRailItem) => {
        const roleAgent = item.agentTargetKey;
        if (!roleAgent || selectedChoices.length === 0) return null;
        if (selectedChoices.every((choice) => choiceRunsAgent(choice, roleAgent))) return null;
        return t('agentStart.role.replaces', { agent: selectedChoices.map((choice) => choice.title).join(' + ') });
    }, [selectedChoices]);
    const openRoleSettings = React.useCallback(() => { router.push('/settings/roles' as never); }, [router]);
    const rolesRail = React.useMemo(() => buildRolesRailPickerOption({
        value: roleValue,
        roles,
        onChange: chooseRole,
        describeConsequence: describeRoleConsequence,
        onManageRoles: openRoleSettings,
    }), [chooseRole, describeRoleConsequence, openRoleSettings, roleValue, roles]);

    // The shared Who rows and their demanded model details consume the same launch choices.
    const selectedChoice = options.selectedBackendChoice;
    const draftModelSelection = React.useMemo(() => {
        const parsed = ProviderBoundModelRefSchema.safeParse(actionInput.modelSelection);
        return parsed.success ? parsed.data : null;
    }, [actionInput.modelSelection]);
    // One exact-model chooser serves both asks: D9's after a refusal (the refused Agent's default or an
    // exact model), and the Run's own model from the route chip. The route's list loads once asked for.
    const pendingChildChoice = childChoice.choice;
    const childChoiceAgent = pendingChildChoice
        ? options.backendChoices.find((choice) => choiceRunsAgent(choice, pendingChildChoice.agentTargetKey)) ?? null
        : null;
    const [routeModelDemanded, setRouteModelDemanded] = React.useState(false);
    const demandRouteModel = React.useCallback(() => setRouteModelDemanded(true), []);
    const modelChoiceAgent = pendingChildChoice ? childChoiceAgent : intent === 'review' ? null : selectedChoice;
    const exactModelChoice = useExactModelChoice({
        agentTargetKey: pendingChildChoice?.agentTargetKey
            ?? (modelChoiceAgent ? buildBackendTargetKeyV2(modelChoiceAgent.backendTarget) : null),
        agentId: modelChoiceAgent?.agentId ?? null,
        machineId,
        serverId,
        selected: pendingChildChoice ? null : draftModelSelection ?? options.inheritedDraftSelection,
        ...(!pendingChildChoice ? { teamModelChoice: teamCredential.pickerProps } : {}),
        title: pendingChildChoice ? t('session.agentContinuation.childChoice.chooseModel') : t('agentInput.model.title'),
        fallbackLabel: t('runPage.menu.selectionChoose'),
        enabled: pendingChildChoice !== null || routeModelDemanded,
    });
    const openExactModel = exactModelChoice.open;
    const chooseChild = childChoice.choose;
    const startWithChild = React.useCallback((selection: ExecutionRunChildSelection) => {
        // A failure is already said under the composer by the start itself.
        chooseChild(selection).catch(() => undefined);
    }, [chooseChild]);
    const chooseChildModel = React.useCallback(() => openExactModel((ref) => {
        if (ref) startWithChild(ref);
    }), [openExactModel, startWithChild]);
    const chooseDraftModel = React.useCallback(() => openExactModel((ref) => {
        setError(null);
        setActionInput((previous) => (ref ? applyExecutionRunChildSelection(previous, ref) : clearExecutionRunChildSelection(previous)));
    }), [openExactModel, setActionInput]);
    const exactModelPresentation = exactModelChoice.presentation;
    const exactModelSubtitle = [exactModelPresentation.subtitle, exactModelPresentation.detail].filter(Boolean).join(' · ');

    const reportToSession = actionInput.notifyParentOnCompletion === true;
    const onPatch = options.onPatch;
    const chipRevision = JSON.stringify([actionInput, editable]);
    const renderOptions = React.useCallback((
        sections: React.ComponentProps<typeof ExecutionRunLauncherOptions>['sections'],
        includeFieldPath?: (path: string) => boolean,
    ) => (
        <ExecutionRunLauncherOptions
            backendChoices={options.backendChoices}
            selectedBackendTargetKeys={options.selectedBackendTargetKeys}
            profileChoices={options.profileChoices}
            selectedProfileId={options.selectedProfileId}
            selectedPermissionMode={options.selectedPermissionMode}
            permissionModeOptions={options.visiblePermissionModeOptions}
            fields={options.fields}
            input={actionInput}
            editable={editable}
            resolveFieldOptions={options.resolveFieldOptions}
            machineName={machine.name}
            sections={sections}
            {...(includeFieldPath ? { includeFieldPath } : {})}
            backendSectionLabel={intent === 'review' ? t('runPage.launcher.who.review') : undefined}
            multiSelect={intent === 'review'}
            onSelectBackend={selectBackend}
            onSelectProfile={(choice) => {
                setError(null);
                options.onSelectProfile(choice);
            }}
            onPatch={(patch) => {
                setError(null);
                options.onPatch(patch);
            }}
        />
    ), [actionInput, editable, intent, machine.name, options, selectBackend]);

    // RT4: a new Run follows the session's route and model unless the draft chooses its own. On a
    // phone the composer's rail scrolls and shows whole chips only, so a chip with a long label
    // sits past its edge: there the chip keeps just its glyph and the words move beside "Starts
    // when you send". A wide window has room for the labelled chip and says it once.
    const { width: windowWidth } = useWindowDimensions();
    const routeInFoot = isMobileLayoutWidth(windowWidth);
    const routeFollowed = options.inheritedDraftRoutePresentation !== null;
    const hasSelectedBackend = options.selectedBackendChoice !== null;
    const routeChoice = React.useMemo(() => intent !== 'review' && hasSelectedBackend
        ? resolveExecutionRunRouteChoice({
            inherits: routeFollowed,
            inheritedSelection: options.targetMatchesParent ? inheritedModelSelection ?? null : null,
            inheritedTeamCredentialModel: options.targetMatchesParent ? inheritedTeamCredentialModel : null,
            inheritedRoutePresentation: options.targetMatchesParent ? inheritedRoutePresentation ?? null : null,
            inheritedModelLabel: options.targetMatchesParent ? resolveInheritedModelLabel(inheritedModelSelection ?? null) : null,
        })
        : null,
    [hasSelectedBackend, inheritedModelSelection, inheritedTeamCredentialModel, inheritedRoutePresentation, intent, options.targetMatchesParent, resolveInheritedModelLabel, routeFollowed]);

    const reviewScopeField = intent === 'review' && !props.comparisonReview
        ? options.fields.find(field => field.path === 'changeType') : undefined;
    const reviewScopeLabel = reviewScopeField?.options?.find(option => option.value === actionInput.changeType)?.label
        ?? t('agentStart.chips.scope');
    const reviewScopeDetail = intent === 'review' && !props.comparisonReview ? options.fields.flatMap(field => {
        if (field.visible === false || field.path === 'changeType' || !isReviewScopeFieldPath(field.path)) return [];
        const value = getValueAtPath(actionInput, field.path);
        const label = field.options?.find(option => option.value === value)?.label ?? (typeof value === 'string' ? value : '');
        return label ? [`${field.title ?? field.path}: ${label}`] : [];
    }).join(' · ') : '';

    const startChips = React.useMemo<ReadonlyArray<AgentInputExtraActionChip>>(() => {
        const chips: AgentInputExtraActionChip[] = [];
        const disabled = !editable;
        if (options.visiblePermissionModeOptions.length > 1) {
            const selected = options.visiblePermissionModeOptions.find((option) => option.value === options.selectedPermissionMode);
            chips.push(createExecutionRunStartContentChip({
                ...getExecutionRunStartChipDefinition('permissions'), pending: true,
                label: selected?.label ?? t('executionRuns.newRun.sections.permissions'),
                testID: 'execution-run-start-permissions-chip',
                disabled,
                revision: chipRevision,
                renderContent: () => renderOptions(['permissions']),
            }));
        }
        if (routeChoice) {
            const inherits = routeFollowed;
            const hasModelField = options.fields.some((field) => field.path === 'modelId' && field.visible !== false);
            chips.push(createExecutionRunStartContentChip({
                ...getExecutionRunStartChipDefinition('route'), pending: true,
                icon: inherits ? 'arrow-elbow-down-right' : 'path',
                label: routeChoice.label,
                testID: 'execution-run-start-route-chip',
                iconOnly: routeInFoot,
                disabled,
                revision: `${chipRevision}:${routeChoice.label}:${routeChoice.inheritDetail ?? ''}:${exactModelSubtitle}`,
                renderContent: () => (
                    <ExecutionRunRouteChoiceContent
                        inherits={inherits}
                        canInherit={options.targetMatchesParent}
                        inheritDetail={routeChoice.inheritDetail}
                        onInherit={() => {
                            setError(null);
                            setActionInput(clearExecutionRunChildSelection);
                        }}
                        chooseContent={hasModelField ? (
                            <ExecutionRunExactModelRow
                                subtitle={exactModelSubtitle}
                                {...(exactModelPresentation.accessibilityLabel ? { accessibilityLabel: exactModelPresentation.accessibilityLabel } : {})}
                                onDemand={demandRouteModel}
                                onPress={chooseDraftModel}
                            />
                        ) : null}
                    />
                ),
            }));
        }
        if (reviewScopeField) {
            chips.push(createExecutionRunStartContentChip({
                ...getExecutionRunStartChipDefinition('scope'), pending: true,
                label: reviewScopeLabel,
                testID: 'execution-run-start-scope-chip',
                disabled,
                revision: chipRevision,
                renderContent: () => renderOptions(['fields'], isReviewScopeFieldPath),
            }));
        }
        // A captured comparison asks one more question (lab flRun `compare`): a walkthrough after the
        // findings, and who writes it. Its chip names the choice; the content holds the narrator rows.
        const comparisonFields = props.comparisonReview ? comparisonReview.fields : null;
        if (comparisonFields) {
            chips.push(createExecutionRunStartContentChip({
                ...getExecutionRunStartChipDefinition('walkthrough'), pending: true,
                label: comparisonFields.walkthrough ? t('reviewWalkthrough.dialog.walkMeThroughAfter') : t('reviewWalkthrough.dialog.findingsOnlyChoice'),
                testID: 'execution-run-start-walkthrough-chip',
                disabled,
                requirement: comparisonFields.plan.blocked === 'no_narrator' ? { code: 'no_narrator', fieldPath: 'narrator' } : null,
                revision: `${chipRevision}:${comparisonFields.walkthrough}:${comparisonFields.plan.narrator?.engineId ?? ''}:${comparisonFields.plan.narrator?.candidates.length ?? 0}:${comparisonFields.plan.footer?.kind ?? ''}`,
                renderContent: () => <ComparisonWalkthroughChoice plan={comparisonFields.plan} walkthrough={comparisonFields.walkthrough}
                    onToggleWalkthrough={comparisonFields.onToggleWalkthrough} onSelectNarrator={comparisonFields.onSelectNarrator} />,
            }));
        }
        if (props.sessionId !== null) chips.push(createExecutionRunReportChip({
            pending: true,
            value: reportToSession,
            disabled,
            onChange: (next) => onPatch({ notifyParentOnCompletion: next }),
        }));
        // The route chip owns a Run's model (exact source and model); a review has no route chip.
        const isAdvancedFieldPath = (path: string) => path !== 'permissionMode' && !isReviewScopeFieldPath(path)
            && !(path === 'modelId' && intent !== 'review');
        const hasAdvancedFields = options.fields.some((field) => field.visible !== false && isAdvancedFieldPath(field.path)
            && !['backendTargetKeys', 'engineIds', 'instructions', 'notifyParentOnCompletion', 'secretReferenceOverlay', 'teamCredentialModel', 'teamCredentialSessionBindingConsent'].includes(field.path));
        if (options.profileChoices.length > 0 || hasAdvancedFields || (intent === 'review' && teamCredential.picker)) {
            chips.push(createExecutionRunStartContentChip({
                ...getExecutionRunStartChipDefinition('advanced'), pending: true,
                label: t('agentStart.chips.advanced'),
                testID: 'execution-run-start-advanced-chip',
                disabled,
                revision: chipRevision,
                renderContent: () => (
                    <View style={{ gap: theme.space.s16 }}>
                        {renderOptions(['profiles', 'fields'], isAdvancedFieldPath)}
                        {intent === 'review' ? teamCredential.picker : null}
                    </View>
                ),
            }));
        }
        return chips;
    }, [props.sessionId, props.comparisonReview, comparisonReview.fields, reviewScopeField, reviewScopeLabel, chipRevision, editable, routeChoice, routeFollowed, routeInFoot, intent, onPatch, onSelectBackend, roleItem?.name, roleValue, rolesRail, rolesStatus, options.backendChoices, options.fields, options.profileChoices.length, options.selectedBackendTargetKeys, options.selectedPermissionMode, options.targetMatchesParent, options.targetRequirement, options.visiblePermissionModeOptions, renderOptions, reportToSession, teamCredential.picker, exactModelSubtitle, exactModelPresentation.accessibilityLabel, demandRouteModel, chooseDraftModel]);

    // Why it can't start yet, said above the kept draft (lab `convo-ST` "Machine offline"): still
    // reading what the machine offers, or the reason agents can't start in this Session.
    const capabilityRead = launchUnavailableReason === null
        && canLaunchExecutionRuns !== true
        && !(executionRunsBackends && Object.keys(executionRunsBackends).length > 0)
        ? resolveExecutionRunsCapabilityRead(machineCapabilitiesState)
        : 'answered';
    const checkingCapabilities = capabilityRead === 'reading';
    const blockedReason = launchUnavailableReason === 'machineOffline'
        ? t('agentStart.offline', { machine: machine.name })
        : launchUnavailableReason !== null
            ? t(UNAVAILABLE_REASON_KEYS[launchUnavailableReason])
            : checkingCapabilities
                ? t('runPage.launcher.checking')
                : capabilityRead === 'unreadable'
                    ? t('machineAgents.unknown')
                    : canLaunchExecutionRuns !== true
                        ? t('runPage.launcher.unavailableReason')
                        : null;
    const leadAgentIds = intent === 'review'
        ? options.backendChoices.filter((choice) => options.selectedBackendTargetKeys.includes(choice.targetKey)).map((choice) => choice.agentId)
        : selectedChoice ? [selectedChoice.agentId] : [];
    // A review is about the changes in this folder (the scope chip says which), not about the machine.
    const reviewFolder = leafFolderName(workspace?.cwd ?? (session ? readSessionOwnerMetadataView(session)?.path : null))
        ?? t('agentStart.thisFolder');
    const startCount = intent === 'review' ? Math.max(1, options.selectedBackendTargetKeys.length) : 1;
    const startsWhenYouSend = t('agentStart.startsWhenYouSend', { count: startCount });

    const childParentSelection = pendingChildChoice?.parentModelSelection ?? inheritedModelSelection ?? null;
    const childParentDetail = pendingChildChoice
        ? resolveExecutionRunRouteChoice({
            inherits: true,
            inheritedSelection: childParentSelection,
            inheritedTeamCredentialModel,
            inheritedRoutePresentation: inheritedRoutePresentation ?? null,
            inheritedModelLabel: resolveInheritedModelLabel(childParentSelection),
        }).inheritDetail
        : null;

    const whereTarget = React.useMemo(() => {
        const directory = workspace?.cwd ?? (session ? readSessionOwnerMetadataView(session)?.path : null);
        return machineId && directory ? { machineId, directory } : null;
    }, [machineId, session, workspace?.cwd]);
    const reviewModelSubtitle = reviewOptions.modelSubtitle;
    const contextualSource = React.useMemo<ContextualStartSource>(() => ({
        enabled: accountLifetime !== null,
        busy: !editable,
        sections: [{ category: 'newAgent', section: { kind: 'static', id: 'new-agents', options: options.backendChoices.map(choice => ({
            id: choice.targetKey, testID: `contextual-start-agent:${choice.agentId}`,
            label: choice.title, disabled: choice.disabled,
            icon: <ExecutionRunAgentMark agentId={choice.agentId} size={16} />,
            ...(choice.unavailable === 'notOnMachine' ? { subtitle: t('machineAgents.notOnMachineYet', { machine: machine.name }) }
                : choice.unavailable === 'cantRun' ? { subtitle: t('machineAgents.cantRunOn', { machine: machine.name }) } : {}),
            ...(intent !== 'review' && selectedChoice?.targetKey === choice.targetKey
                && (draftModelSelection || options.inheritedDraftSelection || teamCredential.selected)
                ? { subtitle: exactModelPresentation.subtitle } : {}),
            ...(intent === 'review' && reviewModelSubtitle && options.selectedBackendChoice?.targetKey === choice.targetKey
                ? { subtitle: reviewModelSubtitle } : {}),
            onSelect: () => selectBackend(choice.targetKey),
        })) } }],
        selectedIds: new Set(options.selectedBackendTargetKeys),
        where: { accountLifetime, target: whereTarget, machineName: machine.name,
            machineHomeDir: session ? readSessionOwnerMetadataView(session)?.homeDir : null,
            testIDPrefix: 'run-start', choose: target => {
                if (isWorkflowProjectTarget(target)) setChosenWorkspace({ machineId: target.machineId, cwd: target.directory });
            } },
    }), [accountLifetime, draftModelSelection, editable, exactModelPresentation.subtitle, intent, machine.name, reviewModelSubtitle,
        options.backendChoices, options.inheritedDraftSelection, options.selectedBackendTargetKeys, selectBackend,
        selectedChoice?.targetKey, session, teamCredential.selected, whereTarget]);
    const contextualComposer = useContextualStartComposer(contextualSource,
        props.sessionId === null && !props.comparisonReview ? RUN_DETACHED_ADMISSIBLE : RUN_SESSION_ADMISSIBLE);
    // A single chosen reviewer's model opens under the list from its row's Change (lab flOpinion
    // `recipe`), never as a whole model list drawn inline.
    const reviewModelChoice = intent === 'review' && !props.credentialSelectionOnly ? reviewOptions.modelChoice : null;
    const reviewModelTarget = reviewModelChoice ? options.selectedBackendChoice?.targetKey ?? null : null;
    const agentDetails = React.useMemo(() => new Map(intent === 'review' ? reviewModelTarget ? [[reviewModelTarget, () => reviewModelChoice] as const] : [] : options.backendChoices.map(choice => [choice.targetKey, () =>
        <ExecutionRunAgentModelPicker choice={choice} sessionId={props.sessionId} machineId={machineId}
            serverId={serverId} actionInput={actionInput}
            selected={[draftModelSelection, options.inheritedDraftSelection].find(ref => ref && choiceRunsAgent(choice, ref.agentTargetKey)) ?? null}
            inheritedTeamCredentialModel={options.inheritedDraftTeamCredentialModel
                && choiceRunsAgent(choice, options.inheritedDraftTeamCredentialModel.agentTargetKey) ? options.inheritedDraftTeamCredentialModel : null}
            selectBackend={selectBackend} setActionInput={setActionInput} />] as const)),
    [actionInput, draftModelSelection, intent, machineId, options.backendChoices, options.inheritedDraftSelection, reviewModelChoice, reviewModelTarget,
        options.inheritedDraftTeamCredentialModel, props.sessionId, selectBackend, serverId, setActionInput]);

    return (
        <ScrollView testID="execution-run-start-form" style={styles.scroll} contentContainerStyle={styles.root}
            keyboardShouldPersistTaps="handled">
            {/* What this start is, right above the composer where the answer will appear (lab S1/S3).
                An Ask Agent draft leads with the lead and the selected context instead (collab lab R1). */}
            {props.launchOrigin && selectionContext ? (
                <ExecutionRunDraftSelectionContext
                    sessionId={props.sessionId}
                    serverId={serverId}
                    origin={props.launchOrigin}
                    contextText={selectionContext}
                    agentId={options.selectedBackendChoice?.agentId ?? null}
                />
            ) : props.credentialSelectionOnly ? null : (
                // A value-returning selector's sheet band already names it; this lead would repeat it.
                <ContextualStartLead testID="execution-run-start-lead"
                    marks={leadAgentIds.length > 0 ? leadAgentIds.slice(0, 3).map((agentId) => (
                        <ExecutionRunAgentMark key={agentId} agentId={agentId} size={28} />
                    )) : null}
                    title={props.heading ?? (intent ? t(`runPage.launcher.titles.${intent}` as const) : t('agentStart.titles.conversation'))}
                    description={intent === 'review'
                        ? t('runPage.launcher.descriptions.review', { folder: reviewFolder })
                        : intent
                        ? t(`runPage.launcher.descriptions.${intent}` as const, { machine: machine.name })
                        : t('agentStart.descriptions.conversation', { machine: machine.name })}>
                    {props.comparisonReview ? <ComparisonReviewScope scopeLabel={comparisonReview.fields.scopeLabel}
                        scopeDetail={comparisonReview.fields.scopeDetail} error={comparisonReview.fields.error} onRetry={comparisonReview.fields.onRetry} />
                        : intent === 'review' ? <ExecutionRunReviewSource sessionId={props.sessionId} serverId={serverId}
                            workspace={workspace} workingChanges={actionInput.changeType === 'uncommitted'}
                            scopeLabel={reviewScopeLabel} scopeDetail={reviewScopeDetail} /> : null}
                </ContextualStartLead>
            )}
            {blockedReason ? (
                <SurfaceStateCard
                    testID="execution-run-start-blocked"
                    size="line"
                    kind={checkingCapabilities ? 'loading' : launchUnavailableReason === 'machineOffline' || capabilityRead === 'unreadable' ? 'warning' : 'denied'}
                    title={blockedReason}
                    diagnosticCode={detachedProtocol?.ok === false && !checkingCapabilities ? detachedProtocol.errorCode : null}
                />
            ) : null}
            {pendingChildChoice ? (
                <View>
                    <ExecutionRunChildChoiceCard
                        choice={pendingChildChoice}
                        agentTitle={childChoiceAgent?.title ?? t('session.agentContinuation.childChoice.agentFallback')}
                        parentDetail={childParentDetail}
                        starting={phase === 'starting'}
                        onUseDefault={() => startWithChild('agentDefault')}
                        onChooseModel={chooseChildModel}
                        onCancel={childChoice.cancel}
                    />
                </View>
            ) : null}
            <ContextualStartComposerBody model={contextualComposer}
                whoAccessory={{ label: roleItem?.name ?? (rolesStatus === 'loading' ? t('common.loading') : roleValue ?? t('roles.rail.title')),
                    render: close => rolesRail.renderDetailContent?.({ onRequestClose: close }) ?? null }}
                details={agentDetails}
                whoContent={intent === 'review' && props.credentialSelectionOnly ? reviewOptions.modelChoice : null}
                question={<View style={styles.composerHang}><SessionParticipantComposer
                // The draft identity rotates as a live prop. Keying on it would remount the
                // composer and discard the text, references and staged attachments the
                // person authored but has not sent anywhere.
                key={JSON.stringify([serverId, accountBinding?.accountId, props.sessionId, launcherDraftKey])}
                sessionId={props.credentialSelectionOnly ? null : props.sessionId}
                workspace={workspace ?? (props.credentialSelectionOnly && machineId && session
                    ? { machineId, cwd: readSessionOwnerMetadataView(session)?.path ?? '' } : undefined)}
                serverId={serverId}
                canSendMessages={canSendMessages}
                placeholder={intent === 'review' ? t('agentStart.placeholders.review') : undefined}
                disabled={!editable}
                isSendDisabled={unavailable || !editable}
                recipient={null}
                browserContextState={browserContextRuntime?.composerContext.state ?? null}
                initialText={composerInitialText}
                initialLocalId={identity.inputLocalId}
                draftOccurrenceId={identity.inputLocalId}
                launcherDraftKey={launcherDraftKey}
                onDraftDocumentEdit={launcherDraft.onDocumentEdit}
                onComposerRefAvailable={setMountedComposerRef}
                submitPreparedMessage={submitPreparedMessage}
                extraActionChips={startChips}
            /></View>} />
            <Text testID="execution-run-start-foot" style={styles.foot}>
                {/* Choosing here returns a selection to the plugin; it starts nothing itself. */}
                {props.credentialSelectionOnly ? t('agentStart.selector.nothingStarts')
                    : routeInFoot && routeChoice ? `${routeChoice.label} \u00B7 ${startsWhenYouSend}` : startsWhenYouSend}
            </Text>
            {reviewOptions.controls}
            {phase === 'starting' || phase === 'reconciling' ? (
                <Text testID="execution-run-conversation-phase" style={{ color: theme.colors.text.secondary }}>
                    {phase === 'starting'
                        ? t('sessionDrafts.executionRunStart.starting')
                        : t('sessionDrafts.executionRunStart.reconciling')}
                </Text>
            ) : null}
            {error ? (
                <Text testID="execution-run-conversation-error" style={{ color: theme.colors.status?.error ?? theme.colors.text.primary }}>
                    {error}
                </Text>
            ) : null}
            <PoliteAccessibilityStatus
                statusTestID="execution-run-conversation-accessibility-status"
                transitionKey={error ? `error:${error}` : `phase:${phase}`}
                announcement={error ?? (phase === 'starting'
                    ? t('sessionDrafts.executionRunStart.starting')
                    : phase === 'reconciling'
                        ? t('sessionDrafts.executionRunStart.reconciling')
                        : '')}
            />
            {phase === 'unresolved' ? (
                <HappierPressable
                    accessibilityRole="button"
                    accessibilityLabel={t('sessionDrafts.startAnother')}
                    testID="execution-run-conversation-start-another"
                    onPress={() => {
                        runIdRef.current = null;
                        notifiedRunIdRef.current = null;
                        setIdentity(createDraftIdentity());
                        setError(null);
                        setPhase('idle');
                    }}
                    style={({ pressed }) => ({
                        alignSelf: 'flex-start',
                        paddingVertical: theme.space.s8,
                        paddingHorizontal: theme.space.s10,
                        borderRadius: 10,
                        backgroundColor: theme.colors.surface.inset,
                        opacity: pressed ? motionTokens.press.opacity : 1,
                    })}
                >
                    <Text style={{ color: theme.colors.text.primary }}>{t('sessionDrafts.startAnother')}</Text>
                </HappierPressable>
            ) : null}
        </ScrollView>
    );
});

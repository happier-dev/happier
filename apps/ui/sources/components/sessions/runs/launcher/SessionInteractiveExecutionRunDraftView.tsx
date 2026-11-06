import { getExecutionRunStartChipDefinition } from './executionRunStartChipPlacements';
import { ExecutionRunStartResponseSchema, readExecutionRunStartRunCreation } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { resolveExecutionRunImplicitRoleIdV1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { resolveExecutionRunNotifyParentDefaultV1 } from '@happier-dev/protocol/execution/runs/executionRunNotifyParentDefaultV1';
import type { DiscussionSelectionSourceV1 } from '@happier-dev/protocol/discussions/content';
import * as React from 'react';
import { readableMessageText } from '@/components/sessions/transcript/messageDisplayText';
import { useHomeAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';
import { Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ProviderBoundModelRefSchema, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildRolesRailPickerOption, ROLES_RAIL_PICKER_OPTION_ID } from '@/components/roles/rail/buildRolesRailPickerOption';
import type { RoleRailItem } from '@/components/roles/rail/rolesRailTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { leafFolderName } from '@/utils/path/pathUtils';
import { useRoleRailCatalog } from '@/components/roles/rail/useRoleRailItems';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { SESSION_EXECUTION_RUN_LAUNCH_UNAVAILABLE_KEYS, useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { extractExecutionRunsBackendsFromMachineCapabilitiesState, resolveExecutionRunsCapabilityRead } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';
import { readExecutionRunProtocolV2Support } from '@happier-dev/protocol/execution/runs/protocolSupport';
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
    type ParticipantComposerEngine,
    type ParticipantComposerPreparedSubmission,
} from '@/components/sessions/participants/composer/SessionParticipantComposer';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { useExecutionRunMachineName } from '@/components/sessions/runs/details/useExecutionRunMachineName';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolveActionInputValidationError } from '@/sync/domains/actions/resolveActionInputValidationError';
import { Typography } from '@/constants/Typography';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useSessionBrowserContextRuntimeContext } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import {
    getSessionInputFailureLabelKey,
} from '@/components/sessions/pending/pendingMessageVisualState';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { randomUUID } from '@/platform/randomUUID';
import {
    sessionExecutionRunList,
} from '@/sync/ops/sessionExecutionRuns';
import { writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { t } from '@/text';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { ExecutionRunLauncherOptions } from './ExecutionRunLauncherOptions';
import {
    resolveExecutionRunLaunchTitle,
    resolveExecutionRunLauncherActionId,
    resolveExecutionRunTargetFieldPath,
    type ExecutionRunIntent,
} from './executionRunLauncherModel';
import { createExecutionRunReportChip, createExecutionRunReviewerChip, createExecutionRunStartContentChip } from './executionRunStartChips';
import { ExecutionRunRouteChoiceContent } from './ExecutionRunRouteChoiceContent';
import { resolveExecutionRunRouteChoice } from './resolveExecutionRunRouteChoice';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';
import { useExecutionRunTeamCredentialModel } from './useExecutionRunTeamCredentialModel';
import { ExecutionRunDraftSelectionContext } from './ExecutionRunDraftSelectionContext';
import { resolveExecutionRunIntentTitle } from '@/components/sessions/runs/resolveExecutionRunIntentTitle';
import { useExecutionRunLauncherOptionsModel } from './useExecutionRunLauncherOptionsModel';
import { resolveRowlessExecutionRunStartOptions } from './resolveRowlessExecutionRunStartOptions';
import {
    ExecutionRunSecretReferenceOverlayField,
    resolveExecutionRunSessionLaunchProfile,
    type ExecutionRunSecretReferenceOverlayState,
} from './ExecutionRunSecretReferenceOverlayField';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { requestRegisteredComposerFocus } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import { useExecutionRunLaunchContext } from './useExecutionRunLaunchContext';
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

export type ExecutionRunStartedPresentation = Readonly<{
    /** The Run's intent in the person's words — what its tab and header are titled by. */
    title: string | null;
}>;

const UNAVAILABLE_REASON_KEYS = SESSION_EXECUTION_RUN_LAUNCH_UNAVAILABLE_KEYS;

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
    // The view owns its gutter, so the Details pane and the phone's Run page frame it the same way;
    // the lead and foot sit on the composer card's edge.
    root: {
        flex: 1,
        gap: theme.space.s12,
        justifyContent: 'flex-end',
        paddingHorizontal: theme.space.s16,
    },
    // Alone on a page there is no transcript above to anchor to: the start sits in the middle.
    rootCentered: {
        justifyContent: 'center',
    },
    lead: {
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s8,
    },
    // A question asked of the person stands on the lead's edge, not the composer card's.
    question: {
        paddingHorizontal: theme.space.s8,
    },
    marks: {
        flexDirection: 'row',
        gap: theme.space.s6,
    },
    title: {
        color: theme.colors.text.primary,
        ...Typography.variant('title'),
    },
    description: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
    },
    foot: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
        textAlign: 'right',
        paddingHorizontal: theme.space.s8,
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
    /**
     * Where the start sits in its space. The Details pane keeps it on the composer's edge, below the
     * conversation it belongs to; as a page of its own, with nothing above it, it is centered.
     */
    placement?: 'bottom' | 'center';
}>) => {
    const intent = props.intent ?? null;
    const optionsIntent: ExecutionRunIntent = intent ?? 'delegate';
    const styles = stylesheet;
    const selectionContext = props.launchOrigin ? props.initialText?.trim() || null : null;
    const composerInitialText = props.launchOrigin ? undefined : props.initialText;
    const { theme } = useUnistyles();
    const interactiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const explicitServerId = props.serverId?.trim() || null;
    const preferredServerId = usePreferredServerIdForSession({
        serverId: explicitServerId,
        sessionId: props.sessionId ?? '',
    });
    const serverId = props.sessionId === null ? explicitServerId : preferredServerId;
    const { session, accountBinding, accountLifetime, exactSettings, settings, profileCatalogReady, acpCatalogSnapshot, enabledAgentIds, defaultBackend,
        backendTarget, inheritedModelSelection, inheritedTeamCredentialModel, resolveInheritedModelLabel, inheritedRoutePresentation, inheritedConnectedServicesSelection, machineId, machineReachable, startAction, executeAction } = useExecutionRunLaunchContext(props.sessionId, serverId, props.workspace);
    const [mountedComposerRef, setMountedComposerRef] = React.useState<Extract<ComposerRefV1, { kind: 'participantMessage' | 'newSession' }> | null>(null);
    const initialComposerFocusApplied = React.useRef(false);
    const sharedSavedSecretsEnabled = useFeatureEnabled('teams', {
        scopeKind: 'spawn',
        serverId,
    });
    const launchProfiles = useHomeAiLaunchProfiles(accountBinding?.scope ?? null);
    const sessionLaunchProfile = React.useMemo(
        () => resolveExecutionRunSessionLaunchProfile(session?.metadata, launchProfiles),
        [session?.metadata, launchProfiles],
    );
    const defaultSecretBindings = sessionLaunchProfile?.secretBindings ?? null;
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
    const detachedProtocol = props.sessionId === null ? readExecutionRunProtocolV2Support(
        'snapshot' in machineCapabilitiesState && machineCapabilitiesState.snapshot
            ? { supported: true, response: machineCapabilitiesState.snapshot.response }
            : { supported: false, reason: machineCapabilitiesState.status === 'not-supported' ? 'not-supported' : 'error' }, {
            detachedScope: true, startAndWait: false, exactInputResults: true, runScopedAgentBindings: false, secretReferenceOverlay: false,
        }) : null;
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
        machineId,
        serverId: serverId ?? null,
        enabled: Boolean(machineId),
        staleMs: 60_000,
    });
    // Which Agents the Machine really has; the New Session picker reads the same inventory.
    const machineAgents = useMachineAgents({ machineId, serverId, load: Boolean(machineId) });
    const browserContextRuntime = useSessionBrowserContextRuntimeContext();
    const [phase, setPhase] = React.useState<'idle' | 'starting' | 'reconciling' | 'unresolved'>('idle');
    const [error, setError] = React.useState<string | null>(null);
    const [secretOverlayState, setSecretOverlayState] = React.useState<ExecutionRunSecretReferenceOverlayState>({
        readiness: { ok: true },
    });
    const launcherDraftKey = executionRunLauncherDraftKey({
        intent,
        roleId: props.roleId,
        discussionCorrelationId: props.launchOrigin?.draftCorrelationId,
    });
    const launcherDraft = useExecutionRunLauncherDraft({
        lifetime: accountLifetime,
        sessionId: props.sessionId,
        draftKey: launcherDraftKey,
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
    const teamCredential = useExecutionRunTeamCredentialModel({
        sessionId: props.sessionId,
        serverId,
        machineId,
        selectedBackendChoice: options.selectedBackendChoice,
        hasBackendChoices: options.backendChoices.length > 0,
        actionInput,
        setActionInput,
        inheritedSelection: options.inheritedDraftTeamCredentialModel,
        onSelectionChange: () => setError(null),
    });
    const machine = useExecutionRunMachineName(session, serverId, props.workspace?.machineId);
    const childChoice = useExecutionRunChildChoice();
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
            ...actionInput,
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
            const result = await startAction(options.actionId, input, identity.correlationId);
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
                    setActionInput((previous) => ({ ...previous, [targetFieldPath]: refusedKeys }));
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
                throw new Error(resolveActionExecutionFailureMessage(result, t('common.requestFailed')) ?? t('common.requestFailed'));
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
            });
            if (notStarted.length > 0) {
                Modal.alert(
                    t('runPage.review.reviewersNotStarted', { count: notStarted.length }),
                    notStarted.map((reviewer) => t('runPage.review.reviewerNotStarted', { reviewer })).join('\n'),
                );
            }
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
    }, [accountLifetime, childChoice.begin, childChoice.offer, startAction, identity.correlationId, actionInput, options.actionId, options.actionSpec, options.backendChoices, options.fields, props.onRunStarted, props.sessionId, secretOverlayState.overlay, secretOverlayState.readiness.ok, teamCredential.available]);

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
                    intent: 'delegate',
                    ...startOptions.options,
                    ...(intentTitle ? { display: { title: intentTitle } } : {}),
                    retentionPolicy: 'resumable',
                    runClass: 'long_lived',
                    ioMode: 'streaming',
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
                if (!machineId) throw new Error(t('common.unavailable'));
                const sent = await executeAction('execution.run.send', { sessionId: null, runId,
                    message: selectionContext ? `${selectionContext}\n\n${submission.text}` : submission.text,
                    localInputId: identity.inputLocalId }, { executionRunTargetMachineId: machineId,
                    externalActionTarget: { kind: 'machine', machineId } });
                if (!sent.ok) throw new Error(resolveActionExecutionFailureMessage(sent, t('errors.failedToSendMessage')) ?? t('errors.failedToSendMessage'));
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
    }, [accountLifetime, actionInput, childChoice.begin, childChoice.offer, startAction, executeAction, machineId, findCorrelatedRun, identity, notifyRunStarted, options.selectedBackendChoice, props.launchOrigin, props.sessionId, secretOverlayState.overlay, secretOverlayState.readiness.ok, selectionContext, serverId, teamCredential.available]);

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
        // A role on its own Agent moves who answers there, so the chips say what the run will do.
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

    // Who answers: the one engine popover, led by the Roles rail (lab `convo-S2`), when one Agent
    // takes the start. A review asks for several at once, so its reviewers and role are chips instead.
    const selectedChoice = options.selectedBackendChoice;
    // While the Machine has not said what it can run, the Agent chip still names the Session's own
    // Agent instead of vanishing; its popover lists the same choices, unavailable until it answers.
    const engineChoice = selectedChoice ?? (executionRunsBackends == null ? options.initialBackendChoice : null);
    const draftModelSelection = React.useMemo(() => {
        const parsed = ProviderBoundModelRefSchema.safeParse(actionInput.modelSelection);
        return parsed.success ? parsed.data : null;
    }, [actionInput.modelSelection]);
    // The Roles row makes the popover a detailed one, where a row commits only through its own
    // `onSelectImmediate` (as every other detailed picker's rows do); a plain row would just take focus.
    // The rail draws one heading per group in first-seen order: Agents the Machine has, then the rest.
    const engineOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => [
        ...options.backendChoices.filter((choice) => !choice.unavailable),
        ...options.backendChoices.filter((choice) => choice.unavailable === 'notOnMachine'),
        ...options.backendChoices.filter((choice) => choice.unavailable === 'cantRun'),
    ].map((choice) => ({
        id: choice.targetKey,
        label: choice.title,
        icon: <ExecutionRunAgentMark agentId={choice.agentId} size={12} />,
        ...(choice.disabled ? { muted: true } : {}),
        ...(choice.unavailable === 'notOnMachine'
            ? { sectionId: 'notOnMachine', sectionLabel: t('machineAgents.notOnMachineYet', { machine: machine.name }) }
            : choice.unavailable === 'cantRun'
                ? { sectionId: 'cantRun', sectionLabel: t('machineAgents.cantRunOn', { machine: machine.name }) }
                : {}),
        onSelectImmediate: () => selectBackend(choice.targetKey),
        closeOnSelectImmediate: false,
        ...(!choice.disabled ? {
            renderDetailContent: () => <ExecutionRunAgentModelPicker
                choice={choice}
                sessionId={props.sessionId}
                machineId={machineId}
                serverId={serverId}
                actionInput={actionInput}
                selected={[draftModelSelection, options.inheritedDraftSelection].find(ref => ref
                    && choiceRunsAgent(choice, ref.agentTargetKey)) ?? null}
                inheritedTeamCredentialModel={options.inheritedDraftTeamCredentialModel
                    && choiceRunsAgent(choice, options.inheritedDraftTeamCredentialModel.agentTargetKey)
                    ? options.inheritedDraftTeamCredentialModel : null}
                selectBackend={selectBackend}
                setActionInput={setActionInput}
            />,
        } : {}),
    })), [actionInput, draftModelSelection, machine.name, machineId, options.backendChoices, options.inheritedDraftSelection, options.inheritedDraftTeamCredentialModel, props.sessionId, selectBackend, serverId, setActionInput]);
    const roleName = chosenRoleId ? roleItem?.name ?? (rolesStatus === 'loading' ? null : chosenRoleId) : null;
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
    const engine = React.useMemo<ParticipantComposerEngine | null>(() => (
        intent !== 'review' && engineChoice && engineOptions.length > 0
            ? {
                agentType: engineChoice.agentId,
                label: roleName ?? engineChoice.title,
                ...(!roleName && (draftModelSelection || options.inheritedDraftSelection || teamCredential.selected)
                    ? { modelLabel: exactModelPresentation.subtitle } : {}),
                title: t('agentStart.chips.engineTitle'),
                options: [rolesRail, ...engineOptions],
                selectedOptionId: engineChoice.targetKey,
                onSelect: (optionId: string) => {
                    if (optionId === ROLES_RAIL_PICKER_OPTION_ID) return;
                    selectBackend(optionId);
                },
            }
            : null
    ), [draftModelSelection, engineChoice, engineOptions, exactModelPresentation.subtitle, intent, options.inheritedDraftSelection, roleName, rolesRail, selectBackend, teamCredential.selected]);

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

    const startChips = React.useMemo<ReadonlyArray<AgentInputExtraActionChip>>(() => {
        const chips: AgentInputExtraActionChip[] = [];
        const disabled = !editable;
        if (intent === 'review') {
            // Lab convo-S1 "Reviewer ▾": the review's role, from the same Roles rail.
            chips.push(createExecutionRunStartContentChip({
                key: 'execution-run-start-role', controlId: 'workflowRoles',
                icon: 'users',
                label: roleItem?.name ?? (rolesStatus === 'loading' ? t('common.loading') : roleValue ?? t('roles.rail.title')),
                title: t('roles.rail.title'),
                testID: 'execution-run-start-role-chip',
                disabled,
                revision: `${chipRevision}:${roleValue ?? ''}:${roleItem?.name ?? ''}:${rolesStatus}`,
                renderContent: ({ requestClose }) => rolesRail.renderDetailContent?.({ onRequestClose: requestClose }) ?? null,
            }));
            // Lab convo-S1: one removable chip per chosen reviewer, then "+" for the reviewer tiles.
            for (const targetKey of options.selectedBackendTargetKeys) {
                const choice = options.backendChoices.find((candidate) => candidate.targetKey === targetKey);
                if (!choice) continue;
                chips.push(createExecutionRunReviewerChip({
                    targetKey,
                    label: choice.title,
                    mark: <ExecutionRunAgentMark agentId={choice.agentId} size={12} />,
                    disabled,
                    onRemove: () => {
                        setError(null);
                        onSelectBackend(targetKey);
                    },
                }));
            }
            // The chip that needs a choice says so: with no reviewer Send cannot start anything, and
            // the missing reviewer reads here rather than as a dead Send.
            chips.push(createExecutionRunStartContentChip({
                key: 'execution-run-start-reviewers-add', controlId: 'reviewComments',
                icon: 'plus',
                label: options.targetRequirement ? t('agentStart.chips.reviewerNeeded') : t('agentStart.chips.reviewer'),
                requirement: options.targetRequirement,
                title: t('agentStart.chips.addReviewer'),
                testID: 'execution-run-start-reviewers-add-chip',
                disabled,
                revision: chipRevision,
                renderContent: () => renderOptions(['backends']),
            }));
        }
        if (options.visiblePermissionModeOptions.length > 1) {
            const selected = options.visiblePermissionModeOptions.find((option) => option.value === options.selectedPermissionMode);
            chips.push(createExecutionRunStartContentChip({
                ...getExecutionRunStartChipDefinition('permissions'), pending: true,
                icon: 'shield',
                label: selected?.label ?? t('executionRuns.newRun.sections.permissions'),
                title: t('executionRuns.newRun.sections.permissions'),
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
                title: t('agentInput.model.title'),
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
        const scopeField = intent === 'review' ? options.fields.find((field) => field.path === 'changeType') : undefined;
        if (scopeField) {
            const changeType = actionInput.changeType;
            const scopeLabel = scopeField.options?.find((option) => option.value === changeType)?.label
                ?? t('agentStart.chips.scope');
            chips.push(createExecutionRunStartContentChip({
                ...getExecutionRunStartChipDefinition('scope'), pending: true,
                icon: 'git-diff',
                label: scopeLabel,
                title: t('agentStart.chips.scope'),
                testID: 'execution-run-start-scope-chip',
                disabled,
                revision: chipRevision,
                renderContent: () => renderOptions(['fields'], isReviewScopeFieldPath),
            }));
        }
        if (props.sessionId !== null) chips.push(createExecutionRunReportChip({
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
                icon: 'sliders-horizontal',
                label: t('agentStart.chips.advanced'),
                title: t('agentStart.chips.advanced'),
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
    }, [props.sessionId, actionInput.changeType, chipRevision, editable, routeChoice, routeFollowed, routeInFoot, intent, onPatch, onSelectBackend, roleItem?.name, roleValue, rolesRail, rolesStatus, options.backendChoices, options.fields, options.profileChoices.length, options.selectedBackendTargetKeys, options.selectedPermissionMode, options.targetMatchesParent, options.targetRequirement, options.visiblePermissionModeOptions, renderOptions, reportToSession, teamCredential.picker, exactModelSubtitle, exactModelPresentation.accessibilityLabel, demandRouteModel, chooseDraftModel]);

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
    const reviewFolder = leafFolderName(props.workspace?.cwd ?? (session ? readSessionOwnerMetadataView(session)?.path : null))
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

    return (
        <View style={[styles.root, props.placement === 'center' ? styles.rootCentered : null]}>
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
            ) : (
                <View testID="execution-run-start-lead" style={styles.lead}>
                    {leadAgentIds.length > 0 ? (
                        <View style={styles.marks}>
                            {leadAgentIds.slice(0, 3).map((agentId) => (
                                <ExecutionRunAgentMark key={agentId} agentId={agentId} size={28} />
                            ))}
                        </View>
                    ) : null}
                    <Text accessibilityRole="header" style={styles.title}>
                        {props.heading ?? (intent ? t(`runPage.launcher.titles.${intent}` as const) : t('agentStart.titles.conversation'))}
                    </Text>
                    <Text style={styles.description}>
                        {intent === 'review'
                            ? t('runPage.launcher.descriptions.review', { folder: reviewFolder })
                            : intent
                            ? t(`runPage.launcher.descriptions.${intent}` as const, { machine: machine.name })
                            : t('agentStart.descriptions.conversation', { machine: machine.name })}
                    </Text>
                </View>
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
                <View style={styles.question}>
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
            <SessionParticipantComposer
                // The draft identity rotates as a live prop. Keying on it would remount the
                // composer and discard the text, references and staged attachments the
                // person authored but has not sent anywhere.
                key={JSON.stringify([serverId, accountBinding?.accountId, props.sessionId, launcherDraftKey])}
                sessionId={props.sessionId}
                workspace={props.workspace}
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
                engine={engine}
                extraActionChips={startChips}
            />
            <Text testID="execution-run-start-foot" style={styles.foot}>
                {routeInFoot && routeChoice ? `${routeChoice.label} \u00B7 ${startsWhenYouSend}` : startsWhenYouSend}
            </Text>
            <ExecutionRunSecretReferenceOverlayField
                profile={sessionLaunchProfile}
                machineId={machineId}
                serverId={serverId}
                accountScope={accountBinding?.scope ?? null}
                defaultBindings={defaultSecretBindings}
                personalSecrets={settings.secrets}
                sharedEnabled={sharedSavedSecretsEnabled}
                editable={editable}
                onChange={setSecretOverlayState}
            />
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
                <Pressable
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
                        minWidth: interactiveTargetSize,
                        minHeight: interactiveTargetSize,
                        justifyContent: 'center',
                        paddingVertical: theme.space.s8,
                        paddingHorizontal: theme.space.s10,
                        borderRadius: 10,
                        backgroundColor: theme.colors.surface.inset,
                        opacity: pressed ? motionTokens.press.opacity : 1,
                    })}
                >
                    <Text style={{ color: theme.colors.text.primary }}>{t('sessionDrafts.startAnother')}</Text>
                </Pressable>
            ) : null}
        </View>
    );
});

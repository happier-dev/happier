import {
    readExecutionRunStartRunCreation,
    resolveExecutionRunImplicitRoleIdV1,
    resolveExecutionRunNotifyParentDefaultV1,
    type SessionDiscussionSelectionSourceV1,
} from '@happier-dev/protocol';
import * as React from 'react';
import { useHomeAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildRolesRailPickerOption, ROLES_RAIL_PICKER_OPTION_ID } from '@/components/roles/rail/buildRolesRailPickerOption';
import type { RoleRailItem } from '@/components/roles/rail/rolesRailTypes';
import { useRoleRailItems } from '@/components/roles/rail/useRoleRailItems';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { createRepositoryComposerDocumentOwner } from '@/components/sessions/composer/repositoryComposerDocumentOwner';
import {
    promoteAcceptedComposerDocument,
    type ComposerDraftFieldCurrentness,
    type MutableComposerDocumentOwner,
} from '@/components/sessions/composer/composerDocumentOwner';
import {
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
    sessionExecutionRunStart,
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
    type ExecutionRunIntent,
} from './executionRunLauncherModel';
import { createExecutionRunReportChip, createExecutionRunReviewerChip, createExecutionRunStartContentChip } from './executionRunStartChips';
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

type DraftIdentity = Readonly<{ correlationId: string; inputLocalId: string }>;

function createDraftIdentity(): DraftIdentity {
    return { correlationId: randomUUID(), inputLocalId: randomUUID() };
}

export type ExecutionRunStartedPresentation = Readonly<{
    /** The Run's intent in the person's words — what its tab and header are titled by. */
    title: string | null;
}>;

const UNAVAILABLE_REASON_KEYS = {
    notEnabled: 'sessionAgentActivity.roster.unavailable.notEnabled',
    sessionInactive: 'sessionAgentActivity.roster.unavailable.sessionInactive',
    externalRunnerInactive: 'sessionAgentActivity.roster.unavailable.externalRunnerInactive',
} as const;

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
    lead: {
        gap: 6,
        paddingHorizontal: 4,
    },
    marks: {
        flexDirection: 'row',
        gap: 6,
    },
    title: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 20,
        lineHeight: 26,
    },
    description: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
    },
    foot: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
        textAlign: 'right',
        paddingHorizontal: 4,
    },
}));

export const SessionInteractiveExecutionRunDraftView = React.memo((props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    onRunStarted: (
        runId: string,
        recovery?: Readonly<{ retryInputLocalId: string }>,
        presentation?: ExecutionRunStartedPresentation,
    ) => void;
    /**
     * Host-provided text. Without a `launchOrigin` it seeds the composer. With a Discussion
     * `launchOrigin` it is the selected messages: shown as the draft's context (never as text the
     * person writes their question around) and sent to the agent ahead of the prompt.
     */
    initialText?: string;
    launchOrigin?: SessionDiscussionSelectionSourceV1 & Readonly<{ draftCorrelationId: string }>;
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
        sessionId: props.sessionId,
    });
    const serverId = preferredServerId;
    const { session, accountBinding, accountLifetime, exactSettings, settings, enabledAgentIds, defaultBackend,
        backendTarget, machineId, admitExactTarget: admitTarget, startAction } = useExecutionRunLaunchContext(props.sessionId, serverId);
    const [mountedComposerRef, setMountedComposerRef] = React.useState<Extract<ComposerRefV1, { kind: 'participantMessage' }> | null>(null);
    React.useEffect(() => {
        if (!props.autoFocusComposer || !mountedComposerRef) return;
        requestRegisteredComposerFocus(mountedComposerRef);
    }, [mountedComposerRef, props.autoFocusComposer]);
    const sharedSavedSecretsEnabled = useFeatureEnabled('teams', {
        scopeKind: 'spawn',
        serverId,
    });
    const launchProfiles = useHomeAiLaunchProfiles(settings.profiles, accountBinding?.scope ?? null);
    const sessionLaunchProfile = React.useMemo(
        () => resolveExecutionRunSessionLaunchProfile(settings, session?.metadata, launchProfiles),
        [session?.metadata, settings, launchProfiles],
    );
    const defaultSecretBindings = React.useMemo(() => sessionLaunchProfile
        ? { ...sessionLaunchProfile.secretBindings, ...settings.currentSecretBindingsByProfileId[sessionLaunchProfile.id] }
        : null, [sessionLaunchProfile, settings.currentSecretBindingsByProfileId]);
    const { canLaunchExecutionRuns, launchUnavailableReason, executionRunsBackends } = useSessionExecutionRunLaunchability(
        props.sessionId,
        session,
        serverId,
    );
    const { state: machineCapabilitiesState } = useMachineCapabilitiesCache({
        machineId,
        enabled: Boolean(machineId),
        ...(serverId ? { serverId } : {}),
        request: { requests: [{ id: 'tool.executionRuns', params: { sessionId: props.sessionId } }] },
    });
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId,
        serverId: serverId ?? null,
        enabled: Boolean(machineId),
        staleMs: 60_000,
    });
    const browserContextRuntime = useSessionBrowserContextRuntimeContext();
    const [identity, setIdentity] = React.useState<DraftIdentity>(() => ({
        correlationId: props.launchOrigin?.draftCorrelationId ?? randomUUID(),
        inputLocalId: randomUUID(),
    }));
    const [phase, setPhase] = React.useState<'idle' | 'starting' | 'reconciling' | 'unresolved'>('idle');
    const [error, setError] = React.useState<string | null>(null);
    const [secretOverlayState, setSecretOverlayState] = React.useState<ExecutionRunSecretReferenceOverlayState>({
        readiness: { ok: true },
    });
    const [actionInput, setActionInput] = React.useState<Record<string, unknown>>(() => buildExecutionRunActionDraftInputForUi({
        actionId: resolveExecutionRunLauncherActionId(optionsIntent),
        sessionId: props.sessionId,
        // A review asks who reviews; it never silently picks the Session's own Agent.
        defaultBackendTarget: intent === 'review' ? null : backendTarget,
        defaultBackendId: defaultBackend?.defaultBackendId ?? null,
        instructions: '',
        // "Report to this session" starts at the one default owner: on for an ask, the Account's
        // preference for a side conversation. The chip's value is always sent explicitly.
        extra: {
            ...(props.roleId ? { roleId: props.roleId } : {}),
            notifyParentOnCompletion: resolveExecutionRunNotifyParentDefaultV1({
                runClass: intent ? 'bounded' : 'long_lived',
                accountDefault: settings.executionRunsNotifyParentOnCompletionDefault,
            }),
        },
    }));
    const options = useExecutionRunLauncherOptionsModel({
        sessionId: props.sessionId,
        intent: optionsIntent,
        actionInput,
        setActionInput,
        singleTarget: intent !== 'review',
        enabledAgentIds,
        executionRunsBackends,
        acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
        initialBackendTarget: backendTarget,
        fallbackAgentId: defaultBackend?.defaultAgentId ?? null,
        machineCapabilitiesState,
        mergedBackendProjectionById: daemonMergedProjection.inputs?.mergedBackendProjectionById ?? null,
        mergedProviderProjectionById: daemonMergedProjection.inputs?.mergedProviderProjectionById ?? null,
    });
    const teamCredential = useExecutionRunTeamCredentialModel({
        sessionId: props.sessionId,
        serverId,
        selectedBackendChoice: options.selectedBackendChoice,
        hasBackendChoices: options.backendChoices.length > 0,
        actionInput,
        setActionInput,
        onSelectionChange: () => setError(null),
    });
    const machine = useExecutionRunMachineName(session?.metadata ?? null);
    const runIdRef = React.useRef<string | null>(null);
    const notifiedRunIdRef = React.useRef<string | null>(null);
    const submitInFlightRef = React.useRef(false);
    const startedTitleRef = React.useRef<string | null>(null);
    const notifyRunStarted = React.useCallback((runId: string, recovery?: Readonly<{ retryInputLocalId: string }>) => {
        if (notifiedRunIdRef.current === runId) return;
        notifiedRunIdRef.current = runId;
        const presentation: ExecutionRunStartedPresentation = { title: startedTitleRef.current };
        props.onRunStarted(runId, recovery, presentation);
    }, [props.onRunStarted]);

    const findCorrelatedRun = React.useCallback(async (): Promise<string | null> => {
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
                ? launchOrigin.kind === 'session_discussion'
                    && launchOrigin.sessionId === props.launchOrigin.sessionId
                    && launchOrigin.discussionId === props.launchOrigin.discussionId
                    && launchOrigin.messageIds.length === props.launchOrigin.messageIds.length
                    && launchOrigin.messageIds.every((messageId, index) => messageId === props.launchOrigin?.messageIds[index])
                : launchOrigin.kind === 'session'
                    && launchOrigin.sessionId === props.sessionId;
        });
        return matches.length === 1 ? matches[0]!.runId : null;
    }, [identity.correlationId, props.launchOrigin, props.sessionId, serverId]);

    /**
     * The exact-target checks every start takes before it reaches the Home: a Saved Secret overlay
     * or a Team credential model is admitted by the exact daemon, and a stopped Session resumes.
     * Throws with the person-facing reason; nothing has been created when it does.
     */
    const admitExactTarget = React.useCallback((requires: Parameters<typeof admitTarget>[0]) => (
        admitTarget(requires, identity.correlationId)
    ), [admitTarget, identity.correlationId]);

    /**
     * A review, plan or delegated task: the first message is its instructions, started through the
     * canonical Action (several reviewers fan out there). The captured message is accepted only once
     * the Action returns a Run; a refusal leaves the draft as it was.
     */
    const submitBoundedStart = React.useCallback(async (
        boundedIntent: ExecutionRunIntent,
        submission: ParticipantComposerPreparedSubmission,
    ) => {
        if (submitInFlightRef.current) throw new Error(t('common.loading'));
        const input: Record<string, unknown> = {
            ...actionInput,
            instructions: submission.text,
            ...(secretOverlayState.overlay ? { secretReferenceOverlay: secretOverlayState.overlay } : {}),
        };
        const validationError = resolveActionInputValidationError({
            sessionId: props.sessionId,
            input,
            spec: options.actionSpec as never,
            fields: options.fields as never,
        });
        if (validationError) {
            setError(validationError);
            throw new Error(validationError);
        }
        if (!accountLifetime?.isCurrent() || !secretOverlayState.readiness.ok || !teamCredential.available) {
            throw new Error(t('common.unavailable'));
        }
        submitInFlightRef.current = true;
        setError(null);
        setPhase('starting');
        try {
            const result = await startAction(options.actionId, input, identity.correlationId);
            const output = result.ok && result.result && typeof result.result === 'object'
                ? result.result as { results?: readonly { key?: unknown; ok?: boolean; result?: { runId?: unknown } }[] }
                : null;
            // Several reviewers start as one group (`display.groupId`); its pane shows them all, so
            // any member that started opens it, and the start is accepted. Members that didn't
            // start are said out loud, not dropped; only a start where none did is refused.
            const runId = output?.results?.find((item) => item.ok === true)?.result?.runId;
            if (typeof runId !== 'string' || !runId.trim()) {
                throw new Error(resolveActionExecutionFailureMessage(result, t('common.requestFailed')) ?? t('common.requestFailed'));
            }
            const notStarted = (output?.results ?? []).filter((item) => item.ok !== true).map((item) => {
                const key = typeof item.key === 'string' ? item.key : '';
                return options.backendChoices.find((choice) => choice.targetKey === key)?.title ?? key;
            });
            submission.onOutboundHandoff();
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
            const failureLabelKey = getSessionInputFailureLabelKey(cause);
            setError(failureLabelKey
                ? t(failureLabelKey)
                : cause instanceof Error ? cause.message : t('common.requestFailed'));
            throw cause;
        } finally {
            submitInFlightRef.current = false;
        }
    }, [accountLifetime, startAction, identity.correlationId, actionInput, options.actionId, options.actionSpec, options.backendChoices, options.fields, props.onRunStarted, props.sessionId, secretOverlayState.overlay, secretOverlayState.readiness.ok, teamCredential.available]);

    const submitConversationStart = React.useCallback(async (submission: ParticipantComposerPreparedSubmission) => {
        if (submitInFlightRef.current) {
            throw new Error(t('common.loading'));
        }
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
        setError(null);
        setPhase('starting');
        let handedOff = false;
        let startIssued = false;
        let runDraftPromotion: Readonly<{
            owner: MutableComposerDocumentOwner;
            acceptedCurrentness: ComposerDraftFieldCurrentness;
        }> | null = null;
        try {
            await admitExactTarget({
                secretReferenceOverlay: startOptions.options.secretReferenceOverlay !== undefined,
                teamCredentialModel: startOptions.options.teamCredentialModel !== undefined,
                roleBinding: startOptions.options.roleId !== undefined,
            });
            let runId = runIdRef.current;
            if (!runId) {
                startIssued = true;
                const intentTitle = resolveExecutionRunIntentTitle(submission.displayText ?? submission.text);
                startedTitleRef.current = intentTitle;
                const started = await sessionExecutionRunStart(props.sessionId, {
                    intent: 'delegate',
                    ...startOptions.options,
                    ...(intentTitle ? { display: { title: intentTitle } } : {}),
                    retentionPolicy: 'resumable',
                    runClass: 'long_lived',
                    ioMode: 'streaming',
                    // Each attempt carries its own correlation so a lost response can be
                    // reconciled; a Discussion launch keeps its selection provenance.
                    launchOrigin: props.launchOrigin
                        ? { ...props.launchOrigin, draftCorrelationId: identity.correlationId }
                        : {
                            kind: 'session',
                            sessionId: props.sessionId,
                            draftCorrelationId: identity.correlationId,
                        },
                }, {
                    ...(serverId ? { serverId } : {}),
                    ...(machineId ? { expectedMachineId: machineId } : {}),
                });
                if ('runId' in started) {
                    runId = started.runId;
                } else if (readExecutionRunStartRunCreation(started.details) !== 'noRunCreated') {
                    runId = await findCorrelatedRun();
                }
                if (!runId) {
                    const knownNoRun = !('runId' in started)
                        && readExecutionRunStartRunCreation(started.details) === 'noRunCreated';
                    setPhase(knownNoRun ? 'idle' : 'unresolved');
                    // An unknown outcome is not a failure: the Run may already exist, so the copy
                    // says so and warns that another Start may create a second conversation.
                    const message = knownNoRun ? started.error : t('sessionDrafts.executionRunStart.unresolved');
                    setError(message);
                    throw new Error(message);
                }
                runIdRef.current = runId;
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
                notifyRunStarted(runIdRef.current, handedOff ? undefined : { retryInputLocalId: identity.inputLocalId });
                setPhase('idle');
            } else if (!startIssued) {
                // The refusal happened before any start reached the Home, so nothing can
                // exist to reconcile and the draft stays editable. Only a start that was
                // actually issued keeps the unresolved recovery the try block chose.
                setPhase('idle');
            }
            const failureLabelKey = getSessionInputFailureLabelKey(cause);
            const message = failureLabelKey
                ? t(failureLabelKey)
                : cause instanceof Error ? cause.message : t('errors.failedToSendMessage');
            setError(message);
            throw cause;
        } finally {
            submitInFlightRef.current = false;
        }
    }, [accountLifetime, actionInput, admitExactTarget, findCorrelatedRun, identity, machineId, notifyRunStarted, options.selectedBackendChoice, props.launchOrigin, props.sessionId, secretOverlayState.overlay, secretOverlayState.readiness.ok, selectionContext, serverId, teamCredential.available]);

    const submitPreparedMessage = React.useCallback(
        (submission: ParticipantComposerPreparedSubmission) => (intent
            ? submitBoundedStart(intent, submission)
            : submitConversationStart(submission)),
        [intent, submitBoundedStart, submitConversationStart],
    );

    const editable = phase === 'idle';
    const hasTarget = intent === 'review'
        ? options.selectedBackendTargetKeys.length > 0
        : options.selectedBackendChoice !== null;
    const unavailable = exactSettings === null
        || !session
        || canLaunchExecutionRuns !== true
        || !hasTarget
        || !secretOverlayState.readiness.ok
        || !teamCredential.available
        || (options.selectedProfileId !== '' && (
            options.selectedProfileChoice?.disabled !== false || !options.selectedProfileMatchesSelectedBackend
        ));

    // The role this start runs (lab `convo-S1/S2`): the one chosen here, else the role the run-start
    // owner gives its intent (a review is the Reviewer's). Only a chosen role travels as `roleId`; the
    // target Session's admission resolves it and stamps its engine.
    const router = useRouter();
    const roles = useRoleRailItems();
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
    const engineOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => options.backendChoices.map((choice) => ({
        id: choice.targetKey,
        label: choice.title,
        icon: <ExecutionRunAgentMark agentId={choice.agentId} size={12} />,
        ...(choice.disabled ? { muted: true } : {}),
    })), [options.backendChoices]);
    const roleName = chosenRoleId ? roleItem?.name ?? chosenRoleId : null;
    const engine = React.useMemo<ParticipantComposerEngine | null>(() => (
        intent !== 'review' && selectedChoice && engineOptions.length > 0
            ? {
                agentType: selectedChoice.agentId,
                // The chip names the role it runs ("Planner"), else who answers.
                label: roleName ?? selectedChoice.title,
                title: t('agentStart.chips.engineTitle'),
                options: [rolesRail, ...engineOptions],
                selectedOptionId: selectedChoice.targetKey,
                onSelect: (optionId: string) => {
                    // The rail chooses through its own detail; its row is not an Agent.
                    if (optionId === ROLES_RAIL_PICKER_OPTION_ID) return;
                    selectBackend(optionId);
                },
            }
            : null
    ), [engineOptions, intent, roleName, rolesRail, selectBackend, selectedChoice]);

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
    ), [actionInput, editable, intent, options, selectBackend]);

    const startChips = React.useMemo<ReadonlyArray<AgentInputExtraActionChip>>(() => {
        const chips: AgentInputExtraActionChip[] = [];
        const disabled = !editable;
        if (intent === 'review') {
            // Lab convo-S1 "Reviewer ▾": the review's role, from the same Roles rail.
            chips.push(createExecutionRunStartContentChip({
                key: 'execution-run-start-role',
                icon: 'users',
                label: roleItem?.name ?? roleValue ?? t('roles.rail.title'),
                title: t('roles.rail.title'),
                testID: 'execution-run-start-role-chip',
                disabled,
                revision: `${chipRevision}:${roleValue ?? ''}:${roleItem?.name ?? ''}`,
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
            chips.push(createExecutionRunStartContentChip({
                key: 'execution-run-start-reviewers-add',
                icon: 'plus',
                label: t('agentStart.chips.addReviewer'),
                title: t('agentStart.chips.addReviewer'),
                testID: 'execution-run-start-reviewers-add-chip',
                iconOnly: true,
                disabled,
                revision: chipRevision,
                renderContent: () => renderOptions(['backends']),
            }));
        }
        if (options.visiblePermissionModeOptions.length > 1) {
            const selected = options.visiblePermissionModeOptions.find((option) => option.value === options.selectedPermissionMode);
            chips.push(createExecutionRunStartContentChip({
                key: 'execution-run-start-permissions',
                icon: 'shield',
                label: selected?.label ?? t('executionRuns.newRun.sections.permissions'),
                title: t('executionRuns.newRun.sections.permissions'),
                testID: 'execution-run-start-permissions-chip',
                disabled,
                revision: chipRevision,
                renderContent: () => renderOptions(['permissions']),
            }));
        }
        const scopeField = intent === 'review' ? options.fields.find((field) => field.path === 'changeType') : undefined;
        if (scopeField) {
            const changeType = actionInput.changeType;
            const scopeLabel = scopeField.options?.find((option) => option.value === changeType)?.label
                ?? t('agentStart.chips.scope');
            chips.push(createExecutionRunStartContentChip({
                key: 'execution-run-start-scope',
                icon: 'git-diff',
                label: scopeLabel,
                title: t('agentStart.chips.scope'),
                testID: 'execution-run-start-scope-chip',
                disabled,
                revision: chipRevision,
                renderContent: () => renderOptions(['fields'], isReviewScopeFieldPath),
            }));
        }
        chips.push(createExecutionRunReportChip({
            value: reportToSession,
            disabled,
            onChange: (next) => onPatch({ notifyParentOnCompletion: next }),
        }));
        const isAdvancedFieldPath = (path: string) => path !== 'permissionMode' && !isReviewScopeFieldPath(path);
        const hasAdvancedFields = options.fields.some((field) => field.visible !== false && isAdvancedFieldPath(field.path)
            && !['backendTargetKeys', 'engineIds', 'instructions', 'notifyParentOnCompletion', 'secretReferenceOverlay', 'teamCredentialModel', 'teamCredentialSessionBindingConsent'].includes(field.path));
        if (options.profileChoices.length > 0 || hasAdvancedFields || teamCredential.picker) {
            chips.push(createExecutionRunStartContentChip({
                key: 'execution-run-start-advanced',
                icon: 'sliders-horizontal',
                label: t('agentStart.chips.advanced'),
                title: t('agentStart.chips.advanced'),
                testID: 'execution-run-start-advanced-chip',
                disabled,
                revision: chipRevision,
                renderContent: () => (
                    <View style={{ gap: 16 }}>
                        {renderOptions(['profiles', 'fields'], isAdvancedFieldPath)}
                        {teamCredential.picker}
                    </View>
                ),
            }));
        }
        return chips;
    }, [actionInput.changeType, chipRevision, editable, intent, onPatch, onSelectBackend, roleItem?.name, roleValue, rolesRail, options.backendChoices, options.fields, options.profileChoices.length, options.selectedBackendTargetKeys, options.selectedPermissionMode, options.visiblePermissionModeOptions, renderOptions, reportToSession, teamCredential.picker]);

    // Why it can't start yet, said above the kept draft (lab `convo-ST` "Machine offline"): still
    // reading what the machine offers, or the reason agents can't start in this Session.
    const checkingCapabilities = launchUnavailableReason === null
        && canLaunchExecutionRuns !== true
        && !(executionRunsBackends && Object.keys(executionRunsBackends).length > 0)
        && (machineCapabilitiesState.status === 'idle' || machineCapabilitiesState.status === 'loading');
    const blockedReason = launchUnavailableReason === 'machineOffline'
        ? t('agentStart.offline', { machine: machine.name })
        : launchUnavailableReason !== null
            ? t(UNAVAILABLE_REASON_KEYS[launchUnavailableReason])
            : checkingCapabilities
                ? t('runPage.launcher.checking')
                : canLaunchExecutionRuns !== true
                    ? t('runPage.launcher.unavailableReason')
                    : null;
    const leadAgentIds = intent === 'review'
        ? options.backendChoices.filter((choice) => options.selectedBackendTargetKeys.includes(choice.targetKey)).map((choice) => choice.agentId)
        : selectedChoice ? [selectedChoice.agentId] : [];
    const startCount = intent === 'review' ? Math.max(1, options.selectedBackendTargetKeys.length) : 1;

    return (
        <View style={{ flex: 1, gap: 12, justifyContent: 'flex-end' }}>
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
                        {intent ? t(`runPage.launcher.titles.${intent}` as const) : t('agentStart.titles.conversation')}
                    </Text>
                    <Text style={styles.description}>
                        {intent
                            ? t(`runPage.launcher.descriptions.${intent}` as const, { machine: machine.name })
                            : t('agentStart.descriptions.conversation', { machine: machine.name })}
                    </Text>
                </View>
            )}
            {blockedReason ? (
                <SurfaceStateCard
                    testID="execution-run-start-blocked"
                    size="line"
                    kind={checkingCapabilities ? 'loading' : launchUnavailableReason === 'machineOffline' ? 'warning' : 'denied'}
                    title={blockedReason}
                />
            ) : null}
            <SessionParticipantComposer
                // The draft identity rotates as a live prop. Keying on it would remount the
                // composer and discard the text, references and staged attachments the
                // person authored but has not sent anywhere.
                key={JSON.stringify([serverId, props.sessionId])}
                sessionId={props.sessionId}
                serverId={serverId}
                canSendMessages={!unavailable && editable}
                recipient={null}
                browserContextState={browserContextRuntime?.composerContext.state ?? null}
                initialText={composerInitialText}
                initialLocalId={identity.inputLocalId}
                draftOccurrenceId={identity.inputLocalId}
                onComposerRefAvailable={setMountedComposerRef}
                submitPreparedMessage={submitPreparedMessage}
                engine={engine}
                extraActionChips={startChips}
            />
            <Text testID="execution-run-start-foot" style={styles.foot}>
                {t('agentStart.startsWhenYouSend', { count: startCount })}
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
                        paddingVertical: 8,
                        paddingHorizontal: 10,
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

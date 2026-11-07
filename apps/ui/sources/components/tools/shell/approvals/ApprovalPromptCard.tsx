import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from 'react';
import { View } from 'react-native';
import type { ApprovalRequest, ApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { describeApprovalRequestFields } from '@happier-dev/protocol/actions';
import { StyleSheet } from 'react-native-unistyles';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { readConfidentialFillSettlement, resolveConfidentialFillOutcome, resolveConfidentialSubmitOutcome } from '@/components/approvals/confidentialSecretApprovalModel';
import { t } from '@/text';
import { Modal } from '@/modal';
import { buildPermissionToolCallRoute, canOpenPermissionToolCallRoute } from '@/utils/sessions/permissions/buildPermissionToolCallRoute';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { ApprovalDecisionFooter } from './ApprovalDecisionFooter';
import { ApprovalPromptChrome } from './ApprovalPromptChrome';
import { ApprovalOpenButton } from './ApprovalOpenButton';
import { BrowserOpenApprovalProgress } from '@/components/approvals/BrowserOpenOperationStatus';
import { readBrowserOpenAcceptance } from '@/sync/domains/browser/firstUse/browserFirstUse';
import { alertApprovalFailure, isApprovalReplayRouteUnavailable, useApprovalDecisionHandler, useApprovalHome } from './useApprovalDecisionHandler';
import { ServiceOutputDisclosure } from '@/components/sessions/localServices/ServiceOutputDisclosure';
import { presentApprovalFailureOutcome, resolveApprovalActionTitle } from './approvalFailureOutcome';
import { useFailedApprovalDismissal } from './failedApprovalDismissal';
import { ActionApprovalFieldsCard, ApprovalTechnicalDetails } from '@/components/approvals/ActionApprovalFieldsCard';
import { DiscussionDraftAnswer, readDiscussionDraftApproval } from '@/components/approvals/discussionDraftApproval';
import { PromptDocApprovalDiff } from '@/components/approvals/PromptDocApprovalDiff';
import { ArtifactEditProposalReview } from '@/components/artifacts/ArtifactEditProposal';
import { ComputerActionApprovalCard, readComputerActLine } from '@/components/approvals/ComputerActionApprovalCard';
import { ComputerApprovalCapture } from '@/components/approvals/ComputerApprovalCapture';
import {
    ProjectCommandApprovalFacts,
    describeProjectCommandApprovalDecisions,
    readProjectCommandApproval,
    useProjectCommandApprovalTitle,
} from '@/components/approvals/ProjectCommandApprovalFacts';
import { useComputerApprovalChoice } from '@/components/approvals/useComputerApprovalChoice';
import { useEnvironmentBindingApprovalChoice } from '@/components/approvals/useEnvironmentBindingApprovalChoice';
import { useActionApprovalReview, readApprovalCannotRunReason } from '@/components/approvals/actionApprovalReview';
import { ResourceProposalBody, ResourceProposalModeChip } from '@/components/approvals/resourceProposal/ResourceProposalBody';
import { useResourceProposalApprovalMode } from '@/components/approvals/resourceProposal/useResourceProposalApprovalMode';
import { resolveResourceProposalLabels } from '@/components/approvals/resourceProposal/resourceProposalLabels';
import { useResourceProposalCheck } from '@/components/approvals/resourceProposal/useResourceProposalCheck';
import { CapabilityEnableApproval } from '@/components/sessions/capabilities/CapabilityEnableApproval';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import { useDeviceType } from '@/utils/platform/responsive';
import { ToolOutcomeStatus } from '../presentation/ToolOutcomeStatus';
import { formatApprovalStatusLabel } from '@/components/approvals/approvalStatusLabel';
import { useApprovalAccountLabel, useApprovalRequesterViewer } from '@/components/approvals/ApprovalRequesterConfirmationSection';
import { resolveUnknownAccountActorName } from '@/sync/domains/account/accountActorPresentation';
import { resolveApprovalVisualTranscriptOccurrence } from '@/components/approvals/approvalVisualTranscriptOccurrence';
import { SessionBoardItemReferenceOccurrence } from '@/components/sessions/transcript/references/SessionBoardActionResultReference';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { SavedSkillResult } from '@/components/tools/renderers/system/SavedSkillResult';
import { readApprovedSavedSkillResult } from '@/components/tools/renderers/system/savedSkillResultModel';


type ApprovalPromptCardArtifact = Pick<DecryptedArtifact, 'id' | 'header'>;
type ApprovalPromptCardProps<TApproval extends ApprovalRequest | TargetActionApprovalRequestV1> = Readonly<{
    artifact: ApprovalPromptCardArtifact;
    approval: TApproval;
    sessionId: string;
    metadata?: Metadata | null;
    location?: PermissionToolCallMessageLocation | null;
    canApprovePermissions?: boolean;
    canApprove?: boolean;
    disabledReason?: TranscriptPermissionDisabledReason;
    chrome?: 'card' | 'inline';
    /** A declined request's tool row defers its output here: it stays reachable in Technical details. */
    toolOutput?: string | null;
    /** Whether the transcript row currently demands its visual body (an approved Agent visual reads as that visual). */
    contentDemand?: boolean;
}>;

function isTargetActionApproval(
    approval: ApprovalRequest | TargetActionApprovalRequestV1,
): approval is TargetActionApprovalRequestV1 {
    return 'kind' in approval && approval.kind === 'plugin_target_action';
}

function useRequesterDecisionPresentation(
    approval: ApprovalRequest | TargetActionApprovalRequestV1,
    serverId: string | null,
): Readonly<{ withheld: boolean; waitingText: string | null }> {
    const subject: ApprovalRequesterConfirmationV1 | undefined = isTargetActionApproval(approval)
        ? approval.requesterConfirmation
        : approval.v === 2 ? approval.requesterConfirmation : undefined;
    const requesterMayDecide = useApprovalRequesterViewer(subject, serverId);
    const requester = useApprovalAccountLabel(
        serverId,
        subject?.requesterAccountId,
        'sentence',
    ) ?? resolveUnknownAccountActorName('sentence');
    return {
        withheld: Boolean(subject && !requesterMayDecide),
        waitingText: subject ? t('detailPages.approval.requester.thread.waiting', { name: requester }) : null,
    };
}

function getPreviewSummary(preview: unknown): string | null {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
    const summary = typeof (preview as { summary?: unknown }).summary === 'string'
        ? (preview as { summary: string }).summary.trim()
        : '';
    return summary || null;
}

function resolveDeferredComputerPicker() {
    return (require('../../../computer/openComputerTargetPickerForSession') as typeof import('../../../computer/openComputerTargetPickerForSession')).openComputerTargetPickerForSession;
}


function TargetActionApprovalPromptCard(props: ApprovalPromptCardProps<TargetActionApprovalRequestV1>) {
    const transcriptSource = useSessionTranscriptSource();
    const decide = useApprovalDecisionHandler(props.artifact, props.approval, props.sessionId, transcriptSource.serverId);
    const approvalHome = useApprovalHome(props.artifact, props.approval, props.sessionId, transcriptSource.serverId);
    const [isDeciding, setIsDeciding] = React.useState(false);
    const [recordedArtifactId, setRecordedArtifactId] = React.useState<string | null>(null);
    const decisionRecorded = recordedArtifactId === props.artifact.id;
    const sourceInteraction = transcriptSource.useInteraction();
    const requesterDecision = useRequesterDecisionPresentation(props.approval, approvalHome.serverId);
    const approvalDisabledReason = props.disabledReason === 'inactive' ? undefined : props.disabledReason;
    const presentationAllowsApproval = props.disabledReason === 'inactive'
        ? props.canApprove !== false
        : props.canApprovePermissions ?? props.canApprove ?? true;
    const canApprove = transcriptSource.actions !== null
        && presentationAllowsApproval
        && (sourceInteraction.canApproveActions ?? sourceInteraction.canApprovePermissions);
    const approvalRouteUnavailable = isApprovalReplayRouteUnavailable(props.approval);
    const accessDisabled = !canApprove || Boolean(approvalDisabledReason);
    const decisionDisabled = accessDisabled || approvalRouteUnavailable || requesterDecision.withheld;
    const actionFields = React.useMemo(() => describeApprovalRequestFields(props.approval), [props.approval]);
    const onDecision = React.useCallback(async (decision: 'approve' | 'reject') => {
        if (decisionDisabled || isDeciding) return;
        try {
            setIsDeciding(true);
            if (!await decide(decision, { onExecution: () => setRecordedArtifactId(props.artifact.id) })) {
                Modal.alert(t('common.error'), t('approvals.decisionError'));
            } else setRecordedArtifactId(props.artifact.id);
        } catch (error) {
            alertApprovalFailure(error);
        } finally {
            setIsDeciding(false);
        }
    }, [decisionDisabled, decide, isDeciding]);
    return (
        <ApprovalPromptChrome
            testID="approval-prompt-card"
            chrome={props.chrome ?? 'card'}
            title={props.approval.summary}
            subtitle={props.approval.qualifiedActionId}
            subtitleNumberOfLines={2}
            footer={props.approval.status === 'open' && !decisionRecorded ? (requesterDecision.withheld ? (
                <Text testID="approval-prompt-requester-waiting" style={styles.previewText}>
                    {requesterDecision.waitingText}
                </Text>
            ) : (
                <ApprovalDecisionFooter
                    disabled={accessDisabled}
                    decisionDisabled={approvalRouteUnavailable}
                    disabledReason={approvalDisabledReason}
                    isDeciding={isDeciding}
                    onApprove={() => { void onDecision('approve'); }}
                    onReject={() => { void onDecision('reject'); }}
                />
            )) : undefined}
        >
            {actionFields.rows.length > 0 ? (
                <ActionApprovalFieldsCard presentation={actionFields} serverId={approvalHome.serverId}
                    collapsed={(props.chrome ?? 'card') === 'inline' && props.approval.status === 'open'} />
            ) : null}
            {approvalRouteUnavailable ? (
                <Text style={styles.previewText}>{t('actionConfirmations.homeUnavailable')}</Text>
            ) : null}
        </ApprovalPromptChrome>
    );
}

const BuiltInApprovalPromptCard = React.memo(function BuiltInApprovalPromptCard(props: ApprovalPromptCardProps<ApprovalRequest>) {
    const transcriptSource = useSessionTranscriptSource();
    const decide = useApprovalDecisionHandler(props.artifact, props.approval, props.sessionId);
    const approvalHome = useApprovalHome(props.artifact, props.approval, props.sessionId);
    const [isDeciding, setIsDeciding] = React.useState(false);
    const [recordedArtifactId, setRecordedArtifactId] = React.useState<string | null>(null);
    const decisionRecorded = recordedArtifactId === props.artifact.id;
    const chrome = props.chrome ?? 'card';
    // On a phone the composer's inline prompt keeps its decision in view: the arguments wait behind Details.
    const phone = useDeviceType() === 'phone';
    const actionTitle = React.useMemo(() => resolveApprovalActionTitle(props.approval), [props.approval]);
    const previewSummary = React.useMemo(() => getPreviewSummary(props.approval.preview), [props.approval.preview]);
    const bindingChoice = useEnvironmentBindingApprovalChoice({ artifactId: props.artifact.id, approval: props.approval,
        serverId: transcriptSource.serverId ?? approvalHome.serverId });
    const reviewedBindingRequest = bindingChoice.reviewRequest ?? props.approval;
    const review = useActionApprovalReview(reviewedBindingRequest);
    // An agent's private Discussion draft reads as the answer it would post, as in the Discussion thread.
    const discussionDraft = React.useMemo(() => readDiscussionDraftApproval(props.approval), [props.approval]);
    const draftAnswer = props.approval.status === 'open' ? discussionDraft?.answer ?? null : null;
    const approveAdmission = review.admission;
    const executionFailure = React.useMemo(
        () => readApprovalExecutionFailure(props.approval),
        [props.approval],
    );
    const failureOutcome = React.useMemo(
        () => executionFailure ? presentApprovalFailureOutcome(props.approval, executionFailure) : null,
        [executionFailure, props.approval],
    );
    // A declined request keeps its review at its originating call: what was asked, and that the person said no.
    const declined = (props.approval.status === 'rejected' || props.approval.status === 'canceled') && executionFailure === null;
    const toolOutput = declined ? props.toolOutput?.trim() || undefined : undefined;
    const { dismiss: dismissFailure } = useFailedApprovalDismissal();
    const artifactId = props.artifact.id;
    const onDismissFailure = React.useCallback(() => dismissFailure(artifactId), [artifactId, dismissFailure]);
    const confidentialAction = review.confidentialAction;
    const confidentialApproval = review.confidential;
    // Declared secret inputs are chosen on the approval's own page, like a fill; plain Approve cannot answer them.
    const confidentialInputs = review.confidentialInputs;
    const secretPrompt = confidentialAction || confidentialInputs !== null;
    // A settled confidential fill reads as what was entered and what is still held for the person (lab `b-secret` F);
    // a refused one is a failure and says why through the failure outcome.
    const confidentialOutcome = React.useMemo(() => {
        if (!confidentialAction || props.approval.status !== 'executed' || failureOutcome) return null;
        const fill = readConfidentialFillSettlement(props.approval);
        if (!fill) return null;
        return joinHappierFacts(resolveConfidentialFillOutcome(fill).title,
            resolveConfidentialSubmitOutcome(fill, confidentialApproval?.request.submit?.label ?? null));
    }, [confidentialAction, confidentialApproval, failureOutcome, props.approval]);
    const actionFields = React.useMemo(() => confidentialAction ? null
        : approveAdmission?.presentation ?? describeApprovalRequestFields(reviewedBindingRequest), [confidentialAction, approveAdmission, reviewedBindingRequest]);
    // An agent's finite Project command reads as its exact command, target and identity (lab `s-agent` ADHOC).
    const projectCommand = React.useMemo(() => readProjectCommandApproval(props.approval), [props.approval]);
    const projectCommandTitle = useProjectCommandApprovalTitle(projectCommand);
    const projectCommandDecisions = projectCommand ? describeProjectCommandApprovalDecisions(projectCommand) : null;
    // An Agent's instructions edit reads as its diff against the current document (lab `b-work P`).
    const promptDocUpdate = review.promptDocUpdate;
    const docEditProposal = review.docEditProposal;
    const capabilityEnable = review.capabilityEnable;
    const sessionId = props.sessionId;
    const computerChoice = useComputerApprovalChoice({
        artifactId: props.artifact.id,
        actionId: String(props.approval.actionId),
        actionArgs: props.approval.actionArgs,
        approvedInput: props.approval.v === 2 && props.approval.status !== 'open' && props.approval.decision?.kind === 'approve'
            ? props.approval.decision.narrowedInput : undefined,
        preview: props.approval.preview,
        sessionId,
        serverId: transcriptSource.serverId,
        // Loaded on the press: the picker reads the Session and the store, which this card never does.
        resolveOpenPicker: resolveDeferredComputerPicker,
    });
    const computerAction = computerChoice.presentation;
    const chooseComputerTarget = computerChoice.chooseTarget;
    // An agent's cleanup or stop proposal is this approval's body (plan 60 AGW-6): check on view, pick some.
    const proposal = useResourceProposalCheck(props.approval, approvalHome.serverId, props.artifact.id);
    const proposalLabels = proposal ? resolveResourceProposalLabels(proposal) : null;
    const proposalMode = useResourceProposalApprovalMode(props.approval);
    const approvalWithheld = secretPrompt ? (confidentialAction && confidentialApproval === null) || transcriptSource.navigate === null
        : approveAdmission?.status === 'unavailable' || Boolean(proposal?.approveWithheld);
    // A request that can never run says so on the card (owner ruling C3); Deny stays to clear it.
    const cannotRun = readApprovalCannotRunReason(approveAdmission);
    const sourceInteraction = transcriptSource.useInteraction();
    const requesterDecision = useRequesterDecisionPresentation(props.approval, approvalHome.serverId);
    // Runtime permission prompts need a live process; artifact decisions use the
    // same access grant without that lifecycle restriction.
    const approvalDisabledReason = props.disabledReason === 'inactive' ? undefined : props.disabledReason;
    const presentationAllowsApproval = props.disabledReason === 'inactive'
        ? props.canApprove !== false
        : props.canApprovePermissions ?? props.canApprove ?? true;
    const canApprove = transcriptSource.actions !== null
        && presentationAllowsApproval
        && (sourceInteraction.canApproveActions ?? sourceInteraction.canApprovePermissions);
    const approvalRouteUnavailable = isApprovalReplayRouteUnavailable(props.approval);
    const accessDisabled = !canApprove || Boolean(approvalDisabledReason);
    const decisionDisabled = accessDisabled || approvalRouteUnavailable || requesterDecision.withheld;
    const canOpenToolRoute = transcriptSource.navigate !== null && canOpenPermissionToolCallRoute(props.location ?? null);

    const onViewTool = React.useCallback(() => {
        navigateWithBlurOnWeb(() => {
            transcriptSource.navigate?.(buildPermissionToolCallRoute({ sessionId: props.sessionId, location: props.location ?? null }));
        });
    }, [props.location, props.sessionId, transcriptSource]);

    const onDecision = React.useCallback(async (decision: 'approve' | 'reject', choice?: Readonly<{ keepUndo?: boolean }>) => {
        if (decisionDisabled || isDeciding || (decision === 'approve' && approvalWithheld)) return;
        if (decision === 'approve' && secretPrompt) {
            const home = confidentialApproval ? confidentialApproval.expectedServerIdentityId ?? confidentialApproval.request.serverId
                : confidentialInputs?.expectedServerIdentityId ?? approvalHome.serverId;
            if (!home || !transcriptSource.navigate) return;
            navigateWithBlurOnWeb(() => transcriptSource.navigate?.(`/inbox/approvals/${encodeURIComponent(props.artifact.id)}?serverId=${encodeURIComponent(home)}`));
            return;
        }
        let settledOnCard = false;
        try {
            setIsDeciding(true);
            // An agent's window choice is approved with the exact window the person picked.
            if (decision === 'approve' && bindingChoice.needsChoiceBeforeApprove) {
                await bindingChoice.choose();
                return;
            }
            if (decision === 'approve' && computerChoice.needsChoiceBeforeApprove) {
                computerChoice.chooseTarget();
                return;
            }
            const existingOptions = proposal ? proposal.decisionOptions(decision, choice)
                : decision === 'approve' ? { ...computerChoice.decisionOptions, ...bindingChoice.decisionOptions } : undefined;
            const ok = await decide(decision, {
                ...existingOptions,
                onExecution: (execution) => {
                    settledOnCard = execution !== null;
                    setRecordedArtifactId(props.artifact.id);
                },
            });
            if (!ok) {
                Modal.alert(t('common.error'), t('approvals.decisionError'));
            } else setRecordedArtifactId(props.artifact.id);
        } catch (error) {
            // A saved decision whose effect failed or went stale settles on this card from its record
            // (owner ruling C3): one message, in place. Only a decision that was never saved alerts.
            if (!settledOnCard) alertApprovalFailure(error);
        } finally {
            setIsDeciding(false);
        }
    }, [approvalHome.serverId, approvalWithheld, bindingChoice, confidentialApproval, confidentialInputs, computerChoice, decisionDisabled, decide, isDeciding, proposal, props.artifact.id, secretPrompt, transcriptSource]);

    // An approved Agent visual is that visual's one transcript occurrence (owner amendment 2026-10-26): the same
    // live reference and controls as an Allowed call, at the request's position, with no card around it.
    const visualOccurrence = React.useMemo(() => {
        // The row's own Home, as the Allowed reference reads it, so the panel and Show here controls bind to it.
        const address = normalizeSessionAddress(transcriptSource.serverId ?? approvalHome.serverId, props.sessionId);
        return address ? resolveApprovalVisualTranscriptOccurrence({ approval: props.approval, address }) : null;
    }, [approvalHome.serverId, props.approval, props.sessionId, transcriptSource.serverId]);
    if (visualOccurrence?.kind === 'approved' && visualOccurrence.reference.itemDestination !== 'board') {
        return <SessionBoardItemReferenceOccurrence reference={visualOccurrence.reference} contentDemand={props.contentDemand} />;
    }

    const savedSkill = readApprovedSavedSkillResult(props.approval);
    if (savedSkill) {
        return <SavedSkillResult fact={savedSkill} sessionId={props.sessionId}
            serverId={transcriptSource.serverId ?? approvalHome.serverId ?? undefined} />;
    }

    const viewToolButton = canOpenToolRoute ? <ApprovalOpenButton testID="approval-prompt-view-tool" onPress={onViewTool} /> : null;
    // An Agent asking to turn a skill or MCP server on for its session reads as that request (P8 U8.5, lab xi Q).
    if (capabilityEnable) {
        return <CapabilityEnableApproval artifact={props.artifact} approval={props.approval} sessionId={props.sessionId}
            chrome={chrome} decisionsAvailable={!decisionDisabled} headerAccessory={viewToolButton} />;
    }
    // An approved Browser open reads as its live operation, not as a decision.
    if (props.approval.status !== 'open' && readBrowserOpenAcceptance(props.approval)) {
        return <BrowserOpenApprovalProgress request={props.approval} serverId={approvalHome.serverId} title={actionTitle}
            chrome={chrome} headerAccessory={viewToolButton} />;
    }
    // A decided proposal stays in the transcript; declined collapses to its one line (lab `ra` A7·7).
    if (proposal && proposal.display.kind === 'declined' && props.approval.status !== 'open') {
        return <ResourceProposalBody controller={proposal} decisionsAvailable={!decisionDisabled} arrive={false} />;
    }

    // A Computer ask is asked by its one act line ("Click in Safari?"); its card starts at where.
    const requestTitle = projectCommandTitle ?? proposalLabels?.title ?? (computerAction ? readComputerActLine(computerAction) : actionTitle);
    // A failed approval leads with its outcome; what was approved follows once, as its summary.
    const cardTitle = failureOutcome?.headline ?? requestTitle;
    // A summary that only repeats the title says nothing more: the card reads it once.
    // The failure headline names the action, so a summary that only repeats that name is not a second line.
    const failureSummary = failureOutcome && !projectCommand ? props.approval.summary?.trim() || null : null;
    const sameWords = (left: string, right: string) => left.replace(/[.\s]+$/, '').toLowerCase() === right.replace(/[.\s]+$/, '').toLowerCase();
    const repeatsActionName = (text: string) => sameWords(text, requestTitle);
    const cardSubtitle = failureOutcome ? (failureSummary && !repeatsActionName(failureSummary) ? failureSummary : null)
        : projectCommand || computerAction ? null
            : !props.approval.summary ? t('approvals.untitled')
                : sameWords(props.approval.summary.trim(), cardTitle) ? null : props.approval.summary;
    return (
        <ApprovalPromptChrome
            testID="approval-prompt-card"
            chrome={chrome}
            title={cardTitle}
            titleNumberOfLines={failureOutcome ? 2 : 1}
            tone={failureOutcome ? 'danger' : undefined}
            icon={failureOutcome ? 'warning-circle' : undefined}
            subtitle={cardSubtitle}
            subtitleNumberOfLines={2}
            // A failed card closes from its head, so several of them in the tray stay a line or two each.
            headerAccessory={canOpenToolRoute || failureOutcome || (proposal && proposalMode && props.approval.status === 'open') ? (
                <View style={styles.headerAccessories}>
                    {proposal && proposalMode && props.approval.status === 'open' ? <ResourceProposalModeChip mode={proposalMode} /> : null}
                    {viewToolButton}
                    {failureOutcome && props.approval.status !== 'open' ? <ApprovalDecisionFooter isDeciding={false} onDismiss={onDismissFailure} /> : null}
                </View>
            ) : null}
            // An instructions edit's body already says what its decline kept, so the generic line would say it twice.
            footer={props.approval.status !== 'open' ? (declined && !promptDocUpdate ? (
                <ToolOutcomeStatus testID="approval-prompt-declined" label={formatApprovalStatusLabel(props.approval.status)}
                    glyph="minus-circle" tone="quiet" />
            ) : undefined) : decisionRecorded ? undefined : requesterDecision.withheld ? (
                <Text testID="approval-prompt-requester-waiting" style={styles.previewText}>
                    {requesterDecision.waitingText}
                </Text>
            ) : (
                <ApprovalDecisionFooter
                    approveLabel={secretPrompt ? t('approvals.confidential.review')
                        : projectCommandDecisions?.approve ?? proposalLabels?.approve ?? discussionDraft?.postLabel ?? review.approveVerb ?? undefined}
                    irreversible={review.irreversible && !secretPrompt}
                    rejectLabel={projectCommandDecisions?.reject ?? proposalLabels?.reject ?? discussionDraft?.declineLabel}
                    disabled={accessDisabled}
                    decisionDisabled={approvalRouteUnavailable}
                    approveDisabled={approvalWithheld}
                    approveAccessibilityHint={approvalWithheld ? cannotRun ?? t('approvals.approveUnavailableHint') : undefined}
                    disabledReason={approvalDisabledReason}
                    isDeciding={isDeciding}
                    onApprove={() => { void onDecision('approve'); }}
                    onReject={() => { void onDecision('reject'); }}
                />
            )}
        >
            {!computerAction && previewSummary && previewSummary !== cardSubtitle?.trim() && !sameWords(previewSummary, cardTitle)
                && !(failureOutcome && repeatsActionName(previewSummary)) ? (
                <Text style={styles.previewText}>{previewSummary}</Text>
            ) : null}
            {draftAnswer !== null ? (
                <DiscussionDraftAnswer testID="approval-prompt-discussion-draft" answer={draftAnswer} />
            ) : null}
            {confidentialOutcome ? (
                <Text testID="approval-prompt-confidential-outcome" style={styles.previewText}>{confidentialOutcome}</Text>
            ) : null}
            {failureOutcome?.reason || failureOutcome?.serviceStartFailure?.recovery ? (
                // The outcome is one paragraph: why it failed and its output, set apart from what was
                // approved below, so "Review output" never reads as the caption of the command block.
                <View style={styles.failureGroup}>
                    {failureOutcome?.reason ? (
                        <View testID="approval-prompt-execution-failure" accessibilityRole="alert">
                            <Text style={styles.previewText}>{failureOutcome.reason}</Text>
                        </View>
                    ) : null}
                    {/* The same output disclosure the Service row and the Browser card use for this failed start. */}
                    {failureOutcome?.serviceStartFailure?.recovery ? (
                        <ServiceOutputDisclosure output={failureOutcome.serviceStartFailure.recovery} testID="approval-prompt-service-start" />
                    ) : null}
                </View>
            ) : null}
            {computerAction ? (
                <ComputerActionApprovalCard
                    presentation={computerAction}
                    titled
                    serverId={transcriptSource.serverId ?? approvalHome.serverId}
                    onChooseTarget={!decisionDisabled ? chooseComputerTarget : undefined}
                    media={<ComputerApprovalCapture presentation={computerAction}
                        serverId={transcriptSource.serverId ?? approvalHome.serverId} testID="approval-prompt-computer-action-capture" />}
                    testID="approval-prompt-computer-action"
                />
            ) : null}
            {proposal ? (
                <ResourceProposalBody controller={proposal} decisionsAvailable={!decisionDisabled}
                    arrive={Date.now() - props.approval.createdAtMs < 15_000}
                    onApproveKeepingUndo={() => { void onDecision('approve', { keepUndo: true }); }} />
            ) : projectCommand ? (
                <ProjectCommandApprovalFacts presentation={projectCommand} testID="approval-prompt-project-command" />
            ) : docEditProposal ? (
                <ArtifactEditProposalReview proposal={docEditProposal} testID="approval-prompt-doc-edit-proposal" />
            ) : promptDocUpdate ? (
                <PromptDocApprovalDiff request={promptDocUpdate} serverId={transcriptSource.serverId ?? null}
                    testID="approval-prompt-prompt-doc-diff" />
            ) : actionFields && (actionFields.rows.length > 0 || failureOutcome || toolOutput) ? (
                <ActionApprovalFieldsCard presentation={actionFields} request={props.approval} serverId={approvalHome.serverId}
                    failureTechnicalDetails={failureOutcome?.technicalDetails}
                    outputText={toolOutput}
                    // Only a prompt waiting on a decision keeps its arguments behind Details so the decision stays in view.
                    collapsed={failureOutcome !== null || draftAnswer !== null || (chrome === 'inline' && phone && props.approval.status === 'open')} />
            ) : null}
            {/* A specialized body keeps the same failure facts when it replaces the generic fields card. */}
            {failureOutcome?.code && (proposal || projectCommand || promptDocUpdate || docEditProposal) ? (
                <ApprovalTechnicalDetails lines={failureOutcome.technicalDetails} />
            ) : null}
            {cannotRun ? (
                <Text testID="approval-prompt-cannot-run" style={styles.previewText}>{cannotRun}</Text>
            ) : null}
            {approvalRouteUnavailable ? (
                <Text style={styles.previewText}>{t('actionConfirmations.homeUnavailable')}</Text>
            ) : null}
        </ApprovalPromptChrome>
    );
});

export const ApprovalPromptCard = React.memo(function ApprovalPromptCard(
    props: ApprovalPromptCardProps<ApprovalRequest | TargetActionApprovalRequestV1>,
) {
    return isTargetActionApproval(props.approval)
        ? <TargetActionApprovalPromptCard {...props} approval={props.approval} />
        : <BuiltInApprovalPromptCard {...props} approval={props.approval} />;
});

const styles = StyleSheet.create((theme) => ({
    headerAccessories: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    failureGroup: {
        gap: theme.space.s2,
        marginBottom: theme.space.s8,
    },
    previewText: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
}));

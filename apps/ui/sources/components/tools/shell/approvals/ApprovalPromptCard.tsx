import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from 'react';
import { View } from 'react-native';
import type { ApprovalRequest } from '@happier-dev/protocol';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { describeApprovalRequestFields } from '@happier-dev/protocol/actions';
import { StyleSheet } from 'react-native-unistyles';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { Text } from '@/components/ui/text/Text';
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
import { presentApprovalFailureOutcome, resolveApprovalActionTitle } from './approvalFailureOutcome';
import { useFailedApprovalDismissal } from './failedApprovalDismissal';
import { ActionApprovalFieldsCard, ApprovalTechnicalDetails } from '@/components/approvals/ActionApprovalFieldsCard';
import { PromptDocApprovalDiff } from '@/components/approvals/PromptDocApprovalDiff';
import { ComputerActionApprovalCard } from '@/components/approvals/ComputerActionApprovalCard';
import {
    ProjectCommandApprovalFacts,
    describeProjectCommandApprovalDecisions,
    readProjectCommandApproval,
    useProjectCommandApprovalTitle,
} from '@/components/approvals/ProjectCommandApprovalFacts';
import { useComputerApprovalChoice } from '@/components/approvals/useComputerApprovalChoice';
import { readActionApprovalReview } from '@/components/approvals/actionApprovalReview';
import { ResourceProposalBody, ResourceProposalModeChip } from '@/components/approvals/resourceProposal/ResourceProposalBody';
import { useResourceProposalApprovalMode } from '@/components/approvals/resourceProposal/useResourceProposalApprovalMode';
import { resolveResourceProposalLabels } from '@/components/approvals/resourceProposal/resourceProposalLabels';
import { useResourceProposalCheck } from '@/components/approvals/resourceProposal/useResourceProposalCheck';
import { CapabilityEnableApproval } from '@/components/sessions/capabilities/CapabilityEnableApproval';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import { useDeviceType } from '@/utils/platform/responsive';
import { ToolOutcomeStatus } from '../presentation/ToolOutcomeStatus';
import { formatApprovalStatusLabel } from '@/components/approvals/approvalStatusLabel';


type ApprovalPromptCardArtifact = Pick<DecryptedArtifact, 'id' | 'header'>;

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


export const ApprovalPromptCard = React.memo(function ApprovalPromptCard(props: Readonly<{
    artifact: ApprovalPromptCardArtifact;
    approval: ApprovalRequest;
    sessionId: string;
    metadata?: Metadata | null;
    location?: PermissionToolCallMessageLocation | null;
    canApprovePermissions?: boolean;
    canApprove?: boolean;
    disabledReason?: TranscriptPermissionDisabledReason;
    chrome?: 'card' | 'inline';
    /** A declined request's tool row defers its output here: it stays reachable in Technical details. */
    toolOutput?: string | null;
}>) {
    const transcriptSource = useSessionTranscriptSource();
    const decide = useApprovalDecisionHandler(props.artifact, props.approval, props.sessionId);
    const approvalHome = useApprovalHome(props.artifact, props.approval, props.sessionId);
    const [isDeciding, setIsDeciding] = React.useState(false);
    const chrome = props.chrome ?? 'card';
    // On a phone the composer's inline prompt keeps its decision in view: the arguments wait behind Details.
    const phone = useDeviceType() === 'phone';
    const actionTitle = React.useMemo(() => resolveApprovalActionTitle(props.approval), [props.approval]);
    const previewSummary = React.useMemo(() => getPreviewSummary(props.approval.preview), [props.approval.preview]);
    const review = React.useMemo(() => readActionApprovalReview(props.approval), [props.approval]);
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
    const actionFields = React.useMemo(() => confidentialAction ? null
        : approveAdmission?.presentation ?? describeApprovalRequestFields(props.approval), [confidentialAction, approveAdmission, props.approval]);
    // An agent's finite Project command reads as its exact command, target and identity (lab `s-agent` ADHOC).
    const projectCommand = React.useMemo(() => readProjectCommandApproval(props.approval), [props.approval]);
    const projectCommandTitle = useProjectCommandApprovalTitle(projectCommand);
    const projectCommandDecisions = projectCommand ? describeProjectCommandApprovalDecisions(projectCommand) : null;
    // An Agent's instructions edit reads as its diff against the current document (lab `b-work P`).
    const promptDocUpdate = review.promptDocUpdate;
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
    const sourceInteraction = transcriptSource.useInteraction();
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
    const decisionDisabled = accessDisabled || approvalRouteUnavailable;
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
        try {
            setIsDeciding(true);
            // An agent's window choice is approved with the exact window the person picked.
            if (decision === 'approve' && computerChoice.needsChoiceBeforeApprove) {
                computerChoice.chooseTarget();
                return;
            }
            const ok = await decide(decision, proposal ? proposal.decisionOptions(decision, choice)
                : decision === 'approve' ? computerChoice.decisionOptions : undefined);
            if (!ok) {
                Modal.alert(t('common.error'), t('approvals.decisionError'));
            }
        } catch (error) {
            alertApprovalFailure(error);
        } finally {
            setIsDeciding(false);
        }
    }, [approvalHome.serverId, approvalWithheld, secretPrompt, confidentialApproval, confidentialInputs, computerChoice, decisionDisabled, decide, isDeciding, proposal, props.artifact.id, transcriptSource]);

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

    const requestTitle = projectCommandTitle ?? proposalLabels?.title ?? actionTitle;
    // A failed approval leads with its outcome; what was approved follows once, as its summary.
    const cardTitle = failureOutcome?.headline ?? requestTitle;
    // A summary that only repeats the title says nothing more: the card reads it once.
    // The failure headline names the action, so a summary that only repeats that name is not a second line.
    const failureSummary = failureOutcome && !projectCommand ? props.approval.summary?.trim() || null : null;
    const sameWords = (left: string, right: string) => left.replace(/[.\s]+$/, '').toLowerCase() === right.replace(/[.\s]+$/, '').toLowerCase();
    const repeatsActionName = (text: string) => sameWords(text, requestTitle);
    const cardSubtitle = failureOutcome ? (failureSummary && !repeatsActionName(failureSummary) ? failureSummary : null)
        : projectCommand ? null
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
            footer={props.approval.status !== 'open' ? (declined ? (
                <ToolOutcomeStatus testID="approval-prompt-declined" label={formatApprovalStatusLabel(props.approval.status)}
                    glyph="minus-circle" tone="quiet" />
            ) : undefined) : (
                <ApprovalDecisionFooter
                    approveLabel={secretPrompt ? t('approvals.confidential.review')
                        : projectCommandDecisions?.approve ?? proposalLabels?.approve ?? review.approveVerb ?? undefined}
                    irreversible={review.irreversible && !secretPrompt}
                    rejectLabel={projectCommandDecisions?.reject ?? proposalLabels?.reject}
                    disabled={accessDisabled}
                    decisionDisabled={approvalRouteUnavailable}
                    approveDisabled={approvalWithheld}
                    approveAccessibilityHint={approvalWithheld ? t('approvals.approveUnavailableHint') : undefined}
                    disabledReason={approvalDisabledReason}
                    isDeciding={isDeciding}
                    onApprove={() => { void onDecision('approve'); }}
                    onReject={() => { void onDecision('reject'); }}
                />
            )}
        >
            {failureOutcome?.reason ? (
                <View testID="approval-prompt-execution-failure" accessibilityRole="alert">
                    <Text style={styles.previewText}>{failureOutcome.reason}</Text>
                </View>
            ) : null}
            {previewSummary && previewSummary !== cardSubtitle?.trim() && !sameWords(previewSummary, cardTitle)
                && !(failureOutcome && repeatsActionName(previewSummary)) ? (
                <Text style={styles.previewText}>{previewSummary}</Text>
            ) : null}
            {computerAction ? (
                <ComputerActionApprovalCard
                    presentation={computerAction}
                    onChooseTarget={canApprove ? chooseComputerTarget : undefined}
                    testID="approval-prompt-computer-action"
                />
            ) : null}
            {proposal ? (
                <ResourceProposalBody controller={proposal} decisionsAvailable={!decisionDisabled}
                    arrive={Date.now() - props.approval.createdAtMs < 15_000}
                    onApproveKeepingUndo={() => { void onDecision('approve', { keepUndo: true }); }} />
            ) : projectCommand ? (
                <ProjectCommandApprovalFacts presentation={projectCommand} testID="approval-prompt-project-command" />
            ) : promptDocUpdate ? (
                <PromptDocApprovalDiff request={promptDocUpdate} serverId={transcriptSource.serverId ?? null}
                    sessionId={props.sessionId} testID="approval-prompt-prompt-doc-diff" />
            ) : actionFields && (actionFields.rows.length > 0 || failureOutcome || toolOutput) ? (
                <ActionApprovalFieldsCard presentation={actionFields} serverId={approvalHome.serverId}
                    failureMessage={failureOutcome?.message ?? undefined} failureCode={failureOutcome?.code ?? undefined}
                    outputText={toolOutput}
                    // Only a prompt waiting on a decision keeps its arguments behind Details so the decision stays in view.
                    collapsed={failureOutcome !== null || (chrome === 'inline' && phone && props.approval.status === 'open')} />
            ) : null}
            {/* A specialized body replaces the generic fields card, which is the one place the card shows the
                failure's code; the page keeps it through the same disclosure. */}
            {failureOutcome?.code && (proposal || projectCommand || promptDocUpdate) ? (
                <ApprovalTechnicalDetails lines={[{ key: 'failure-code', label: t('common.error'), value: failureOutcome.code }]} />
            ) : null}
            {approvalRouteUnavailable ? (
                <Text style={styles.previewText}>{t('actionConfirmations.homeUnavailable')}</Text>
            ) : null}
        </ApprovalPromptChrome>
    );
});

const styles = StyleSheet.create((theme) => ({
    headerAccessories: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    previewText: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
}));

import * as React from 'react';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';


import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { readOpenApprovalInboxEntry } from '@/sync/domains/artifacts/approvalArtifactAdmission';
import { useOpenApprovalArtifactBodyDemand, useServerScopedMachineLabel, useSession } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveApprovalHomeServerId } from '@/components/approvals/approvalHomeServerId';
import { readApprovalArtifactTitleInput, useApprovalRequestTitle } from '@/components/approvals/approvalRequestTitle';
import { readResourceProposalApproval } from '@/components/approvals/resourceProposal/readResourceProposalApproval';
import { describeResourceProposalInboxFacts } from '@/components/approvals/resourceProposal/resourceProposalLabels';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import {
  describeUnnamedApprovalRequester,
  isHappierGuardApproval,
  readApprovalRequesterSurface,
  resolveApprovalHomeName,
  resolveApprovalHomeSentenceName,
} from '@/components/approvals/approvalRequesterLabels';
import { readApprovalSessionName, useApprovalSessionReading } from '@/components/approvals/useApprovalSessionReading';
import { readApprovalOriginMachineId } from '@/components/approvals/approvalEndpointLabels';
import { InboxWorkRow } from '../InboxWorkRow';
import { InboxRelativeTime } from '../InboxRelativeTime';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { readApprovalQuickActions } from '@/components/approvals/approvalQuickActions';
import { readActionApprovalReview, type ActionApprovalReview } from '@/components/approvals/actionApprovalReview';
import { readProjectCommandApproval } from '@/components/approvals/ProjectCommandApprovalFacts';
import { ApprovalDecisionBar } from '@/components/approvals/ApprovalDecisionBar';
import {
  alertApprovalFailure,
  useApprovalDecisionHandler,
} from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useApprovalRequesterViewer } from '@/components/approvals/ApprovalRequesterConfirmationSection';

/**
 * The row is itself a target: its answer pills keep to their own gaps and never reach up or down into the
 * row's text (touch-target doctrine: a control nested in a tappable row keeps its drawn size).
 */
const ROW_BUTTON_REACH = { top: 0, bottom: 0 } as const;

/**
 * A simple approval's one-shot answer from its row (lab coordination P4): a quiet Deny and a bordered
 * Allow once, through the same decision owner the approval page uses. Only the shared review owner
 * offers it (`readApprovalQuickActions`); anything it cannot show whole stays behind Review.
 */
function ApprovalInboxDecision(
  props: Readonly<{
    artifact: DecryptedArtifact;
    approval: ApprovalRequest;
    /** The verb and irreversibility the approval page and the transcript card read from the same owner. */
    review: Pick<ActionApprovalReview, 'approveVerb' | 'irreversible'>;
    sessionId: string;
    serverId: string;
  }>,
): React.ReactElement | null {
  const decide = useApprovalDecisionHandler(
    props.artifact,
    props.approval,
    props.sessionId,
    props.serverId,
  );
  const [deciding, setDeciding] = React.useState<'approve' | 'reject' | null>(
    null,
  );
  const [recorded, setRecorded] = React.useState(false);
  const { approveVerb, irreversible } = props.review;
  const run = (decision: 'approve' | 'reject') => {
    if (deciding) return;
    setDeciding(decision);
    fireAndForget(
      decide(decision, { onExecution: () => setRecorded(true) })
        .then((accepted) => { if (accepted) setRecorded(true); })
        .catch((error: unknown) => {
          alertApprovalFailure(error);
        })
        .finally(() => setDeciding(null)),
      { tag: `ApprovalInboxCard.${decision}` },
    );
  };
  if (recorded) return null;
  return (
    <ApprovalDecisionBar size="small" quiet hitReach={ROW_BUTTON_REACH} disabled={deciding !== null} irreversible={irreversible} hideIrreversibleNote
      approve={{ testID: `inbox.approval.${props.artifact.id}.allow_once`,
        label: approveVerb ?? t('inbox.work.quickDecision.allowOnce'), busy: deciding === 'approve',
        onPress: () => run('approve') }}
      reject={{ testID: `inbox.approval.${props.artifact.id}.deny`,
        busy: deciding === 'reject',
        onPress: () => run('reject') }} />
  );
}

export const ApprovalInboxCard = React.memo(
  (
    props: Readonly<{
      artifact: DecryptedArtifact;
      onPress: () => void;
      /** Testable awareness-projection time. */
      nowMs?: number;
      showDivider?: boolean;
      /** The Inbox spans several Homes, so a row names the Home its session lives on. */
      showHome?: boolean;
      /** The request whose detail is open beside the list. */
      selected?: boolean;
      density?: 'comfortable' | 'cozy' | 'compact' | 'tight';
      /** A phone or the rail popover: kind and age on the line beneath, no time column (`InboxWorkRow`). */
      narrow?: boolean;
      /**
       * The rail popover's inline answer (lab `inbox-I2`): one bordered action that opens the request.
       * A simple request the shared review shows whole is answered there instead (Deny / Allow once);
       * anything else is decided on its page, which shows what would run first.
       */
      inlineActionLabel?: string;
      /**
       * A phone's page row has no room beside its text: a simple request's Deny / Allow once sit beneath
       * it instead (lab coordination `P4-Ap`). Anything else is opened by the row itself.
       */
      decideBelow?: boolean;
    }>,
  ): React.ReactElement => {
    const { theme } = useUnistyles();
    // The list knows this row from its header; the mounted row reads its own body for its decision facts.
    useOpenApprovalArtifactBodyDemand(props.artifact);

    const sessionId =
      typeof props.artifact.header?.sessionId === 'string'
        ? props.artifact.header.sessionId.trim()
        : '';
    // This device's profile for the Home that asked (the request may record another device's id).
    const serverId = resolveApprovalHomeServerId(props.artifact.header);
    const legacySession = useSession(serverId ? '' : sessionId);
    // The same exact-Home reading as the approval's title and page: its `resolving` state is the one source
    // of "the Home's list has not answered yet".
    const scopedReading = useApprovalSessionReading(
      serverId || null,
      sessionId,
    );
    const session = serverId ? scopedReading.session : legacySession;
    const nowMs = React.useMemo(
      () => props.nowMs ?? Date.now(),
      [props.nowMs, session],
    );
    const parsedApproval = React.useMemo(
      () =>
        approvalArtifactBodyMatchesHeaderV1(
          props.artifact.header ?? {},
          'body' in props.artifact && typeof props.artifact.body === 'string'
            ? props.artifact.body
            : null,
        ),
      [props.artifact],
    );
    // The shared review owner, read once per approval version: list re-renders never re-derive it.
    const review = React.useMemo(
      () => parsedApproval?.family === 'built_in' ? readActionApprovalReview(parsedApproval.request) : null,
      [parsedApproval],
    );
    const requesterConfirmation = parsedApproval?.family === 'target_action'
      ? parsedApproval.request.requesterConfirmation
      : parsedApproval?.family === 'built_in' && parsedApproval.request.v === 2
        ? parsedApproval.request.requesterConfirmation
        : undefined;
    const requesterMayDecide = useApprovalRequesterViewer(requesterConfirmation, serverId || null);
    // The card names the Machine; it subscribes to that name, not to the record its presence heartbeats replace.
    const originMachineLabel = useServerScopedMachineLabel(
      serverId || null,
      sessionId ? '' : readApprovalOriginMachineId(parsedApproval),
    );

    // The one title rule shared with the approval page and its tab.
    const { title, actionTitle } = useApprovalRequestTitle(
      readApprovalArtifactTitleInput(props.artifact, parsedApproval),
      serverId || null,
    );

    const sessionTitle = session ? readApprovalSessionName(session, serverId || null, nowMs) : null;
    // What tells this request from its siblings, on one line like every other Inbox row: where it comes
    // from, the Action's name when the title does not already say it, the session that asked (by name,
    // or by where it lives when this device does not have it; never its id, its Home's address or its folder path),
    // the Home only when the Inbox spans several, and when it was asked. Every row here needs an
    // approval, so those words are the line only when nothing else is known; a screen reader always
    // hears them.
    const isFact = (value: string | null | undefined): value is string =>
      typeof value === 'string' && value.trim().length > 0;
    const homeName = resolveApprovalHomeName(serverId);
    // While the Home's list is still being read, no claim is made about where the session lives.
    const builtIn = parsedApproval?.family === 'built_in';
    const askingSession = isHappierGuardApproval(parsedApproval?.request ?? null, builtIn)
      ? t('detailPages.approval.requesterGuard')
      : sessionTitle ??
      (sessionId && !(serverId && scopedReading.status === 'resolving')
        ? describeUnnamedApprovalRequester(
            readApprovalRequesterSurface(parsedApproval?.request ?? null, builtIn),
            resolveApprovalHomeSentenceName(serverId),
          )
        : null);
    // An agent's cleanup or stop proposal says what it holds (lab `ra` A5): "7 items, all safe · …".
    const proposalFacts = React.useMemo(() => {
      const model =
        parsedApproval?.family === 'built_in'
          ? readResourceProposalApproval(parsedApproval.request)
          : null;
      return model ? describeResourceProposalInboxFacts(model) : null;
    }, [parsedApproval]);
    // Where it comes from leads the line under the title: the session that asked, or its Machine, unless
    // the title already names it as the request's own subject.
    const requester = askingSession ?? originMachineLabel;
    const source = requester && !title.includes(requester) ? requester : null;
    // An agent's request to remember a Project's setup says so on its row; the page spells out the consequence.
    const projectCommand = parsedApproval?.family === 'built_in' ? readProjectCommandApproval(parsedApproval.request) : null;
    const asksToRemember = projectCommand?.kind === 'setup' && projectCommand.remembersConsent
      ? t('projects.scripts.setup.agentAsksRememberedRow') : null;
    const distinguishingFacts = [
      // The row has no room under its buttons: it says once, calmly, what its destructive verb means.
      // It leads the line so a narrow row truncates where the request comes from, never the consequence.
      review?.irreversible
        ? t('approvals.irreversibleFact')
        : null,
      source,
      proposalFacts,
      asksToRemember,
      actionTitle && actionTitle !== title && !proposalFacts
        ? actionTitle
        : null,
      props.showHome === true && sessionTitle ? homeName : null,
    ].filter(isFact);
    const quickActions = React.useMemo(
      () =>
        serverId && (props.inlineActionLabel || props.decideBelow)
          ? readApprovalQuickActions(readOpenApprovalInboxEntry(props.artifact), serverId, requesterMayDecide)
          : null,
      [props.artifact, props.inlineActionLabel, props.decideBelow, requesterMayDecide, serverId],
    );
    const quickApproval =
      quickActions && parsedApproval?.family === 'built_in'
        ? parsedApproval.request
        : null;
    const quickDecision =
      quickApproval && review && serverId ? (
        <ApprovalInboxDecision
          artifact={props.artifact}
          approval={quickApproval}
          review={review}
          sessionId={sessionId}
          serverId={serverId}
        />
      ) : null;
    const needsApproval = t('inbox.work.rows.approvalNeeded');
    const accessibilityLabel = joinHappierFacts(
      ...[title, needsApproval, ...distinguishingFacts].filter(isFact),
    );

    return (
      <InboxWorkRow
        testID={`inbox.approval.${props.artifact.id}`}
        title={title}
        facts={distinguishingFacts.length > 0 ? distinguishingFacts : [needsApproval]}
        time={
          props.artifact.createdAt > 0 ? (
            <InboxRelativeTime
              timestamp={props.artifact.createdAt}
              nowMs={props.nowMs}
            />
          ) : null
        }
        // The same leading column as the session and run rows it sits between.
        mark={
          <Icon
            name="shield-check"
            size={18}
            color={theme.colors.text.secondary}
          />
        }
        accessibilityLabel={accessibilityLabel}
        onPress={props.onPress}
        belowAccessory={quickDecision && props.decideBelow ? quickDecision : undefined}
        trailingAccessory={
          quickDecision && !props.decideBelow ? (
            quickDecision
          ) : props.inlineActionLabel ? (
            <RoundButton
              testID={`inbox.approval.${props.artifact.id}.review`}
              size="small"
              display="secondary"
              hitReach={ROW_BUTTON_REACH}
              title={props.inlineActionLabel}
              onPress={props.onPress}
            />
          ) : undefined
        }
        selected={props.selected === true}
        showDivider={props.showDivider}
        narrow={props.narrow}
      />
    );
  },
);

ApprovalInboxCard.displayName = 'ApprovalInboxCard';

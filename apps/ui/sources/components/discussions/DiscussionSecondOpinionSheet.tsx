import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_MENU_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';
import {
  isDiscussionSecondOpinionSourceGrantRepairableV1 as isRepairableSourceGap,
  resolveDiscussionSecondOpinionSourceGrantsV1,
  type DiscussionSecondOpinionSourceV1,
  type DiscussionSecondOpinionPreviewV1,
} from '@happier-dev/protocol/discussions/secondOpinion';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { ReplyQuote } from '@/components/ui/text/ReplyQuote';
import { stripMarkdown } from '@/utils/sessions/messageUtils';
import { DetailsTabHeader } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSessionCollaborationAvailabilityState } from '@/hooks/session/useSessionCollaborationAvailability';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import {
  createDiscussionSecondOpinionController,
  type DiscussionSecondOpinionSnapshot,
} from './discussionSecondOpinionController';
import { ContextualStartComposerBody, useContextualStartComposer, useContextualStartParticipantSource, type ContextualStartAdmissibleSet } from '@/components/sessions/authoring/ContextualStartComposer';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { executableParticipantOptionId } from './useExecutableParticipantSections';
import { useExecutableParticipantLabel } from '@/components/sessions/authoring/useExecutableParticipantLabel';
import { useOpenDiscussion } from './useOpenDiscussion';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { PhoneDetailsStartContext } from '@/components/appShell/panes/details/PhoneDetailsStartSheet';

export type DiscussionSecondOpinionIntent = 'second_opinion' | 'discuss';
const OPINION_ADMISSIBLE: ContextualStartAdmissibleSet = {
  who: ['newAgent', 'session', 'bot', 'person'], machine: 'select', folder: 'select',
};

type SheetProps = Readonly<{
  active?: boolean;
  source: Extract<DiscussionSecondOpinionSourceV1, { kind: 'session' }>;
  intent: DiscussionSecondOpinionIntent;
  /** The committed answer as the person read it; the quote leads the sheet before any preview. */
  sourceText: string;
  onClose: () => void;
  /** Opens the Fresh opinions Run through the host's navigation owner. */
  onNavigate: (href: string) => void;
  sourcePaneScopeId?: string;
  /** Lab T3: beside the transcript the form is a Details pane; a phone (or a host without one) gets the sheet. */
  presentation?: 'dialog' | 'pane';
  /** A pane keeps its controller while its tab is open, so switching tabs keeps the draft and an Ask in flight. */
  retained?: { controller?: unknown };
  /** A pane turns into the Discussion it started, in place; the dialog opens it beside the source instead. */
  onOpenDiscussion?: (discussionId: string, title: string, messageId: string) => void;
}>;

/** What an entry point hands over: everything but where it is presented and how it closes. */
export type DiscussionSecondOpinionRequest = Omit<SheetProps, 'active' | 'onClose' | 'sourcePaneScopeId' | 'presentation' | 'retained' | 'onOpenDiscussion'>;

/** The pane form of the same sheet (lab T3-A), rendered by the Session's Details pane. */
export function DiscussionSecondOpinionPane(props: Omit<SheetProps, 'presentation'>) {
  return (
    <View style={styles.paneBody}>
      <DiscussionSecondOpinionForm {...props} presentation="pane" />
    </View>
  );
}

const NO_SERVER_IDS: readonly string[] = [];

function sheetTitle(intent: DiscussionSecondOpinionIntent): string {
  return intent === 'discuss'
    ? t('session.collaboration.discussion.secondOpinion.discussTitle')
    : t('session.collaboration.discussion.secondOpinion.title');
}

function DiscussionSecondOpinionForm(props: SheetProps) {
  const serverId = props.source.message.session.serverId;
  const serverIds = React.useMemo(() => [serverId], [serverId]);
  const bindings = useServerCredentialAccountScopeBindings(
    serverId ? serverIds : NO_SERVER_IDS,
  );
  const binding = [...bindings.values()][0] ?? null;
  // Renewal withdraws execution authority without replacing the editable form. A different
  // Account gets its own form/controller below; a retained binding is display identity only.
  const [retainedBinding, setRetainedBinding] = React.useState(binding);
  if (binding && binding !== retainedBinding) setRetainedBinding(binding);
  const displayBinding = binding ?? retainedBinding;
  if (!displayBinding) {
    return (
      <SheetFrame intent={props.intent} subtitle={null} onClose={props.onClose} presentation={props.presentation}>
        <SurfaceStateCard
          size="line"
          kind="unavailable"
          title={t('session.collaboration.discussion.bindingUnavailable')}
        />
      </SheetFrame>
    );
  }
  return <BoundForm key={JSON.stringify(displayBinding.scope)} {...props} binding={displayBinding}
    credentialsAvailable={binding?.isCurrent() === true} />;
}

function BoundForm(
  props: SheetProps &
    Readonly<{ binding: ServerCredentialAccountScopeBinding; credentialsAvailable: boolean }>,
) {
  const { theme } = useUnistyles();
  const { binding } = props;
  const credentialsAvailable = props.credentialsAvailable && binding.isCurrent();
  const featureAvailability = useSessionCollaborationAvailabilityState(
    binding.scope.serverId,
  );
  const availabilityState = credentialsAvailable ? featureAvailability : 'unavailable';
  // The controller issues actions, so its boundary intentionally fails closed while the sheet presents loading.
  const availability = availabilityState === 'available' ? 'available' : 'unavailable';
  const sourceSession = props.source.message.session;
  const anchor = React.useMemo(() => ({ kind: 'session' as const, sessionId: sourceSession.sessionId,
    messageId: props.source.message.messageId }), [props.source.message.messageId, sourceSession.sessionId]);
  const { openDiscussion } = useOpenDiscussion({ address: binding.scope, anchor, sourceSurface: 'collaboration',
    paneScopeId: props.sourcePaneScopeId });
  const [sourceTitle] = useSessionDisplayTitles(
    React.useMemo(() => [sourceSession], [sourceSession]),
  );
  const discuss = props.intent === 'discuss';
  const [controller] = React.useState(() => {
    const retained = props.retained?.controller as ReturnType<typeof createDiscussionSecondOpinionController> | undefined;
    if (retained?.scope.serverId === binding.scope.serverId && retained.scope.accountId === binding.scope.accountId) return retained;
    const created = createDiscussionSecondOpinionController({
      scope: binding.scope,
      availability,
      source: props.source,
      draft: {
        title: discuss
          ? t(
              'session.collaboration.discussion.secondOpinion.discussDiscussionTitle',
            )
          // Named by its subject, so the Discussions list says what it is a second opinion on (lab T2-L).
          : sourceTitle
            ? t('session.collaboration.discussion.secondOpinion.discussionTitleOn', { session: sourceTitle })
            : t('session.collaboration.discussion.secondOpinion.discussionTitle'),
        question: discuss
          ? ''
          : t('session.collaboration.discussion.secondOpinion.defaultQuestion'),
        reviewers: [],
      },
    });
    if (props.retained) props.retained.controller = created;
    return created;
  });
  React.useLayoutEffect(() => {
    controller.setAvailability(binding.isCurrent() ? availability : 'unavailable');
    const retirement = binding.onRetire(() => controller.setAvailability('unavailable'));
    return () => { retirement.dispose(); controller.setAvailability('unavailable'); };
  }, [availability, binding, controller]);
  const snapshot = React.useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const { requestApproval } = useActionApprovalContinuation({
    scopeKey: JSON.stringify(binding.scope), serverId: binding.scope.serverId, onExecuted: () => {},
  });
  React.useEffect(() => {
    if (snapshot.approval) requestApproval(snapshot.approval);
  }, [requestApproval, snapshot.approval]);
  const active = props.active !== false;
  const done = snapshot.discussionMessage !== null;
  React.useEffect(() => {
    const message = snapshot.discussionMessage;
    if (!message) return;
    if (props.onOpenDiscussion) props.onOpenDiscussion(message.discussion.discussionId, snapshot.draft.title, message.messageId);
    else { openDiscussion(message.discussion.discussionId, snapshot.draft.title, message.messageId); props.onClose(); }
  }, [snapshot.discussionMessage, snapshot.draft.title, props.onOpenDiscussion, openDiscussion, props.onClose]);
  const detailEnabled = active && credentialsAvailable && !done;
  const question = snapshot.draft.question;
  const setQuestion = React.useCallback((question: string) => {
    controller.updateDraft({ ...controller.getSnapshot().draft, question });
  }, [controller]);
  // Asking several starts Fresh opinions, a Workflow that runs where the Discussion's Workflows run.
  const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(null);
  const toggleReviewer = React.useCallback((selection: ExecutableParticipantSelectionV1) => {
    const question = controller.getSnapshot().draft.question || t('session.collaboration.discussion.secondOpinion.defaultQuestion');
    if (controller.toggleReviewer(selection, question) && controller.getSnapshot().draft.reviewers.length > 0) {
      void controller.preview();
    }
  }, [controller]);
  const togglePerson = React.useCallback((participant: Readonly<{ kind: 'account'; accountId: string }>) => {
    const current = controller.getSnapshot();
    if (current.working || current.submitted) return;
    const chosen = current.draft.participants ?? [];
    const participants = chosen.some(person => person.accountId === participant.accountId)
      ? chosen.filter(person => person.accountId !== participant.accountId) : [...chosen, participant];
    if (controller.updateDraft({ ...current.draft, participants })) void controller.preview();
  }, [controller]);
  const people = React.useMemo(() => ({ includeModels: true,
    title: t('session.collaboration.discussion.participants.peopleGroup'), onChoose: togglePerson,
    chosen: (snapshot.draft.participants ?? []).map(ref => presentSharePrincipal({ ref, viewerAccountId: binding.scope.accountId })),
  }), [binding.scope.accountId, snapshot.draft.participants, togglePerson]);
  const replaceReviewer = React.useCallback((previous: ExecutableParticipantSelectionV1, next: ExecutableParticipantSelectionV1) => {
    const current = controller.getSnapshot();
    if (current.working || current.submitted) return;
    if (controller.updateDraft({ ...current.draft, reviewers: current.draft.reviewers.map(reviewer =>
      reviewer.selection === previous ? { ...reviewer, selection: next } : reviewer) })) void controller.preview();
  }, [controller]);
  const selectedReviewers = React.useMemo(() => snapshot.draft.reviewers.map(reviewer => reviewer.selection), [snapshot.draft.reviewers]);
  const composerSource = useContextualStartParticipantSource({ accountLifetime: binding, enabled: detailEnabled,
    busy: snapshot.working || snapshot.submitted, sessionsContext: t('session.collaboration.discussion.secondOpinion.yourSession'),
    excludeSessionId: sourceSession.sessionId, onChoose: toggleReviewer, people,
    selected: selectedReviewers, onReplace: replaceReviewer,
    question, onQuestionChange: setQuestion, showWhere: snapshot.draft.reviewers.length > 1, onProject: setProject });
  const composer = useContextualStartComposer(composerSource, OPINION_ADMISSIBLE);

  // Discuss… previews at once; a selected second opinion also recovers when this Home becomes available.
  React.useEffect(() => {
    if (!detailEnabled) return;
    const current = controller.getSnapshot();
    if (current.submitted || (!discuss && (availability !== 'available' || current.draft.reviewers.length === 0 && !current.draft.participants?.length))) return;
    if (!current.working) {
      void controller.preview();
      return;
    }
    // A feature change can arrive during a preview. Finish it before refreshing the same draft once.
    const unsubscribe = controller.subscribe(() => {
      const next = controller.getSnapshot();
      if (next.working) return;
      unsubscribe();
      if (!next.submitted) void controller.preview();
    });
    return unsubscribe;
  }, [controller, detailEnabled, discuss, availability, binding]);
  const ask = async (sourceAccess?: 'quote_only') => {
    const draft = snapshot.draft;
    const reviewersFor = sourceAccess
      ? draft.reviewers.map((reviewer) => ({ ...reviewer, sourceAccess }))
      : draft.reviewers;
    if (question !== draft.question || sourceAccess) {
      controller.updateDraft({ ...draft, question, reviewers: reviewersFor });
      if (sourceAccess) await controller.preview();
    }
    await controller.ask({ project });
  };

  const several = snapshot.draft.reviewers.length > 1;
  const preview = snapshot.preview?.preview ?? null;
  const sourceGrants = preview ? resolveDiscussionSecondOpinionSourceGrantsV1(preview) : null;
  const needsGrant = sourceGrants?.ok === true && sourceGrants.accountIds.length > 0;
  // A reviewer outside the answer's audience is a gap the person can close by sharing the source
  // (the Ask admits its recipients before granting); any other refusal stays one.
  const blocked = sourceGrants?.ok === false;
  const canAsk =
    active && credentialsAvailable &&
    !snapshot.working &&
    !done &&
    !blocked &&
    preview !== null &&
    ((discuss && snapshot.draft.reviewers.length === 0) ||
      ((snapshot.draft.reviewers.length > 0 || (snapshot.draft.participants?.length ?? 0) > 0) &&
        question.trim().length > 0 &&
        (!several || project !== null)));

  const subtitle = sourceTitle
    ? t('session.collaboration.discussion.secondOpinion.subtitle', {
        session: sourceTitle,
      })
    : t('session.collaboration.discussion.secondOpinion.subtitleUntitled');
  // Lab flows `pending`: while the Ask waits on approval the choices are locked and Review is the only action.
  const outcome = snapshot.working ? null : snapshot.result?.outcome ?? null;
  const approval = outcome?.kind === 'approval_request_created' ? outcome : null;
  const phoneSheet = React.useContext(PhoneDetailsStartContext) !== null;
  const router = useRouter();
  // The quote reads as the answer did on screen (lab `quote`): words, not the Markdown source the reviewer receives.
  const quoteText = React.useMemo(() => stripMarkdown(props.sourceText), [props.sourceText]);
  if (availabilityState === 'loading') {
    return <SheetFrame intent={props.intent} subtitle={subtitle} onClose={props.onClose} presentation={props.presentation}>
      <SurfaceStateCard testID="second-opinion-loading" kind="loading" title={t('common.loading')} />
    </SheetFrame>;
  }
  // Wide: Cancel quietly at the start, the one primary at the end. Phone (one large sheet): the close
  // and the drag dismiss it, so the primary takes the full width above the home indicator.
  const footer = done || approval ? null : (
    <>
      {phoneSheet ? null : <RoundButton
        testID="second-opinion.cancel"
        size="small"
        display="inverted"
        title={t('common.cancel')}
        onPress={props.onClose}
      />}
      {phoneSheet ? null : <View style={styles.footerSpacer} />}
      {needsGrant && !blocked && !discuss ? (
        <RoundButton
          testID="second-opinion.quote-only"
          size={phoneSheet ? 'normal' : 'small'}
          display="inverted"
          title={t(
            'session.collaboration.discussion.secondOpinion.askQuoteOnly',
          )}
          disabled={!canAsk}
          action={() => ask('quote_only')}
        />
      ) : null}
      <RoundButton
        testID="second-opinion.ask"
        size={phoneSheet ? 'normal' : 'small'}
        style={phoneSheet ? styles.footerPrimaryWide : undefined}
        disabled={!canAsk}
        loading={snapshot.working && snapshot.submitted}
        title={
          discuss
            ? t('session.collaboration.discussion.create')
            : needsGrant
              ? t('session.collaboration.discussion.secondOpinion.shareAndAsk')
              : several
                ? t('session.collaboration.discussion.secondOpinion.askFreshOpinions', {
                    count: snapshot.draft.reviewers.length,
                  })
                : t('session.collaboration.discussion.secondOpinion.ask')
        }
        action={() =>
          snapshot.draft.reviewers.length === 0 ? controller.discuss().then(() => undefined) : ask()
        }
      />
    </>
  );

  return (
    <SheetFrame
      intent={props.intent}
      subtitle={subtitle}
      onClose={props.onClose}
      footer={footer}
      presentation={props.presentation}
      phoneSheet={phoneSheet}
    >
      {approval ? (
        <ActionApprovalPendingNotice
          presentation="banner"
          testID="second-opinion.approval-pending"
          message={t('approvals.waitingForYou')}
          description={t('session.collaboration.discussion.secondOpinion.approvalPendingBody')}
          onOpenApproval={() => router.pushRetainingCurrent(buildApprovalHref(approval.artifactId, binding.scope.serverId))}
        />
      ) : null}
      <ReplyQuote
        testID="second-opinion.quote"
        kind="message"
        form="passage"
        source={{
          state: 'available',
          label:
            sourceTitle ??
            t('session.collaboration.discussion.secondOpinion.answer'),
          text: quoteText,
        }}
      />
      {done ? null : approval ? (
        <LockedChoices
          reviewers={selectedReviewers}
          people={people.chosen.map(principal => principal.displayName)}
          question={question}
          serverId={binding.scope.serverId}
        />
      ) : (
        <ContextualStartComposerBody model={composer}
          whoHint={several ? null : t('session.collaboration.discussion.secondOpinion.freshOpinionsHint')} />
      )}
      {active && !done && preview ? (
        <ReadsSheet
          preview={preview}
          discuss={discuss}
          serverId={binding.scope.serverId}
          viewerAccountId={binding.scope.accountId}
          sourceTitle={sourceTitle}
        />
      ) : null}
      <ResultLine snapshot={snapshot} serverId={binding.scope.serverId} onRetry={() => void controller.retry()} />
    </SheetFrame>
  );
}

function SheetFrame(
  props: Readonly<{
    intent: DiscussionSecondOpinionIntent;
    subtitle: string | null;
    onClose: () => void;
    footer?: React.ReactNode;
    children: React.ReactNode;
    presentation?: 'dialog' | 'pane';
    phoneSheet?: boolean;
  }>,
) {
  const pane = props.presentation === 'pane';
  return (
    <View style={pane ? styles.paneForm : styles.form} testID="second-opinion.sheet">
      {pane ? (
        <DetailsTabHeader
          testID="second-opinion.header"
          title={sheetTitle(props.intent)}
          meta={props.subtitle ? [{ key: 'source', text: props.subtitle }] : undefined}
        />
      ) : <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.heading} accessibilityRole="header">
            {sheetTitle(props.intent)}
          </Text>
          {props.subtitle ? (
            <Text style={styles.meta} numberOfLines={1}>
              {props.subtitle}
            </Text>
          ) : null}
        </View>
      </View>}
      <ScrollView
        style={pane ? styles.paneScroll : styles.scroll}
        contentContainerStyle={pane ? [styles.body, styles.paneContent] : styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {props.children}
      </ScrollView>
      {props.footer ? <View style={[pane ? styles.paneFooter : styles.footer, props.phoneSheet ? styles.phoneFooter : null]}>{props.footer}</View> : null}
    </View>
  );
}

/** The chosen reviewers and the question as they were asked; nothing here changes while approval waits. */
function LockedChoices(props: Readonly<{
  reviewers: readonly ExecutableParticipantSelectionV1[];
  people: readonly string[];
  question: string;
  serverId: string;
}>) {
  return (
    <>
      <View>
        <View style={styles.hang}>
          <CollectionListGroupLabel title={t('agentStart.chips.engineTitle')} presentation="menu" />
        </View>
        <View testID="second-opinion.locked-choices" style={styles.locked}>
          {props.reviewers.map((selection, index) => (
            <LockedChoice key={`r${index}`} selection={selection} serverId={props.serverId} />
          ))}
          {props.people.map((name, index) => <LockedChoiceRow key={`p${index}`} title={name} />)}
        </View>
      </View>
      <View>
        <View style={styles.hang}>
          <CollectionListGroupLabel title={t('session.collaboration.discussion.secondOpinion.question')} presentation="menu" />
        </View>
        <Text style={styles.question}>{props.question}</Text>
      </View>
    </>
  );
}

function LockedChoice(props: Readonly<{ selection: ExecutableParticipantSelectionV1; serverId: string }>) {
  const label = useExecutableParticipantLabel(props.selection, props.serverId);
  return <LockedChoiceRow title={label ?? t('session.collaboration.discussion.heldParticipant')} />;
}

function LockedChoiceRow(props: Readonly<{ title: string }>) {
  const { theme } = useUnistyles();
  return <Item density="compact" showChevron={false} showDivider={false} title={props.title}
    rightElement={<Icon name="check" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />} />;
}

type ReviewerPreview = DiscussionSecondOpinionPreviewV1['reviewers'][number];
type ReadRowModel = Readonly<{ icon: IconName; title: string; body: string; warning?: boolean }>;

/** "What they can read": one line per party, saying what each will be able to open. */
function ReadsSheet(
  props: Readonly<{
    preview: DiscussionSecondOpinionPreviewV1;
    discuss: boolean;
    serverId: string;
    viewerAccountId: string;
    sourceTitle: string | null;
  }>,
) {
  const others = props.preview.discussionAudienceAccountIds.filter(
    (id) => id !== props.viewerAccountId,
  ).length;
  const discussionRow: ReadRowModel = props.preview.discussionDisclosure.ok
    ? {
        icon: 'users',
        title: t('session.collaboration.discussion.secondOpinion.discussionTitleRow'),
        body:
          others === 0
            ? t('session.collaboration.discussion.secondOpinion.discussionOnlyYou')
            : t('session.collaboration.discussion.secondOpinion.discussionPeople', { count: others }),
      }
    : {
        icon: 'warning',
        warning: true,
        title: t('session.collaboration.discussion.secondOpinion.discussionTitleRow'),
        body: disclosureReason(props.preview.discussionDisclosure.reason),
      };
  const reviewers = props.discuss ? [] : props.preview.reviewers;
  return (
    <View>
      <View style={styles.hang}>
        <CollectionListGroupLabel
          title={t('session.collaboration.discussion.secondOpinion.readsGroup')}
          presentation="menu"
        />
      </View>
      <View style={styles.reads}>
        {reviewers.map((reviewer, index) => (
          <ReviewerReadRow
            key={executableParticipantOptionId(reviewer.selection) + (reviewer.participantSlotId ?? '')}
            reviewer={reviewer}
            divider={index > 0}
            serverId={props.serverId}
            viewerAccountId={props.viewerAccountId}
            sourceTitle={props.sourceTitle}
          />
        ))}
        <ReadRow row={discussionRow} divider={reviewers.length > 0} />
      </View>
    </View>
  );
}

/** One reviewer's line, named through the shared participant label owner. */
function ReviewerReadRow(
  props: Readonly<{
    reviewer: ReviewerPreview;
    divider: boolean;
    serverId: string;
    viewerAccountId: string;
    sourceTitle: string | null;
  }>,
) {
  const { reviewer } = props;
  const name =
    useExecutableParticipantLabel(reviewer.selection, props.serverId) ??
    t('session.collaboration.discussion.heldParticipant');
  const session =
    props.sourceTitle ??
    t('session.collaboration.discussion.secondOpinion.thisSession');
  const row: ReadRowModel =
    !reviewer.disclosure.ok && !isRepairableSourceGap(reviewer)
      ? {
          icon: 'warning',
          warning: true,
          title: t('session.collaboration.discussion.secondOpinion.cannotAskTitle', { name }),
          body: disclosureReason(reviewer.disclosure.reason),
        }
      : reviewer.sourceAccess === 'quote_only'
        ? {
            icon: 'quotes',
            title: t('session.collaboration.discussion.secondOpinion.quoteOnlyTitle', { name }),
            body: t('session.collaboration.discussion.secondOpinion.quoteOnlyBody'),
          }
        : reviewer.missingSourceAccountIds.length > 0
          ? {
              icon: 'eye',
              title: t('session.collaboration.discussion.secondOpinion.grantTitle', { name }),
              body: reviewer.canGrantSource
                ? t('session.collaboration.discussion.secondOpinion.grantBody', { name, session })
                : t('session.collaboration.discussion.secondOpinion.grantUnavailable'),
            }
          : {
              icon: 'eye',
              title:
                reviewer.runtimeAccountId === props.viewerAccountId
                  ? t('session.collaboration.discussion.secondOpinion.readsAsYouTitle', { name })
                  : t('session.collaboration.discussion.secondOpinion.readsTitle', { name }),
              body: t('session.collaboration.discussion.secondOpinion.readsAsYouBody'),
            };
  return <ReadRow row={row} divider={props.divider} />;
}

function ReadRow(props: Readonly<{ row: ReadRowModel; divider: boolean }>) {
  const { theme } = useUnistyles();
  return (
    <View style={[styles.readRow, props.divider ? styles.readDivider : null]}>
      <Icon
        name={props.row.icon}
        size={ICON_SIZE.sm}
        color={
          props.row.warning
            ? theme.colors.state.warning.foreground
            : theme.colors.text.secondary
        }
      />
      <View style={styles.readText}>
        <Text style={styles.readTitle}>{props.row.title}</Text>
        <Text style={styles.meta}>{props.row.body}</Text>
      </View>
    </View>
  );
}

function disclosureReason(reason: string): string {
  switch (reason) {
    case 'same_session':
      return t(
        'session.collaboration.discussion.secondOpinion.disclosure.sameSession',
      );
    case 'destination_audience_broader':
      return t(
        'session.collaboration.discussion.secondOpinion.disclosure.broader',
      );
    case 'destination_public':
      return t(
        'session.collaboration.discussion.secondOpinion.disclosure.public',
      );
    case 'configurer_not_allowed':
    case 'destination_runtime_not_allowed':
      return t(
        'session.collaboration.discussion.secondOpinion.disclosure.notAllowed',
      );
    default:
      return t(
        'session.collaboration.discussion.secondOpinion.disclosure.unavailable',
      );
  }
}

function ResultLine(
  props: Readonly<{
    snapshot: DiscussionSecondOpinionSnapshot;
    serverId: string;
    onRetry: () => void;
  }>,
) {
  const outcome = props.snapshot.result?.outcome;
  if (!outcome || props.snapshot.working) return null;
  // Waiting on approval is the form's own state: its banner leads the sheet (see BoundForm).
  if (outcome.kind === 'approval_request_created') return null;
  if (outcome.kind !== 'succeeded') {
    return (
      <SurfaceStateCard
        size="line"
        kind="error"
        testID="second-opinion.failed"
        title={t('session.collaboration.discussion.secondOpinion.failed')}
        diagnosticCode={outcome.errorCode}
        action={
          props.snapshot.submitted
            ? {
                label: t('session.collaboration.discussion.retry'),
                onPress: props.onRetry,
              }
            : undefined
        }
      />
    );
  }
  const value = outcome.value;
  if (!('status' in value)) return null;
  if (value.status === 'pending') {
    return (
      <SurfaceStateCard
        size="line"
        kind="warning"
        testID="second-opinion.pending"
        title={t('session.collaboration.discussion.secondOpinion.pending')}
        diagnosticCode={value.errorCode}
        action={{
          label: t('session.collaboration.discussion.retry'),
          onPress: props.onRetry,
        }}
      />
    );
  }
  if (value.status === 'preview_changed') {
    return (
      <SurfaceStateCard
        size="line"
        kind="warning"
        testID="second-opinion.changed"
        title={t(
          'session.collaboration.discussion.secondOpinion.previewChanged',
        )}
      />
    );
  }
  return null;
}

const styles = StyleSheet.create((theme) => ({
  form: {
    paddingVertical: theme.space.s16,
    gap: theme.space.s12,
    flexShrink: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    paddingHorizontal: theme.space.s16,
  },
  headerText: { flex: 1, minWidth: 0 },
  // The sheet's one anchor, as the Discussion's other sheets title themselves (lab T3-Ap).
  heading: {
    ...Typography.variant('heading', 'semiBold'),
    color: theme.colors.text.primary,
  },
  meta: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  scroll: { flexShrink: 1 },
  body: { paddingHorizontal: theme.space.s16, gap: theme.space.s12 },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s8,
    paddingRight: HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx,
  },
  // Lab T3-A: every heading, the quote, the fields and the row marks share the form's one edge, so menu rows
  // and their group labels hang their own inset into the gutter and a chosen row's tint reaches past it.
  hang: { marginHorizontal: -HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx },
  groupNote: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
  reads: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    borderRadius: theme.borderRadius.md,
  },
  readRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s10,
    padding: theme.space.s12,
  },
  readDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  readText: { flex: 1, minWidth: 0, gap: theme.space.s2 },
  // Read like the reviewer rows above (lab T3-A): the title in the rows' weight, the consequence beneath.
  readTitle: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
  },
  footerSpacer: { flex: 1 },
  footerPrimaryWide: { flex: 1 },
  phoneFooter: { paddingTop: theme.space.s8 },
  locked: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    borderRadius: theme.borderRadius.md,
    overflow: 'hidden',
  },
  question: { ...Typography.variant('body'), color: theme.colors.text.primary },
  modalBody: {
    width: '100%',
    flexShrink: 1,
  },
  paneBody: { flex: 1, minHeight: 0 },
  // The pane keeps its height while reviewers change; its footer stays pinned to the bottom edge.
  paneForm: { flex: 1, minHeight: 0 },
  paneScroll: { flex: 1 },
  paneContent: { paddingVertical: theme.space.s12 },
  paneFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
}));

import * as React from 'react';
import { type LayoutChangeEvent, StyleSheet as RNStyleSheet, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import type { SessionDraftSessionMessagingValueV1 } from '@happier-dev/protocol/drafts/sessionDrafts';
import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import { projectSessionFollowerCensus } from '@/components/sessions/collaboration/SessionPeopleFollowSections';
import { useSessionFollowers } from '@/components/sessions/follow/useSessionFollowers';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { participantRecipientsMatch } from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { t } from '@/text';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { useDiscussionTitleProjections } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { useSessionSelector } from '@/sync/domains/state/storage';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

import { AGENT_INPUT_MENU_ICON_SIZE_PX } from '../definitions/agentInputChipIconMetrics';
import { resolveSessionParticipantTargetLabel } from './recipientOptions';
import { SessionTalkDiscussionChoices } from './SessionTalkDiscussionChoices';
import { createSessionTalkMatchingFilter, SessionTalkMatchingStep } from './SessionTalkMatchingStep';
import { useSessionTalkTargets, type SessionTalkTargets } from './sessionTalkTargets';
import { SessionTalkModelStep } from './SessionTalkModelStep';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

export type SessionTalkIntent = SessionDraftSessionMessagingValueV1;
export type SessionTalkVerb = 'send' | 'ask' | 'post_update';
/** The selectors the composer offers, each previewed by the Action's own resolver. */
export type SessionTalkSelector = 'manager' | 'workers' | 'siblings' | 'followers' | 'following' | 'matching' | 'discussion';
/** A chosen selector: Discussion carries which Discussion, Matching its filter (never the rows it showed). */
export type SessionTalkTarget =
  | Readonly<{ selector: Exclude<SessionTalkSelector, 'discussion' | 'matching'> }>
  | Readonly<{ selector: 'matching'; filter: SessionListFilterV1 }>
  | Readonly<{ selector: 'discussion'; discussionId: string }>;

const RELATION_SELECTORS = [
  'manager',
  'workers',
  'siblings',
  'followers',
  'following',
] as const satisfies readonly SessionTalkSelector[];
const SELECTOR_ICON: Readonly<Record<SessionTalkSelector, IconName>> = {
  manager: 'tree-structure',
  workers: 'arrow-elbow-down-right',
  siblings: 'arrows-left-right',
  followers: 'bell',
  following: 'eye',
  matching: 'funnel-simple',
  discussion: 'chats-circle',
};

export function readSessionTalkVerb(
  intent: SessionTalkIntent | null,
): SessionTalkVerb | null {
  return intent
    ? intent.kind === 'post_update'
      ? 'post_update'
      : intent.kind === 'ask_new_session' ? 'ask' : intent.kind
    : null;
}

export function readSessionTalkTarget(
  intent: SessionTalkIntent | null,
): SessionTalkTarget | null {
  if (
    !intent ||
    intent.kind === 'post_update' ||
    intent.kind === 'ask_new_session' ||
    typeof intent.target === 'string'
  )
    return null;
  const target = intent.target;
  if (target.selector === 'discussion') return { selector: 'discussion', discussionId: target.discussionId };
  if (target.selector === 'matching') return { selector: 'matching', filter: target.filter };
  return (RELATION_SELECTORS as readonly string[]).includes(target.selector)
    ? { selector: target.selector as (typeof RELATION_SELECTORS)[number] }
    : null;
}

export function readSessionTalkSelector(
  intent: SessionTalkIntent | null,
): SessionTalkSelector | null {
  return readSessionTalkTarget(intent)?.selector ?? null;
}

/** Ask always returns its answers here: the composer has no inline reader for a waited answer. */
export function buildSessionTalkIntent(
  verb: SessionTalkVerb,
  target: SessionTalkTarget | null,
): SessionTalkIntent | null {
  if (verb === 'post_update') return { kind: 'post_update' };
  if (!target) return null;
  return verb === 'ask'
    ? { kind: 'ask', target, reply: 'return' }
    : { kind: 'send', target };
}

export function selectorTitle(selector: SessionTalkSelector): string {
  return t(`session.participants.talk.${selector}`);
}

export type SessionTalkPickerProps = Readonly<{
  sessionId: string;
  serverId: string | null;
  intent: SessionTalkIntent | null;
  onIntentChange: (next: SessionTalkIntent | null) => void;
  /** The inside-Session roster (Agent team, Runs) keeps its own recipient contract. */
  participants: Readonly<{
    targets: readonly SessionParticipantTarget[];
    recipient: ParticipantRecipientV1 | null;
    onRecipientChange: (next: ParticipantRecipientV1 | null) => void;
  }> | null;
  requestClose: () => void;
  /** The popover's height budget for the picker; a step never asks for more. */
  maxHeight?: number;
}>;

/**
 * The composer's To picker (coordination lab T1): the verb first (Send · Ask · Post update), then the
 * sessions it goes to, each named as it resolves now. "This session" returns to ordinary chat. People
 * are never addressed here.
 */
export function SessionTalkPicker(props: SessionTalkPickerProps) {
  const { theme } = useUnistyles();
  const [verb, setVerb] = React.useState<SessionTalkVerb>(
    () => readSessionTalkVerb(props.intent) ?? 'ask',
  );
  const selectedTarget = readSessionTalkTarget(props.intent);
  const selected = selectedTarget?.selector ?? null;
  // The Discussion selector needs one Discussion; the step below chooses it, and the row then previews it.
  const [step, setStep] = React.useState<'targets' | 'discussion' | 'matching' | 'model'>('targets');
  const sourceMachineId = useSessionSelector(props.sessionId, props.serverId, session => session?.metadata?.machineId ?? null);
  const sourceDirectory = useSessionSelector(props.sessionId, props.serverId, session => session?.metadata?.path ?? null);
  const modelLaunch = props.intent?.kind === 'ask_new_session' ? props.intent.launch : null;
  const modelTarget = modelLaunch?.executionTarget ?? (props.serverId && sourceMachineId
    ? { serverId: props.serverId, machineId: sourceMachineId } : null);
  const modelPresence = useMachinePresenceSummary(modelTarget?.serverId, modelTarget?.machineId);
  const modelAvailable = modelTarget !== null && modelPresence.reachability === 'reachable';
  const [discussionId, setDiscussionId] = React.useState<string | null>(
    () => (selectedTarget?.selector === 'discussion' ? selectedTarget.discussionId : null),
  );
  const [commitDiscussion, setCommitDiscussion] = React.useState(false);
  // Matching previews the chosen filter; while its step is open, the filter being edited.
  const chosenFilter = selectedTarget?.selector === 'matching' ? selectedTarget.filter : null;
  const [draftFilter, setDraftFilter] = React.useState<SessionListFilterV1 | null>(null);
  const matchingFilter = step === 'matching' ? draftFilter : chosenFilter;
  const targets = useSessionTalkTargets(props.sessionId, props.serverId, {
    enabled: verb !== 'post_update' && step !== 'model',
    ...(step === 'matching' ? { selectors: ['matching'] as const } : step === 'discussion' ? { selectors: ['discussion'] as const } : {}),
    ...(discussionId ? { discussionId } : {}),
    ...(matchingFilter ? { matchingFilter } : {}),
  });
  const matchingSummary = useMatchingSummary(targets.matching);
  const discussionTitle = useDiscussionTitleProjections(React.useMemo(
    () => (discussionId ? [{ serverId: props.serverId, discussionId }] : []),
    [discussionId, props.serverId],
  ))[0] ?? null;
  const participantTargets = props.participants?.targets ?? [];
  const chatSelected = props.intent === null && !props.participants?.recipient;

  // Post update and back restores the sessions chosen before (lab T1u).
  const lastTarget = React.useRef(selectedTarget);
  if (selectedTarget) lastTarget.current = selectedTarget;
  const chooseVerb = React.useCallback(
    (next: SessionTalkVerb) => {
      setVerb(next);
      setStep('targets');
      if (next === 'post_update') props.onIntentChange({ kind: 'post_update' });
      else if (next === 'ask' && props.intent?.kind === 'ask_new_session') return;
      else if (props.intent)
        props.onIntentChange(buildSessionTalkIntent(next, lastTarget.current));
    },
    [props.intent, props.onIntentChange],
  );
  // The popover keeps its height while the list turns into the audience, a step, and back.
  const [bodyMinHeight, setBodyMinHeight] = React.useState(0);
  const onBodyLayout = React.useCallback((event: LayoutChangeEvent) => {
    const height = Math.ceil(event.nativeEvent.layout.height);
    setBodyMinHeight((current) => (height > current ? height : current));
  }, []);
  // The Matching step brings its own footer and takes the people footer's place in the same frame.
  const [footerHeight, setFooterHeight] = React.useState(0);
  const onFooterLayout = React.useCallback((event: LayoutChangeEvent) => {
    setFooterHeight(Math.ceil(event.nativeEvent.layout.height));
  }, []);
  const [verbHeight, setVerbHeight] = React.useState(0);
  const onVerbLayout = React.useCallback((event: LayoutChangeEvent) => {
    setVerbHeight(Math.ceil(event.nativeEvent.layout.height));
  }, []);
  // The step takes the frame the list set (its body plus the people footer and its margin), within the popover's budget.
  const listFrame = bodyMinHeight > 0 ? bodyMinHeight + footerHeight + theme.space.s8 : undefined;
  const budget = props.maxHeight !== undefined ? props.maxHeight - verbHeight - 2 * theme.space.s8 : undefined;
  const matchingFrame = listFrame !== undefined && budget !== undefined ? Math.min(listFrame, budget) : listFrame ?? budget;
  const inlineStep = step === 'matching' || step === 'model';

  const chooseTarget = (target: SessionTalkTarget) => {
    props.participants?.onRecipientChange(null);
    props.onIntentChange(buildSessionTalkIntent(verb, target));
    props.requestClose();
  };
  // A Discussion chosen in its step is sent to once the Action's preview proves who is in it.
  const discussionPreview = targets.discussion;
  const discussionReady = discussionPreview.coverage === 'complete' && discussionPreview.addresses.length > 0;
  React.useEffect(() => {
    if (!commitDiscussion || !discussionId || discussionPreview.loading) return;
    setCommitDiscussion(false);
    if (discussionReady) chooseTarget({ selector: 'discussion', discussionId });
  });
  const chooseDiscussion = (id: string) => {
    setDiscussionId(id);
    setCommitDiscussion(true);
    setStep('targets');
  };
  const chooseChat = () => {
    props.onIntentChange(null);
    props.participants?.onRecipientChange(null);
    props.requestClose();
  };
  const chooseParticipant = (target: SessionParticipantTarget) => {
    props.onIntentChange(null);
    props.participants?.onRecipientChange(target.recipient);
    props.requestClose();
  };

  const verbTabs = React.useMemo(
    () => [
      { id: 'send' as const, label: t('session.participants.talk.verbSend') },
      { id: 'ask' as const, label: t('session.participants.talk.verbAsk') },
      {
        id: 'post_update' as const,
        label: t('session.participants.talk.verbPostUpdate'),
      },
    ],
    [],
  );
  const iconColor = theme.colors.text.secondary;
  const check = (
    <Icon
      name="check"
      size={AGENT_INPUT_MENU_ICON_SIZE_PX}
      color={theme.colors.text.primary}
    />
  );
  return (
    <View style={styles.root} testID="session-talk-picker">
      <View style={styles.verb} onLayout={onVerbLayout}>
        <SegmentedTabBar<SessionTalkVerb>
          tabs={verbTabs}
          activeTabId={verb}
          onSelectTab={chooseVerb}
          role="radiogroup"
          accessibilityLabel={t('session.participants.talk.verbLabel')}
          testIDPrefix="session-talk-verb"
        />
        <Text variant="meta" style={styles.verbMeaning}>
          {t(
            verb === 'send'
              ? 'session.participants.talk.meaningSend'
              : verb === 'ask'
                ? 'session.participants.talk.meaningAsk'
                : 'session.participants.talk.meaningPostUpdate',
          )}
        </Text>
      </View>
      {/* Inline steps fill the frame the list set; they never grow it. */}
      <View
        style={{ minHeight: inlineStep ? matchingFrame ?? 0 : bodyMinHeight }}
        onLayout={inlineStep ? undefined : onBodyLayout}
      >
      {verb === 'post_update' ? (
        <SessionTalkAudience
          sessionId={props.sessionId}
          serverId={props.serverId}
        />
      ) : step === 'model' && modelTarget ? (
        <SessionTalkModelStep
          target={modelTarget}
          seed={modelLaunch ? { existingDraft: modelLaunch } : { ...(sourceDirectory ? { directory: sourceDirectory } : {}) }}
          frameHeight={matchingFrame}
          onBack={() => setStep('targets')}
          onUse={launch => {
            props.participants?.onRecipientChange(null);
            props.onIntentChange({ kind: 'ask_new_session', launch });
            props.requestClose();
          }}
        />
      ) : step === 'matching' && props.serverId && draftFilter ? (
        <SessionTalkMatchingStep
          serverId={props.serverId}
          filter={draftFilter}
          onFilterChange={setDraftFilter}
          summary={matchingSummary}
          canUse={targets.matching.coverage === 'complete' && targets.matching.addresses.length > 0}
          onUse={() => chooseTarget({ selector: 'matching', filter: draftFilter })}
          onBack={() => setStep('targets')}
          frameHeight={matchingFrame}
        />
      ) : step === 'discussion' && props.serverId ? (
        <SessionTalkDiscussionChoices
          sessionId={props.sessionId}
          serverId={props.serverId}
          selectedId={discussionId}
          onChoose={chooseDiscussion}
          onBack={() => setStep('targets')}
        />
      ) : (
        <View>
          <CollectionListGroupLabel
            title={t('session.participants.to')}
            presentation="menu"
          />
          <Item
            testID="session-talk-target:self"
            rowRole="menu"
            icon={
              <Icon
                name="chat-circle"
                size={AGENT_INPUT_MENU_ICON_SIZE_PX}
                color={iconColor}
              />
            }
            title={t('session.participants.lead')}
            subtitle={t('session.participants.talk.selfSubtitle')}
            selected={chatSelected}
            rightElement={chatSelected ? check : undefined}
            showChevron={false}
            showDivider={false}
            accessibilityRole="radio"
            accessibilityChecked={chatSelected}
            onPress={chooseChat}
          />
          {RELATION_SELECTORS.map((selector) => {
            const preview = targets[selector];
            const isSelected = selected === selector;
            return (
              <Item
                key={selector}
                testID={`session-talk-target:${selector}`}
                rowRole="menu"
                icon={<Icon name={SELECTOR_ICON[selector]} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={iconColor} />}
                title={selectorTitle(selector)}
                subtitle={describeTalkPreview(preview)}
                detail={preview.coverage === 'complete' && preview.names.length > 0 ? String(preview.names.length) : undefined}
                selected={isSelected}
                rightElement={isSelected ? check : undefined}
                disabled={preview.coverage !== 'complete' || preview.names.length === 0}
                showChevron={false}
                showDivider={false}
                accessibilityRole="radio"
                accessibilityChecked={isSelected}
                onPress={() => chooseTarget({ selector })}
              />
            );
          })}
          {verb === 'ask' ? <Item
            testID="session-talk-target:model"
            rowRole="menu"
            title={t('session.participants.talk.modelChoose')}
            subtitle={modelAvailable ? t('session.participants.talk.modelHint') : t('newSession.recipeComposerMachineNotReady')}
            disabled={!modelAvailable}
            selected={modelLaunch !== null}
            showDivider={false}
            onPress={() => setStep('model')}
          /> : null}
          <Item
            testID="session-talk-target:matching"
            rowRole="menu"
            icon={<Icon name={SELECTOR_ICON.matching} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={iconColor} />}
            title={chosenFilter ? selectorTitle('matching') : t('session.participants.talk.matchingChoose')}
            subtitle={chosenFilter ? describeTalkPreview(targets.matching) : t('session.participants.talk.matchingHint')}
            detail={chosenFilter && targets.matching.coverage === 'complete' && targets.matching.names.length > 0
              ? String(targets.matching.names.length) : undefined}
            selected={selected === 'matching'}
            rightElement={selected === 'matching' ? check : undefined}
            showChevron={selected !== 'matching'}
            showDivider={false}
            accessibilityRole="radio"
            accessibilityChecked={selected === 'matching'}
            onPress={() => {
              if (!props.serverId) return;
              setDraftFilter(chosenFilter ?? createSessionTalkMatchingFilter(props.serverId));
              setStep('matching');
            }}
          />
          <Item
            testID="session-talk-target:discussion"
            rowRole="menu"
            icon={<Icon name={SELECTOR_ICON.discussion} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={iconColor} />}
            title={discussionTitle ?? selectorTitle('discussion')}
            subtitle={discussionId ? describeTalkPreview(discussionPreview) : t('session.participants.talk.chooseDiscussion')}
            detail={discussionReady ? String(discussionPreview.names.length) : undefined}
            selected={selected === 'discussion'}
            // Ready, it sends there; otherwise (none chosen, or one that can't be reached) it opens the choice.
            rightElement={selected === 'discussion' ? check : undefined}
            showChevron={!discussionReady}
            showDivider={false}
            accessibilityRole="radio"
            accessibilityChecked={selected === 'discussion'}
            onPress={() => (discussionReady && discussionId
              ? chooseTarget({ selector: 'discussion', discussionId })
              : setStep('discussion'))}
          />
          {participantTargets.length > 0 ? (
            <>
              <CollectionListGroupLabel
                title={t('session.participants.talk.insideSession')}
                presentation="menu"
              />
              {participantTargets.map((target) => {
                const isSelected = Boolean(
                  props.participants?.recipient &&
                  participantRecipientsMatch(
                    target.recipient,
                    props.participants.recipient,
                  ),
                );
                return (
                  <Item
                    key={target.key}
                    testID={`session-talk-participant:${target.key}`}
                    rowRole="menu"
                    title={resolveSessionParticipantTargetLabel(target)}
                    selected={isSelected}
                    rightElement={isSelected ? check : undefined}
                    showChevron={false}
                    showDivider={false}
                    accessibilityRole="radio"
                    accessibilityChecked={isSelected}
                    onPress={() => chooseParticipant(target)}
                  />
                );
              })}
            </>
          ) : null}
        </View>
      )}
      </View>
      {(step === 'matching' || step === 'model') && verb !== 'post_update' ? null : (
      <View style={styles.footer} onLayout={onFooterLayout}>
        <Icon
          name="users"
          size={AGENT_INPUT_MENU_ICON_SIZE_PX}
          color={iconColor}
        />
        <Text variant="meta" style={styles.footerText}>
          {t('session.participants.talk.peopleFooter')}
        </Text>
      </View>
      )}
    </View>
  );
}

/**
 * The Matching step's footer line: how many sessions the filter reaches now. While a new filter is
 * checked, the last answer stays with "refreshing" rather than flashing to Loading (lab T1 stale).
 */
function useMatchingSummary(preview: SessionTalkTargets['matching']): string {
  const last = React.useRef<string | null>(null);
  if (preview.loading && preview.names.length === 0) {
    return last.current
      ? `${last.current} · ${t('session.participants.talk.refreshing')}`
      : t('common.loading');
  }
  const summary = preview.coverage === 'complete'
    ? preview.names.length === 0
      ? t('session.participants.talk.noMatches')
      : `${t('session.participants.talk.matchCount', { count: preview.names.length })} · ${summarizeNames(preview.names)}`
    : describeTalkPreview(preview);
  if (preview.coverage === 'complete') last.current = summary;
  return summary;
}

/**
 * One line for a selector's preview: who it reaches now, or why that isn't known. Unloaded or unreachable
 * relations never read as empty; only a complete preview with nobody in it says "None right now".
 */
function describeTalkPreview(preview: SessionTalkTargets[SessionTalkSelector]): string {
  if (preview.loading && preview.names.length === 0) return t('common.loading');
  if (preview.coverage === 'unavailable') return t('session.participants.talk.unavailable');
  if (preview.coverage === 'partial') {
    return `${summarizeNames(preview.names)} · ${t('session.participants.talk.partial')}`;
  }
  return preview.names.length === 0 ? t('session.participants.talk.noneNow') : summarizeNames(preview.names);
}

/** "A, B" up to two names, then "A, B +N" (the approval preview lists everyone). */
function summarizeNames(names: readonly string[]): string {
  const shown = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

/**
 * Post update turns the list into its live audience: each Session that follows this one, with how an
 * update reaches it under its own policies (one level table for people and sessions), and people as a
 * count. Mounted only while Post update is chosen.
 */
function SessionTalkAudience(
  props: Readonly<{ sessionId: string; serverId: string | null }>,
) {
  const { theme } = useUnistyles();
  const address = React.useMemo(
    () => ({ serverId: props.serverId ?? '', sessionId: props.sessionId }),
    [props.serverId, props.sessionId],
  );
  const followers = useSessionFollowers(address, Boolean(props.serverId));
  // One census owner with People: one row per receiving session, its relations' effective union.
  const census = React.useMemo(
    () => projectSessionFollowerCensus(followers.projection),
    [followers.projection],
  );
  const receivers = React.useMemo(
    () =>
      (census.sessions ?? []).map((follower) => {
        const delivery = follower.effective.updatePosted.delivery;
        return {
          sessionId: follower.sessionId,
          manager: follower.manager,
          arrival:
            delivery === 'wake'
              ? ('wake' as const)
              : delivery === 'next_turn'
                ? ('nextTurn' as const)
                : ('none' as const),
        };
      }),
    [census.sessions],
  );
  const titles = useSessionDisplayTitles(
    React.useMemo(
      () =>
        receivers.map((receiver) => ({
          sessionId: receiver.sessionId,
          serverId: props.serverId,
        })),
      [receivers, props.serverId],
    ),
  );
  const peopleCount = census.peopleCount ?? 0;
  const iconColor = theme.colors.text.secondary;
  const settled = followers.projection !== null;

  return (
    <View testID="session-talk-audience">
      <CollectionListGroupLabel
        title={t('session.participants.talk.whoHears')}
        presentation="menu"
      />
      {!settled ? (
        <Item
          rowRole="menu"
          mode="info"
          loading={followers.loading}
          title={
            followers.loading
              ? t('common.loading')
              : t('session.participants.talk.audienceUnavailable')
          }
          rightElement={
            followers.loading ? undefined : (
              <HappierPressable
                accessibilityRole="button"
                onPress={followers.refresh}
                testID="session-talk-audience-retry"
              >
                <Text variant="meta" style={styles.link}>
                  {t('common.retry')}
                </Text>
              </HappierPressable>
            )
          }
          showChevron={false}
          showDivider={false}
        />
      ) : receivers.length === 0 && peopleCount === 0 ? (
        <Item
          rowRole="menu"
          mode="info"
          title={t('session.participants.talk.noAudience')}
          showChevron={false}
          showDivider={false}
        />
      ) : (
        <>
          {receivers.map((receiver, index) => (
            <Item
              key={receiver.sessionId}
              testID={`session-talk-audience:${receiver.sessionId}`}
              rowRole="menu"
              mode="info"
              icon={
                <Icon
                  name="chat-circle"
                  size={AGENT_INPUT_MENU_ICON_SIZE_PX}
                  color={iconColor}
                />
              }
              title={titles[index] ?? t('message.provenanceSession')}
              subtitle={t(
                receiver.manager
                  ? 'session.participants.talk.managesIt'
                  : 'session.participants.talk.followsIt',
              )}
              detail={t(
                receiver.arrival === 'wake'
                  ? 'session.participants.talk.arrivalWake'
                  : receiver.arrival === 'nextTurn'
                    ? 'session.participants.talk.arrivalNextTurn'
                    : 'session.participants.talk.arrivalNone',
              )}
              showChevron={false}
              showDivider={false}
            />
          ))}
          {peopleCount > 0 ? (
            <Item
              testID="session-talk-audience:people"
              rowRole="menu"
              mode="info"
              icon={
                <Icon
                  name="users"
                  size={AGENT_INPUT_MENU_ICON_SIZE_PX}
                  color={iconColor}
                />
              }
              title={t('session.participants.talk.people', {
                count: peopleCount,
              })}
              subtitle={t('session.participants.talk.peopleLevel')}
              showChevron={false}
              showDivider={false}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    paddingVertical: theme.space.s8,
  },
  verb: {
    paddingHorizontal: theme.space.s12,
    paddingBottom: theme.space.s8,
    gap: theme.space.s8,
  },
  verbMeaning: {
    color: theme.colors.text.secondary,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    marginTop: theme.space.s8,
    paddingTop: theme.space.s10,
    paddingHorizontal: theme.space.s12,
    borderTopWidth: RNStyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  link: {
    color: theme.colors.text.link,
  },
  footerText: {
    flex: 1,
    color: theme.colors.text.secondary,
  },
}));

import * as React from 'react';
import type { ReactElement } from 'react';
import {
  Avatar,
  Banner,
  Button,
  Card,
  DiffStat,
  FreshnessLine,
  formatHappierAsOfTime,
  Icon,
  Menu,
  Row,
  Spinner,
  Stack,
  Text,
  usePluginTranslation,
  type MenuItem,
  type TextTone,
} from '@happier-dev/plugin-ui';
import type {
  SessionPullRequestWatchModeV1,
  SessionPullRequestWatchPolicyV1,
} from '@happier-dev/channels-protocol/v1';

import type { TriageConfigureSourceOfferV1, TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';
import type { TriageSessionPullRequestBindingV1 } from '../sessionPullRequestStatus.js';
import {
  projectPullRequestGlanceV1,
  projectPullRequestStatusFactsV1,
  type PullRequestGlanceV1,
  type PullRequestStatusFactsV1,
} from './glanceModel.js';
import { useConfigureSourceRecoveryV1 } from './useGlanceNavigation.js';
import { PullRequestFailureDetails } from './PullRequestReadFailure.js';
import { capitalizeFirst, checksFact, reviewFact, mergeFact, watchLineText } from './factPresentation.js';

type Translate = ReturnType<typeof usePluginTranslation>;

/** The fact key column holds the longest of Checks/Review/Merge in every locale without moving the values. */
const FACT_KEY_STYLE = { minWidth: 64 } as const;

export const PULL_REQUEST_WATCH_MODES_V1: readonly SessionPullRequestWatchModeV1[] =
  ['off', 'notify', 'analyse', 'address', 'autoFix'];

export function pullRequestWatchModeLabelV1(
  text: Translate,
  mode: SessionPullRequestWatchModeV1,
): string {
  switch (mode) {
    case 'off':
      return text('plugins.triage.prWatch.mode.off', 'Off');
    case 'notify':
      return text('plugins.triage.prWatch.mode.notify', 'Notify');
    case 'analyse':
      return text('plugins.triage.prWatch.mode.analyse', 'Analyse');
    case 'address':
      return text('plugins.triage.prWatch.mode.address', 'Address');
    case 'autoFix':
      return text('plugins.triage.prWatch.mode.autoFix', 'Auto-fix');
  }
}

/** What each mode does, said with the session's own agent name (never a vendor name). */
export function pullRequestWatchModeConsequenceV1(
  text: Translate,
  mode: SessionPullRequestWatchModeV1,
  agent: string | null,
): string {
  // Every consequence starts its sentence with the agent; a missing name reads "The agent".
  const values = {
    agent: capitalizeFirst(agent ?? text('plugins.triage.prWatch.theAgent', 'the agent')),
  };
  switch (mode) {
    case 'off':
      return text(
        'plugins.triage.prWatch.mode.offDetail',
        'Stays linked. Nothing is watched.',
      );
    case 'notify':
      return text(
        'plugins.triage.prWatch.mode.notifyDetail',
        'You’re notified. {agent} isn’t woken.',
        values,
      );
    case 'analyse':
      return text(
        'plugins.triage.prWatch.mode.analyseDetail',
        '{agent} investigates and reports here, read-only.',
        values,
      );
    case 'address':
      return text(
        'plugins.triage.prWatch.mode.addressDetail',
        '{agent} fixes; you approve pushes and replies.',
        values,
      );
    case 'autoFix':
      return text(
        'plugins.triage.prWatch.mode.autoFixDetail',
        '{agent} fixes, pushes this branch and replies on the PR.',
        values,
      );
  }
}



function Fact(
  props: Readonly<{
    label: string;
    value: string;
    tone: TextTone;
    sub: string | null;
    lead?: ReactElement | null;
    testID: string;
  }>,
): ReactElement {
  return (
    <Row gap="small" align="center" testID={props.testID}>
      <Stack style={FACT_KEY_STYLE}>
        <Text variant="meta" tone="secondary" value={props.label} />
      </Stack>
      <Row gap="xsmall" align="center" grow>
        {props.lead ?? null}
        <Text
          variant="label"
          tone={props.tone}
          value={props.value}
          numberOfLines={1}
        />
        {props.sub === null ? null : (
          <Stack grow>
            <Text
              variant="meta"
              tone="secondary"
              value={props.sub}
              numberOfLines={1}
            />
          </Stack>
        )}
      </Row>
    </Row>
  );
}

/** Checks · Review · Merge: the same three facts in the glance, the Git/Project card and the linked-entry detail. */
export function PullRequestFacts(
  props: Readonly<{ model: PullRequestStatusFactsV1 }>,
): ReactElement | null {
  const text = usePluginTranslation();
  const { model } = props;
  if (model.merge.kind === 'merged' || model.merge.kind === 'closed') {
    // A finished PR folds its facts into the one that still matters.
    const merge = mergeFact(text, model.merge, model.branch?.base ?? null);
    return (
      <Stack gap="small" testID="pr-glance.facts">
        <Fact testID="pr-glance.merge" label={text('plugins.triage.sessionLinks.status.merge', 'Merge')} {...merge}
          lead={<Icon name={model.merge.kind === 'merged' ? 'change-complete' : 'close'} size="small" tone="secondary" />} />
      </Stack>
    );
  }
  const checks = checksFact(text, model.checks);
  const review = reviewFact(text, model.review);
  const merge = mergeFact(text, model.merge, model.branch?.base ?? null);
  const checkLead =
    checks.lead === 'failed' ? (
      <Icon name="error" size="small" tone="danger" />
    ) : checks.lead === 'running' ? (
      <Spinner size="small" tone="secondary" accessibilityLabel={checks.value} />
    ) : checks.lead === 'passed' ? (
      <Icon name="check" size="small" tone="secondary" />
    ) : null;
  return (
    <Stack gap="small" testID="pr-glance.facts">
      <Fact
        testID="pr-glance.checks"
        label={text('plugins.triage.sessionLinks.status.checks', 'Checks')}
        {...checks}
        lead={checkLead}
      />
      <Fact
        testID="pr-glance.review"
        label={text('plugins.triage.sessionLinks.fact.review', 'Review')}
        {...review}
        lead={
          review.person === null ? null : (
            <Avatar name={review.person} size="small" />
          )
        }
      />
      <Fact
        testID="pr-glance.merge"
        label={text('plugins.triage.sessionLinks.status.merge', 'Merge')}
        {...merge}
      />
    </Stack>
  );
}

/** The status facts for a linked entry that has a 06 status but no Session watch (the linked-entry detail). */
export function PullRequestStatusFacts(props: Readonly<{ status: TriagePullRequestStatusV1 }>): ReactElement | null {
  const model = React.useMemo(() => projectPullRequestStatusFactsV1(props.status), [props.status]);
  return (
    <Stack gap="small">
      {model.branch === null ? null : (
        <Row gap="xsmall" align="center" wrap>
          <Text variant="code" value={model.branch.head} numberOfLines={1} />
          <Icon name="forward" size="small" tone="muted" />
          <Text variant="code" value={model.branch.base} numberOfLines={1} />
          {props.status.branch?.additions !== undefined || props.status.branch?.deletions !== undefined ? (
            <DiffStat added={props.status.branch?.additions ?? 0} removed={props.status.branch?.deletions ?? 0} />
          ) : null}
        </Row>
      )}
      <PullRequestFacts model={model} />
    </Stack>
  );
}

/** The PR's identity: title (when the caller knows it) and head → base. */
export function PullRequestIdentity(
  props: Readonly<{ model: PullRequestGlanceV1; title: string | null }>,
): ReactElement {
  const { model } = props;
  return (
    <Stack gap="xsmall" testID="pr-glance.identity">
      <Text
        variant="label"
        value={props.title ?? `${model.repository} #${model.number}`}
        numberOfLines={2}
      />
      {model.branch === null ? null : (
        <Row gap="xsmall" align="center" wrap>
          <Text variant="code" value={model.branch.head} numberOfLines={1} />
          <Icon name="forward" size="small" tone="muted" />
          <Text variant="code" value={model.branch.base} numberOfLines={1} />
        </Row>
      )}
    </Stack>
  );
}


const MODE_GROUP = 'mode';
const MERGE_ARCHIVE = 'merge:archive';
const UNLINK = 'unlink';

/**
 * The watch mode picker: one radio group (Off · Notify · Analyse · Address · Auto-fix, each with what it does)
 * and what happens on merge. Desktop gets the shared popover menu; a phone gets the host's sheet.
 */
export function PullRequestWatchMenu(
  props: Readonly<{
    policy: SessionPullRequestWatchPolicyV1;
    agent: string | null;
    disabled?: boolean;
    trigger?: string;
    onChange(policy: SessionPullRequestWatchPolicyV1): void;
    /** Removes the link from this session (reversible: link it again). Absent where unlinking is not offered. */
    onUnlink?: () => void;
    testID?: string;
  }>,
): ReactElement {
  const text = usePluginTranslation();
  const [open, setOpen] = React.useState(false);
  const { policy } = props;
  const modes: MenuItem[] = PULL_REQUEST_WATCH_MODES_V1.map((mode) => ({
    id: `mode:${mode}`,
    kind: 'radio',
    radioGroupId: MODE_GROUP,
    label: pullRequestWatchModeLabelV1(text, mode),
    subtitle: pullRequestWatchModeConsequenceV1(text, mode, props.agent),
  }));
  const merged: MenuItem[] = [
    {
      id: MERGE_ARCHIVE,
      kind: 'checkbox',
      checked: policy.archiveAfterMerge,
      label: text(
        'plugins.triage.prWatch.archiveAfterMerge',
        'Archive the session too',
      ),
      subtitle: text(
        'plugins.triage.prWatch.archiveAfterMergeDetail',
        'Only when it’s idle and nothing is waiting on you',
      ),
    },
  ];
  const label = props.trigger ?? pullRequestWatchModeLabelV1(text, policy.mode);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      trigger={label}
      triggerAppearance="control"
      triggerAccessibilityLabel={text(
        'plugins.triage.prWatch.menuLabel',
        'Watch mode: {mode}',
        { mode: pullRequestWatchModeLabelV1(text, policy.mode) },
      )}
      disabled={props.disabled === true}
      showGroupLabels
      groups={[
        {
          id: MODE_GROUP,
          accessibilityLabel: text(
            'plugins.triage.prWatch.modesTitle',
            'Watch',
          ),
          items: modes,
        },
        {
          id: 'merge',
          accessibilityLabel: text(
            'plugins.triage.prWatch.mergeTitle',
            'When the PR merges',
          ),
          items: merged,
        },
        ...(props.onUnlink
          ? [{ id: 'link', accessibilityLabel: text('plugins.triage.prWatch.linkTitle', 'This session'),
              items: [{ id: UNLINK, label: text('plugins.triage.prWatch.unlink', 'Unlink from this session'), icon: 'link' as const }] }]
          : []),
      ]}
      radioGroups={[
        {
          id: MODE_GROUP,
          accessibilityLabel: text(
            'plugins.triage.prWatch.modesTitle',
            'Watch',
          ),
          selectedId: `mode:${policy.mode}`,
        },
      ]}
      onSelect={(id) => {
        if (id === UNLINK) {
          props.onUnlink?.();
          return;
        }
        if (id.startsWith('mode:')) {
          const mode = id.slice(
            'mode:'.length,
          ) as SessionPullRequestWatchModeV1;
          if (mode !== policy.mode) props.onChange({ ...policy, mode });
          return;
        }
        if (id === MERGE_ARCHIVE)
          props.onChange({
            ...policy,
            archiveAfterMerge: !policy.archiveAfterMerge,
          });
      }}
      testID={props.testID ?? 'pr-glance.watch-menu'}
    />
  );
}

export type PullRequestGlanceProps = Readonly<{
  binding: TriageSessionPullRequestBindingV1;
  /** The PR's title when the caller has it (branch discovery carries one; the linked Resource does not yet). */
  title: string | null;
  /** The session's own agent display name; null reads "the agent". */
  agent: string | null;
  /** A configure in flight disables the picker; the Resource stays the one source of the shown mode. */
  configuring?: boolean;
  onConfigure(policy: SessionPullRequestWatchPolicyV1): void;
  onUnlink?: () => void;
  /** After the fix limit: grant the Account's N more rounds to this PR (Watch `retryFix`). */
  onContinueFixing?: () => unknown;
  /** After the fix limit: open the local-run form for this checkout (08); opening runs nothing. */
  onRunLocally?: () => unknown;
  /** The local-run form could not be opened for this Session (no accepted checkout, another repository). */
  runLocallyUnavailable?: boolean;
  onOpenProvider(): void;
  onReconnect(): void;
  /** Opens the latest update where it happened, when that place is reachable. */
  onOpenLatest?: (() => void) | null;
  /** Replaces the default Open footer; `null` draws none. */
  footer?: ReactElement | null;
}>;

/**
 * The PR glance body (c6): what blocks it first (a stale or expired read), identity, Checks/Review/Merge, the
 * watch line with its mode, the latest update, and one way out. It renders whatever the one admitted binding
 * says, last-known included.
 */
export function PullRequestGlance(props: PullRequestGlanceProps): ReactElement {
  const text = usePluginTranslation();
  const model = React.useMemo(() => projectPullRequestGlanceV1(props.binding), [props.binding]);
  const watch = watchLineText(text, model.watch, props.agent);
  const latest = props.binding.latestUpdate;
  const policy = props.binding.watch.policy;
  const showMenu = model.watch.kind !== 'terminal';
  const unreadable = model.freshness.kind === 'unavailable' && model.freshness.failure.class !== 'authentication'
    ? model.freshness.failure : null;
  return (
    <Stack gap="medium" testID="pr-glance">
      <GlanceFreshness model={model} onReconnect={props.onReconnect} />
      <PullRequestIdentity model={model} title={props.title} />
      {unreadable === null ? <PullRequestFacts model={model} /> : model.freshness.kind === 'unavailable' && model.freshness.configureSources ? (
        <ConfigureSourceRecovery offers={model.freshness.configureSources} reason={unreadable.code} />
      ) : (
        <Banner tone="warning" testID="pr-glance.unavailable"
          title={text('plugins.triage.prGlance.unavailable.title', 'Pull request status can’t be read')}
          description={unreadable.class === 'permission'
            ? text('plugins.triage.prGlance.unavailable.permission', 'This GitHub sign-in can’t read checks, review or merge state for this PR. The link stays.')
            : unreadable.class === 'rateLimit'
              ? text('plugins.triage.prGlance.unavailable.rate', 'GitHub is limiting requests, so checks, review and merge state wait. The link stays and they come back on their own.')
              : text('plugins.triage.prGlance.unavailable.description', 'Checks, review and merge state can’t be shown right now. The link stays, and watching resumes when they can be read.')} />
      )}
      {model.freshness.kind === 'current' ? null : <PullRequestFailureDetails codes={[model.freshness.failure.code]} />}
      <Row gap="small" align="center" testID={`pr-glance.watch:${model.watch.kind}`}>
        {model.watch.kind === 'fixing' ? <Spinner size="small" tone="secondary" accessibilityLabel={watch.value} />
          : model.watch.kind === 'exhausted' ? <Icon name="attention" size="small" tone="warning" />
            : <Icon name="watch" size="small" tone={model.watch.kind === 'off' ? 'muted' : 'secondary'} />}
        <Stack grow><Text variant="body" tone={watch.tone} value={watch.value} numberOfLines={1} /></Stack>
        {showMenu ? (
          <PullRequestWatchMenu policy={policy} agent={props.agent} disabled={props.configuring}
            {...(model.watch.kind === 'off' ? { trigger: text('plugins.triage.prGlance.watch.start', 'Watch') } : {})}
            onChange={props.onConfigure} {...(props.onUnlink ? { onUnlink: props.onUnlink } : {})} />
        ) : null}
      </Row>
      {model.watch.kind === 'exhausted' && props.onContinueFixing ? (
        <Stack gap="small" testID="pr-glance.exhausted">
          <Text variant="body" tone="secondary" value={text('plugins.triage.prGlance.exhaustedDetail',
            'Watching continues. {agent} won’t start another fix on this PR until you decide; a push from someone else starts a fresh count.',
            { agent: capitalizeFirst(props.agent ?? text('plugins.triage.prWatch.theAgent', 'the agent')) })} />
          <Row gap="small" align="center" wrap>
            <Button variant="primary" size="small" disabled={props.configuring}
              title={props.binding.watch.fixAttemptLimit === null
                ? text('plugins.triage.prWatch.continue', 'Continue fixing')
                : text('plugins.triage.prGlance.continueN', 'Continue {count} more', { count: props.binding.watch.fixAttemptLimit })}
              onPress={props.onContinueFixing} testID="pr-glance.continue" />
            {props.onRunLocally ? (
              <Button variant="secondary" size="small" title={text('plugins.triage.prGlance.runLocally', 'Run the job locally')}
                onPress={props.onRunLocally} testID="pr-glance.run-locally" />
            ) : null}
            <Button variant="plain" size="small" disabled={props.configuring}
              title={text('plugins.triage.prWatch.stop', 'Stop watching')}
              onPress={() => props.onConfigure({ ...policy, mode: 'off' })} testID="pr-glance.stop" />
          </Row>
          {props.runLocallyUnavailable ? (
            <Text variant="meta" tone="secondary" value={text('plugins.triage.prGlance.runLocallyUnavailable',
              'A local run needs this session’s checkout of the same repository.')} />
          ) : null}
        </Stack>
      ) : null}
      {latest === null ? null : (
        <Card tone="muted" padding="small" testID="pr-glance.latest"
          {...(props.onOpenLatest ? { onPress: props.onOpenLatest, accessibilityLabel: text('plugins.triage.prGlance.latestOpen', 'Open the latest update: {summary}', { summary: latest.summary }) } : {})}>
          <Row gap="small" align="center">
            <Text variant="meta" tone="secondary" value={formatHappierAsOfTime(latest.occurredAtMs)} />
            <Stack grow><Text variant="body" value={latest.summary} numberOfLines={1} /></Stack>
            {props.onOpenLatest ? <Icon name="forward" size="small" tone="muted" /> : null}
          </Row>
        </Card>
      )}
      {props.footer !== undefined ? props.footer : (
        <Row gap="small" align="center">
          <Button variant="secondary" size="small" title={text('plugins.triage.resource.open', 'Open')}
            onPress={props.onOpenProvider} testID="pr-glance.open-provider" />
        </Row>
      )}
    </Stack>
  );
}

/** One cause, one line: a stale or expired read says how old it is, why, and the one recovery. */
function GlanceFreshness(props: Readonly<{ model: PullRequestGlanceV1; onReconnect(): void }>): ReactElement | null {
  const text = usePluginTranslation();
  const { model } = props;
  if (model.watch.kind === 'credentials' || (model.freshness.kind !== 'current' && model.freshness.failure.class === 'authentication')) {
    return (
      <FreshnessLine tone="warning" {...(model.freshness.kind === 'unavailable' ? {} : { asOf: model.freshness.checkedAtMs })}
        reason={text('plugins.triage.prGlance.fresh.expired', 'GitHub sign-in expired')}
        action={{ label: text('plugins.triage.prGlance.fresh.reconnect', 'Reconnect account'), onPress: props.onReconnect }}
        testID="pr-glance.fresh:expired" />
    );
  }
  // Unavailable with nothing retained is the body's banner, never a freshness line over an empty body.
  if (model.freshness.kind !== 'stale') return null;
  const failure = model.freshness.failure;
  const reason = failure.class === 'rateLimit'
    ? failure.retryNotBeforeMs === undefined
      ? text('plugins.triage.prGlance.fresh.rateNoReset', 'GitHub is briefly limiting requests')
      : text('plugins.triage.prGlance.fresh.rateReset', 'GitHub limit used up · resets {time}', { time: formatHappierAsOfTime(failure.retryNotBeforeMs) })
    : failure.class === 'permission'
      ? text('plugins.triage.prGlance.fresh.permission', 'This GitHub sign-in can’t read this PR')
      : text('plugins.triage.prGlance.fresh.unreadable', 'Couldn’t refresh from GitHub');
  return <FreshnessLine asOf={model.freshness.checkedAtMs} reason={reason} tone="warning" testID="pr-glance.fresh:stale" />;
}

/**
 * Consume the Resource's reason and admitted source destinations without deciding availability here.
 * Opening a source page changes nothing: its own save owns the selection.
 */
function ConfigureSourceRecovery(props: Readonly<{ offers: readonly TriageConfigureSourceOfferV1[]; reason: string }>): ReactElement {
  const text = usePluginTranslation();
  const [chooseOpen, setChooseOpen] = React.useState(false);
  const recovery = useConfigureSourceRecoveryV1();
  const { offers } = props;
  const single = offers.length === 1 ? offers[0]! : null;
  const sourceChoiceRequired = props.reason === 'sessionLinksSourceInstanceRequired';
  const choose = text('plugins.triage.prGlance.unavailable.chooseSource', 'Choose a source');
  const action = recovery.open === null ? undefined : single !== null ? (
    <Button variant="primary" size="small" title={sourceChoiceRequired ? choose : text('plugins.triage.prGlance.unavailable.chooseRepositories', 'Choose repositories')}
      onPress={() => { void recovery.open?.(single); }} testID="pr-glance.configure-source" />
  ) : (
    <Menu open={chooseOpen} onOpenChange={setChooseOpen} trigger={choose} triggerAccessibilityLabel={choose} triggerAppearance="control"
      items={offers.map((offer) => ({ id: `${offer.destination.pluginId}/${offer.destination.localId}`, label: offer.displayName }))}
      onSelect={(id) => {
        const offer = offers.find((candidate) => `${candidate.destination.pluginId}/${candidate.destination.localId}` === id);
        if (offer !== undefined) void recovery.open?.(offer);
      }} />
  );
  return (
    <Stack gap="small" testID="pr-glance.unavailable">
      <Banner tone="warning" actionPlacement="below" {...(action === undefined ? {} : { action })}
        title={sourceChoiceRequired
          ? text('plugins.triage.prGlance.unavailable.title', 'Pull request status can’t be read')
          : single !== null
          ? text('plugins.triage.prGlance.unavailable.sourceMissing', 'This repository isn’t in your {source} source', { source: single.displayName })
          : text('plugins.triage.prGlance.unavailable.sourceMissingMany', 'This repository isn’t in a source you’ve set up')}
        {...(sourceChoiceRequired ? {} : { description: text('plugins.triage.prGlance.unavailable.sourceMissingDetail', 'Add it to the repositories a source reads to see checks, review and merge state. The link stays.') })} />
      {recovery.refused === null ? null : (
        <Text variant="meta" tone="danger" testID="pr-glance.configure-source.refused"
          value={text('plugins.triage.prGlance.unavailable.sourceRefused', 'Couldn’t open {source} settings. Try again.', { source: recovery.refused })} />
      )}
    </Stack>
  );
}

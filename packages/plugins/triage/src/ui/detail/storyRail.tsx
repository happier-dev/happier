import * as React from 'react';

import {
  ApprovalPrompt,
  BrandMark,
  Button,
  CodeBlock,
  Icon,
  ReviewSeverity,
  Row,
  Stack,
  Status,
  Step,
  Text,
  SessionCard,
  usePluginHostApi,
  usePluginTranslation,
  useReviewCommentProposalsForEntry,
  type ReviewCommentProposalQueryV1,
  type SessionStateReadV1,
} from '@happier-dev/plugin-ui';
import type { SessionPendingPermissionV1, SessionPermissionAnswerV1, SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import type { TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';

import { TriageStoryLoadingLines } from '@happier-dev/triage-sources/ui';
import { useTriagePluralCount } from '../pluralCount.js';

import { describeTriageAgentStatusV1, readTriageSessionWhereV1 } from './agentState.js';
import { TriageLinkedSessions } from './linkedSessions.js';
import { useLinkedSessionOpen } from './useLinkedSessionOpen.js';

/** The entry's agent entry points, published by its action row (one start controller) for the story to offer. */
export type TriageAgentEntryV1 = Readonly<{ start(): void; send(): void }>;

type TriageFindingV1 = ReturnType<typeof useReviewCommentProposalsForEntry>['proposals'][number];

/** Where a finding points, as a reader would type it: `path:line`, `path:start-end`, a path, or nothing. */
function readTriageFindingLocationV1(anchor: TriageFindingV1['anchor']): string | null {
  switch (anchor.kind) {
    case 'line': return `${anchor.filePath}:${anchor.line}`;
    case 'range': return `${anchor.filePath}:${anchor.startLine}-${anchor.endLine}`;
    case 'hunk':
    case 'file': return anchor.filePath;
    case 'folder': return anchor.folderPath;
    default: return null;
  }
}

const FINDING_SEVERITY_LABEL = Object.freeze({
  blocker: 'Blocker', high: 'High', medium: 'Medium', low: 'Low', nit: 'Nit',
} as const satisfies Record<NonNullable<TriageFindingV1['findingSeverity']>, string>);

/** How many of the agent's findings the step lists before counting the rest. */
const SHOWN_FINDINGS = 3;

/**
 * Triage's own step on the Overview story rail (r0.42): ③ the agent's work.
 *
 * The source's overview panel draws ① the ask, ② what changed and the checks
 * state; this step follows it, numbered third in every source's grammar. It
 * reads the most recent linked Session's live state through the host's
 * canonical Session projection, lists the agent's review findings through the
 * canonical Reviews read, and keeps every linked Session one press away
 * through the canonical Session-open path.
 */
export function TriageAgentStep(props: Readonly<{
  sessions: readonly TriageLinkedSessionProjectionV1[];
  hasMore: boolean;
  pageState?: 'idle' | 'loading' | 'failed';
  onLoadMore?: () => void;
  onSelectSession?: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => void;
  /** The live read of `sessions[0]`, owned by the detail so the card and step share one watch. */
  live: SessionStateReadV1;
  /** The detail's live reads of the linked Sessions. */
  sessionStates?: ReadonlyMap<string, SessionStateReadV1>;
  /** This entry, as the Reviews read names it. */
  reviewEntry: ReviewCommentProposalQueryV1['entry'];
  /**
   * `step`: ③ on the Overview rail. `card`: the live agent card that ends
   * Activity, the same facts without the rail marker.
   */
  variant?: 'step' | 'card';
  /** The step's place in the story: the source's chapters come first (③ after an ask and its changes). */
  number?: number;
  /**
   * The entry's own Start and Send to a Session (the action row's primary press), offered here while no Session is
   * linked, where the agent's work will appear (lab t1). Absent: the entry has no agent action to offer.
   */
  entry?: TriageAgentEntryV1 | null;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const pluralCount = useTriagePluralCount();
  const linkedSessionIds = React.useMemo(() => props.sessions.map((session) => session.sessionId), [props.sessions]);
  const findings = useReviewCommentProposalsForEntry({ linkedSessionIds, entry: props.reviewEntry });
  const opener = useLinkedSessionOpen();
  if (props.sessions.length === 0) {
    if (props.entry === undefined || props.entry === null || props.variant === 'card') return null;
    const entry = props.entry;
    return (
      <Step
        marker={{ kind: 'number', value: props.number ?? 3 }}
        title={text('plugins.triage.surface.detail.agent.workUnnamed', 'The agent\u2019s work')}
        testID="triage-story-agent"
      >
        <Row gap="small" align="center" wrap>
          <Button title={text('plugins.triage.surface.detail.agent.start', 'Start a Session')} variant="secondary"
            size="small" onPress={entry.start} />
          <Button title={text('plugins.triage.surface.actions.sendToSession', 'Send to a Session…')} variant="plain"
            size="small" onPress={entry.send} />
        </Row>
      </Step>
    );
  }
  const status = props.live.state === null ? null : describeTriageAgentStatusV1(props.live.state);
  const whereLabel = readTriageSessionWhereV1(props.live.state);
  const shown = findings.proposals.slice(0, SHOWN_FINDINGS);
  // Reviews are read in linked-Session scope. Scoped rows may omit that optional
  // field; in that case use the story's current linked Session destination.
  const omittedFinding = findings.proposals[SHOWN_FINDINGS];
  const findingsSessionId = omittedFinding?.sessionId ?? props.sessions[0]?.sessionId;
  // The step names whose work it is (lab: "Claude's work"); the Session cards under it name each Session.
  const agentName = props.live.state?.agent?.displayName;
  const stepTitle = agentName === undefined
    ? text('plugins.triage.surface.detail.agent.workUnnamed', 'The agent\u2019s work')
    : text('plugins.triage.surface.detail.agent.work', '{agent}\u2019s work', { agent: agentName });
  const content = (
    <>
      {shown.length === 0 ? null : (
        <Stack gap="xsmall">
          <Text
            variant="label"
            value={pluralCount('surface.detail.agent.findings', findings.proposals.length,
              { one: '{count} finding', other: '{count} findings' })}
          />
          {shown.map((finding) => {
            const location = readTriageFindingLocationV1(finding.anchor);
            const severity = finding.findingSeverity;
            return (
              <Stack key={finding.id} gap="xsmall">
                {severity === undefined && location === null ? null : (
                  <Row gap="xsmall" align="center" wrap>
                    {severity === undefined ? null : (
                      <ReviewSeverity
                        presentation="badge"
                        severity={severity}
                        label={text(`plugins.triage.surface.detail.finding.severity.${severity}`, FINDING_SEVERITY_LABEL[severity])}
                        testID={`triage-finding-severity-${finding.id}`}
                      />
                    )}
                    {location === null ? null : <Text variant="micro" tone="secondary" value={location} numberOfLines={1} />}
                  </Row>
                )}
                <Text variant="reading" value={finding.body} />
              </Stack>
            );
          })}
          {omittedFinding === undefined || findingsSessionId === undefined ? null : (
            <Button
              titleKey="plugins.triage.surface.detail.agent.seeAll"
              title="See all"
              variant="plain"
              busy={opener.busySessionId !== null}
              onPress={() => { void opener.open(findingsSessionId); }}
            />
          )}
          {opener.failedSessionId === null ? null : (
            <Status tone="danger" labelKey="plugins.triage.surface.detail.sessionOpenFailed"
              label="This Session could not be opened." />
          )}
        </Stack>
      )}
    </>
  );
  if (props.variant === 'card') {
    // The Activity's last word (lab c7 Activity): the shared Session card for the most recent linked Session.
    const sessionId = props.sessions[0]?.sessionId;
    if (sessionId === undefined) return null;
    return (
      <SessionCard
        sessionId={sessionId}
        read={props.live}
        status={status === null ? null : {
          label: text(status.labelKey, status.label, status.labelParams), tone: status.tone, live: status.live,
        }}
        onOpen={() => { void opener.open(sessionId); }}
        openBusy={opener.busySessionId === sessionId}
        testID="triage-activity-agent"
      >
        {shown.length === 0 ? null : content}
      </SessionCard>
    );
  }
  // Until the linked Sessions' live reads answer, the step holds its place with the story's own reading lines and
  // offers nothing to press: a "Loading…" card with a live Open is a promise the row cannot keep yet.
  const reading = props.live.status === 'loading'
    || props.sessions.some((session) => props.sessionStates?.get(session.sessionId)?.status === 'loading');
  if (reading) {
    return (
      <Step marker={{ kind: 'number', value: props.number ?? 3 }} title={stepTitle} testID="triage-story-agent">
        <TriageStoryLoadingLines label={text('plugins.triage.surface.detail.agent.reading', 'Reading the agent\u2019s work')} />
      </Step>
    );
  }
  return (
    <Step
      marker={{ kind: 'number', value: props.number ?? 3 }}
      title={stepTitle}
      trailing={whereLabel === undefined ? undefined : <Text variant="micro" tone="secondary" value={whereLabel} />}
      testID="triage-story-agent"
    >
      {content}
      <TriageLinkedSessions
        sessions={props.sessions}
        hasMore={props.hasMore}
        labelled={false}
        onSelect={props.onSelectSession}
        {...(props.sessionStates === undefined ? {} : { states: props.sessionStates })}
        {...(props.pageState === undefined ? {} : { pageState: props.pageState })}
        {...(props.onLoadMore === undefined ? {} : { onLoadMore: props.onLoadMore })}
      />
    </Step>
  );
}

const ANSWER_COPY: Readonly<Record<SessionPermissionAnswerV1, Readonly<{ key: string; fallback: string }>>> = Object.freeze({
  allowOnce: { key: 'plugins.triage.surface.detail.permission.allowOnce', fallback: 'Allow once' },
  allowForSession: { key: 'plugins.triage.surface.detail.permission.allowForSession', fallback: 'Always for this session' },
  deny: { key: 'plugins.triage.surface.detail.permission.deny', fallback: 'Deny' },
});

/**
 * A waiting agent's permission request, above the story rail (r0.42).
 *
 * It offers exactly the answers the host says this viewer may give, and
 * answers through the host's one Session permission owner — the same decision
 * the Session's own prompt makes. It flips nothing itself: the card leaves
 * when the Session's live state no longer lists the request.
 */
export function TriagePermissionCard(props: Readonly<{
  sessionId: string;
  /** The asking Session's live state: who asks (its Agent) and where it works. */
  state: SessionStateV1;
  request: SessionPendingPermissionV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const [pending, setPending] = React.useState<SessionPermissionAnswerV1 | null>(null);
  const [refused, setRefused] = React.useState(false);
  const answer = React.useCallback((choice: SessionPermissionAnswerV1) => {
    setPending(choice);
    setRefused(false);
    void (async () => {
      try {
        const result = await host.respondToSessionPermission({
          sessionId: props.sessionId,
          requestId: props.request.requestId,
          answer: choice,
        });
        if (result.status !== 'answered') setRefused(true);
      } catch {
        setRefused(true);
      } finally {
        setPending(null);
      }
    })();
  }, [host, props.request.requestId, props.sessionId]);

  // The Agent asks, never the Session's title ("Fix failing checks on #2476 wants to run…" names no one).
  const agent = props.state.agent;
  const title = agent === undefined
    ? text('plugins.triage.surface.detail.permission.title', 'The agent wants to run {tool}', { tool: props.request.toolName })
    : text('plugins.triage.surface.detail.permission.titleNamed', '{session} wants to run {tool}', {
      session: agent.displayName,
      tool: props.request.toolName,
    });
  const where = readTriageSessionWhereV1(props.state);
  return (
    <ApprovalPrompt
      testID="triage-permission-card"
      tone="attention"
      title={title}
      subtitle={props.request.summary}
      // The asking Agent's own mark when the catalog knows it; it stands alone, no tile.
      icon={agent?.brand === undefined
        ? <Icon name="review" size="small" tone="attention" />
        : <BrandMark pluginId={agent.brand.pluginId} size="small" externallyLabelled />}
      {...(where === undefined ? {} : {
        headerAccessory: <Text variant="micro" tone="secondary" value={where} numberOfLines={1} />,
      })}
      footer={(
        <Stack gap="small">
          {props.request.answers.length === 0 ? (
            <Text
              variant="micro"
              tone="secondary"
              value={text('plugins.triage.surface.detail.permission.notYours', 'Someone who can approve this Session has to answer.')}
            />
          ) : (
            <Row gap="small" wrap>
              {props.request.answers.map((choice, index) => (
                <Button
                  key={choice}
                  title={text(ANSWER_COPY[choice].key, ANSWER_COPY[choice].fallback)}
                  variant={index === 0 ? 'primary' : choice === 'deny' ? 'plain' : 'secondary'}
                  busy={pending === choice}
                  disabled={pending !== null && pending !== choice}
                  onPress={() => answer(choice)}
                />
              ))}
            </Row>
          )}
          {refused ? (
            <Status
              tone="warning"
              labelKey="plugins.triage.surface.detail.permission.refused"
              label="That answer did not reach the Session. It may already have been answered."
            />
          ) : null}
        </Stack>
      )}
    >
      {props.request.command === undefined ? null : <CodeBlock code={props.request.command} />}
    </ApprovalPrompt>
  );
}

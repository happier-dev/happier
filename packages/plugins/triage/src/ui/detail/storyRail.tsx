import * as React from 'react';

import {
  Banner,
  Button,
  CodeBlock,
  Row,
  Stack,
  Status,
  Step,
  Text,
  usePluginHostApi,
  usePluginTranslation,
  useReviewCommentProposalsForEntry,
  type ReviewCommentProposalQueryV1,
  type SessionStateReadV1,
} from '@happier-dev/plugin-ui';
import type { SessionPendingPermissionV1, SessionPermissionAnswerV1 } from '@happier-dev/plugin-sdk/ui';
import type { TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';
import { HAPPIER_WORK_STATUS_SEMANTIC_TONE } from '@happier-dev/plugin-ui/presentation';

import { describeTriageAgentStatusV1 } from './agentState.js';
import { TriageLinkedSessions } from './linkedSessions.js';
import { useLinkedSessionOpen } from './useLinkedSessionOpen.js';

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
  /** This entry, as the Reviews read names it. */
  reviewEntry: ReviewCommentProposalQueryV1['entry'];
  /**
   * `step`: ③ on the Overview rail. `card`: the live agent card that ends
   * Activity, the same facts without the rail marker.
   */
  variant?: 'step' | 'card';
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const linkedSessionIds = React.useMemo(() => props.sessions.map((session) => session.sessionId), [props.sessions]);
  const findings = useReviewCommentProposalsForEntry({ linkedSessionIds, entry: props.reviewEntry });
  const opener = useLinkedSessionOpen();
  if (props.sessions.length === 0) return null;
  const status = props.live.state === null ? null : describeTriageAgentStatusV1(props.live.state);
  const where = props.live.state?.workspace;
  const whereLabel = where?.worktreeName ?? where?.projectName;
  const shown = findings.proposals.slice(0, SHOWN_FINDINGS);
  // Reviews are read in linked-Session scope. Scoped rows may omit that optional
  // field; in that case use the story's current linked Session destination.
  const omittedFinding = findings.proposals[SHOWN_FINDINGS];
  const findingsSessionId = omittedFinding?.sessionId ?? props.sessions[0]?.sessionId;
  const title = text('plugins.triage.surface.detail.story.agent', 'Agent work');
  const content = (
    <>
      {status === null ? null : (
        <Status tone={HAPPIER_WORK_STATUS_SEMANTIC_TONE[status.tone]} labelKey={status.labelKey} label={status.label} pulsing={status.live} />
      )}
      {shown.length === 0 ? null : (
        <Stack gap="xsmall">
          <Text
            variant="label"
            value={text('plugins.triage.surface.detail.agent.findings', '{count} findings', {
              count: String(findings.proposals.length),
            })}
          />
          {shown.map((finding) => (
            <Text key={finding.id} variant="caption" value={finding.body} />
          ))}
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
    return (
      <Stack gap="small" testID="triage-activity-agent">
        <Row gap="small" align="center">
          <Stack style={{ flex: 1, minWidth: 0 }}>
            <Text variant="label" value={props.sessions[0]?.displayTitle ?? title} />
          </Stack>
          {whereLabel === undefined ? null : <Text variant="caption" tone="secondary" value={whereLabel} />}
        </Row>
        {content}
      </Stack>
    );
  }
  return (
    <Step
      marker={{ kind: 'number', value: 3 }}
      title={title}
      trailing={whereLabel === undefined ? undefined : <Text variant="caption" tone="secondary" value={whereLabel} />}
      testID="triage-story-agent"
    >
      {content}
      <TriageLinkedSessions
        sessions={props.sessions}
        hasMore={props.hasMore}
        labelled={false}
        onSelect={props.onSelectSession}
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
  sessionTitle: string | undefined;
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

  const title = props.sessionTitle === undefined
    ? text('plugins.triage.surface.detail.permission.title', 'The agent wants to run {tool}', { tool: props.request.toolName })
    : text('plugins.triage.surface.detail.permission.titleNamed', '{session} wants to run {tool}', {
      session: props.sessionTitle,
      tool: props.request.toolName,
    });
  return (
    <Banner
      tone="warning"
      title={title}
      description={props.request.summary}
      action={(
        <Stack gap="small">
          {props.request.command === undefined ? null : <CodeBlock code={props.request.command} />}
          {props.request.answers.length === 0 ? (
            <Text
              variant="caption"
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
    />
  );
}

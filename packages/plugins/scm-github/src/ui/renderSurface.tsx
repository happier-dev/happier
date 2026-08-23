/**
 * The GitHub Triage detail surface artifact entry.
 *
 * Triage mounts this renderer inside its own detail pane and hands it exactly one value: the
 * published `TriageDetailSurfaceInputV1` launch input. This file admits that value through the
 * published closed schema rather than casting it — a mount that hands over something else is a
 * contract break the surface reports, not one it renders around.
 *
 * It begins directly below Triage's permanently mounted common header and renders none of that
 * header's facts. The title, kind, state, scope, provider link, attention and Session
 * relationship belong to the aggregate (`CONTRACT.md` §7); repeating them here is a second
 * renderer of one header, and the copy that drifts is the one the user is looking at.
 *
 * What it does own are GitHub's own facts: the event timeline, the files a pull request changes,
 * its check runs and commit statuses, the conversation, and — on a pull request — the feedback on
 * it. Every read has its own lifetime, issued when its tab becomes active and never on mount:
 * GitHub involvement scanning already spends real provider budget, and planes fetched eagerly
 * would multiply it on every detail open.
 *
 * `Feedback` is the one plane that opens no route of its own. What a reviewer needs from it —
 * what was said, who has signed off, who is still being waited on, and what GitHub reports as
 * wrong — is already carried by the conversation walk, the event walk and the applied
 * observation, so it composes those in memory rather than paying GitHub twice for facts already
 * in hand. That is also why a pull request has no separate `Comments` tab: its conversation is
 * one of the things `Feedback` unifies, and a second tab would read the same resource again and
 * split one conversation across two places a reviewer has to check.
 *
 * Every panel distinguishes the same four settled outcomes, because on this source they are
 * genuinely different answers: a collection the provider stated as empty says so; a first read
 * that failed says *that* instead, naming itself; a later page that failed keeps the rows the
 * reader already had and shows the failure beside them; and a walk that stopped short of the whole
 * collection keeps its rows and names the reason.
 *
 * Diffs are not rendered here. The rich diff body is held at the shared component catalog under
 * B6, so the Files panel presents the changed-file LIST through the approved `List` family with
 * its counts, its status, its deterministic reading order and its per-file *diff unavailable*
 * state. It neither wraps an app-private diff component nor invents a partial one.
 */

import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Action,
  Badge,
  Banner,
  Button,
  Divider,
  EmptyState,
  ErrorState,
  Form,
  Item,
  ItemGroup,
  List,
  LoadingState,
  Markdown,
  Metadata,
  Row,
  Screen,
  ScrollArea,
  Stack,
  Status,
  Tabs,
  Text,
  defineUiSurface,
  usePluginTranslation,
  useExecutePluginAction,
  useSurfaceContext,
  type MetadataEntry,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import {
  TriageDetailSurfaceInputV1Schema,
  type TriageDetailSurfaceInputV1,
  type TriageLinkedSessionProjectionV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
// The presentation rules used below are projections of the Triage contract's own
// closed fact and failure vocabularies, so they are consumed from the one published
// owner rather than re-spelled here: six copies is how one declared `compact` number
// could start meaning two things in one list. They are aliased to this file's local
// vocabulary so the call sites read as the panel language they already are.
import {
  describeTriageSourceFailureV1 as failureDescription,
  formatTriageCountV1 as formatNumber,
  formatTriageTimestampV1 as formatTimestamp,
  projectTriageDetailFieldTextV1 as fieldValueText,
} from '@happier-dev/triage-protocol/v1';

import {
  groupGithubChangedFiles,
  orderGithubChangedFiles,
} from '../triage/detail/files/orderChangedFiles.js';
import type {
  GithubProjectedChangedFileRowV1,
  GithubProjectedCheckRowV1,
  GithubProjectedCommentRowV1,
  GithubProjectedTimelineRowV1,
} from '../triage/detail/projection.js';
import { GITHUB_CHANGED_FILES_CEILING_V1 } from '../triage/detail/routes.js';
import {
  GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1,
  readGithubTriageKindId,
} from '../triage/contribution.js';
import { GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import {
  GithubPullRequestMergeResultV1Schema,
  GithubPullRequestStateResultV1Schema,
  type GithubMergeMethodV1,
} from '../triage/mutations/contracts.js';
import type { GithubTriageKindIdV1 } from '../triage/types.js';

import {
  projectGithubFeedback,
  type GithubFeedbackFindingV1,
  type GithubFeedbackReviewPeopleV1,
  type GithubFeedbackViewV1,
} from './detail/feedback.js';
import {
  projectGithubDetailBody,
  type GithubDetailBodyV1,
  type GithubDetailFieldV1,
} from './detail/model.js';
import {
  useGithubChangedFiles,
  useGithubChecks,
  useGithubComments,
  useGithubTimeline,
  type GithubChecksViewV1,
  type GithubPagedControllerV1,
} from './detail/panelReaders.js';
import type { GithubPagedStateV1, GithubReadStateV1 } from './detail/panelState.js';
import {
  GITHUB_MERGE_METHODS_V1,
  buildGithubPullRequestMergeInputV1,
  buildGithubPullRequestTargetInputV1,
  githubOfferedMutationsV1,
  projectGithubMutationOutcomeV1,
  type GithubMutationOutcomeV1,
  type GithubMutationRefusalReasonV1,
  type GithubMutationResultV1,
} from './detail/mutations.js';
import {
  GITHUB_DEFAULT_DETAIL_TAB_V1,
  githubResolveSelectedTab,
  githubVisibleDetailTabs,
  type GithubDetailTabIdV1,
} from './detail/tabDeclarations.js';
import {
  GITHUB_REVIEW_STATE_LABELS_V1,
  GITHUB_REVIEW_STATE_UNKNOWN_KEY_V1,
  GITHUB_REVIEW_STATE_UNKNOWN_LABEL_V1,
  GITHUB_TIMELINE_HEADLINES_V1,
  githubDetailFieldLabelKey,
  githubReviewStateKey,
  githubTimelineHeadlineKey,
} from './detail/vocabulary.js';


/**
 * The sentence a walk owes its reader when it stopped without finishing.
 *
 * Only the changed-file plane has a documented ceiling, so only it supplies a
 * ceiling sentence. A plane with no ceiling never claims one — saying "GitHub
 * caps this list" about a timeline would be a fact this product invented.
 */
function incompleteDescription(
  text: PluginTranslate,
  incomplete: 'ceiling' | 'pagination' | null,
  ceilingSentence: string | null,
): string | null {
  if (incomplete === 'pagination') {
    return text(
      'plugins.github.ui.incompletePagination',
      'GitHub offered another page in a form this build will not follow, so this list'
        + ' stops here.',
    );
  }
  return incomplete === 'ceiling' ? ceilingSentence : null;
}

/**
 * The banner a later-page failure owes its reader.
 *
 * It appears only over rows that already arrived. A first-page failure is a
 * different presentation entirely — the panel says it could not look.
 */
function PageFailureBanner({
  state,
}: Readonly<{ state: GithubPagedStateV1<unknown> }>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (state.failure === null) return null;
  return (
    <Banner
      tone="warning"
      title="Showing what was read so far"
      titleKey="plugins.github.ui.partial"
      description={failureDescription(
        state.failure,
        text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'),
      )}
    />
  );
}

/**
 * The explicit refresh every panel offers, and the only one it offers.
 *
 * There is no automatic poll inside a detail tab: a panel that re-read on its own would spend
 * GitHub rate budget for a reader who is not looking at it.
 */
function RefreshRow({
  onRefresh,
  pending,
  accessibilityLabel,
  accessibilityLabelKey,
}: Readonly<{
  onRefresh: () => void;
  /** A walk already in flight; the control stays mounted and inert rather than vanishing. */
  pending: boolean;
  accessibilityLabel: string;
  accessibilityLabelKey?: string;
}>): React.ReactElement {
  return (
    <Row gap="small">
      <Action.Refresh
        onRefresh={onRefresh}
        disabled={pending}
        variant="plain"
        accessibilityLabel={accessibilityLabel}
        accessibilityLabelKey={accessibilityLabelKey}
      />
    </Row>
  );
}

/* ----------------------------------------------------------------------- Writes */

/**
 * The three pull-request writes, offered where the entry's own state is shown.
 *
 * They belong on the Overview panel because that panel IS the applied observation:
 * the state that decides which writes exist, and the head a merge is pinned to,
 * are already the facts on this screen. Hanging them off a live provider read
 * instead would make a write's meaning depend on a panel the reader may never have
 * opened, and its head on a fetch they did not ask for.
 *
 * Nothing here confirms anything, and that is deliberate. Each Action declares
 * host-owned confirmation metadata in the manifest; the host presents it and holds
 * the write until the user decides. A dialog of this surface's own would be a
 * second confirmation lifecycle for one decision, and the copy that drifts is the
 * one standing between a reader and a merge.
 *
 * What this surface does owe is that every press has a settled, visible answer.
 * A control that returned to rest would leave "did that merge?" answerable only by
 * leaving the entry and coming back — and, for the outcome that could not be
 * confirmed, would invite exactly the blind retry the write contract forbids.
 */

const WRITE_REFUSAL_COPY: Readonly<Record<
  GithubMutationRefusalReasonV1,
  Readonly<{ key: string; fallback: string }>
>> = Object.freeze({
  head_advanced: Object.freeze({
    key: 'plugins.github.ui.mutations.refused.head_advanced',
    fallback: 'New commits were pushed since the head shown here, so nothing was merged.',
  }),
  state_changed: Object.freeze({
    key: 'plugins.github.ui.mutations.refused.state_changed',
    fallback: 'The state this entry is in on GitHub cannot make this change.',
  }),
  not_mergeable: Object.freeze({
    key: 'plugins.github.ui.mutations.refused.not_mergeable',
    fallback: 'GitHub will not merge this pull request right now.',
  }),
  merge_method_not_allowed: Object.freeze({
    key: 'plugins.github.ui.mutations.refused.merge_method_not_allowed',
    fallback: 'This repository does not allow that merge method.',
  }),
});

/**
 * GitHub's merge methods in the reader's words. Keyed by the contract's own union,
 * so a method added there fails this build rather than losing its label.
 */
const MERGE_METHOD_COPY: Readonly<Record<
  GithubMergeMethodV1,
  Readonly<{ key: string; fallback: string }>
>> = Object.freeze({
  merge: Object.freeze({
    key: 'plugins.github.ui.mutations.mergeMethod.merge',
    fallback: 'Create a merge commit',
  }),
  squash: Object.freeze({
    key: 'plugins.github.ui.mutations.mergeMethod.squash',
    fallback: 'Squash and merge',
  }),
  rebase: Object.freeze({
    key: 'plugins.github.ui.mutations.mergeMethod.rebase',
    fallback: 'Rebase and merge',
  }),
});

/** The settled answer one write owes the reader who pressed it. */
function WriteOutcome({
  outcome,
}: Readonly<{ outcome: GithubMutationOutcomeV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  if (outcome.kind === 'applied') {
    return outcome.effect === 'changed'
      ? (
        <Banner
          tone="success"
          title="Done"
          titleKey="plugins.github.ui.mutations.applied"
          description={text(
            'plugins.github.ui.mutations.applied.description',
            'GitHub now reports the state you asked for. The facts above are still the'
              + ' earlier observation.',
          )}
        />
      )
      : (
        <Banner
          tone="info"
          title="Nothing to do"
          titleKey="plugins.github.ui.mutations.alreadySatisfied"
          description={text(
            'plugins.github.ui.mutations.alreadySatisfied.description',
            'No request was sent: GitHub already held this state.',
          )}
        />
      );
  }
  if (outcome.kind === 'refused') {
    const copy = WRITE_REFUSAL_COPY[outcome.reason];
    return (
      <Banner
        tone="warning"
        title="Refused"
        titleKey="plugins.github.ui.mutations.refused"
        description={text(copy.key, copy.fallback)}
      />
    );
  }
  if (outcome.kind === 'uncertain') {
    // Never presented as a failure, and never beside a "try again": this request
    // may already have changed GitHub.
    const stated = text(
      'plugins.github.ui.mutations.uncertain.description',
      'The request was accepted and its effect could not be confirmed. Open this entry'
        + ' again to see what is true now rather than pressing again.',
    );
    return (
      <Banner
        tone="warning"
        title="Outcome unknown"
        titleKey="plugins.github.ui.mutations.uncertain"
        description={outcome.failure === null
          ? stated
          : `${failureDescription(outcome.failure, stated)} ${stated}`}
      />
    );
  }
  if (outcome.kind === 'failed') {
    return (
      <Banner
        tone="danger"
        title="Not carried out"
        titleKey="plugins.github.ui.mutations.notCarriedOut"
        description={failureDescription(
          outcome.failure,
          text(
            'plugins.github.ui.mutations.writeFailed',
            'GitHub could not complete this change.',
          ),
        )}
      />
    );
  }
  if (outcome.kind === 'rejected') {
    return (
      <Banner
        tone="danger"
        title="Not carried out"
        titleKey="plugins.github.ui.mutations.notCarriedOut"
        description={text(
          'plugins.github.ui.mutations.rejected.description',
          'Nothing was changed on GitHub ({code}).',
          { code: outcome.code },
        )}
      />
    );
  }
  return (
    <Banner
      tone="danger"
      title="This answer could not be read"
      titleKey="plugins.github.ui.mutations.unreadable"
      description={text(
        'plugins.github.ui.mutations.unreadable.description',
        'GitHub answered in a form this build does not understand, so nothing here says'
          + ' whether the change was made. Open this entry again to see its current state.',
      )}
    />
  );
}

type GithubWriteControllerV1 = Readonly<{
  /** `null` until one dispatch has settled; a press in flight settles nothing. */
  outcome: GithubMutationOutcomeV1 | null;
  pending: boolean;
  run: (payload: GithubWritePayloadV1) => void;
}>;

type GithubWritePayloadV1 =
  NonNullable<ReturnType<typeof buildGithubPullRequestTargetInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestMergeInputV1>>;

/**
 * One write's dispatch and its settled answer, held together.
 *
 * The in-flight guard is the execution hook's, not a second one here: it owns the
 * action's identity, so a second press while one is in flight is the same mutation
 * running twice. The outcome is cleared at dispatch rather than kept, because a
 * stale "Done" sitting above a new press is the worst thing this panel could show.
 */
function useGithubWrite(
  localId: string,
  parseResult: (value: unknown) => GithubMutationResultV1 | null,
): GithubWriteControllerV1 {
  const action = React.useMemo(
    () => ({ pluginId: GITHUB_PLUGIN_ID, localId }),
    [localId],
  );
  const { execution, execute } = useExecutePluginAction(action);
  const [outcome, setOutcome] = React.useState<GithubMutationOutcomeV1 | null>(null);

  const run = React.useCallback((payload: GithubWritePayloadV1) => {
    setOutcome(null);
    void (async () => {
      const settled = await execute(payload);
      setOutcome(projectGithubMutationOutcomeV1(
        settled,
        settled.status === 'success' ? parseResult(settled.result) : null,
      ));
    })();
  }, [execute, parseResult]);

  return React.useMemo(
    () => ({ outcome, pending: execution.status === 'pending', run }),
    [execution.status, outcome, run],
  );
}

function parseMergeResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestMergeResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseStateResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestStateResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The merge control: choose how, then merge the head you are looking at.
 *
 * The method has no preselection, here or in the contract. Which of the three runs
 * decides whether the author's commits survive as themselves, and picking one on
 * the reader's behalf would make an accidental press a rewritten history. Until one
 * is chosen the button is inert, which is also what keeps a stray press harmless
 * before the host's own confirmation is ever reached.
 */
function MergeWrite({
  input,
}: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  const [mergeMethod, setMergeMethod] = React.useState<GithubMergeMethodV1 | null>(null);
  const write = useGithubWrite(
    GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge,
    parseMergeResult,
  );
  // Built against the first method only to answer whether this observation can
  // address a merge at all; the dispatched payload always carries the chosen one.
  const addressable = React.useMemo(
    () => buildGithubPullRequestMergeInputV1(input, 'merge') !== null,
    [input],
  );
  const payload = React.useMemo(
    () => (mergeMethod === null
      ? null
      : buildGithubPullRequestMergeInputV1(input, mergeMethod)),
    [input, mergeMethod],
  );
  const head = input.observation.nativeRevision;

  if (!addressable) {
    // A merge is pinned to the head the user saw. Without one there is nothing
    // honest to pin it to, so the control is absent rather than present and broken.
    return (
      <Text
        variant="caption"
        tone="neutral"
        valueKey="plugins.github.ui.mutations.mergeHeadUnknown"
        fallback={'This observation carries no head commit, so this pull request cannot be'
          + ' merged from here.'}
      />
    );
  }

  return (
    <Stack gap="small">
      <Form.Select
        label={text('plugins.github.ui.mutations.mergeMethod', 'Merge method')}
        options={GITHUB_MERGE_METHODS_V1.map((method) => ({
          value: method,
          label: text(MERGE_METHOD_COPY[method].key, MERGE_METHOD_COPY[method].fallback),
        }))}
        {...(mergeMethod === null ? {} : { value: mergeMethod })}
        onChange={(value) => {
          // The chooser is the one place a method enters this control, and only
          // the declared vocabulary may. A value outside it selects nothing.
          const chosen = GITHUB_MERGE_METHODS_V1.find((method) => method === value);
          if (chosen !== undefined) setMergeMethod(chosen);
        }}
        disabled={write.pending}
      />
      {head === undefined
        ? null
        : (
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.github.ui.mutations.mergeHead"
            fallback="Merges {revision}, the head this observation carries. If GitHub has moved on, the merge is refused instead."
            values={{ revision: head.slice(0, 7) }}
          />
        )}
      <Button
        title="Merge pull request"
        titleKey="plugins.github.ui.mutations.merge"
        variant="primary"
        busy={write.pending}
        disabled={payload === null || write.pending}
        onPress={() => {
          if (payload !== null) write.run(payload);
        }}
      />
      {write.outcome === null ? null : <WriteOutcome outcome={write.outcome} />}
    </Stack>
  );
}

/**
 * Close and reopen: one control shape, because they are one contract shape. Both
 * are head-independent by declaration, so neither is pinned to a revision and
 * neither needs an input beyond the target the observation already names.
 */
function StateWrite({
  localId,
  payload,
  title,
  titleKey,
}: Readonly<{
  localId: string;
  payload: GithubWritePayloadV1;
  title: string;
  titleKey: string;
}>): React.ReactElement {
  const write = useGithubWrite(localId, parseStateResult);
  return (
    <Stack gap="small">
      <Button
        title={title}
        titleKey={titleKey}
        variant="secondary"
        busy={write.pending}
        disabled={write.pending}
        onPress={() => write.run(payload)}
      />
      {write.outcome === null ? null : <WriteOutcome outcome={write.outcome} />}
    </Stack>
  );
}

function WritesSection({
  input,
  kindId,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
}>): React.ReactElement | null {
  const offered = githubOfferedMutationsV1({
    kindId,
    state: input.observation.snapshot.state,
  });
  const target = React.useMemo(
    () => buildGithubPullRequestTargetInputV1(input),
    [input],
  );
  if (offered.length === 0) return null;

  return (
    <Stack gap="small">
      <Divider />
      <Text
        variant="label"
        valueKey="plugins.github.ui.mutations"
        fallback="Change this on GitHub"
      />
      {target === null
        ? (
          <Banner
            tone="warning"
            title="This entry cannot be changed from here"
            titleKey="plugins.github.ui.mutations.noRoute"
            description="This observation carries no route to GitHub, so nothing here can be written."
            descriptionKey="plugins.github.ui.mutations.noRoute.description"
          />
        )
        : (
          <Stack gap="medium">
            <Text
              variant="caption"
              tone="neutral"
              valueKey="plugins.github.ui.mutations.description"
              fallback="These change the pull request on GitHub itself. Each one asks you to confirm before anything is written."
            />
            {offered.includes('merge') ? <MergeWrite input={input} /> : null}
            {offered.includes('close')
              ? (
                <StateWrite
                  localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestClose}
                  payload={target}
                  title="Close pull request"
                  titleKey="plugins.github.ui.mutations.close"
                />
              )
              : null}
            {offered.includes('reopen')
              ? (
                <StateWrite
                  localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestReopen}
                  payload={target}
                  title="Reopen pull request"
                  titleKey="plugins.github.ui.mutations.reopen"
                />
              )
              : null}
          </Stack>
        )}
    </Stack>
  );
}

/* --------------------------------------------------------------------- Overview */

function OverviewPanel({
  body,
  input,
  kindId,
  locale,
  nowMs,
}: Readonly<{
  body: GithubDetailBodyV1;
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const statusFields = body.fields.filter(
    (field): field is Extract<GithubDetailFieldV1, { kind: 'status' }> => field.kind === 'status',
  );
  const pendingFields = body.fields.filter((field) => field.kind === 'pending');
  const entries: readonly MetadataEntry[] = body.fields.flatMap((field) => {
    if (field.kind === 'pending' || field.kind === 'status') return [];
    const value = fieldValueText(field, locale, nowMs);
    return value === null
      ? []
      // The label is this source's own word for one of its fact ids, so it is
      // resolved through the catalog with the declared English as its fallback.
      : [{ label: field.label, labelKey: githubDetailFieldLabelKey(field.id), value }];
  });

  return (
    <ScrollArea>
      <Stack gap="large">
        {statusFields.length === 0 ? null : (
          <Row gap="small">
            {statusFields.map((field) => (
              <Status
                key={field.id}
                tone={field.tone}
                label={text('plugins.github.ui.factStatus', '{label}: {value}', {
                  label: text(githubDetailFieldLabelKey(field.id), field.label),
                  value: field.value,
                })}
              />
            ))}
          </Row>
        )}
        {entries.length === 0
          ? (
            <EmptyState
              title="No projected facts"
              titleKey="plugins.github.ui.noFacts"
              description="This observation carried no displayable GitHub facts."
              descriptionKey="plugins.github.ui.noFacts.description"
            />
          )
          : <Metadata title="GitHub" titleKey="plugins.github.ui.facts" entries={entries} />}
        {pendingFields.length === 0 ? null : (
          <Stack gap="small">
            <Text
              variant="caption"
              tone="neutral"
              valueKey="plugins.github.ui.pendingPanels.description"
              fallback="Answered in the panels beside this one, not on the list row:"
            />
            <Row gap="small">
              {pendingFields.map((field) => (
                <Badge
                  key={field.id}
                  value={field.label}
                  valueKey={githubDetailFieldLabelKey(field.id)}
                />
              ))}
            </Row>
          </Stack>
        )}
        <WritesSection input={input} kindId={kindId} />
      </Stack>
    </ScrollArea>
  );
}

/* --------------------------------------------------------------------- Timeline */

/**
 * The reader-facing sentence for one timeline arm.
 *
 * `forcePushed` and `baseChanged` read differently from an ordinary push on
 * purpose: both silently invalidate work computed against the previous head or
 * base, and a reader scanning the timeline is exactly who needs to notice.
 */
function timelineHeadline(text: PluginTranslate, row: GithubProjectedTimelineRowV1): string {
  // An event this build does not model keeps GitHub's own word for it rather
  // than disappearing or being described as something it is not. GitHub's word
  // is not translated, because it is a provider fact and not this product's
  // sentence about one.
  const modelled = GITHUB_TIMELINE_HEADLINES_V1[row.kind];
  const headline = modelled === undefined
    ? row.rawKind
    : text(githubTimelineHeadlineKey(row.kind), modelled);
  return row.actor === undefined ? headline : `${headline} · ${row.actor}`;
}

function TimelinePanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useGithubTimeline(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading this timeline from GitHub" titleKey="plugins.github.ui.readingTimeline" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The timeline is unavailable"
        titleKey="plugins.github.ui.timelineUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'),
        )}
      />
    );
  }

  const incomplete = incompleteDescription(text, state.incomplete, null);
  return (
    <List
      accessibilityLabel="Events GitHub recorded for this entry"
      accessibilityLabelKey="plugins.github.ui.timelineLabel"
      items={state.rows}
      keyForItem={(row) => row.id}
      header={<PageFailureBanner state={state} />}
      empty={(
        <EmptyState
          title="No recorded events"
          titleKey="plugins.github.ui.noEvents"
          description="GitHub has recorded no timeline events for this entry yet."
          descriptionKey="plugins.github.ui.noEvents.description"
        />
      )}
      footer={(
        <Stack gap="small">
          <Text
            variant="caption"
            tone="neutral"
            valueKey={state.omittedRowCount === 0
              ? 'plugins.github.ui.eventsRead'
              : 'plugins.github.ui.eventsReadWithUnreadable'}
            fallback={state.omittedRowCount === 0
              ? '{count} event(s) read.'
              : '{count} event(s) read. {unreadable} row(s) on the pages read could not be understood.'}
            values={{ count: state.rows.length, unreadable: state.omittedRowCount }}
          />
          {incomplete === null
            ? null
            : <Text variant="caption" tone="neutral">{incomplete}</Text>}
          {state.canLoadMore
            ? (
              <Button
                // GitHub pages this timeline oldest first, so the next page is
                // LATER events, not earlier ones. The control says what it does.
                title="Load more events"
                titleKey="plugins.github.ui.loadMoreEvents"
                variant="secondary"
                busy={state.pending}
                onPress={controller.loadMore}
              />
            )
            : null}
          <RefreshRow
            onRefresh={controller.refresh}
            pending={state.pending}
            accessibilityLabel="Re-read this timeline from GitHub"
            accessibilityLabelKey="plugins.github.ui.rereadTimeline"
          />
        </Stack>
      )}
      renderItem={(row) => (
        <Item
          title={timelineHeadline(text, row)}
          {...(row.summary === undefined ? {} : { subtitle: row.summary })}
          {...(row.atMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, row.atMs, 'relative', nowMs) })}
          {...(row.webUrl === undefined
            ? {}
            : {
              accessory: (
                <Action.OpenExternal
                  url={row.webUrl}
                  variant="plain"
                  accessibilityLabel={text(
                    'plugins.github.ui.openOnGithub',
                    'Open {item} on GitHub',
                    { item: timelineHeadline(text, row) },
                  )}
                />
              ),
            })}
        />
      )}
    />
  );
}

/* ------------------------------------------------------------------------ Files */

const CHANGED_FILE_TONES: Readonly<Record<string, 'success' | 'danger' | 'info' | 'neutral'>> =
  Object.freeze({
    added: 'success',
    removed: 'danger',
    renamed: 'info',
    copied: 'info',
  });

function changedFileDetail(
  row: GithubProjectedChangedFileRowV1,
  locale: string,
): string {
  return `+${formatNumber(locale, row.additions, 'compact')} −${formatNumber(locale, row.deletions, 'compact')}`;
}

function changedFileSubtitle(text: PluginTranslate, row: GithubProjectedChangedFileRowV1): string {
  const renamed = row.previousPath === undefined
    ? null
    : text('plugins.github.ui.fileWasAt', 'was {path}', { path: row.previousPath });
  // A file GitHub omitted the patch for is a real provider fact, and it renders
  // as that fact rather than as an empty diff.
  const diff = row.diffAvailable
    ? null
    : text('plugins.github.ui.fileDiffUnavailable', 'diff unavailable for this file');
  return [row.status, renamed, diff].filter((part) => part !== null).join(' · ');
}

function FilesPanel({
  input,
  locale,
}: Readonly<{ input: TriageDetailSurfaceInputV1; locale: string }>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useGithubChangedFiles(input);
  const { state } = controller;
  // The reading order is a source-owned fact computed over everything read so
  // far, so appending a page reorders within the same three bands rather than
  // stapling a second, differently ordered list onto the end.
  const sections = React.useMemo(
    () => groupGithubChangedFiles(orderGithubChangedFiles(state.rows))
      .map((section) => ({ key: section.band, title: section.title, data: section.rows })),
    [state.rows],
  );

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the changed files from GitHub" titleKey="plugins.github.ui.readingFiles" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The changed files are unavailable"
        titleKey="plugins.github.ui.filesUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'),
        )}
      />
    );
  }

  const incomplete = incompleteDescription(
    text,
    state.incomplete,
    text(
      'plugins.github.ui.incompleteFiles.description',
      'GitHub returns at most {limit} files for one pull request, and this one reached that'
        + ' limit. Open it on GitHub to see the rest.',
      { limit: GITHUB_CHANGED_FILES_CEILING_V1 },
    ),
  );

  if (state.rows.length === 0) {
    return (
      <EmptyState
        title="No changed files"
        titleKey="plugins.github.ui.noFiles"
        description="GitHub reports that this pull request changes no files."
        descriptionKey="plugins.github.ui.noFiles.description"
      />
    );
  }

  return (
    <List
      accessibilityLabel="Files this pull request changes"
      accessibilityLabelKey="plugins.github.ui.filesLabel"
      sections={sections}
      keyForItem={(row) => row.path}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
          {incomplete === null
            ? null
            : (
              // Known-incomplete is a rendered state, not a log line: a count
              // that stops at a round number with no explanation reads as a
              // defect in this product rather than a limit of GitHub's.
              <Banner tone="warning" title="This file list is incomplete" titleKey="plugins.github.ui.incompleteFiles" description={incomplete} />
            )}
        </Stack>
      )}
      footer={(
        <Stack gap="small">
          <Text
            variant="caption"
            tone="neutral"
            valueKey={state.omittedRowCount === 0
              ? 'plugins.github.ui.filesRead'
              : 'plugins.github.ui.filesReadWithUnreadable'}
            fallback={state.omittedRowCount === 0
              ? '{count} changed file(s) read.'
              : '{count} changed file(s) read. {unreadable} row(s) on the pages read could not be understood.'}
            values={{ count: state.rows.length, unreadable: state.omittedRowCount }}
          />
          {state.canLoadMore
            ? (
              <Button
                title="Load more files"
                titleKey="plugins.github.ui.loadMoreFiles"
                variant="secondary"
                busy={state.pending}
                onPress={controller.loadMore}
              />
            )
            : null}
          <RefreshRow
            onRefresh={controller.refresh}
            pending={state.pending}
            accessibilityLabel="Re-read the changed files from GitHub"
            accessibilityLabelKey="plugins.github.ui.rereadFiles"
          />
        </Stack>
      )}
      renderItem={(row) => (
        <Item
          title={row.path}
          subtitle={changedFileSubtitle(text, row)}
          detail={changedFileDetail(row, locale)}
          tone={CHANGED_FILE_TONES[row.status] ?? 'neutral'}
          accessory={(
            <Row gap="small">
              <Action.Copy
                value={row.path}
                variant="plain"
                accessibilityLabel={text('plugins.github.ui.copyValue', 'Copy {item}', {
                  item: row.path,
                })}
              />
              {row.webUrl === undefined
                ? null
                : (
                  <Action.OpenExternal
                    url={row.webUrl}
                    variant="plain"
                    accessibilityLabel={text(
                      'plugins.github.ui.openOnGithub',
                      'Open {item} on GitHub',
                      { item: row.path },
                    )}
                  />
                )}
            </Row>
          )}
        />
      )}
    />
  );
}

/* ----------------------------------------------------------------------- Checks */

function checkTone(row: GithubProjectedCheckRowV1): 'success' | 'danger' | 'warning' | 'neutral' {
  if (row.status !== 'completed') return 'warning';
  if (row.conclusion === undefined) return 'neutral';
  return row.conclusion === 'success' ? 'success' : 'danger';
}

function checksRollup(view: GithubChecksViewV1): readonly MetadataEntry[] {
  // A count is shown only where the source could compute one over a suite it
  // fully read. Rendering `0 failing` for a suite nobody could read would be a
  // fabricated fact, so the entry is absent instead.
  return [
    ...(view.failingCount === undefined
      ? []
      : [{
        label: 'Failing',
        labelKey: 'plugins.github.ui.checksFailing',
        value: String(view.failingCount),
      }]),
    ...(view.runningCount === undefined
      ? []
      : [{
        label: 'Running',
        labelKey: 'plugins.github.ui.checksRunning',
        value: String(view.runningCount),
      }]),
    ...(view.passingCount === undefined
      ? []
      : [{
        label: 'Passing',
        labelKey: 'plugins.github.ui.checksPassing',
        value: String(view.passingCount),
      }]),
  ];
}

function ChecksBody({
  view,
  locale,
  nowMs,
  onRefresh,
}: Readonly<{
  view: GithubChecksViewV1;
  locale: string;
  nowMs: number;
  onRefresh: () => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const rollup = checksRollup(view);
  const failures = [
    ...(view.checkRunsFailure === undefined
      ? []
      : [{
        label: text('plugins.github.ui.checkRuns', 'Check runs'),
        failure: view.checkRunsFailure,
      }]),
    ...(view.commitStatusFailure === undefined
      ? []
      : [{
        label: text('plugins.github.ui.commitStatuses', 'Commit statuses'),
        failure: view.commitStatusFailure,
      }]),
  ];

  return (
    <List
      accessibilityLabel="Checks GitHub reports for this pull request"
      accessibilityLabelKey="plugins.github.ui.checksLabel"
      items={view.rows}
      keyForItem={(row) => row.key}
      header={(
        <Stack gap="small">
          {failures.length === 0
            ? null
            : (
              <Banner
                tone="warning"
                title="One check surface could not be read"
                titleKey="plugins.github.ui.checkSurfaceUnavailable"
                description={failures
                  .map((entry) => `${entry.label}: ${entry.failure.code}`)
                  .join(' · ')}
              />
            )}
          {view.state !== 'knownIncomplete'
            ? null
            : (
              <Banner
                tone="warning"
                title="This check suite is larger than GitHub will list"
                titleKey="plugins.github.ui.checkSuiteIncomplete"
                description="The rows below are real, but they are not the whole suite."
                descriptionKey="plugins.github.ui.checkSuiteIncomplete.description"
              />
            )}
          {rollup.length === 0 ? null : <Metadata title="At this head" titleKey="plugins.github.ui.atHead" entries={rollup} />}
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.github.ui.readAgainstRevision"
            fallback="Read against {revision}."
            values={{ revision: view.headRevision.slice(0, 7) }}
          />
        </Stack>
      )}
      empty={(
        // `none` and `unknown` are different answers and never render alike.
        view.state === 'unknown'
          ? (
            <ErrorState
              title="The checks could not be determined"
              titleKey="plugins.github.ui.checksUnknown"
              description="GitHub did not answer for this commit, so nothing here says the checks passed."
              descriptionKey="plugins.github.ui.checksUnknown.description"
            />
          )
          : (
            <EmptyState
              title="No checks configured"
              titleKey="plugins.github.ui.noChecks"
              description="No check run or commit status reports against this commit."
              descriptionKey="plugins.github.ui.noChecks.description"
            />
          )
      )}
      footer={(
        <Stack gap="small">
          {view.omittedRowCount === 0
            ? null
            : (
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.github.ui.checksNotListed"
                fallback="{count} further check(s) are not listed."
                values={{ count: view.omittedRowCount }}
              />
            )}
          <RefreshRow
            onRefresh={onRefresh}
            pending={false}
            accessibilityLabel="Re-read the checks from GitHub"
            accessibilityLabelKey="plugins.github.ui.rereadChecks"
          />
        </Stack>
      )}
      renderItem={(row) => (
        <Item
          title={row.name}
          subtitle={row.conclusion ?? row.status}
          tone={checkTone(row)}
          {...(row.completedAtMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, row.completedAtMs, 'relative', nowMs) })}
          accessory={(
            <Row gap="small">
              <Action.Copy
                value={row.name}
                variant="plain"
                accessibilityLabel={text('plugins.github.ui.copyValue', 'Copy {item}', {
                  item: row.name,
                })}
              />
              {row.detailsUrl === undefined
                ? null
                : (
                  <Action.OpenExternal
                    url={row.detailsUrl}
                    variant="plain"
                  accessibilityLabel={text(
                    'plugins.github.ui.openResults',
                    'Open results for {item}',
                    { item: row.name },
                  )}
                  />
                )}
            </Row>
          )}
        />
      )}
    />
  );
}

function ChecksPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useGithubChecks(input);
  const checks: GithubReadStateV1<GithubChecksViewV1> = controller.state;

  if (checks.kind === 'loading') {
    return <LoadingState title="Reading the checks from GitHub" titleKey="plugins.github.ui.readingChecks" />;
  }
  if (checks.kind === 'unavailable') {
    return (
      <ErrorState
        title="The checks are unavailable"
        titleKey="plugins.github.ui.checksUnavailable"
        description={failureDescription(
          checks.failure,
          text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'),
        )}
      />
    );
  }
  return (
    <ChecksBody
      view={checks.value}
      locale={locale}
      nowMs={nowMs}
      onRefresh={controller.refresh}
    />
  );
}

/* --------------------------------------------------------------------- Comments */

/**
 * The one sentence this panel owes its reader, every time it is shown.
 *
 * GitHub serves pull-request-level comments, line comments and review bodies as
 * separate resources with separate cursors. This panel reads the first of them,
 * and saying so is what keeps a reader from believing the conversation is empty
 * when it is only elsewhere.
 */
function commentScopeDisclosure(text: PluginTranslate): string {
  return text(
    'plugins.github.ui.commentScope',
    'These are the comments on the entry itself. Review comments anchored to a line are a'
      + ' separate GitHub resource this build does not read.',
  );
}

/**
 * One remark, rendered the same way wherever it is read.
 *
 * The `Comments` panel and the `Feedback` plane show the same GitHub comment,
 * and two markups for one body is how a comment starts announcing its author
 * differently in one product. The two callers differ only in the shape their
 * read hands over, so this row takes the resolved facts rather than either
 * caller's row type.
 */
type GithubCommentRowFactsV1 = Readonly<{
  author: string | null;
  atMs: number | null;
  body: string;
  webUrl: string | null;
  edited: boolean;
}>;

function commentHeadline(text: PluginTranslate, row: GithubCommentRowFactsV1): string {
  const author = row.author ?? text('plugins.github.ui.someone', 'Someone');
  return row.edited
    ? text('plugins.github.ui.commentEdited', '{author} · edited', { author })
    : author;
}

function CommentRow({
  row,
  locale,
  nowMs,
}: Readonly<{
  row: GithubCommentRowFactsV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const headline = commentHeadline(text, row);
  return (
    <Stack gap="small">
      <Row gap="small">
        <Text variant="caption">{headline}</Text>
        {row.atMs === null
          ? null
          : (
            <Text variant="caption" tone="neutral">
              {formatTimestamp(locale, row.atMs, 'relative', nowMs)}
            </Text>
          )}
        {row.webUrl === null
          ? null
          : (
            <Action.OpenExternal
              url={row.webUrl}
              variant="plain"
              accessibilityLabel={text(
                'plugins.github.ui.openOnGithub',
                'Open {item} on GitHub',
                { item: headline },
              )}
            />
          )}
      </Row>
      {row.body === ''
        ? (
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.github.ui.commentNoText"
            fallback="This comment carries no text."
          />
        )
        : <Markdown value={row.body} />}
      <Divider />
    </Stack>
  );
}

function commentRowFacts(row: GithubProjectedCommentRowV1): GithubCommentRowFactsV1 {
  return {
    author: row.author ?? null,
    atMs: row.atMs ?? null,
    body: row.body,
    webUrl: row.webUrl ?? null,
    edited: row.editedAtMs !== undefined,
  };
}

function CommentsPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useGithubComments(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading this conversation from GitHub" titleKey="plugins.github.ui.readingConversation" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The conversation is unavailable"
        titleKey="plugins.github.ui.conversationUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'),
        )}
      />
    );
  }

  const incomplete = incompleteDescription(text, state.incomplete, null);
  return (
    <List
      accessibilityLabel="Comments on this GitHub entry"
      accessibilityLabelKey="plugins.github.ui.commentsLabel"
      items={state.rows}
      keyForItem={(row) => row.id}
      header={(
        <Stack gap="small">
          <Text variant="caption" tone="neutral">{commentScopeDisclosure(text)}</Text>
          <PageFailureBanner state={state} />
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No comments yet"
          titleKey="plugins.github.ui.noComments"
          description={commentScopeDisclosure(text)}
        />
      )}
      footer={(
        <Stack gap="small">
          <Text
            variant="caption"
            tone="neutral"
            valueKey={state.omittedRowCount === 0
              ? 'plugins.github.ui.commentsRead'
              : 'plugins.github.ui.commentsReadWithUnreadable'}
            fallback={state.omittedRowCount === 0
              ? '{count} comment(s) read.'
              : '{count} comment(s) read. {unreadable} row(s) on the pages read could not be understood.'}
            values={{ count: state.rows.length, unreadable: state.omittedRowCount }}
          />
          {state.projectionTruncated
            ? (
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.github.ui.commentsShortened.description"
                fallback="Some comments were shortened. Open the entry on GitHub to read them in full."
              />
            )
            : null}
          {incomplete === null
            ? null
            : <Text variant="caption" tone="neutral">{incomplete}</Text>}
          {state.canLoadMore
            ? (
              <Button
                title="Load more comments"
                titleKey="plugins.github.ui.loadMoreComments"
                variant="secondary"
                busy={state.pending}
                onPress={controller.loadMore}
              />
            )
            : null}
          <RefreshRow
            onRefresh={controller.refresh}
            pending={state.pending}
            accessibilityLabel="Re-read this conversation from GitHub"
            accessibilityLabelKey="plugins.github.ui.rereadConversation"
          />
        </Stack>
      )}
      renderItem={(row) => (
        <CommentRow row={commentRowFacts(row)} locale={locale} nowMs={nowMs} />
      )}
    />
  );
}

/* --------------------------------------------------------------------- Feedback */

/** GitHub's own review-state word, in the reader's language where there is one. */
function reviewStateText(text: PluginTranslate, state: string | null): string {
  if (state === null) {
    return text(GITHUB_REVIEW_STATE_UNKNOWN_KEY_V1, GITHUB_REVIEW_STATE_UNKNOWN_LABEL_V1);
  }
  const normalized = state.trim().toLowerCase();
  const copy = GITHUB_REVIEW_STATE_LABELS_V1[normalized];
  return copy === undefined ? state : text(githubReviewStateKey(normalized), copy);
}

/** The two review-people groups, rendered as two labelled groups and never unioned. */
function ReviewPeople({
  people,
  locale,
  nowMs,
}: Readonly<{
  people: GithubFeedbackReviewPeopleV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (people.reviewed.length === 0 && people.requested.length === 0) return null;

  const someone = text('plugins.github.ui.someone', 'Someone');
  const reviewed: readonly MetadataEntry[] = people.reviewed.map((reviewer) => ({
    label: reviewer.login ?? someone,
    value: reviewer.atMs === null
      ? reviewStateText(text, reviewer.state)
      : `${reviewStateText(text, reviewer.state)} · ${formatTimestamp(locale, reviewer.atMs, 'relative', nowMs)}`,
  }));
  const requested: readonly MetadataEntry[] = people.requested.map((request) => ({
    label: request.subject,
    value: request.atMs === null
      ? text('plugins.github.ui.reviewAwaited', 'Waiting')
      : formatTimestamp(locale, request.atMs, 'relative', nowMs),
  }));

  return (
    <Stack gap="small">
      {reviewed.length === 0
        ? null
        : (
          <Metadata
            title="Reviewed"
            titleKey="plugins.github.ui.reviewedBy"
            entries={reviewed}
          />
        )}
      {requested.length === 0
        ? null
        : (
          // Never merged with the group above: a person who reviewed is history,
          // and a request nobody has answered is work still outstanding.
          <Metadata
            title="Review requested from"
            titleKey="plugins.github.ui.reviewRequestedFrom"
            entries={requested}
          />
        )}
    </Stack>
  );
}

const FINDING_STATE_COPY: Readonly<Record<'check' | 'conflict', Readonly<{
  key: string;
  fallback: string;
}>>> = Object.freeze({
  check: Object.freeze({
    key: 'plugins.github.ui.findingCheck',
    fallback: 'Checks GitHub reports as failing',
  }),
  conflict: Object.freeze({
    key: 'plugins.github.ui.findingConflict',
    fallback: 'GitHub cannot merge this as it stands',
  }),
});

function FeedbackFindingRow({
  finding,
  locale,
  nowMs,
}: Readonly<{
  finding: GithubFeedbackFindingV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  if (finding.resource === 'comment') {
    return (
      <CommentRow
        row={{
          author: finding.author,
          atMs: finding.atMs,
          body: finding.body,
          webUrl: finding.webUrl,
          // The finding arm carries no edit instant, and inventing one would
          // label an unedited comment as edited.
          edited: false,
        }}
        locale={locale}
        nowMs={nowMs}
      />
    );
  }
  const copy = FINDING_STATE_COPY[finding.kind];
  return (
    <Item
      // GitHub's own words for the state, kept as the provider fact they are.
      title={finding.label}
      subtitle={text(copy.key, copy.fallback)}
      tone={finding.tone}
      {...(finding.atMs === null
        ? {}
        : { detail: formatTimestamp(locale, finding.atMs, 'relative', nowMs) })}
    />
  );
}

/**
 * The `Feedback` plane: what is being said about this pull request, who has
 * signed off, who is still being waited on, and what GitHub reports as wrong.
 *
 * It composes the two walks this surface already owns rather than opening a
 * third route, so a reviewer gets the whole picture for the provider budget the
 * conversation alone already cost. The two walks settle independently: one
 * failing leaves the other's rows on screen beside a banner naming exactly what
 * could not be read, because blanking the plane because the event walk 403'd
 * throws away the comments that answered.
 */
function FeedbackPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const conversation = useGithubComments(input);
  const history = useGithubTimeline(input);
  const { observation } = input;
  const view: GithubFeedbackViewV1 = React.useMemo(
    () => projectGithubFeedback({
      facts: observation.snapshot.facts,
      observedAtMs: observation.observedAtMs,
      comments: conversation.state.rows,
      timeline: history.state.rows,
    }),
    [conversation.state.rows, history.state.rows, observation],
  );

  const conversationSettling = conversation.state.kind === 'idle'
    || conversation.state.kind === 'loading';
  const historySettling = history.state.kind === 'idle' || history.state.kind === 'loading';
  if (conversationSettling && historySettling) {
    return (
      <LoadingState
        title="Reading the feedback on this pull request from GitHub"
        titleKey="plugins.github.ui.readingFeedback"
      />
    );
  }

  const readFailed = text(
    'plugins.github.ui.readFailed',
    'GitHub could not complete this read.',
  );
  if (conversation.state.kind === 'unavailable' && history.state.kind === 'unavailable') {
    // Cold: neither read answered, so there is no content to keep and nothing
    // honest to say beyond that we could not look.
    return (
      <ErrorState
        title="The feedback is unavailable"
        titleKey="plugins.github.ui.feedbackUnavailable"
        description={failureDescription(conversation.state.failure, readFailed)}
      />
    );
  }

  // Each connection names ITSELF. "Something failed" over a partial plane leaves
  // the reader unable to tell which half of the picture they are missing.
  const failedConnections = [
    ...(conversation.state.kind === 'unavailable' || conversation.state.failure !== null
      ? [text('plugins.github.ui.feedbackConversationFailed', 'the conversation')]
      : []),
    ...(history.state.kind === 'unavailable' || history.state.failure !== null
      ? [text('plugins.github.ui.feedbackHistoryFailed', 'the review history')]
      : []),
  ];
  // Review people are only ever as settled as the walk they were read from, and
  // GitHub pages this history oldest first, so an unfinished walk means the
  // newest reviews are the ones missing. Saying so is what keeps "nobody has
  // approved this" from being read as a fact.
  const historyPartial = history.state.canLoadMore
    || history.state.incomplete !== null
    || history.state.failure !== null
    || history.state.kind === 'unavailable';
  const commentsIncomplete = incompleteDescription(text, conversation.state.incomplete, null);

  return (
    <List
      accessibilityLabel="Feedback on this pull request"
      accessibilityLabelKey="plugins.github.ui.feedbackLabel"
      items={view.findings}
      keyForItem={(finding) => `${finding.resource}:${finding.id}`}
      header={(
        <Stack gap="medium">
          {view.review.kind === 'decided'
            ? (
              <Row gap="small">
                <Status
                  tone={view.review.tone}
                  label={text('plugins.github.ui.reviewDecision', 'Review: {value}', {
                    value: view.review.label,
                  })}
                />
              </Row>
            )
            : (
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.github.ui.reviewUnresolved"
                fallback={'GitHub did not report a review decision for this observation, so'
                  + ' nothing here says whether it is approved.'}
              />
            )}
          <ReviewPeople people={view.people} locale={locale} nowMs={nowMs} />
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.github.ui.feedbackScope"
            fallback={'This is the conversation on the pull request itself, who has reviewed'
              + ' it, and what GitHub reports as wrong with it. Comments anchored to a line'
              + ' of the diff, and whether their threads are resolved, are a separate GitHub'
              + ' resource this build does not read.'}
          />
          {historyPartial
            ? (
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.github.ui.feedbackHistoryPartial"
                fallback={'Review history was read only as far as the events loaded so far.'
                  + ' Who has reviewed and who is still being waited on may have changed'
                  + ' since.'}
              />
            )
            : null}
          {failedConnections.length === 0
            ? null
            : (
              <Banner
                tone="warning"
                title="Part of this feedback could not be read"
                titleKey="plugins.github.ui.feedbackPartial"
                description={failureDescription(
                  conversation.state.failure ?? history.state.failure,
                  text(
                    'plugins.github.ui.feedbackPartial.description',
                    'GitHub could not complete {connections}, so it is missing from what is'
                      + ' shown here.',
                    { connections: failedConnections.join(', ') },
                  ),
                )}
              />
            )}
        </Stack>
      )}
      empty={(
        <EmptyState
          title="Nothing has been said yet"
          titleKey="plugins.github.ui.noFeedback"
          description={text(
            'plugins.github.ui.noFeedback.description',
            'No comment has been left on this pull request, and GitHub reports nothing wrong'
              + ' with it.',
          )}
        />
      )}
      footer={(
        <Stack gap="small">
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.github.ui.feedbackRead"
            fallback="{comments} comment(s) and {events} event(s) read."
            values={{
              comments: conversation.state.rows.length,
              events: history.state.rows.length,
            }}
          />
          {conversation.state.projectionTruncated
            ? (
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.github.ui.commentsShortened.description"
                fallback="Some comments were shortened. Open the entry on GitHub to read them in full."
              />
            )
            : null}
          {commentsIncomplete === null
            ? null
            : <Text variant="caption" tone="neutral">{commentsIncomplete}</Text>}
          {conversation.state.canLoadMore
            ? (
              <Button
                title="Load more comments"
                titleKey="plugins.github.ui.loadMoreComments"
                variant="secondary"
                busy={conversation.state.pending}
                onPress={conversation.loadMore}
              />
            )
            : null}
          {history.state.canLoadMore
            ? (
              <Button
                title="Load more events"
                titleKey="plugins.github.ui.loadMoreEvents"
                variant="secondary"
                busy={history.state.pending}
                onPress={history.loadMore}
              />
            )
            : null}
          <RefreshRow
            onRefresh={() => {
              conversation.refresh();
              history.refresh();
            }}
            pending={conversation.state.pending || history.state.pending}
            accessibilityLabel="Re-read this feedback from GitHub"
            accessibilityLabelKey="plugins.github.ui.rereadFeedback"
          />
        </Stack>
      )}
      renderItem={(finding) => (
        <FeedbackFindingRow finding={finding} locale={locale} nowMs={nowMs} />
      )}
    />
  );
}

/* ---------------------------------------------------------------- Work Sessions */

/**
 * The issue composition's `Work Sessions` panel: the exact bounded projection the input
 * carried, rendered read-only. It performs no Session-store read and owns no Session.
 */
function WorkSessionsPanel({
  sessions,
}: Readonly<{ sessions: readonly TriageLinkedSessionProjectionV1[] }>): React.ReactElement {
  const text = usePluginTranslation();
  if (sessions.length === 0) {
    return (
      <EmptyState
        title="No linked sessions"
        titleKey="plugins.github.ui.noSessions"
        description="Sessions started from this issue will be listed here."
        descriptionKey="plugins.github.ui.noSessions.description"
      />
    );
  }
  return (
    <List accessibilityLabel="Sessions linked to this GitHub issue" accessibilityLabelKey="plugins.github.ui.sessionsLabel">
      <ItemGroup>
        {sessions.map((session) => (
          <Item
            key={session.sessionId}
            title={session.displayTitle ?? session.sessionId}
            // A retained link whose Session summary is unavailable keeps its id and loses
            // only its display text. It is never presented as "never linked".
            subtitle={session.displayTitle === undefined
              ? text(
                'plugins.github.ui.sessionUnavailable',
                'Session details are unavailable',
              )
              : undefined}
          />
        ))}
      </ItemGroup>
    </List>
  );
}

/* ------------------------------------------------------------------ detail body */

function GithubDetailBody({
  input,
  kindId,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const [selected, setSelected] = React.useState<GithubDetailTabIdV1>(
    GITHUB_DEFAULT_DETAIL_TAB_V1,
  );
  // One render-time read, passed down as data, so no child owns a hidden clock.
  const nowMs = Date.now();
  const body = React.useMemo(() => projectGithubDetailBody(input), [input]);

  const visible = githubVisibleDetailTabs(kindId);
  const tab = githubResolveSelectedTab(selected, visible);

  const panels: Readonly<Record<GithubDetailTabIdV1, React.ReactNode>> = {
    overview: (
      <OverviewPanel
        body={body}
        input={input}
        kindId={kindId}
        locale={locale}
        nowMs={nowMs}
      />
    ),
    timeline: <TimelinePanel input={input} locale={locale} nowMs={nowMs} />,
    files: <FilesPanel input={input} locale={locale} />,
    checks: <ChecksPanel input={input} locale={locale} nowMs={nowMs} />,
    feedback: <FeedbackPanel input={input} locale={locale} nowMs={nowMs} />,
    comments: <CommentsPanel input={input} locale={locale} nowMs={nowMs} />,
    'work-sessions': <WorkSessionsPanel sessions={body.linkedSessions} />,
  };

  return (
    <Screen safeArea>
      <Tabs
        value={tab}
        onValueChange={(next) => {
          // The visible declarations are the only tab identities this body renders, so a value
          // that is not one of them selects nothing rather than becoming a tab id by assertion.
          const declared = visible.find((candidate) => candidate.id === next);
          if (declared !== undefined) setSelected(declared.id);
        }}
        ariaLabel={text('plugins.github.ui.detailTabs', 'GitHub entry detail')}
      >
        {visible.map((declaration) => (
          <Tabs.Item
            key={declaration.id}
            value={declaration.id}
            // `Tabs.Item` takes a plain string, so the declaration carries both
            // halves and the title is resolved here rather than read.
            title={text(declaration.titleKey, declaration.title)}
            // Stated, never inherited: the shared primitive would otherwise discard a panel
            // this source means to keep, or keep one it means to discard.
            retention={declaration.retention}
            {...(declaration.id === 'work-sessions' && body.linkedSessions.length > 0
              ? { badge: String(body.linkedSessions.length) }
              : {})}
          >
            {panels[declaration.id]}
          </Tabs.Item>
        ))}
      </Tabs>
    </Screen>
  );
}

function GithubDetailSurface(context: RenderContext): React.ReactElement {
  const admitted = React.useMemo(() => {
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
    if (!parsed.success) return { ok: false as const };
    const kindId = readGithubTriageKindId(parsed.data.observation.entryRef.kindId);
    // A kind this source never declared cannot select a composition, and guessing
    // one would render a pull request's panels over an entry that is not one.
    return kindId === null
      ? { ok: false as const }
      : { ok: true as const, input: parsed.data, kindId };
  }, [context.launchInput]);

  if (!admitted.ok) {
    return (
      <Screen safeArea>
        <ErrorState
          title="This entry cannot be shown"
          titleKey="plugins.github.ui.invalidInput"
          description="Triage supplied a detail input this GitHub build does not accept."
          descriptionKey="plugins.github.ui.invalidInput.description"
        />
      </Screen>
    );
  }

  return <GithubDetailBody input={admitted.input} kindId={admitted.kindId} />;
}

/**
 * The exact export name the build target's Module Federation identity names. Renaming it breaks
 * the native artifact contract, not just this file.
 */
export const renderSurface = defineUiSurface(GithubDetailSurface);

import * as React from 'react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  AnsiText,
  Button,
  CheckStatusGlyph,
  HappierChevron,
  HappierDisclosureChevron,
  HappierPressable,
  Icon,
  IconButton,
  List,
  LoadingState,
  Row,
  Stack,
  Tabs,
  Text,
  usePluginHostApi,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import type {
  ForgeCiJobRefV1,
  ForgeCiJobV1,
  ForgeCiMountedIntentOperationV1,
  ForgeCiStepV1,
} from '@happier-dev/triage-protocol/ci/v1';
import { useOptionalHappierUiPalette } from '@happier-dev/plugin-ui/environment';
import type {
  ForgeCiLogIndexV1,
  ForgeCiLogLineV1,
} from '../../runtime/logs/index.js';
import type { ForgeCiLogGroupV1 } from '../../runtime/logs/groups.js';
import {
  forgeCiJobKeyV1,
  forgeCiSelectionKeyV1,
} from '../../runtime/identity.js';
import { ForgeCiJobView } from '../ForgeCiJobView.js';
import type { ForgeCiMountedViewV1 } from '../mountedCiIntent.js';
import { readForgeOperationStateV1 } from '../operationState.js';
import { useForgeCiLogViewerV1 } from '../useForgeCiLogViewer.js';
import { useForgeCiMountedViewStateV1 } from '../useForgeCiMountedView.js';
import { useForgeCiQueryStatusV1 } from '../useForgeCiReads.js';
import type { ForgeCiBindingV1 } from './binding.js';
import type { ForgeCiReadValueV1 } from '../../runtime/reads.js';
import { presentForgeCiStatusV1 } from './ciStatus.js';
import { ForgeCiElapsedText } from './ForgeCiElapsedText.js';
import { formatForgeCiDurationV1, readForgeCiElapsedMsV1 } from './format.js';
import { ForgeCiStateNotice } from './ForgeCiStateNotice.js';
import { useForgeCiMutationV1 } from './useForgeCiMutation.js';
import { ForgeCiDownloadNotice, useForgeCiDownloadV1 } from './useForgeCiDownload.js';
import { ForgeCiLogFindBar } from './ForgeCiLogFindBar.js';

export type ForgeCiJobPanelProps = Readonly<{
  ci: ForgeCiBindingV1;
  job: ForgeCiJobRefV1;
  /** The job as the run's jobs projection already holds it; no second job read when present. */
  admittedJob?: ForgeCiJobV1 | null;
  /** The host's mounted CI view (selection, folds, timestamps, Find), shared with agents through `ui/ci-view-v1`. */
  view: ForgeCiMountedViewV1 | null;
  /** The Find surface id the host registers this mount's log under. */
  surfaceId: string;
  presentation: 'page' | 'pane';
  /** Back to the run ("CI #4820"), when the host draws no Back of its own. */
  back?: Readonly<{ label: string; onPress: () => void }>;
  chrome?: ReactNode;
  /** 08's Reproduce locally entry for this job, when the host has an accepted checkout. */
  jobAction?: ReactNode;
  /** What the page shows above the job (lab a5: the run's own header), scrolling with the log. */
  lead?: ReactNode;
  testID?: string;
}>;

type LogSegment = Readonly<{
  key: string;
  kind: 'step' | 'ambiguous' | 'unattributed';
  step: ForgeCiStepV1 | null;
  /** Candidate steps of output whose timing fits more than one step. */
  candidates: readonly ForgeCiStepV1[];
  lines: readonly ForgeCiLogLineV1[];
}>;

type LogRow =
  | Readonly<{
      kind: 'segment';
      key: string;
      segment: LogSegment;
      open: boolean;
    }>
  | Readonly<{
      kind: 'group';
      key: string;
      group: ForgeCiLogGroupV1;
      depth: number;
      count: number;
      open: boolean;
    }>
  | Readonly<{
      kind: 'line';
      key: string;
      line: ForgeCiLogLineV1;
      depth: number;
      segment: LogSegment;
    }>;

/**
 * Lines into steps by native timing only (plan 02 §7): a line whose time fits one step joins it; a line that fits
 * several keeps its candidates; a line with no time stays unattributed. Steps with no output still appear, in order.
 */
function segmentLog(
  lines: readonly ForgeCiLogLineV1[],
  steps: readonly ForgeCiStepV1[],
): readonly LogSegment[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const segments: Array<{
    key: string;
    kind: LogSegment['kind'];
    step: ForgeCiStepV1 | null;
    candidates: ForgeCiStepV1[];
    lines: ForgeCiLogLineV1[];
  }> = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const attribution = line.attribution;
    const stepId =
      attribution.kind === 'step' ? (attribution.stepIds[0] ?? null) : null;
    const key =
      stepId !== null
        ? `step:${stepId}`
        : attribution.kind === 'ambiguous'
          ? `ambiguous:${attribution.stepIds.join(',')}`
          : 'unattributed';
    const last = segments[segments.length - 1];
    if (
      last &&
      (last.kind === 'step'
        ? `step:${last.step?.id}`
        : last.key.replace(/#\d+$/u, '')) === key
    ) {
      last.lines.push(line);
      continue;
    }
    const kind =
      stepId !== null
        ? 'step'
        : attribution.kind === 'ambiguous'
          ? 'ambiguous'
          : 'unattributed';
    const unique = seen.has(key) ? `${key}#${line.number}` : key;
    seen.add(key);
    segments.push({
      key: unique,
      kind,
      step: stepId === null ? null : (byId.get(stepId) ?? null),
      candidates:
        attribution.kind === 'ambiguous'
          ? attribution.stepIds
              .map((id) => byId.get(id))
              .filter((s): s is ForgeCiStepV1 => !!s)
          : [],
      lines: [line],
    });
  }
  // Steps that wrote nothing (skipped, still queued) keep their place after the step before them.
  const ordered: LogSegment[] = [];
  const present = new Set(
    segments.filter((s) => s.kind === 'step').map((s) => s.step?.id),
  );
  let cursor = 0;
  for (const step of steps) {
    if (present.has(step.id)) {
      while (cursor < segments.length) {
        const segment = segments[cursor++]!;
        ordered.push(segment);
        if (segment.kind === 'step' && segment.step?.id === step.id) break;
      }
      continue;
    }
    ordered.push({
      key: `step:${step.id}:empty`,
      kind: 'step',
      step,
      candidates: [],
      lines: [],
    });
  }
  while (cursor < segments.length) ordered.push(segments[cursor++]!);
  // Output GitHub's step times cannot pin to one step sits right under the step a reader opens it for: the failed
  // candidate, else the first. Its header keeps the uncertainty ("Output between …"); it never joins that step.
  const placed = ordered.filter((segment) => segment.kind !== 'ambiguous');
  for (const segment of ordered) {
    if (segment.kind !== 'ambiguous') continue;
    const anchor =
      segment.candidates.find((step) => presentForgeCiStatusV1(step.state).kind === 'failed') ??
      segment.candidates[0];
    const at = anchor
      ? placed.findIndex((other) => other.kind === 'step' && other.step?.id === anchor.id)
      : -1;
    if (at < 0) placed.push(segment);
    else placed.splice(at + 1, 0, segment);
  }
  return placed;
}

/**
 * Open by default (lab a5): the failed step's own output, and output shared with a failed step when GitHub's
 * timing cannot say which step wrote it. A failed step with no output of its own stays a closed header above it.
 */
function opensByDefault(segment: LogSegment): boolean {
  if (segment.kind === 'ambiguous')
    return segment.candidates.some((step) => presentForgeCiStatusV1(step.state).kind === 'failed');
  return segmentStatus(segment)?.kind === 'failed' && segment.lines.length > 0;
}

function segmentStatus(segment: LogSegment) {
  return segment.step ? presentForgeCiStatusV1(segment.step.state) : null;
}

/** The rows a reader sees: open steps and groups expand into their lines; folded ones stay one row. */
function flatten(
  segments: readonly LogSegment[],
  index: ForgeCiLogIndexV1,
  openSegments: ReadonlySet<string>,
  groupExpanded: Readonly<Record<string, boolean>>,
): readonly LogRow[] {
  const groups = new Map(index.groups.map((group) => [group.id, group]));
  const rows: LogRow[] = [];
  for (const segment of segments) {
    const open = openSegments.has(segment.key);
    rows.push({ kind: 'segment', key: `s:${segment.key}`, segment, open });
    if (!open) continue;
    const announced = new Set<string>();
    for (const line of segment.lines) {
      // The innermost closed group hides its lines behind one row naming the group and its size.
      let hidden = false;
      let depth = 0;
      for (const groupId of line.groupIds) {
        const group = groups.get(groupId);
        if (!group) continue;
        if (!announced.has(groupId)) {
          announced.add(groupId);
          const count = segment.lines.filter((other) =>
            other.groupIds.includes(groupId),
          ).length;
          rows.push({
            kind: 'group',
            key: `g:${groupId}`,
            group,
            depth,
            count,
            open: groupExpanded[groupId] === true,
          });
        }
        if (groupExpanded[groupId] !== true) {
          hidden = true;
          break;
        }
        depth++;
      }
      if (!hidden)
        rows.push({ kind: 'line', key: `l:${line.id}`, line, depth, segment });
    }
  }
  return rows;
}

/** GitHub-style permalink to one line, when the job's page and the step's number are known. */
function lineLink(
  job: ForgeCiJobV1 | null,
  row: Extract<LogRow, { kind: 'line' }>,
): string | null {
  if (
    !job?.webUrl ||
    !row.segment.step ||
    row.segment.step.number === undefined
  )
    return null;
  const position = row.segment.lines.indexOf(row.line) + 1;
  return `${job.webUrl}#step:${row.segment.step.number}:${position}`;
}

/** The job's mark and name: grows on a wide header, keeps a readable width before its controls wrap. */
const JOB_IDENTITY_STYLE = { flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0 } as const;

function JobHeader({
  ci,
  job,
  annotationsOpen,
  onToggleAnnotations,
  annotationsBody,
  jobAction,
  chrome,
  back,
  compact,
}: Readonly<{
  ci: ForgeCiBindingV1;
  job: ForgeCiJobV1;
  annotationsOpen: boolean;
  onToggleAnnotations: () => void;
  annotationsBody: ReactNode;
  jobAction?: ReactNode;
  chrome?: ReactNode;
  back?: ForgeCiJobPanelProps['back'];
  compact: boolean;
}>): ReactElement {
  const t = usePluginTranslation();
  const host = usePluginHostApi();
  const { locale } = useSurfaceContext();
  const { spacing } = usePluginTheme();
  const status = presentForgeCiStatusV1(job.state);
  const live = job.state.phase === 'running';
  const elapsed = live ? null : readForgeCiElapsedMsV1(job, Date.now());
  const mutation = useForgeCiMutationV1(ci, () => undefined);
  const running =
    job.state.phase !== 'completed' && job.state.phase !== 'unknown';
  const attempt =
    job.ref.selection.kind === 'attempt'
      ? job.ref.selection.attempt.attemptId
      : null;
  const facts = [
    t(status.wordKey, status.word),
    elapsed === null ? null : formatForgeCiDurationV1(elapsed, locale),
    // A running job's clock is drawn by its own leaf just after the state word.
    attempt ? t('forgeCi.job.attempt', 'Attempt {attempt}', { attempt }) : null,
    job.runnerName ?? null,
    ...(job.runnerLabels ?? []),
  ].filter((part): part is string => !!part);
  const run =
    job.ref.selection.kind === 'attempt'
      ? job.ref.selection.attempt.run
      : job.ref.selection.run;
  const count = job.annotationsCount;
  return (
    <Stack gap="small" testID="forge-ci-job-header">
      {back ? (
        <Row>
          <Button
            title={back.label}
            variant="plain"
            size="small"
            icon={<Icon name="back" size="small" />}
            onPress={back.onPress}
          />
        </Row>
      ) : null}
      {/* The job's name keeps a readable width; on a narrow page its controls wrap beneath it, never squeezing
          it to a letter. */}
      <Row gap="small" align="center" wrap>
        <Row gap="small" align="center" style={JOB_IDENTITY_STYLE}>
          <CheckStatusGlyph
            status={status.kind}
            size={compact ? 16 : 18}
            accessibilityLabel={t(status.wordKey, status.word)}
          />
          <Stack grow>
            <Text variant="heading" value={job.name} numberOfLines={1} />
          </Stack>
        </Row>
        {!running && ci.adapter ? (
          <Button
            title={t('forgeCi.job.rerun', 'Re-run this job')}
            variant="secondary"
            size="small"
            busy={mutation.state.pending === 'rerunJob'}
            onPress={() =>
              mutation.run('rerunJob', {
                repository: run.repository,
                runId: run.runId,
                jobId: job.ref.jobId,
                ...(attempt ? { attempt } : {}),
              })
            }
          />
        ) : null}
        {jobAction}
        {job.webUrl ? (
          <IconButton
            icon={<Icon name="external" size="small" />}
            accessibilityLabel={t(
              'forgeCi.job.openOn',
              'View this job on {forge}',
              { forge: ci.about.forgeName },
            )}
            onPress={() => {
              void host.openExternalLink(job.webUrl!);
            }}
          />
        ) : null}
        {chrome}
      </Row>
      {live ? (
        <Row gap="xsmall" align="center" wrap>
          <Text variant="meta" tone="secondary" value={`${facts[0]} ·`} />
          <ForgeCiElapsedText item={job} />
          {facts.length > 1 ? <Text variant="meta" tone="secondary" value={`· ${facts.slice(1).join(' · ')}`} /> : null}
        </Row>
      ) : (
        <Row gap="xsmall" align="center" wrap>
          <Text variant="meta" tone={status.kind === 'failed' ? 'danger' : 'secondary'} value={facts[0] ?? ''} />
          {/* Each fact wraps as its own unit, so a narrow page breaks between facts, not after the state word. */}
          {facts.slice(1).map((fact, index) => (
            <Text key={`${index}:${fact}`} variant="meta" tone="secondary" value={`· ${fact}`} />
          ))}
        </Row>
      )}
      {!running && ci.adapter ? (
        <Text
          variant="micro"
          tone="muted"
          valueKey="forgeCi.job.rerunScope"
          fallback="Re-running also re-runs the jobs that depend on this one."
        />
      ) : null}
      {mutation.state.last &&
      mutation.state.last.result.kind !== 'accepted' &&
      mutation.state.last.result.kind !== 'confirmed' ? (
        <ForgeCiStateNotice
          presentation="banner"
          about={{ ...ci.about, subject: t('forgeCi.subject.job', 'this job') }}
          state={readForgeOperationStateV1({
            mutation: mutation.state.last.result,
            account: ci.account,
            hasRetainedValue: true,
            targetUrl: job.webUrl ?? null,
          })}
        />
      ) : null}
      {running ? null : (
        <Stack gap="xsmall" style={{ paddingTop: spacing.xsmall }}>
          <DisclosureRow open={annotationsOpen} minHeight={32} onToggle={onToggleAnnotations}
            label={count === undefined
                ? t('forgeCi.annotationsCountUnknown', 'Annotations — count unknown')
                : t('forgeCi.job.annotations', 'Annotations {count}', { count })}>
            <Text variant="label" valueKey="forgeCi.job.annotationsTitle" fallback="Annotations" />
            {count === undefined
              ? <Text variant="meta" tone="muted" valueKey="forgeCi.job.annotationsUnknown" fallback="count unknown" />
              : <Text variant="meta" tone="secondary" value={String(count)} />}
          </DisclosureRow>
          {annotationsOpen ? annotationsBody : null}
        </Stack>
      )}
    </Stack>
  );
}

function AnnotationsBody({
  query,
  annotations,
  ci,
}: Readonly<{
  query: Parameters<typeof useForgeCiQueryStatusV1>[0];
  annotations: ForgeCiReadValueV1<'listAnnotations'> | null;
  ci: ForgeCiBindingV1;
}>): ReactElement {
  const t = usePluginTranslation();
  const status = useForgeCiQueryStatusV1(query);
  if (annotations === null) {
    const failure = status.snapshot?.failure ?? null;
    if (failure) {
      return (
        <ForgeCiStateNotice
          presentation="line"
          about={{
            ...ci.about,
            subject: t('forgeCi.subject.annotations', 'the annotations'),
          }}
          state={readForgeOperationStateV1({
            failure,
            account: ci.account,
            hasRetainedValue: false,
          })}
          onRetry={status.refresh}
        />
      );
    }
    return (
      <LoadingState
        title={t('forgeCi.annotations.loading', 'Reading annotations')}
        layout="line"
        rows={2}
      />
    );
  }
  if (annotations.rows.length === 0) {
    return (
      <Text
        variant="meta"
        tone="secondary"
        valueKey="forgeCi.annotations.none"
        fallback="No annotations on this job."
      />
    );
  }
  return (
    <Stack gap="xsmall">
      {annotations.rows.map((annotation) => (
        <Row key={annotation.id} gap="small" align="flex-start">
          <CheckStatusGlyph
            status={
              annotation.level === 'error'
                ? 'failed'
                : annotation.level === 'warning'
                  ? 'waiting'
                  : 'neutral'
            }
            size={14}
          />
          <Stack grow gap="none">
            <Text
              variant="body"
              value={
                annotation.title
                  ? `${annotation.title} · ${annotation.message}`
                  : annotation.message
              }
            />
            {annotation.path ? (
              <Text
                variant="code"
                tone="secondary"
                value={
                  annotation.startLine === undefined
                    ? annotation.path
                    : `${annotation.path}:${annotation.startLine}`
                }
              />
            ) : null}
          </Stack>
        </Row>
      ))}
    </Stack>
  );
}

/**
 * One job (D-22, lab a5): the job's identity, facts and annotations disclosure, then its step-segmented log.
 * Steps open in place (the failed one starts open), `::group::` blocks fold, Find marks and reveals matches across
 * folds, and the toolbar holds the in-memory timestamps toggle, Failed only, jump to the end, copy and download.
 */
export function ForgeCiJobPanel(props: ForgeCiJobPanelProps): ReactElement {
  const viewState = useForgeCiMountedViewStateV1(props.view);
  const { view, job } = props;
  // The mount's selection follows the job this panel shows, so Find and ui/ci-view-v1 address it.
  useEffect(() => {
    if (!view) return;
    const state = view.getSnapshot();
    if (!state) return;
    if (
      !state.selection ||
      forgeCiSelectionKeyV1(state.selection) !==
        forgeCiSelectionKeyV1(job.selection)
    ) {
      void view.invoke({
        mountId: view.mountId,
        operation: { kind: 'selectAttempt', selection: job.selection },
      });
    }
    if (!state.job || forgeCiJobKeyV1(state.job) !== forgeCiJobKeyV1(job)) {
      void view.invoke({
        mountId: view.mountId,
        operation: { kind: 'selectJob', job },
      });
    }
  }, [view, job]);
  const annotationsExpanded = viewState?.annotationsExpanded === true;
  return (
    <ForgeCiJobView
      reads={props.ci.reads}
      job={job}
      {...(props.admittedJob === undefined
        ? {}
        : { admittedJob: props.admittedJob })}
      annotationsExpanded={annotationsExpanded}
      logExpanded
      logSelection={viewState?.tailLines == null ? { kind: 'all' } : { kind: 'tail', lines: viewState.tailLines }}
    >
      {(model) => (
        <JobBody
          {...props}
          model={model}
          annotationsExpanded={annotationsExpanded}
        />
      )}
    </ForgeCiJobView>
  );
}

function JobBody(
  props: ForgeCiJobPanelProps &
    Readonly<{
      model: Parameters<Parameters<typeof ForgeCiJobView>[0]['children']>[0];
      annotationsExpanded: boolean;
    }>,
): ReactElement {
  const t = usePluginTranslation();
  const { ci, model, view } = props;
  const job = model.job;
  const running =
    job !== null &&
    job.state.phase !== 'completed' &&
    job.state.phase !== 'unknown';
  const jobStatus = useForgeCiQueryStatusV1(model.jobQuery);
  const logStatus = useForgeCiQueryStatusV1(model.logQuery);
  const toggleAnnotations = useCallback(() => {
    if (!view) return;
    void view.invoke({
      mountId: view.mountId,
      operation: {
        kind: 'setAnnotationsExpanded',
        expanded: !props.annotationsExpanded,
      },
    });
  }, [view, props.annotationsExpanded]);
  const about = { ...ci.about, subject: t('forgeCi.subject.job', 'this job') };

  if (job === null) {
    const failure = model.failure ?? jobStatus.snapshot?.failure ?? null;
    if (failure) {
      return (
        <ForgeCiStateNotice
          presentation="surface"
          about={about}
          onRetry={jobStatus.refresh}
          state={readForgeOperationStateV1({
            failure,
            account: ci.account,
            hasRetainedValue: false,
          })}
        />
      );
    }
    return (
      <LoadingState
        title={t('forgeCi.job.loading', 'Reading this job')}
        rows={4}
      />
    );
  }

  const jobHeader = (
    <JobHeader
      ci={ci}
      job={job}
      annotationsOpen={props.annotationsExpanded}
      onToggleAnnotations={toggleAnnotations}
      annotationsBody={
        <AnnotationsBody
          query={model.annotationsQuery}
          annotations={model.annotations}
          ci={ci}
        />
      }
      jobAction={props.jobAction}
      chrome={props.chrome}
      back={props.back}
      compact={props.presentation === 'pane'}
    />
  );
  const header = props.lead ? (
    <Stack gap="xlarge">
      {props.lead}
      {jobHeader}
    </Stack>
  ) : jobHeader;

  const log = model.log;
  if (running || log?.kind === 'pending') {
    return (
      <Stack gap="large" {...(props.testID === undefined ? {} : { testID: props.testID })}>
        {header}
        <StepsOnly job={job} />
        <Text
          variant="meta"
          tone="secondary"
          valueKey="forgeCi.log.pending"
          fallback="Logs appear when this job finishes. Steps and their timings update while you watch."
        />
      </Stack>
    );
  }
  if (log?.kind === 'expired' || log?.kind === 'unsupported') {
    return (
      <Stack gap="large" {...(props.testID === undefined ? {} : { testID: props.testID })}>
        {header}
        <StepsOnly job={job} />
        <Text
          variant="meta"
          tone="secondary"
          value={
            log.kind === 'expired'
              ? t(
                  'forgeCi.log.expired',
                  'This job’s log has expired on {forge}.',
                  { forge: ci.about.forgeName },
                )
              : t(
                  'forgeCi.log.unsupported',
                  '{forge} doesn’t provide a log for this job.',
                  { forge: ci.about.forgeName },
                )
          }
        />
      </Stack>
    );
  }
  if (model.logIndex === null || view === null) {
    const failure = logStatus.snapshot?.failure ?? null;
    return (
      <Stack gap="large" {...(props.testID === undefined ? {} : { testID: props.testID })}>
        {header}
        {failure ? (
          <ForgeCiStateNotice
            presentation="surface"
            about={{
              ...ci.about,
              subject: t('forgeCi.subject.log', 'this log'),
            }}
            onRetry={logStatus.refresh}
            state={readForgeOperationStateV1({
              failure,
              account: ci.account,
              hasRetainedValue: false,
            })}
          />
        ) : (
          <LoadingState
            title={t('forgeCi.log.loading', 'Reading the log')}
            rows={8}
            layout="line"
          />
        )}
      </Stack>
    );
  }
  return (
    <LogView
      {...props}
      job={job}
      header={header}
      index={model.logIndex}
      view={view}
    />
  );
}

/** A running job's steps, live: no log yet, so the steps and their clocks carry the story. */
function StepsOnly({
  job,
}: Readonly<{ job: ForgeCiJobV1 }>): ReactElement | null {
  const t = usePluginTranslation();
    if (job.steps.kind !== 'available') return null;
  return (
    <Stack gap="none">
      {job.steps.values.map((step) => {
        const status = presentForgeCiStatusV1(step.state);
        return (
          <Row
            key={step.id}
            gap="small"
            align="center"
            style={{ minHeight: 36 }}
          >
            <CheckStatusGlyph
              status={status.kind}
              size={14}
              accessibilityLabel={t(status.wordKey, status.word)}
            />
            <Stack grow>
              <Text variant="body" value={step.name} numberOfLines={1} />
            </Stack>
            <ForgeCiElapsedText item={step} />
          </Row>
        );
      })}
    </Stack>
  );
}

function LogView(
  props: Omit<ForgeCiJobPanelProps, 'job' | 'view'> &
    Readonly<{
      job: ForgeCiJobV1;
      header: ReactNode;
      index: ForgeCiLogIndexV1;
      view: ForgeCiMountedViewV1;
    }>,
): ReactElement {
  const t = usePluginTranslation();
  const host = usePluginHostApi();
  const { locale } = useSurfaceContext();
  const theme = usePluginTheme();
  const { ci, job, index, view } = props;
  const steps = job.steps.kind === 'available' ? job.steps.values : [];
  const focusInside = useRef(false);
  const findInputFocused = useRef(false);
  const [revealRequest, setRevealRequest] = useState<
    Readonly<{ key: string }> | undefined
  >(undefined);
  const viewer = useForgeCiLogViewerV1({
    index,
    view,
    surfaceId: props.surfaceId,
    containsFocus: () => focusInside.current,
    isInputFocused: () => findInputFocused.current,
    onRevealLine: line => setRevealRequest({ key: `l:${line.id}` }),
  });
  const segments = useMemo(() => segmentLog(viewer.lines, steps), [viewer.lines, steps]);
  // What the person opened or closed; every other segment follows `opensByDefault` as the log arrives.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const openSegments = useMemo<ReadonlySet<string>>(
    () =>
      new Set(
        segments
          .filter((segment) => toggled.get(segment.key) ?? opensByDefault(segment))
          .map((segment) => segment.key),
      ),
    [segments, toggled],
  );
  const segmentByLine = useMemo(() => {
    const map = new Map<string, string>();
    for (const segment of segments)
      for (const line of segment.lines) map.set(line.id, segment.key);
    return map;
  }, [segments]);
  useEffect(() => {
    if (!revealRequest) return;
    const segmentKey = segmentByLine.get(revealRequest.key.slice(2));
    if (segmentKey) setToggled(previous => previous.get(segmentKey) === true ? previous : new Map([...previous, [segmentKey, true]]));
  }, [revealRequest, segmentByLine]);
  const state = viewer.viewState;
  const failedOnly = state?.logFilter === 'failed';
  const timestamps = viewer.timestampsVisible !== false;
  const shownSegments = useMemo(
    () =>
      failedOnly
        ? segments.filter(
            (segment) =>
              segment.kind !== 'step' ||
              segmentStatus(segment)?.kind === 'failed',
          )
        : segments,
    [segments, failedOnly],
  );
  const effectiveOpen = useMemo(
    () =>
      failedOnly
        ? new Set([
            ...openSegments,
            ...shownSegments
              .filter((segment) => segmentStatus(segment)?.kind === 'failed')
              .map((segment) => segment.key),
          ])
        : openSegments,
    [failedOnly, openSegments, shownSegments],
  );
  const rows = useMemo(
    () =>
      flatten(shownSegments, index, effectiveOpen, state?.groupExpanded ?? {}),
    [shownSegments, index, effectiveOpen, state?.groupExpanded],
  );
  const hiddenSteps = failedOnly
    ? segments.filter(
        (segment) =>
          segment.kind === 'step' && segmentStatus(segment)?.kind !== 'failed',
      ).length
    : 0;
  const invoke = (operation: ForgeCiMountedIntentOperationV1) => {
    void view.invoke({ mountId: view.mountId, operation });
  };
  const toggleSegment = (key: string) =>
    setToggled((previous) => new Map([...previous, [key, !openSegments.has(key)]]));
  const numberWidth = String(
    index.lines[index.lines.length - 1]?.number ?? 1,
  ).length;
  const palette = useOptionalHappierUiPalette(theme);
  const failureLine = useMemo(() => {
    for (let i = index.lines.length - 1; i >= 0; i--) {
      if (ERROR_LINE.test(index.lines[i]!.plainText)) return index.lines[i]!.number;
    }
    return null;
  }, [index.lines]);
  const copyLog = () => {
    void host.writeClipboard(index.plainText);
  };
  const downloadRef = ci.actionRefs.downloadJobLog;
  const run =
    job.ref.selection.kind === 'attempt'
      ? job.ref.selection.attempt.run
      : job.ref.selection.run;
  const attempt =
    job.ref.selection.kind === 'attempt'
      ? job.ref.selection.attempt.attemptId
      : undefined;
  const downloads = useForgeCiDownloadV1();
  const downloadLog = downloadRef
    ? () => {
        void downloads.download('log', t('forgeCi.subject.log', 'this log'), {
          action: downloadRef,
          input: { repository: run.repository, runId: run.runId, jobId: job.ref.jobId, ...(attempt ? { attempt } : {}) },
        } as Parameters<typeof downloads.download>[2]);
      }
    : null;
  const lastKey = rows[rows.length - 1]?.key;
  const findStatus = viewer.findSnapshot.status;
  const findLabel = viewer.findSnapshot.query
    ? findStatus.kind === 'results'
      ? findStatus.total === 0
        ? t('forgeCi.log.findNone', '“{query}” · no matches', {
            query: viewer.findSnapshot.query,
          })
        : t('forgeCi.log.findCount', '“{query}” · {current} of {total}', {
            query: viewer.findSnapshot.query,
            current: findStatus.current ?? 0,
            total: findStatus.total,
          })
      : viewer.findSnapshot.query
    : t('forgeCi.log.find', 'Find in this job’s log');

  const toolbar = (
    <Row gap="small" align="center" wrap testID="forge-ci-log-toolbar">
      <Button
        variant="secondary"
        size="small"
        icon={<Icon name="search" size="small" />}
        title={findLabel}
        onPress={() => viewer.find.open()}
        disabled={!viewer.available}
      />
      <Tabs
        value={failedOnly ? 'failed' : 'all'}
        ariaLabel={t('forgeCi.log.stepsShown', 'Steps shown')}
        onValueChange={(value) =>
          invoke({
            kind: 'setLogFilter',
            filter: value === 'failed' ? 'failed' : 'all',
          })
        }
        sharedPanel={null}
      >
        <Tabs.Item value="all" title={t('forgeCi.log.allSteps', 'All steps')} />
        <Tabs.Item
          value="failed"
          title={t('forgeCi.log.failedOnly', 'Failed only')}
        />
      </Tabs>
      <Stack grow />
      <IconButton
        icon={<Icon name="waiting" size="small" />}
        selected={timestamps}
        accessibilityLabel={
          timestamps
            ? t('forgeCi.log.hideTimestamps', 'Hide timestamps')
            : t('forgeCi.log.showTimestamps', 'Show timestamps')
        }
        onPress={() =>
          invoke({ kind: 'setTimestampsVisible', visible: !timestamps })
        }
      />
      {lastKey ? (
        <IconButton
          icon={<HappierChevron direction="down" color={theme.colors.secondaryText} />}
          accessibilityLabel={t('forgeCi.log.jumpEnd', 'Jump to the end')}
          onPress={() => setRevealRequest({ key: lastKey })}
        />
      ) : null}
      <IconButton
        icon={<Icon name="copy" size="small" />}
        accessibilityLabel={t('forgeCi.log.copy', 'Copy log')}
        onPress={copyLog}
      />
      {downloadLog ? (
        <IconButton
          icon={<Icon name="download" size="small" />}
          busy={downloads.state.pending === 'log'}
          accessibilityLabel={t('forgeCi.log.download', 'Download log')}
          onPress={downloadLog}
        />
      ) : null}
    </Row>
  );

  const renderRow = (row: LogRow): ReactNode => {
    if (row.kind === 'segment') {
      const status = segmentStatus(row.segment);
      const elapsed = row.segment.step ? readForgeCiElapsedMsV1(row.segment.step, Date.now()) : null;
      const title = row.segment.step?.name
        ?? (row.segment.kind === 'ambiguous'
          ? t('forgeCi.log.between', 'Output between {steps}', {
              // Candidates are in step order: name the span, not every step inside it.
              steps: (row.segment.candidates.length > 2
                ? [row.segment.candidates[0]!, row.segment.candidates[row.segment.candidates.length - 1]!]
                : row.segment.candidates
              ).map(step => step.name).join(' and '),
            })
          : t('forgeCi.log.unattributed', 'Output outside any step'));
      const fixable = status?.kind === 'failed' && ci.fix;
      return (
        <DisclosureRow open={row.open} label={title} onToggle={() => toggleSegment(row.segment.key)} minHeight={40}
          divided={row.key !== rows[0]?.key}
          trailing={(
            <>
              {fixable ? (
                <Button title={t('forgeCi.run.fix', 'Fix in a session')}
            icon={<Icon name="send" size="small" />} variant="secondary" size="small"
                  onPress={() => ci.fix?.({ selection: job.ref.selection, job: job.ref })} />
              ) : null}
              {elapsed === null ? null : <Text variant="meta" tone="secondary" value={formatForgeCiDurationV1(elapsed, locale)} />}
            </>
          )}>
          {status ? <CheckStatusGlyph status={status.kind} size={14} accessibilityLabel={t(status.wordKey, status.word)} /> : null}
          <Stack grow><Text variant={status?.kind === 'failed' ? 'label' : 'body'} value={title} numberOfLines={1} /></Stack>
        </DisclosureRow>
      );
    }
    if (row.kind === 'group') {
      return (
        <DisclosureRow open={row.open} label={row.group.title} indent={row.depth * 16} minHeight={24} band
          onToggle={() => invoke({ kind: 'setGroupExpanded', groupId: row.group.id, expanded: !row.open })}>
          <Stack grow><AnsiText text={row.group.title} numberOfLines={1} /></Stack>
          <Text variant="micro" tone="muted" value={t('forgeCi.log.groupLines', '{count} lines', { count: row.count })} />
        </DisclosureRow>
      );
    }
    const line = row.line;
    const revealed = state?.revealedLine === line.number;
    const shown = presentLogLine(line, viewer.getLineRanges(line.id));
    const failure = line.number === failureLine;
    const link = lineLink(job, row);
    const number = <Text variant="code" tone="muted" value={String(line.number)} />;
    return (
      <Row
        gap="medium"
        align="flex-start"
        style={{
          position: 'relative',
          paddingLeft: row.depth * 16 + theme.spacing.small,
          paddingRight: theme.spacing.small,
          paddingVertical: 2,
          backgroundColor: revealed ? theme.colors.control : (palette?.inset ?? 'transparent'),
        }}
      >
        {failure ? (
          // The line that failed the job reads first: a breath of the danger ink behind it and its edge marked.
          <Stack
            style={{
              pointerEvents: 'none',
              position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
              backgroundColor: theme.colors.danger, opacity: 0.08,
            }}
          />
        ) : null}
        {failure ? (
          <Stack
            style={{ pointerEvents: 'none', position: 'absolute', top: 0, bottom: 0, left: 0, width: 2, backgroundColor: theme.colors.danger }}
          />
        ) : null}
        <Stack style={{ width: (numberWidth + 1) * 8, alignItems: 'flex-end' }}>
          {link ? (
            <HappierPressable
              accessibilityRole="button"
              accessibilityLabel={t(
                'forgeCi.log.copyLineLink',
                'Copy a link to line {line}',
                { line: line.number },
              )}
              onPress={() => {
                void host.writeClipboard(link);
              }}
            >
              {number}
            </HappierPressable>
          ) : number}
        </Stack>
        {timestamps && line.timestamp ? (
          <Text
            variant="code"
            tone="muted"
            value={line.timestamp.slice(11, 22)}
          />
        ) : null}
        <Stack grow>
          <AnsiText
            tokens={shown.tokens}
            plainText={shown.plainText}
            ranges={shown.ranges}
            tone={shown.error ? 'danger' : 'neutral'}
          />
        </Stack>
      </Row>
    );
  };

  return (
    <List
      items={rows}
      density="flush"
      keyForItem={(row) => row.key}
      renderItem={renderRow}
      accessibilityLabel={t('forgeCi.log.label', 'Log for {job}', {
        job: job.name,
      })}
      {...(revealRequest ? { revealRequest } : {})}
      header={
        <Stack gap="medium" style={{ paddingBottom: theme.spacing.small }}>
          {props.header}
          {toolbar}
          {viewer.findSnapshot.isOpen ? <ForgeCiLogFindBar controller={viewer.find}
            onInputFocus={() => { focusInside.current = true; findInputFocused.current = true; }}
            onInputBlur={() => { focusInside.current = false; findInputFocused.current = false; }} /> : null}
          <ForgeCiDownloadNotice ci={ci} state={downloads.state} targetUrl={job.webUrl ?? null} />
          {hiddenSteps > 0 ? (
            <Text
              variant="meta"
              tone="muted"
              value={t(
                'forgeCi.log.hiddenSteps',
                '{count} steps that passed are hidden.',
                { count: hiddenSteps },
              )}
            />
          ) : null}
        </Stack>
      }
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
  );
}

type LineRanges = ReturnType<ReturnType<typeof useForgeCiLogViewerV1>['getLineRanges']>;
const ERROR_LINE = /^##\[error\]|^Error:/u;
const ERROR_MARKER = '##[error]';

/**
 * How a log line reads: GitHub's `##[error]` workflow command reads as "Error: " (as GitHub draws it), with the
 * tokens and Find ranges moved to the shown text. Copy and download keep the raw log.
 */
function presentLogLine(
  line: ForgeCiLogLineV1,
  ranges: LineRanges,
): Readonly<{ tokens: ForgeCiLogLineV1['tokens']; plainText: string; ranges: LineRanges; error: boolean }> {
  if (!line.plainText.startsWith(ERROR_MARKER)) {
    return { tokens: line.tokens, plainText: line.plainText, ranges, error: ERROR_LINE.test(line.plainText) };
  }
  const prefix = 'Error: ';
  const shift = prefix.length - ERROR_MARKER.length;
  const cut = ERROR_MARKER.length;
  const tokens = [
    { text: prefix, start: 0, end: prefix.length, style: {} },
    ...line.tokens.flatMap((token) => token.end <= cut ? [] : [{
      ...token,
      text: token.text.slice(Math.max(0, cut - token.start)),
      start: Math.max(token.start, cut) + shift,
      end: token.end + shift,
    }]),
  ];
  return {
    tokens,
    plainText: prefix + line.plainText.slice(cut),
    ranges: ranges?.flatMap((range) => range.end <= cut ? [] : [{
      ...range,
      start: Math.max(range.start, cut) + shift,
      end: range.end + shift,
    }]),
    error: true,
  };
}

/** A step or group header: the whole row toggles, the chevron turns, and the expanded state is announced. */
function DisclosureRow({ open, label, onToggle, children, trailing, indent = 0, minHeight, band = false, divided = false }: Readonly<{
  open: boolean; label: string; onToggle: () => void; children: ReactNode; trailing?: ReactNode; indent?: number; minHeight: number;
  /** Inside a step's output: the row sits on the log's inset band, so the output reads as one block. */
  band?: boolean;
  /** A step after the first: the sheet's row hairline above it. */
  divided?: boolean;
}>): ReactElement {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  return (
    <Row gap="small" align="center" style={{
      ...(band && palette?.inset ? { backgroundColor: palette.inset } : {}),
      ...(divided ? { borderTopWidth: 1, borderTopColor: palette?.rowDivider ?? theme.colors.divider } : {}),
    }}>
      <Stack grow>
        <HappierPressable
          onPress={onToggle}
          expanded={open}
          accessibilityRole="button"
          accessibilityLabel={label}
          style={({ hovered, pressed }) => ({
            flexDirection: 'row', alignItems: 'center', gap: theme.spacing.small, minHeight,
            paddingLeft: indent + theme.spacing.xsmall, paddingRight: theme.spacing.xsmall, borderRadius: theme.radii.control,
            ...(hovered || pressed ? { backgroundColor: palette?.navigationHover ?? theme.colors.control } : {}),
          })}>
          <HappierDisclosureChevron expanded={open} color={theme.colors.secondaryText} />
          {children}
        </HappierPressable>
      </Stack>
      {trailing}
    </Row>
  );
}

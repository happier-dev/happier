import * as React from 'react';
import type { PluginUiPageNavigationV1 } from '@happier-dev/plugin-sdk/ui';
import {
  useCallback,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  Banner,
  Button,
  Card,
  CheckStatusGlyph,
  Divider,
  Icon,
  Item,
  ItemGroup,
  ListDetailLayout,
  LoadingState,
  Menu,
  NavigationList,
  PageHeader,
  Row,
  Stack,
  Tabs,
  Text,
  usePluginHostApi,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
  type MenuItem,
} from '@happier-dev/plugin-ui';
import type {
  ForgeCiArtifactV1,
  ForgeCiJobRefV1,
  ForgeCiJobV1,
  ForgeCiMutationResultV1,
  ForgeCiRunV1,
  ForgeCiSelectionV1,
} from '@happier-dev/triage-protocol/ci/v1';
import { formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';
import { readForgeCiSelectionRunV1 } from '../../runtime/identity.js';
import { ForgeCiRunDetail } from '../ForgeCiRunDetail.js';
import { readForgeOperationStateV1 } from '../operationState.js';
import {
  useForgeCiQueryStatusV1,
  useForgeCiQueryValueV1,
} from '../useForgeCiReads.js';
import { useForgeCiPagedQueryV1 } from '../useForgeCiPagedQuery.js';
import type { ForgeCiBindingV1 } from './binding.js';
import { presentForgeCiStatusV1 } from './ciStatus.js';
import { useForgeCiNowMsV1 } from './clock.js';
import {
  formatForgeCiDurationV1,
  readForgeCiElapsedMsV1,
  shortForgeCiShaV1,
} from './format.js';
import { ForgeCiElapsedText } from './ForgeCiElapsedText.js';
import { ForgeCiJobRow, forgeCiRunLabelV1 } from './ForgeCiRows.js';
import { ForgeCiStateNotice } from './ForgeCiStateNotice.js';
import { useForgeCiMutationV1 } from './useForgeCiMutation.js';
import { ForgeCiDownloadNotice, useForgeCiDownloadV1 } from './useForgeCiDownload.js';
import { ForgeCiJobPanel } from './ForgeCiJobPanel.js';
import type { ForgeCiMountedViewV1 } from '../mountedCiIntent.js';
import { useForgeCiMountedViewV1 } from '../useForgeCiMountedView.js';

type Translate = ReturnType<typeof usePluginTranslation>;

export type ForgeCiRunDetailPresentationV1 =
  /** Full page: shared Summary/Jobs navigation, with job drill-down in Jobs. */
  | 'page'
  /** One column inside another page's body (PRs & Issues Checks drill-down). */
  | 'embedded'
  /** The narrow DetailsPane and the phone's pushed page: Summary | Jobs. */
  | 'pane';

export type ForgeCiRunDetailViewProps = Readonly<{
  ci: ForgeCiBindingV1;
  selection: ForgeCiSelectionV1;
  /** The workflow's display name when the host has it ("CI"); the run carries only its reference. */
  workflowName?: string | null;
  /** The step Back returns to ("Runs", "Checks on #2493"); absent when the host draws its own Back. */
  back?: Readonly<{ label: string; onPress: () => void }>;
  /** Host chrome for the header's trailing edge (Open as page, Close). */
  chrome?: ReactNode;
  /** Opening a job: the host routes it (Actions location) or renders it in place (Checks drill-down). */
  onOpenJob: (job: ForgeCiJobRefV1) => void;
  /** The job the page's navigation shows as selected, when a job view is open beside it. */
  selectedJobId?: string | null;
  /** Returning from a job to the run's summary in the `page` presentation's navigation. */
  onOpenSummary?: () => void;
  /** The selected job's view for the `page` presentation's detail column; absent, the shared job panel renders. */
  jobView?: ReactNode;
  /** Action for the default job panel, using the run and selected job already admitted by this view. */
  renderJobAction?: (input: Readonly<{ run: ForgeCiRunV1; job: ForgeCiJobV1 }>) => ReactNode;
  /** The forge plugin's environment review for a run waiting on a deployment approval (lab a4/b3 shared card). */
  deploymentReview?: (run: ForgeCiRunV1) => ReactNode;
  /** The host's mounted CI view (bound to its `ui/ci-view-v1` Action), shared by the job log's Find and folds. */
  view?: ForgeCiMountedViewV1 | null;
  onSelectAttempt?: (attemptId: string) => void;
  /**
   * Where the run's identity (status mark, title, facts) is drawn. `host`: the details pane's own header row
   * already carries it (`useForgeCiRunPaneHeaderV1`), so the body starts at the run controls (lab a9).
   */
  identity?: 'body' | 'host';
  testID?: string;
}> & (Readonly<{
  presentation: 'page';
  pageKind: PluginUiPageNavigationV1['pageKind'];
}> | Readonly<{
  presentation: 'embedded';
  pageKind?: never;
}> | Readonly<{
  presentation: 'pane';
  pageKind?: never;
}>);

/** The run's facts line: the run label, branch and short commit ("#9 · main · 01044b8"). */
function runMetaOf(run: ForgeCiRunV1, workflowName: string | null | undefined): Array<{ key: string; text: string }> {
  const sha = shortForgeCiShaV1(run.headSha);
  return [
    { key: 'run', text: forgeCiRunLabelV1(run, workflowName ?? undefined) },
    ...(run.headRef ? [{ key: 'branch', text: run.headRef }] : []),
    ...(sha ? [{ key: 'sha', text: sha }] : []),
  ];
}

/**
 * The run's identity for a details pane's header row (lab a9: status mark, title and facts beside ⤢ ⋯ ×), so the
 * run detail's body drawn with `identity="host"` never repeats it.
 */
export function useForgeCiRunPaneHeaderV1(
  run: ForgeCiRunV1 | null,
  workflowName?: string | null,
): Readonly<{ title: string; subtitle: string; leading: ReactNode }> | null {
  const t = usePluginTranslation();
  if (run === null) return null;
  const status = presentForgeCiStatusV1(run.state);
  const label = forgeCiRunLabelV1(run, workflowName ?? undefined);
  return {
    title: run.title ?? label,
    subtitle: runMetaOf(run, workflowName).map((fact) => fact.text).join(' · '),
    leading: <CheckStatusGlyph status={status.kind} size={18} accessibilityLabel={t(status.wordKey, status.word)} />,
  };
}

function factsOf(
  t: Translate,
  run: ForgeCiRunV1,
  jobs: readonly ForgeCiJobV1[] | null,
  locale: string,
) {
  const status = presentForgeCiStatusV1(run.state);
  const elapsed = readForgeCiElapsedMsV1(run, Date.now());
  const counts = { passed: 0, failed: 0, skipped: 0, other: 0, done: 0 };
  for (const job of jobs ?? []) {
    const kind = presentForgeCiStatusV1(job.state).kind;
    if (kind === 'passed') counts.passed++;
    else if (kind === 'failed') counts.failed++;
    else if (kind === 'skipped' || kind === 'cancelled' || kind === 'neutral')
      counts.skipped++;
    else counts.other++;
    if (job.state.phase === 'completed') counts.done++;
  }
  const running =
    run.state.phase !== 'completed' && run.state.phase !== 'unknown';
  const jobsValue =
    jobs === null
      ? '—'
      : running
        ? t('forgeCi.run.jobsDone', '{done} of {total} done', {
            done: counts.done,
            total: jobs.length,
          })
        : [
            counts.passed
              ? t('forgeCi.run.jobsPassed', '{count} passed', {
                  count: counts.passed,
                })
              : null,
            counts.failed
              ? t('forgeCi.run.jobsFailed', '{count} failed', {
                  count: counts.failed,
                })
              : null,
            counts.skipped
              ? t('forgeCi.run.jobsSkipped', '{count} skipped', {
                  count: counts.skipped,
                })
              : null,
          ]
            .filter(Boolean)
            .join(' · ') || String(jobs.length);
  return [
    {
      key: 'status',
      label: t('forgeCi.run.status', 'Status'),
      value: t(status.wordKey, status.word),
      tone:
        status.kind === 'failed'
          ? ('danger' as const)
          : status.kind === 'waiting'
            ? ('attention' as const)
            : ('neutral' as const),
      running,
    },
    {
      key: 'took',
      label: running
        ? t('forgeCi.run.runningFor', 'Running for')
        : t('forgeCi.run.took', 'Took'),
      value: elapsed === null ? null : formatForgeCiDurationV1(elapsed, locale),
      tone: 'neutral' as const,
      running: false,
      // A running run's clock is its own leaf, so the facts around it never re-render on the tick.
      live: running ? <ForgeCiElapsedText item={run} variant="reading" tone="neutral" fallback="—" /> : null,
    },
    {
      key: 'jobs',
      label: t('forgeCi.run.jobs', 'Jobs'),
      value: jobsValue,
      tone: 'neutral' as const,
      running: false,
    },
    {
      key: 'started',
      label: t('forgeCi.run.started', 'Started'),
      value:
        run.startedAtMs === undefined
          ? null
          : new Intl.DateTimeFormat(locale, {
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit',
            }).format(new Date(run.startedAtMs)),
      tone: 'neutral' as const,
      running: false,
    },
    // A fact GitHub has not given is left out rather than drawn as a dash.
  ].filter((fact) => fact.value !== null || ('live' in fact && fact.live));
}

/** Status · Took · Jobs · Started: the run's four facts, label over value, on one line that wraps on a phone. */
function RunFacts({
  facts,
}: Readonly<{ facts: ReturnType<typeof factsOf> }>): ReactElement {
  const { spacing } = usePluginTheme();
  return (
    <Row
      wrap
      gap="xlarge"
      style={{ rowGap: spacing.medium }}
      testID="forge-ci-run-facts"
    >
      {facts.map((fact) => (
        <Stack key={fact.key} gap="xsmall">
          <Text variant="meta" tone="secondary" value={fact.label} />
          <Row gap="xsmall" align="center">
            {fact.running ? (
              <CheckStatusGlyph status="running" size={14} />
            ) : null}
            {'live' in fact && fact.live ? fact.live : <Text variant="reading" tone={fact.tone} value={fact.value ?? ''} />}
          </Row>
        </Stack>
      ))}
    </Row>
  );
}

function failedStepName(job: ForgeCiJobV1): string | null {
  if (job.steps.kind !== 'available') return null;
  return (
    job.steps.values.find(
      (step) => presentForgeCiStatusV1(step.state).kind === 'failed',
    )?.name ?? null
  );
}

/**
 * What failed, first (lab `fc-why`): each failed job with the step it failed in and how long it ran, one Open log,
 * and the one sentence about what a session would receive. It reads nothing on its own: the jobs projection
 * already holds these facts.
 */
function FailureCard({
  ci,
  jobs,
  selection,
  onOpenJob,
}: Readonly<{
  ci: ForgeCiBindingV1;
  jobs: readonly ForgeCiJobV1[];
  selection: ForgeCiSelectionV1;
  onOpenJob: (job: ForgeCiJobRefV1) => void;
}>): ReactElement | null {
  const t = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const failed = jobs.filter(
    (job) => presentForgeCiStatusV1(job.state).kind === 'failed',
  );
  if (failed.length === 0) return null;
  return (
    <Card padding="none" testID="forge-ci-failure-card">
      {failed.map((job, index) => {
        const step = failedStepName(job);
        const elapsed = readForgeCiElapsedMsV1(job, Date.now());
        const where = step
          ? elapsed === null
            ? t('forgeCi.failure.inStep', 'failed in “{step}”', { step })
            : t(
                'forgeCi.failure.inStepAfter',
                'failed in “{step}” after {duration}',
                { step, duration: formatForgeCiDurationV1(elapsed, locale) },
              )
          : t('forgeCi.failure.failed', 'failed');
        return (
          <Stack key={job.ref.jobId}>
            {index > 0 ? <Divider /> : null}
            <Item
              title={job.name}
              subtitle={where}
              icon={<CheckStatusGlyph status="failed" />}
              accessoryOutsidePressable
              accessory={
                <Button
                  title={t('forgeCi.failure.openLog', 'Open log')}
                  variant="plain"
                  size="small"
                  onPress={() => onOpenJob(job.ref)}
                />
              }
              onPress={() => onOpenJob(job.ref)}
            />
          </Stack>
        );
      })}
      {ci.fix ? (
        <>
          <Divider />
          <Row gap="small" align="center" style={{ padding: 12 }}>
            <Text
              variant="meta"
              tone="secondary"
              valueKey="forgeCi.failure.handoffNote"
              fallback="Fixing it in a session hands the agent this summary, the step log and the annotations. Nothing is sent until you press Send."
            />
          </Row>
        </>
      ) : null}
    </Card>
  );
}

/** Artifacts the run uploaded: each downloads to this device through the host on press, never on open. */
function ArtifactsSection({
  ci,
  selection,
}: Readonly<{
  ci: ForgeCiBindingV1;
  selection: ForgeCiSelectionV1;
}>): ReactElement | null {
  const t = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const run = readForgeCiSelectionRunV1(selection);
  const query = useForgeCiPagedQueryV1(ci.reads, 'listArtifacts', {
    repository: run.repository,
    runId: run.runId,
  });
  const page = useForgeCiQueryValueV1(query);
  const downloads = useForgeCiDownloadV1();
  const ref = ci.actionRefs.downloadArtifact;
  const busy = downloads.state.pending;
  const download = (artifact: ForgeCiArtifactV1) => {
    if (!ref) return;
    void downloads.download(artifact.id, artifact.name, {
      action: ref, input: { repository: run.repository, runId: run.runId, artifactId: artifact.id },
    } as Parameters<typeof downloads.download>[2]);
  };
  if (!page || page.rows.length === 0) return null;
  const size = (bytes: number | undefined) =>
    bytes === undefined
      ? undefined
      : new Intl.NumberFormat(locale, {
          style: 'unit',
          unit: bytes >= 1e6 ? 'megabyte' : 'kilobyte',
          unitDisplay: 'short',
          maximumFractionDigits: 1,
        }).format(bytes >= 1e6 ? bytes / 1e6 : bytes / 1e3);
  return (
    <Stack gap="small">
    <ItemGroup
      title={t('forgeCi.artifacts.title', 'Artifacts')}
      description={t(
        'forgeCi.artifacts.description',
        'Downloads go to this device. The link is fetched when you press download.',
      )}
    >
      {page.rows.map((artifact) => {
        const expired = artifact.availability === 'expired';
        const detail = size(artifact.sizeBytes);
        return (
          <Item
            key={artifact.id}
            title={artifact.name}
            {...(expired
              ? {
                  subtitle:
                    artifact.expiresAtMs === undefined
                      ? t('forgeCi.artifacts.expired', 'Expired')
                      : t('forgeCi.artifacts.expiredOn', 'Expired {date}', {
                          date: formatTriageTimestampV1(
                            locale,
                            artifact.expiresAtMs,
                            'absolute',
                            Date.now(),
                          ),
                        }),
                }
              : {})}
            {...(detail === undefined ? {} : { detail })}
            {...(!expired && ref
              ? {
                  accessory: (
                    <Button
                      title={t('forgeCi.artifacts.download', 'Download')}
                      icon={<Icon name="download" size="small" />}
                      variant="plain"
                      size="small"
                      busy={busy === artifact.id}
                      onPress={() => download(artifact)}
                    />
                  ),
                }
              : {})}
          />
        );
      })}
    </ItemGroup>
    <ForgeCiDownloadNotice ci={ci} state={downloads.state} />
    </Stack>
  );
}

/** The run's operations: the one primary, then quiet re-run/cancel, with rare operations in the ⋯ menu. */
function RunControls({
  ci,
  run,
  jobs,
  selection,
  compact,
  onCheckStatus,
  cancelRequested,
  onCancelAccepted,
}: Readonly<{
  ci: ForgeCiBindingV1;
  run: ForgeCiRunV1;
  jobs: readonly ForgeCiJobV1[] | null;
  selection: ForgeCiSelectionV1;
  compact: boolean;
  onCheckStatus: () => void;
  cancelRequested: boolean;
  onCancelAccepted: () => void;
}>): ReactElement {
  const t = usePluginTranslation();
  const host = usePluginHostApi();
  const [menuOpen, setMenuOpen] = useState(false);
  const mutation = useForgeCiMutationV1(ci, (result, operation) => {
    if (operation === 'cancelRun' && (result.kind === 'accepted' || result.kind === 'confirmed')) onCancelAccepted();
  });
  const status = presentForgeCiStatusV1(run.state);
  const target = {
    repository: run.ref.repository,
    runId: run.ref.runId,
    ...(selection.kind === 'attempt'
      ? { attempt: selection.attempt.attemptId }
      : {}),
  };
  const running =
    run.state.phase !== 'completed' && run.state.phase !== 'unknown';
  const anyFailed =
    (jobs ?? []).some(
      (job) => presentForgeCiStatusV1(job.state).kind === 'failed',
    ) || status.kind === 'failed';
  const canWrite = ci.adapter !== null;
  const size = compact ? ('small' as const) : ('normal' as const);
  const pending = mutation.state.pending;

  const menu: MenuItem[] = [
    ...(!running && canWrite
      ? [
          {
            id: 'rerun-all',
            label: t('forgeCi.run.rerunAll', 'Re-run all jobs'),
          },
        ]
      : []),
    ...(run.webUrl
      ? [
          {
            id: 'open',
            icon: 'external' as const,
            label: t('forgeCi.run.openOn', 'View on {forge}', {
              forge: ci.about.forgeName,
            }),
          },
        ]
      : []),
    ...(run.webUrl
      ? [
          {
            id: 'copy',
            icon: 'copy' as const,
            label: t('forgeCi.run.copyLink', 'Copy link'),
          },
        ]
      : []),
  ];
  const onMenu = (id: string) => {
    setMenuOpen(false);
    if (id === 'rerun-all') void mutation.run('rerunAll', target);
    else if (id === 'open' && run.webUrl)
      void host.openExternalLink(run.webUrl);
    else if (id === 'copy' && run.webUrl) void host.writeClipboard(run.webUrl);
  };

  return (
    // Inside the header's wrapping row the controls may shrink to the row's width, so their own row wraps
    // (the ⋯ moves to the next line on a phone) instead of sizing to one line and clipping past the page edge.
    <Stack gap="small" grow>
      <Row gap="small" align="center" wrap>
        {anyFailed && !running && ci.fix ? (
          <Button
            title={t('forgeCi.run.fix', 'Fix in a session')}
            icon={<Icon name="send" size="small" />}
            variant="primary"
            size={size}
            onPress={() => ci.fix?.({ selection })}
          />
        ) : null}
        {running && canWrite ? (
          <Button
            title={
              cancelRequested
                ? t('forgeCi.run.cancelling', 'Cancelling…')
                : t('forgeCi.run.cancel', 'Cancel run')
            }
            variant="secondary"
            size={size}
            busy={pending === 'cancelRun'}
            disabled={cancelRequested}
            onPress={() => mutation.run('cancelRun', target)}
          />
        ) : null}
        {!running && canWrite ? (
          <Button
            icon={<Icon name="refresh" size="small" />}
            title={
              anyFailed
                ? t('forgeCi.run.rerunFailed', 'Re-run failed jobs')
                : t('forgeCi.run.rerun', 'Re-run')
            }
            variant="secondary"
            size={size}
            busy={pending === 'rerunFailed' || pending === 'rerunAll'}
            onPress={() =>
              mutation.run(anyFailed ? 'rerunFailed' : 'rerunAll', target)
            }
          />
        ) : null}
        {menu.length > 0 ? (
          <Menu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            trigger={t('forgeCi.run.actions', 'Run actions')}
            triggerIcon="more"
            triggerAccessibilityLabel={t('forgeCi.run.actions', 'Run actions')}
            items={menu}
            onSelect={onMenu}
            placement="bottom"
          />
        ) : null}
      </Row>
      {mutation.state.last &&
      mutation.state.last.result.kind !== 'accepted' &&
      mutation.state.last.result.kind !== 'confirmed' ? (
        <ForgeCiStateNotice
          state={readForgeOperationStateV1({
            mutation: mutation.state.last.result,
            account: ci.account,
            hasRetainedValue: true,
            targetUrl: run.webUrl ?? null,
          })}
          about={{ ...ci.about, subject: t('forgeCi.subject.run', 'this run') }}
          presentation="banner"
          onCheckStatus={onCheckStatus}
        />
      ) : null}
    </Stack>
  );
}

/**
 * A run still going after the forge accepted Cancel (lab a4): says how long, why it may be (a long step finishing),
 * and offers the separate Force-cancel, whose one host confirmation explains the skipped cleanup. Never automatic.
 */
function ForceCancelNotice({ ci, run, selection, acceptedAtMs }: Readonly<{
  ci: ForgeCiBindingV1; run: ForgeCiRunV1; selection: ForgeCiSelectionV1; acceptedAtMs: number;
}>): ReactElement | null {
  const t = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const mutation = useForgeCiMutationV1(ci);
  // This notice is its own small leaf; its clock re-renders only it.
  const nowMs = useForgeCiNowMsV1(true);
  if (ci.adapter === null) return null;
  const since = formatForgeCiDurationV1(Math.max(0, nowMs - acceptedAtMs), locale);
  return (
    <Banner
      tone="neutral"
      title={t('forgeCi.run.stillRunning', 'Still running {duration} after Cancel', { duration: since })}
      description={t('forgeCi.run.stillRunning.body', '{forge} accepted the cancel, but the run hasn’t stopped. It may be finishing a long step. Force-cancel stops it now and skips its cleanup.', { forge: ci.about.forgeName })}
      action={(
        <Button title={t('forgeCi.run.forceCancel', 'Force-cancel…')} variant="destructive" size="small"
          busy={mutation.state.pending === 'forceCancelRun'}
          onPress={() => mutation.run('forceCancelRun', {
            repository: run.ref.repository, runId: run.ref.runId,
            ...(selection.kind === 'attempt' ? { attempt: selection.attempt.attemptId } : {}),
          })} />
      )}
      testID="forge-ci-force-cancel"
    />
  );
}

/** Which attempt of a re-run run is shown; past attempts stay pinned when chosen. */
function AttemptPicker({ attempt, count, onSelect }: Readonly<{ attempt: string; count: number; onSelect: (attemptId: string) => void }>): ReactElement {
  const t = usePluginTranslation();
  const [open, setOpen] = useState(false);
  const items: MenuItem[] = Array.from({ length: count }, (_, index) => String(count - index)).map(id => ({
    id, kind: 'radio' as const, radioGroupId: 'attempt',
    label: id === String(count) ? t('forgeCi.run.attemptLatest', 'Attempt {attempt} · latest', { attempt: id }) : t('forgeCi.run.attempt', 'Attempt {attempt}', { attempt: id }),
  }));
  return (
    <Row>
      <Menu open={open} onOpenChange={setOpen} triggerAppearance="control"
        trigger={t('forgeCi.run.attemptOf', 'Attempt {attempt} of {count}', { attempt, count })}
        triggerAccessibilityLabel={t('forgeCi.run.chooseAttempt', 'Choose an attempt')}
        items={items} radioGroups={[{ id: 'attempt', accessibilityLabel: t('forgeCi.run.attempts', 'Attempts'), selectedId: attempt }]}
        onSelect={id => { setOpen(false); onSelect(id); }} />
    </Row>
  );
}

/** Fork runs wait for a person: who opened it and at which commit, with the one approval that runs their code. */
function ForkApproval({
  ci,
  run,
  selection,
}: Readonly<{
  ci: ForgeCiBindingV1;
  run: ForgeCiRunV1;
  selection: ForgeCiSelectionV1;
}>): ReactElement | null {
  const t = usePluginTranslation();
  const mutation = useForgeCiMutationV1(ci);
  if (!run.forkApproval?.required || ci.adapter === null) return null;
  const who = run.forkApproval.contributor;
  const commit = shortForgeCiShaV1(run.headSha);
  const from = run.forkApproval.sourceRepository?.repository;
  const approval = run.headSha && who && run.forkApproval.sourceRepository ? {
    repository: run.ref.repository,
    runId: run.ref.runId,
    ...(selection.kind === 'attempt' ? { attempt: selection.attempt.attemptId } : {}),
    headSha: run.headSha,
    contributor: who,
    sourceRepository: run.forkApproval.sourceRepository,
  } : null;
  return (
    <Card padding="medium" testID="forge-ci-fork-approval">
      <Row gap="medium" align="center" wrap>
        <CheckStatusGlyph status="waiting" size={18} />
        <Stack grow gap="xsmall">
          <Text
            variant="label"
            valueKey="forgeCi.fork.title"
            fallback="This run waits for your approval"
          />
          <Text
            variant="meta"
            tone="secondary"
            value={[
              who
                ? t('forgeCi.fork.contributor', 'Opened by {who}', { who })
                : null,
              from
                ? t('forgeCi.fork.from', 'from {repository}', {
                    repository: from,
                  })
                : null,
              commit
                ? t('forgeCi.fork.commit', 'at {commit}', { commit })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        </Stack>
        <Button
          title={t('forgeCi.fork.approve', 'Approve fork run')}
          variant="primary"
          size="small"
          busy={mutation.state.pending === 'approveForkRun'}
          disabled={approval === null}
          onPress={() => approval === null ? undefined : mutation.run('approveForkRun', approval)}
        />
      </Row>
    </Card>
  );
}

function JobsSection({
  jobs,
  onOpenJob,
  running,
}: Readonly<{
  jobs: readonly ForgeCiJobV1[];
  onOpenJob: (job: ForgeCiJobRefV1) => void;
  running: boolean;
}>): ReactElement {
  const t = usePluginTranslation();
  return (
    <ItemGroup
      title={t('forgeCi.jobs.titleCount', 'Jobs {count}', {
        count: jobs.length,
      })}
      {...(running
        ? {
            description: t(
              'forgeCi.jobs.live',
              'Jobs update every few seconds while this is open.',
            ),
          }
        : {})}
    >
      {jobs.map((job) => (
        <ForgeCiJobRow
          key={job.ref.jobId}
          job={job}
          showReason
          density="cozy"
          onPress={() => onOpenJob(job.ref)}
        />
      ))}
    </ItemGroup>
  );
}

function orderJobs(
  jobs: readonly ForgeCiJobV1[] | null,
): readonly ForgeCiJobV1[] | null {
  return jobs;
}

/**
 * One run or attempt (lab a4, a8): identity and operations first, its four facts, what failed, then its jobs and
 * artifacts. The page shows jobs navigation beside the summary or the selected job; a pane and a phone fold that
 * into Summary | Jobs; an embedded host (PR Checks) shows the single column. Every presentation reads the same run
 * and jobs projection through the shared read owner, so moving between them reads nothing again.
 */
export function ForgeCiRunDetailView(
  props: ForgeCiRunDetailViewProps,
): ReactElement {
  return (
    <ForgeCiRunDetail reads={props.ci.reads} selection={props.selection}>
      {(model) => <RunDetailBody {...props} model={model} />}
    </ForgeCiRunDetail>
  );
}

function RunDetailBody(
  props: ForgeCiRunDetailViewProps &
    Readonly<{
      model: Parameters<Parameters<typeof ForgeCiRunDetail>[0]['children']>[0];
    }>,
) {
  const t = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const { ci, selection, presentation, model } = props;
  const run = model.run;
  const jobs = useMemo(() => orderJobs(model.jobs?.rows ?? null), [model.jobs]);
  const runStatus = useForgeCiQueryStatusV1(model.runQuery);
  const jobsStatus = useForgeCiQueryStatusV1(model.jobsQuery);
  const surface = useSurfaceContext();
  const ownView = useForgeCiMountedViewV1({ mountId: props.view === undefined ? surface.mountId : undefined, phone: surface.platform === 'ios' || surface.platform === 'android' });
  const mountedView = props.view ?? ownView;
  const selectedJob = props.selectedJobId ? jobs?.find(job => job.ref.jobId === props.selectedJobId) ?? null : null;
  const live =
    run !== null &&
    run.state.phase !== 'completed' &&
    run.state.phase !== 'unknown';
  const [tab, setTab] = useState<'summary' | 'jobs'>('summary');
  // When the forge accepted a normal Cancel: the run may keep going while a long step finishes (lab a4 cancelling).
  const [cancelAcceptedAt, setCancelAcceptedAt] = useState<number | null>(null);
  const refresh = useCallback(() => {
    void runStatus.refresh();
    void jobsStatus.refresh();
  }, [runStatus, jobsStatus]);
  const about = { ...ci.about, subject: t('forgeCi.subject.run', 'this run') };

  if (run === null) {
    const failure = runStatus.snapshot?.failure ?? null;
    if (failure) {
      return (
        <ForgeCiStateNotice
          presentation="surface"
          about={about}
          onRetry={refresh}
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
        title={t('forgeCi.run.loading', 'Reading this run')}
        rows={5}
      />
    );
  }

  const status = presentForgeCiStatusV1(run.state);
  const label = forgeCiRunLabelV1(run, props.workflowName);
  const attempt =
    selection.kind === 'attempt'
      ? selection.attempt.attemptId
      : run.currentAttempt?.attemptId;
  const meta = [
    ...runMetaOf(run, props.workflowName),
    ...(attempt && (run.attemptCount ?? 1) > 1 && !props.onSelectAttempt
      ? [
          {
            key: 'attempt',
            text: t('forgeCi.run.attemptOf', 'Attempt {attempt} of {count}', {
              attempt,
              count: run.attemptCount ?? 1,
            }),
          },
        ]
      : []),
  ];
  const facts = factsOf(t, run, jobs, locale);
  const staleFailure =
    runStatus.snapshot?.failure ?? jobsStatus.snapshot?.failure ?? null;
  const compact = presentation === 'pane';

  const header = (
    <Stack gap="medium">
      {props.back ? (
        <Row>
          <Button
            title={props.back.label}
            variant="plain"
            size="small"
            icon={<Icon name="back" size="small" />}
            onPress={props.back.onPress}
          />
        </Row>
      ) : null}
      {props.identity === 'host' && presentation === 'pane' ? (
        // The pane's header row names the run; the body starts at its controls (lab a9).
        <Row gap="small" align="center" wrap>
          <RunControls
            ci={ci}
            run={run}
            jobs={jobs}
            selection={selection}
            compact={compact}
            onCheckStatus={refresh}
            cancelRequested={cancelAcceptedAt !== null}
            onCancelAccepted={() => setCancelAcceptedAt(Date.now())}
          />
          {attempt && (run.attemptCount ?? 1) > 1 && props.onSelectAttempt ? (
            <AttemptPicker attempt={attempt} count={run.attemptCount ?? 1} onSelect={props.onSelectAttempt} />
          ) : null}
          {props.chrome}
        </Row>
      ) : <PageHeader
        title={run.title ?? label}
        {...(attempt && (run.attemptCount ?? 1) > 1 && props.onSelectAttempt ? {
          details: (
            <AttemptPicker attempt={attempt} count={run.attemptCount ?? 1} onSelect={props.onSelectAttempt} />
          ),
        } : {})}
        leading={
          <CheckStatusGlyph
            status={status.kind}
            size={compact ? 18 : 22}
            accessibilityLabel={t(status.wordKey, status.word)}
          />
        }
        meta={meta}
        actions={
          // Wraps on a phone so the run's ⋯ stays on the page instead of running past its edge.
          <Row gap="small" align="center" wrap>
            <RunControls
              ci={ci}
              run={run}
              jobs={jobs}
              selection={selection}
              compact={compact}
              onCheckStatus={refresh}
              cancelRequested={cancelAcceptedAt !== null}
              onCancelAccepted={() => setCancelAcceptedAt(Date.now())}
            />
            {props.chrome}
          </Row>
        }
      />}
      {staleFailure ? (
        <ForgeCiStateNotice
          presentation="line"
          about={about}
          onRetry={refresh}
          asOfMs={runStatus.snapshot?.checkedAtMs ?? null}
          state={readForgeOperationStateV1({
            failure: staleFailure,
            account: ci.account,
            hasRetainedValue: true,
          })}
        />
      ) : null}
      {live && cancelAcceptedAt !== null ? (
        <ForceCancelNotice ci={ci} run={run} selection={selection} acceptedAtMs={cancelAcceptedAt} />
      ) : null}
      <RunFacts facts={facts} />
      {presentation === 'page' ? <Divider /> : null}
      <ForkApproval
        ci={ci}
        run={run}
        selection={selection}
      />
    </Stack>
  );

  const summary = (
    <Stack gap="large">
      {run && run.state.phase === 'waiting' && props.deploymentReview ? props.deploymentReview(run) : null}
      {jobs ? (
        <FailureCard
          ci={ci}
          jobs={jobs}
          selection={selection}
          onOpenJob={props.onOpenJob}
        />
      ) : null}
      {presentation === 'embedded' ? (
        jobs ? (
          <JobsSection
            jobs={jobs}
            onOpenJob={props.onOpenJob}
            running={live}
          />
        ) : (
          <LoadingState
            title={t('forgeCi.jobs.loading', 'Reading the jobs')}
            rows={4}
            layout="line"
          />
        )
      ) : null}
      {live ? null : <ArtifactsSection ci={ci} selection={selection} />}
    </Stack>
  );

  const jobPanel = selectedJob ? (props.jobView ?? (
    <ForgeCiJobPanel
      ci={ci}
      job={selectedJob.ref}
      admittedJob={selectedJob}
      jobAction={props.renderJobAction?.({ run, job: selectedJob })}
      view={mountedView}
      surfaceId={`${mountedView?.mountId ?? "forge-ci-run"}-log`}
      presentation={presentation === 'pane' ? 'pane' : 'page'}
      {...(presentation !== 'page' && props.onOpenSummary ? { back: { label: label, onPress: props.onOpenSummary } } : {})}
    />
  )) : null;
  if (jobPanel && presentation !== 'page') return jobPanel;

  if (props.presentation === 'pane') {
    return (
      <Stack gap="large" {...(props.testID === undefined ? {} : { testID: props.testID })}>
        {header}
        <Tabs
          value={tab}
          onValueChange={(value) =>
            setTab(value === 'jobs' ? 'jobs' : 'summary')
          }
          ariaLabel={t('forgeCi.run.view', 'Run')}
        >
          <Tabs.Item
            value="summary"
            title={t('forgeCi.run.summary', 'Summary')}
          >
            {summary}
          </Tabs.Item>
          <Tabs.Item
            value="jobs"
            title={t('forgeCi.run.jobs', 'Jobs')}
            {...(jobs ? { badge: String(jobs.length) } : {})}
          >
            {jobs ? (
              <JobsSection
                jobs={jobs}
                onOpenJob={props.onOpenJob}
                running={live}
              />
            ) : (
              <LoadingState
                title={t('forgeCi.jobs.loading', 'Reading the jobs')}
                rows={4}
                layout="line"
              />
            )}
          </Tabs.Item>
        </Tabs>
      </Stack>
    );
  }

  if (props.presentation === 'embedded') {
    return (
      <Stack gap="large" {...(props.testID === undefined ? {} : { testID: props.testID })}>
        {header}
        {summary}
      </Stack>
    );
  }

  const nav = (
    <NavigationList>
      <NavigationList.Group
        title={t('forgeCi.run.jobs', 'Jobs')}
        {...(jobs ? { count: jobs.length } : {})}
      >
        {(jobs ?? []).map((job) => {
          const jobStatus = presentForgeCiStatusV1(job.state);
          // A running job's live clock belongs to its own view; the navigation names its state instead of ticking.
          const elapsed = job.state.phase === 'running' ? null : readForgeCiElapsedMsV1(job, Date.now());
          return (
            <NavigationList.Row
              key={job.ref.jobId}
              title={job.name}
              mark={
                <CheckStatusGlyph
                  status={jobStatus.kind}
                  accessibilityLabel={t(jobStatus.wordKey, jobStatus.word)}
                />
              }
              {...(jobStatus.kind === 'skipped' || jobStatus.kind === 'running' || jobStatus.kind === 'queued'
                ? { detail: t(jobStatus.wordKey, jobStatus.word) }
                : elapsed === null
                  ? {}
                  : { detail: formatForgeCiDurationV1(elapsed, locale) })}
              selected={props.selectedJobId === job.ref.jobId}
              onPress={() => props.onOpenJob(job.ref)}
            />
          );
        })}
      </NavigationList.Group>
    </NavigationList>
  );
  return (
    <Stack gap="large" {...(props.testID === undefined ? {} : { testID: props.testID })}>
      {header}
      <Tabs
        presentation="page"
        pageKind={props.pageKind}
        value={props.selectedJobId ? 'jobs' : tab}
        onValueChange={(value) => {
          if (value !== 'summary' && value !== 'jobs') return;
          setTab(value);
          if (value === 'summary' && props.selectedJobId) props.onOpenSummary?.();
        }}
        ariaLabel={t('forgeCi.run.view', 'Run')}
      >
        <Tabs.Item value="summary" title={t('forgeCi.run.summary', 'Summary')} glyph="info">
          {summary}
        </Tabs.Item>
        <Tabs.Item value="jobs" title={t('forgeCi.run.jobs', 'Jobs')} glyph="workflow"
          {...(jobs ? { badge: String(jobs.length) } : {})}>
          {jobPanel ? (
            <ListDetailLayout list={nav} detail={jobPanel} detailActive
              minListWidth={220} minDetailWidth={480} preferredListRatio={0.24} />
          ) : jobs ? (
            <JobsSection jobs={jobs} onOpenJob={props.onOpenJob} running={live} />
          ) : (
            <LoadingState title={t('forgeCi.jobs.loading', 'Reading the jobs')} rows={4} layout="line" />
          )}
        </Tabs.Item>
      </Tabs>
    </Stack>
  );
}

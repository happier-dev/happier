import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';
import {
  Button,
  CheckStatusGlyph,
  EmptyState,
  Icon,
  IconButton,
  Item,
  LoadingState,
  Row,
  Stack,
  Text,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import type {
  ForgeCiJobRefV1,
  ForgeCiJobV1,
  ForgeCiMutationResultV1,
  ForgeCiRunV1,
  ForgeCiSelectionV1,
} from '@happier-dev/triage-protocol/ci/v1';
import {
  formatTriageTimestampV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import { readForgeOperationStateV1 } from '../operationState.js';
import {
  useForgeCiQueryV1,
  useForgeCiQueryValueV1,
} from '../useForgeCiReads.js';
import type { ForgeCiBindingV1 } from './binding.js';
import { presentForgeCiStatusV1 } from './ciStatus.js';
import {
  formatForgeCiDurationV1,
  readForgeCiElapsedMsV1,
  shortForgeCiShaV1,
} from './format.js';
import { ForgeCiRunRow } from './ForgeCiRows.js';
import { ForgeCiStateNotice } from './ForgeCiStateNotice.js';
import { useForgeCiMutationV1 } from './useForgeCiMutation.js';

/** Where the Session's checkout stands, from accepted SCM facts only (never an older green). */
export type ForgeCiRailContextV1 =
  | Readonly<{ kind: 'ready'; branch: string; headSha: string }>
  | Readonly<{ kind: 'detached' }>
  | Readonly<{ kind: 'unpushed' }>
  | Readonly<{ kind: 'unknown' }>;

export type ForgeCiRailPanelProps = Readonly<{
  ci: ForgeCiBindingV1;
  context: ForgeCiRailContextV1;
  /** Runs for the exact HEAD, newest first; null while the first read is out. */
  headRuns: readonly ForgeCiRunV1[] | null;
  /** The newest runs on the branch, for Earlier pushes; null when not read. */
  branchRuns: readonly ForgeCiRunV1[] | null;
  failure: TriageSourceFailureV1 | null;
  checkedAtMs: number | null;
  onRetry: () => void;
  onOpenRun: (selection: ForgeCiSelectionV1, job?: ForgeCiJobRefV1) => void;
  onOpenActions?: () => void;
  /** 08's Reproduce locally entry for the failed run on this HEAD, when the host has an accepted checkout. */
  failureExtra?: ReactNode;
  workflowNames?: ReadonlyMap<string, string>;
  testID?: string;
}>;

function selectionOf(run: ForgeCiRunV1): ForgeCiSelectionV1 {
  return run.currentAttempt
    ? { kind: 'attempt', attempt: run.currentAttempt }
    : { kind: 'run', run: run.ref };
}

/** The failed run's first failed job and step, from its jobs projection (one read, only for a failed HEAD run). */
function FailureBlock({
  ci,
  run,
  onOpenRun,
  extra,
}: Readonly<{
  ci: ForgeCiBindingV1;
  run: ForgeCiRunV1;
  onOpenRun: ForgeCiRailPanelProps['onOpenRun'];
  extra?: ReactNode;
}>): ReactElement {
  const t = usePluginTranslation();
  const { spacing } = usePluginTheme();
  const selection = selectionOf(run);
  const jobsQuery = useForgeCiQueryV1(ci.reads, 'listJobs', {
    repository: run.ref.repository,
    runId: run.ref.runId,
    ...(selection.kind === 'attempt'
      ? { attempt: selection.attempt.attemptId }
      : {}),
  });
  const jobs = useForgeCiQueryValueV1(jobsQuery);
  const failed: ForgeCiJobV1 | undefined = jobs?.rows.find(
    (job) => presentForgeCiStatusV1(job.state).kind === 'failed',
  );
  const step =
    failed?.steps.kind === 'available'
      ? failed.steps.values.find(
          (candidate) =>
            presentForgeCiStatusV1(candidate.state).kind === 'failed',
        )
      : undefined;
  const mutation = useForgeCiMutationV1(
    ci,
    (_result: ForgeCiMutationResultV1) => undefined,
  );
  return (
    <Stack
      gap="small"
      style={{
        paddingLeft: spacing.xlarge + spacing.small,
        paddingBottom: spacing.small,
      }}
    >
      {failed ? (
        <Text
          variant="meta"
          tone="danger"
          value={
            step
              ? t('forgeCi.rail.failedInStep', 'Failed in {job} · {step}', {
                  job: failed.name,
                  step: step.name,
                })
              : t('forgeCi.rail.failedIn', 'Failed in {job}', {
                  job: failed.name,
                })
          }
        />
      ) : null}
      <Row gap="small" align="center" wrap>
        {ci.fix ? (
          <Button
            title={t('forgeCi.run.fix', 'Fix in a session')}
            icon={<Icon name="send" size="small" />}
            variant="primary"
            size="small"
            onPress={() =>
              ci.fix?.({ selection, ...(failed ? { job: failed.ref } : {}) })
            }
          />
        ) : null}
        <Button
          title={t('forgeCi.failure.openLog', 'Open log')}
          variant="secondary"
          size="small"
          onPress={() => onOpenRun(selection, failed?.ref)}
        />
        {ci.adapter ? (
          <IconButton
            icon={<Icon name="refresh" size="small" />}
            accessibilityLabel={t(
              'forgeCi.run.rerunFailed',
              'Re-run failed jobs',
            )}
            busy={mutation.state.pending !== null}
            onPress={() =>
              mutation.run('rerunFailed', {
                repository: run.ref.repository,
                runId: run.ref.runId,
                ...(selection.kind === 'attempt'
                  ? { attempt: selection.attempt.attemptId }
                  : {}),
              })
            }
          />
        ) : null}
      </Row>
      {extra}
      {mutation.state.last &&
      mutation.state.last.result.kind !== 'accepted' &&
      mutation.state.last.result.kind !== 'confirmed' ? (
        <ForgeCiStateNotice
          presentation="banner"
          about={{ ...ci.about, subject: t('forgeCi.subject.run', 'this run') }}
          state={readForgeOperationStateV1({
            mutation: mutation.state.last.result,
            account: ci.account,
            hasRetainedValue: true,
            targetUrl: run.webUrl ?? null,
          })}
        />
      ) : null}
    </Stack>
  );
}

/**
 * The Session rail's CI panel (lab a6): the runs for this Session's exact pushed HEAD, newest push first, with what
 * failed open under its run, then the branch's earlier pushes. Healthy is quiet. A detached, unpushed or unknown
 * checkout says so instead of showing another commit's result.
 */
export function ForgeCiRailPanel(props: ForgeCiRailPanelProps): ReactElement {
  const t = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const { spacing } = usePluginTheme();
  const { ci, context } = props;
  // Rows read the time once per render; a running run's clock is its own leaf.
  const nowMs = Date.now();
  const about = {
    ...ci.about,
    subject: t('forgeCi.subject.branchRuns', 'this branch’s runs'),
  };

  if (context.kind === 'detached') {
    return (
      <EmptyState
        layout="centered"
        title={t('forgeCi.rail.detached', 'No branch checked out')}
        description={t(
          'forgeCi.rail.detached.body',
          'This Session’s checkout is on a commit, not a branch, so there are no branch runs to follow.',
        )}
      />
    );
  }
  if (context.kind === 'unpushed') {
    return (
      <EmptyState
        layout="centered"
        title={t('forgeCi.rail.unpushed', 'This branch isn’t on {forge} yet', {
          forge: ci.about.forgeName,
        })}
        description={t(
          'forgeCi.rail.unpushed.body',
          'Push it and its checks run here.',
        )}
      />
    );
  }
  if (context.kind === 'unknown') {
    return (
      <EmptyState
        layout="centered"
        title={t('forgeCi.rail.unknown', 'CI isn’t known for this Session')}
        description={t(
          'forgeCi.rail.unknown.body',
          'Happier doesn’t know this checkout’s pushed commit yet, so it shows no result rather than an older one.',
        )}
      />
    );
  }
  if (props.headRuns === null) {
    if (props.failure) {
      return (
        <ForgeCiStateNotice
          presentation="surface"
          about={about}
          onRetry={props.onRetry}
          state={readForgeOperationStateV1({
            failure: props.failure,
            account: ci.account,
            hasRetainedValue: false,
          })}
        />
      );
    }
    return (
      <LoadingState
        title={t('forgeCi.rail.loading', 'Reading CI for this branch')}
        rows={3}
        layout="line"
      />
    );
  }

  const head = props.headRuns;
  const latest = head[0];
  const earlier = (props.branchRuns ?? []).filter(
    (run) => run.headSha !== context.headSha,
  );
  const seen = new Set<string>();
  const earlierByPush = earlier
    .filter((run) => {
      const key = run.headSha ?? run.ref.runId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);

  // Nothing ran for this push and nothing earlier to show: the rail's one state, centred, with where to go (lab a6 noruns).
  if (head.length === 0 && earlierByPush.length === 0 && !props.failure) {
    return (
      <EmptyState
        layout="centered"
        icon="workflow"
        title={t('forgeCi.rail.noRuns', 'No runs for this push yet')}
        description={t(
          'forgeCi.rail.noRuns.body',
          'Workflows that run on pushes to {branch} appear here as they start.',
          { branch: context.branch },
        )}
        {...(props.onOpenActions ? { action: (
          <Button
            title={t('forgeCi.rail.openActions', 'Open in Actions')}
            variant="secondary"
            size="small"
            onPress={props.onOpenActions}
          />
        ) } : {})}
        {...(props.testID === undefined ? {} : { testID: props.testID })}
      />
    );
  }

  return (
    <Stack
      gap="medium"
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.failure ? (
        <ForgeCiStateNotice
          presentation="line"
          about={about}
          onRetry={props.onRetry}
          asOfMs={props.checkedAtMs}
          state={readForgeOperationStateV1({
            failure: props.failure,
            account: ci.account,
            hasRetainedValue: true,
          })}
        />
      ) : null}
      <Stack gap="xsmall">
        <Row gap="small" align="center">
          <Text
            variant="meta"
            tone="secondary"
            value={t('forgeCi.rail.latestPush', 'Latest push')}
          />
          <Text
            variant="code"
            tone="secondary"
            value={shortForgeCiShaV1(context.headSha) ?? ''}
          />
          <Stack grow />
          {latest?.createdAtMs === undefined ? null : (
            <Text
              variant="meta"
              tone="secondary"
              value={formatTriageTimestampV1(
                locale,
                latest.createdAtMs,
                'relative',
                nowMs,
              )}
            />
          )}
        </Row>
        {latest?.title ? (
          <Text variant="body" value={latest.title} numberOfLines={2} />
        ) : null}
      </Stack>
      {head.length === 0 ? (
        <EmptyState
          layout="line"
          title={t('forgeCi.rail.noRuns', 'No runs for this push yet')}
          description={t(
            'forgeCi.rail.noRuns.body',
            'Workflows that run on pushes to {branch} appear here as they start.',
            { branch: context.branch },
          )}
        />
      ) : (
        <Stack gap="none">
          {head.map((run) => {
            const status = presentForgeCiStatusV1(run.state);
            const name = run.workflow
              ? (props.workflowNames?.get(run.workflow.id) ?? null)
              : null;
            return (
              <Stack key={run.ref.runId} gap="none">
                <ForgeCiRunRow run={run} workflowName={name} identity="workflow"
                  density="compact" onPress={() => props.onOpenRun(selectionOf(run))} />
                {status.kind === 'failed' && run.headSha === context.headSha ? (
                  <FailureBlock
                    ci={ci}
                    run={run}
                    onOpenRun={props.onOpenRun}
                    extra={props.failureExtra}
                  />
                ) : null}
              </Stack>
            );
          })}
        </Stack>
      )}
      {earlierByPush.length > 0 ? (
        <Stack gap="xsmall" style={{ paddingTop: spacing.small }}>
          <Text
            variant="meta"
            tone="secondary"
            value={t('forgeCi.rail.earlier', 'Earlier pushes')}
          />
          {earlierByPush.map((run) => {
            const status = presentForgeCiStatusV1(run.state);
            const elapsed = readForgeCiElapsedMsV1(run, nowMs);
            const age =
              run.createdAtMs === undefined
                ? undefined
                : formatTriageTimestampV1(
                    locale,
                    run.createdAtMs,
                    'relative',
                    nowMs,
                  );
            return (
              <Item
                key={run.ref.runId}
                density="tight"
                title={[shortForgeCiShaV1(run.headSha), run.title]
                  .filter(Boolean)
                  .join('  ')}
                titleNumberOfLines={1}
                {...((age ??
                (elapsed === null
                  ? undefined
                  : formatForgeCiDurationV1(elapsed, locale)))
                  ? { detail: age ?? formatForgeCiDurationV1(elapsed!, locale) }
                  : {})}
                icon={
                  <CheckStatusGlyph
                    status={status.kind}
                    size={14}
                    accessibilityLabel={t(status.wordKey, status.word)}
                  />
                }
                onPress={() => props.onOpenRun(selectionOf(run))}
              />
            );
          })}
        </Stack>
      ) : null}
      {props.onOpenActions ? (
        <Row>
          <Button
            title={t('forgeCi.rail.openActions', 'Open in Actions')}
            variant="plain"
            size="small"
            onPress={props.onOpenActions}
          />
        </Row>
      ) : null}
    </Stack>
  );
}

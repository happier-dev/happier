import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { CheckStatusGlyph, Item, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';
import type { ForgeCiJobV1, ForgeCiRunV1, ForgeCiStepV1 } from '@happier-dev/triage-protocol/ci/v1';
import { formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';
import { presentForgeCiStatusV1 } from './ciStatus.js';
import { ForgeCiElapsedText } from './ForgeCiElapsedText.js';
import { formatForgeCiDurationV1, readForgeCiElapsedMsV1, shortForgeCiShaV1 } from './format.js';

/** The workflow-and-number identity every CI surface uses for a run ("CI #4820", or "#4820" without a name). */
export function forgeCiRunLabelV1(run: ForgeCiRunV1, workflowName?: string | null): string {
  const number = run.number === undefined ? `#${run.ref.runId}` : `#${run.number}`;
  return workflowName ? `${workflowName} ${number}` : number;
}

/**
 * A settled row's trailing time: its final duration, or how long ago it ran when no duration is known. A running
 * row draws `ForgeCiElapsedText` instead, so only that leaf ticks.
 */
function settledTime(item: Readonly<{ startedAtMs?: number | undefined; completedAtMs?: number | undefined; updatedAtMs?: number | undefined; createdAtMs?: number | undefined; state: ForgeCiRunV1['state'] }>, locale: string): string | undefined {
  const renderedAtMs = Date.now();
  const elapsed = readForgeCiElapsedMsV1(item, renderedAtMs);
  if (elapsed !== null) return formatForgeCiDurationV1(elapsed, locale);
  const at = item.completedAtMs ?? item.createdAtMs;
  return at === undefined ? undefined : formatTriageTimestampV1(locale, at, 'relative', renderedAtMs);
}

export type ForgeCiRunRowProps = Readonly<{
  run: ForgeCiRunV1;
  /** The workflow's display name when the host knows it; the run itself carries only the workflow reference. */
  workflowName?: string | null;
  /** A short reason under the title when the run needs a reader ("Failed in E2E · webkit"). */
  reason?: string | null;
  selected?: boolean;
  onPress?: () => void;
  density?: 'comfortable' | 'compact';
  /**
   * `title` (default) leads with the run's own title (a runs list); `workflow` leads with `Workflow #n` where the
   * commit is already named above the rows (the Session rail's runs for one push).
   */
  identity?: 'title' | 'workflow';
  testID?: string;
}>;

/**
 * One run as CI lists draw it outside a Collection (the rail): the status mark, the run's identity,
 * `Workflow #n · branch · commit` under it and the duration in the trailing column. Inside a Collection use
 * `useForgeCiRunAnatomyV1`, which draws the same words.
 */
export function ForgeCiRunRow({ run, workflowName, reason, selected, onPress, density, identity = 'title', testID }: ForgeCiRunRowProps): ReactElement {
  const t = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const status = presentForgeCiStatusV1(run.state);
  const facts = [forgeCiRunLabelV1(run, workflowName), run.headRef, shortForgeCiShaV1(run.headSha)].filter((part): part is string => !!part);
  const running = run.state.phase === 'running';
  const time = running ? undefined : settledTime(run, locale);
  return (
    <Item
      title={identity === 'workflow' ? forgeCiRunLabelV1(run, workflowName) : run.title ?? forgeCiRunLabelV1(run, workflowName)}
      titleNumberOfLines={1}
      {...(identity === 'workflow' ? (reason ? { subtitle: reason } : {}) : { subtitle: reason ?? facts.join(' · ') })}
      subtitleNumberOfLines={1}
      {...(time === undefined ? {} : { detail: time })}
      {...(running ? { accessory: <ForgeCiElapsedText item={run} /> } : {})}
      icon={<CheckStatusGlyph status={status.kind} accessibilityLabel={t(status.wordKey, status.word)} />}
      {...(selected === undefined ? {} : { selected })}
      {...(onPress === undefined ? {} : { onPress })}
      density={density ?? 'comfortable'}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}

export type ForgeCiJobRowProps = Readonly<{
  job: ForgeCiJobV1;
  selected?: boolean;
  onPress?: () => void;
  /** A quiet line under the name: where it failed, or why it was skipped. Absent keeps the row to one line. */
  showReason?: boolean;
  density?: 'comfortable' | 'cozy' | 'compact';
  accessory?: ReactNode;
  testID?: string;
}>;

function failedStep(job: ForgeCiJobV1): ForgeCiStepV1 | null {
  return job.steps.kind === 'available'
    ? job.steps.values.find(step => presentForgeCiStatusV1(step.state).kind === 'failed') ?? null
    : null;
}

/** One job: the mark, the job's name and its duration; a failed job can say which step failed. */
export function ForgeCiJobRow({ job, selected, onPress, showReason, density, accessory, testID }: ForgeCiJobRowProps): ReactElement {
  const t = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const status = presentForgeCiStatusV1(job.state);
  const running = job.state.phase === 'running';
  const detail = status.kind === 'skipped' ? t('forgeCi.status.skipped', 'Skipped')
    : status.kind === 'queued' ? t('forgeCi.status.queued', 'Queued')
      : running ? undefined : settledTime(job, locale);
  const step = showReason && status.kind === 'failed' ? failedStep(job) : null;
  const reason = step
    ? t('forgeCi.job.failedIn', 'Failed in {step}', { step: step.name })
    : showReason && status.kind === 'skipped' ? t('forgeCi.job.skippedNeeds', 'Skipped · its needs didn’t pass') : undefined;
  const trailing = running ? <ForgeCiElapsedText item={job} /> : accessory;
  return (
    <Item
      title={job.name}
      titleNumberOfLines={1}
      {...(reason === undefined ? {} : { subtitle: reason, subtitleNumberOfLines: 1 })}
      {...(detail === undefined ? {} : { detail, detailTone: status.kind === 'failed' ? 'danger' : 'secondary' })}
      icon={<CheckStatusGlyph status={status.kind} accessibilityLabel={t(status.wordKey, status.word)} />}
      {...(trailing === undefined ? {} : { accessory: trailing })}
      {...(selected === undefined ? {} : { selected })}
      {...(onPress === undefined ? {} : { onPress })}
      density={density ?? 'compact'}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}

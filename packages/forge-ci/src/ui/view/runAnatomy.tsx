import * as React from 'react';
import { useMemo, useState, type ReactElement } from 'react';
import {
  CheckStatusGlyph,
  Row,
  Text,
  usePluginTranslation,
  useSurfaceContext,
  type CollectionAnatomy,
} from '@happier-dev/plugin-ui';
import type { ForgeCiRunV1 } from '@happier-dev/triage-protocol/ci/v1';
import { formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';
import { presentForgeCiStatusV1 } from './ciStatus.js';
import { ForgeCiElapsedText } from './ForgeCiElapsedText.js';
import { forgeCiRunLabelV1, forgeCiRunNumberFactV1 } from './ForgeCiRows.js';

export type ForgeCiRunAnatomyOptionsV1 = Readonly<{
  /** Workflow display names by workflow id, when the host has them; runs carry only the workflow reference. */
  workflowNames?: ReadonlyMap<string, string>;
}>;

/**
 * A run's trailing time: the live or final duration, then how long ago it started. Only a running run ticks, and
 * only this leaf re-renders on the tick; the Collection's rows, groups and anatomy keep their identity.
 */
export function ForgeCiRunTimeV1({
  run,
}: Readonly<{ run: ForgeCiRunV1 }>): ReactElement | null {
  const t = usePluginTranslation();
  const { locale } = useSurfaceContext();
  // Age is read once per mount; only the shared elapsed leaf ticks, and only for a running run.
  const [mountedAtMs] = useState(() => Date.now());
  const at = run.createdAtMs ?? run.startedAtMs;
  const age =
    at === undefined
      ? null
      : formatTriageTimestampV1(locale, at, 'relative', mountedAtMs);
  const queued =
    run.state.phase === 'queued'
      ? t('forgeCi.status.queued', 'Queued')
      : undefined;
  return (
    // Duration and age are two facts in two columns (lab a2): a wide gap keeps "30m 23s 6 days ago" from reading
    // as one phrase.
    <Row
      gap="large"
      align="center"
      testID={`forge-ci.run.${run.ref.runId}.time`}
    >
      <ForgeCiElapsedText
        item={run}
        {...(queued === undefined ? {} : { fallback: queued })}
      />
      {age === null ? null : (
        <Text variant="meta" tone="secondary" value={age} />
      )}
    </Row>
  );
}

/**
 * The shared run row as Collection anatomy, for every Collection of runs (the Actions runs list, a workflow's
 * recent runs). Same mark, words and identity as `ForgeCiRunRow`: the status glyph, the run's own title, the
 * `Workflow #n · branch` facts under it, the state word only when the run needs a reader, and the duration with
 * its age in the title line's end-aligned meta (`ForgeCiRunTimeV1`, the only part that ticks).
 */
export function useForgeCiRunAnatomyV1({
  workflowNames,
}: ForgeCiRunAnatomyOptionsV1 = {}): CollectionAnatomy<ForgeCiRunV1> {
  const t = usePluginTranslation();
  return useMemo<CollectionAnatomy<ForgeCiRunV1>>(() => {
    const name = (run: ForgeCiRunV1) =>
      run.workflow === undefined
        ? null
        : (workflowNames?.get(run.workflow.id) ?? null);
    return {
      // A runs list is activity in time order, not a catalog: its line 2 is the run's facts, so it keeps item rows
      // (one column, ruled groups, labs a2/a9) rather than the catalog directory a described Collection defaults to.
      rowRole: 'item',
      glyph: (run) => {
        const status = presentForgeCiStatusV1(run.state);
        return (
          <CheckStatusGlyph
            status={status.kind}
            accessibilityLabel={t(status.wordKey, status.word)}
          />
        );
      },
      title: (run) => run.title ?? forgeCiRunLabelV1(run, name(run)),
      description: (run) =>
        [forgeCiRunNumberFactV1(run, name(run)), run.headRef]
          .filter(Boolean)
          .join(' · '),
      reason: (run) => {
        const status = presentForgeCiStatusV1(run.state);
        // Healthy and moving runs stay quiet; a failure, a cancellation or a wait says so in its own word, in the
        // state's own tone (lab a2: a rose failure, an amber wait, a quiet cancellation).
        return status.kind === 'failed' ||
          status.kind === 'waiting' ||
          status.kind === 'cancelled'
          ? <Text variant="meta" tone={status.kind === 'cancelled' ? 'secondary' : status.tone} value={t(status.wordKey, status.word)} numberOfLines={1} />
          : null;
      },
      titleMeta: (run) => <ForgeCiRunTimeV1 run={run} />,
      accessibilityLabel: (run) => {
        const status = presentForgeCiStatusV1(run.state);
        return `${run.title ?? forgeCiRunLabelV1(run, name(run))}, ${t(status.wordKey, status.word)}`;
      },
      testID: (run) => `forge-ci.run.${run.ref.runId}`,
      columnTitles: {
        title: t('forgeCi.run.column', 'Run'),
        titleMeta: t('forgeCi.run.columnTime', 'Time'),
      },
    };
  }, [t, workflowNames]);
}

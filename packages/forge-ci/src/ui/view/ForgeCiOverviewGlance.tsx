import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';
import {
  Button,
  CheckStatusGlyph,
  Divider,
  HappierChevron,
  LoadingState,
  Row,
  Stack,
  Text,
  WidgetGlanceRow,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import type {
  ForgeCiRunV1,
  ForgeCiSelectionV1,
} from '@happier-dev/triage-protocol/ci/v1';
import {
  formatTriageTimestampV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import { readForgeOperationStateV1 } from '../operationState.js';
import type { ForgeCiBindingV1 } from './binding.js';
import { forgeCiStatusRankV1, presentForgeCiStatusV1 } from './ciStatus.js';
import { ForgeCiStateNotice } from './ForgeCiStateNotice.js';

export type ForgeCiOverviewGlanceProps = Readonly<{
  ci: ForgeCiBindingV1;
  /** The repository's default branch, by its provider name. */
  branch: string | null;
  /** The newest runs for the default branch HEAD; null while the first read is out. */
  runs: readonly ForgeCiRunV1[] | null;
  failure: TriageSourceFailureV1 | null;
  checkedAtMs: number | null;
  workflowNames?: ReadonlyMap<string, string>;
  onOpenRun: (selection: ForgeCiSelectionV1) => void;
  onRetry: () => void;
  /** The forge's other half of the widget (the latest release), below a hairline. */
  release?: ReactNode;
  /**
   * One line the host owns that replaces the CI half (the default branch HEAD is not known yet). The release
   * half stays: CI availability never hides what was last shipped.
   */
  unavailable?: ReactNode;
  /** Where the widget leads (lab a7: Actions ›, Releases ›), closing the widget in every state. */
  links?: readonly Readonly<{ label: string; onPress: () => void }>[];
  testID?: string;
}>;

function latestPerWorkflow(runs: readonly ForgeCiRunV1[]): ForgeCiRunV1[] {
  const seen = new Set<string>();
  const latest: ForgeCiRunV1[] = [];
  for (const run of runs) {
    const key = run.workflow?.id ?? `run:${run.ref.runId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(run);
  }
  return latest.sort(
    (left, right) =>
      forgeCiStatusRankV1(left.state) - forgeCiStatusRankV1(right.state),
  );
}

function selectionOf(run: ForgeCiRunV1): ForgeCiSelectionV1 {
  return run.currentAttempt
    ? { kind: 'attempt', attempt: run.currentAttempt }
    : { kind: 'run', run: run.ref };
}

/**
 * The CI half of the Project Overview's forge widget (lab a7): the default branch's workflows as glance rows, a
 * failure leading in words that say what and where, a run waiting on the person in amber, healthy work quiet.
 * It never borrows a Session's commit; the host supplies the default branch HEAD's runs.
 */
export function ForgeCiOverviewGlance(
  props: ForgeCiOverviewGlanceProps,
): ReactElement {
  const t = usePluginTranslation();
  const { locale } = useSurfaceContext();
  // Rows read the time once per render; a running run's clock is its own leaf.
  const nowMs = Date.now();
  const ageOf = (atMs: number | undefined, say: (age: string) => string): string | null =>
    atMs === undefined ? null : say(formatTriageTimestampV1(locale, atMs, 'relative', nowMs));
  const about = {
    ...props.ci.about,
    subject: t('forgeCi.subject.defaultBranch', 'the default branch'),
  };
  const rows =
    props.runs === null ? null : latestPerWorkflow(props.runs).slice(0, 4);
  const name = (run: ForgeCiRunV1) =>
    (run.workflow ? props.workflowNames?.get(run.workflow.id) : undefined) ??
    `#${run.number ?? run.ref.runId}`;

  return (
    <Stack
      gap="small"
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.unavailable ?? null}
      {!props.unavailable && props.failure ? (
        <ForgeCiStateNotice
          presentation="line"
          about={about}
          onRetry={props.onRetry}
          asOfMs={props.checkedAtMs}
          state={readForgeOperationStateV1({
            failure: props.failure,
            account: props.ci.account,
            hasRetainedValue: rows !== null,
          })}
        />
      ) : null}
      {props.unavailable ? null : rows === null ? (
        props.failure ? null : (
          <LoadingState
            title={t('forgeCi.overview.loading', 'Reading CI')}
            rows={3}
            layout="line"
          />
        )
      ) : rows.length === 0 ? (
        <Row gap="small" align="center">
          <Text
            variant="body"
            tone="secondary"
            valueKey="forgeCi.overview.empty"
            fallback="No workflow runs on the default branch yet."
          />
        </Row>
      ) : (
        <Stack gap="none">
          {rows.every((run) => presentForgeCiStatusV1(run.state).kind === 'passed') && props.branch ? (
            // Healthy is quiet (lab a7 ok): one line says the branch passes and when it was last pushed.
            <WidgetGlanceRow
              variant="fact"
              mark={<CheckStatusGlyph status="passed" accessibilityLabel={t('forgeCi.status.succeeded', 'Succeeded')} />}
              title={[
                t('forgeCi.overview.passingOn', '{branch} is passing', { branch: props.branch }),
                ageOf(Math.max(...rows.map((run) => run.createdAtMs ?? 0)) || undefined, (age) =>
                  t('forgeCi.overview.lastPush', 'last push {age}', { age })),
              ].filter(Boolean).join(' · ')}
            />
          ) : rows.map((run, index) => {
            const status = presentForgeCiStatusV1(run.state);
            const age = ageOf(run.createdAtMs, (value) => value);
            const mark = (
              <CheckStatusGlyph
                status={status.kind}
                accessibilityLabel={t(status.wordKey, status.word)}
              />
            );
            const open = () => props.onOpenRun(selectionOf(run));
            if (index === 0 && status.kind === 'failed' && props.branch) {
              // A failure leads in words that say what and where, with since when and the push beneath.
              return (
                <WidgetGlanceRow
                  key={run.ref.runId}
                  mark={mark}
                  title={t('forgeCi.overview.failingOn', '{workflow} is failing on {branch}', {
                    workflow: name(run),
                    branch: props.branch,
                  })}
                  fact={[age ? t('forgeCi.overview.since', 'Since {age}', { age }) : null, run.title]
                    .filter(Boolean)
                    .join(' · ')}
                  onPress={open}
                />
              );
            }
            // Every other workflow is one line: its name, its state word, and when it ran on the right.
            // A running row says when it started rather than tick.
            return (
              <WidgetGlanceRow
                key={run.ref.runId}
                mark={mark}
                title={name(run)}
                tag={t(status.wordKey, status.word)}
                tagTone={status.tone === 'attention' ? 'attention' : status.tone === 'danger' ? 'danger' : 'quiet'}
                trailing={age ? <Text variant="meta" tone="secondary" value={age} /> : null}
                onPress={open}
              />
            );
          })}
        </Stack>
      )}
      {props.release ? (
        <>
          <Divider />
          {props.release}
        </>
      ) : null}
      {props.links && props.links.length > 0 ? <GlanceLinks links={props.links} /> : null}
    </Stack>
  );
}

function GlanceLinks({ links }: Readonly<{ links: NonNullable<ForgeCiOverviewGlanceProps['links']> }>): ReactElement {
  const theme = usePluginTheme();
  return (
    <Row gap="large" align="center">
      {links.map((link) => (
        <Button key={link.label} variant="plain" size="small" accessibilityLabel={link.label} onPress={link.onPress}>
          <Row gap="xsmall" align="center">
            <Text variant="label" tone="secondary" value={link.label} />
            <HappierChevron direction="right" color={theme.colors.mutedText} size={10} />
          </Row>
        </Button>
      ))}
    </Row>
  );
}

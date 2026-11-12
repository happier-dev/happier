import * as React from 'react';
import {
  Action,
  Button,
  CodeBlock,
  Column,
  Columns,
  EmptyState,
  Form,
  HappierRadioChoiceList,
  HappierReviewSeveritySign,
  LoadingState,
  Row,
  Stack,
  Status,
  Step,
  Text,
  usePluginHostApi,
  usePluginTheme,
  usePluginTranslation,
  type useTabPanelActivity,
  type HappierReviewSeverity,
  TextField,
  WidgetFrame,
} from '@happier-dev/plugin-ui';
import {
  describeTriageSourceFailureV1,
  type TriageDetailSurfaceInputV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import { TriageDetailPanel, useTriageDetailPanelOpener, useTriageDetailFixPullRequestsEmpty, useTriageEvidenceDisclosure, type TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';

import type { GithubSecurityAlertReadResultV1 } from '../../triage/securityAlerts/actionContracts.js';
import type { GithubMutationOutcomeV1 } from '../detail/mutations.js';
import { GithubReadFailureDetails } from '../detail/readFailure.js';
import type { GithubReadFailureV1 } from '../detail/readBoundary.js';
import {
  useGithubSecurityAlertDetail,
  type GithubSecurityAlertControllerV1,
  type GithubSecurityAlertLocationRowV1,
} from './controller.js';

/**
 * A security alert in PRs & Issues (plan 07, lab 'forge-ci/b5'): Overview tells the finding in story steps —
 * what's exposed (or where it is), the fix, then the advisory (or the rule) — Locations lists a code-scanning
 * alert's instances and reads the selected one's code from its own commit, and the source's actions panel holds
 * the dismissal with GitHub's own reasons, or Reopen.
 *
 * Composition only. Reads, the dismissal and reopening, their settlement and Fix stay with the selected-alert
 * controller ('controller.ts'); provider text is drawn as untrusted content through the source's Markdown owner.
 */

type Alert = Extract<GithubSecurityAlertReadResultV1, { kind: 'alert' }>;
type DependabotAlert = Extract<Alert, { kindId: 'dependabot-alert' }>;
type ScanningAlert = Extract<Alert, { kindId: 'code-scanning-alert' }>;
type Translate = ReturnType<typeof usePluginTranslation>;

export type GithubSecurityAlertRenderersV1 = Readonly<{
  /** The source's one Markdown projection for provider-authored text. */
  renderMarkdown: (body: string) => React.ReactNode;
  /** The source's settled-write presenter (applied, refused, uncertain…). */
  renderOutcome: (outcome: GithubMutationOutcomeV1) => React.ReactNode;
}>;

const SEVERITY: Readonly<Record<string, HappierReviewSeverity>> = Object.freeze(
  {
    critical: 'blocker',
    high: 'high',
    medium: 'medium',
    moderate: 'medium',
    low: 'low',
    warning: 'medium',
    note: 'low',
    error: 'high',
  },
);

const SEVERITY_WORDS: Readonly<Record<string, Readonly<{ key: string; fallback: string }>>> = Object.freeze({
  critical: { key: 'plugins.github.ui.alert.severity.critical', fallback: 'Critical' },
  high: { key: 'plugins.github.ui.alert.severity.high', fallback: 'High' },
  medium: { key: 'plugins.github.ui.alert.severity.medium', fallback: 'Medium' },
  moderate: { key: 'plugins.github.ui.alert.severity.medium', fallback: 'Medium' },
  low: { key: 'plugins.github.ui.alert.severity.low', fallback: 'Low' },
  error: { key: 'plugins.github.ui.alert.severity.error', fallback: 'Error' },
  warning: { key: 'plugins.github.ui.alert.severity.warning', fallback: 'Warning' },
  note: { key: 'plugins.github.ui.alert.severity.note', fallback: 'Note' },
});

const DEPENDABOT_REASONS = Object.freeze({
  tolerable_risk: {
    key: 'plugins.github.ui.alert.reason.tolerableRisk',
    fallback: 'Risk is tolerable for this project',
  },
  not_used: { key: 'plugins.github.ui.alert.reason.notUsed', fallback: 'The vulnerable code isn’t used' },
  fix_started: { key: 'plugins.github.ui.alert.reason.fixStarted', fallback: 'A fix is already under way' },
  inaccurate: { key: 'plugins.github.ui.alert.reason.inaccurate', fallback: 'The alert is inaccurate' },
  no_bandwidth: { key: 'plugins.github.ui.alert.reason.noBandwidth', fallback: 'No time to fix it now' },
} as const);

const SCANNING_REASONS = Object.freeze({
  'false positive': { key: 'plugins.github.ui.alert.reason.falsePositive', fallback: 'False positive' },
  "won't fix": { key: 'plugins.github.ui.alert.reason.wontFix', fallback: 'Won’t fix' },
  'used in tests': { key: 'plugins.github.ui.alert.reason.usedInTests', fallback: 'Used in tests' },
  mitigated: { key: 'plugins.github.ui.alert.reason.mitigated', fallback: 'Mitigated elsewhere' },
} as const);

function reasonLabel(text: Translate, reason: string): string {
  const copy =
    (
      DEPENDABOT_REASONS as Readonly<
        Record<string, { key: string; fallback: string }>
      >
    )[reason] ??
    (
      SCANNING_REASONS as Readonly<
        Record<string, { key: string; fallback: string }>
      >
    )[reason];
  return copy === undefined
    ? reason
    : text(copy.key, copy.fallback);
}

function describe(text: Translate, failure: TriageSourceFailureV1): string {
  return describeTriageSourceFailureV1(
    failure,
    text(
      'plugins.github.ui.readFailed',
      'GitHub could not complete this read.',
    ),
    text,
  );
}

function SeverityWord({
  severity,
}: Readonly<{ severity: string }>): React.ReactElement {
  const theme = usePluginTheme();
  const text = usePluginTranslation();
  const level = severity.toLowerCase();
  const mapped = SEVERITY[level] ?? 'nit';
  const copy = SEVERITY_WORDS[level];
  // A level GitHub adds later still reads as its own word, never as a guessed one.
  const label = copy === undefined
    ? level.length === 0 ? '—' : `${level[0]!.toUpperCase()}${level.slice(1)}`
    : text(copy.key, copy.fallback);
  return (
    <HappierReviewSeveritySign severity={mapped} label={label} theme={theme} />
  );
}

/** Facts as a quiet label over its value, in one row of columns; a fact the provider did not state is absent. */
function Facts({
  facts,
}: Readonly<{
  facts: readonly Readonly<{
    id: string;
    label: string;
    value: React.ReactNode;
  }>[];
}>): React.ReactElement | null {
  if (facts.length === 0) return null;
  return (
    <Columns
      columns={facts.length >= 4 ? 4 : facts.length === 3 ? 3 : 2}
      minColumnWidth={120}
      gap="medium"
    >
      {facts.map((fact) => (
        <Column key={fact.id}>
          <Stack gap="none">
            <Text variant="micro" tone="secondary" value={fact.label} />
            {typeof fact.value === 'string' ? (
              <Text variant="body" value={fact.value} />
            ) : (
              fact.value
            )}
          </Stack>
        </Column>
      ))}
    </Columns>
  );
}

function Mono({ value }: Readonly<{ value: string }>): React.ReactElement {
  return <Text variant="code" value={value} />;
}

function DismissalHistory({
  detail,
}: Readonly<{ detail: Alert['detail'] }>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (detail.dismissedReason === null && detail.dismissedBy === null)
    return null;
  const reason =
    detail.dismissedReason === null
      ? null
      : reasonLabel(text, detail.dismissedReason);
  const who = detail.dismissedBy;
  const line =
    who !== null && reason !== null
      ? text('plugins.github.ui.alert.history.dismissedByAs', 'Dismissed by {name} as {reason}', {
          name: who,
          reason: reason.toLowerCase(),
        })
      : who !== null
        ? text('plugins.github.ui.alert.history.dismissedBy', 'Dismissed by {name}', { name: who })
        : text('plugins.github.ui.alert.history.dismissedAs', 'Dismissed as {reason}', {
            reason: (reason ?? '').toLowerCase(),
          });
  return (
    <Step
      marker={{
        kind: 'state',
        state: 'passed',
        label: text('plugins.github.ui.alert.history.dismissed', 'Dismissed'),
      }}
      title={text('plugins.github.ui.alert.history', 'History')}
    >
      <Stack gap="xsmall">
        <Text variant="body" value={line} />
        {detail.dismissedComment === null ? null : (
          <Text
            variant="meta"
            tone="secondary"
            value={`“${detail.dismissedComment}”`}
          />
        )}
        <Text
          variant="meta"
          tone="secondary"
          value={text(
            'plugins.github.ui.alert.history.kept',
            'GitHub keeps this reason. The finding is hidden, not fixed.',
          )}
        />
      </Stack>
    </Step>
  );
}

function DependabotOverview({
  alert,
  renderers,
}: Readonly<{
  alert: DependabotAlert;
  renderers: GithubSecurityAlertRenderersV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const d = alert.detail;
  const fixPullRequestsEmpty = useTriageDetailFixPullRequestsEmpty();
  const relationship =
    d.relationship === 'direct'
      ? text('plugins.github.ui.alert.relationship.direct', 'Direct dependency')
      : d.relationship === 'transitive'
        ? text('plugins.github.ui.alert.relationship.transitive', 'Transitive dependency')
        : null;
  const scope =
    d.dependencyScope === 'runtime'
      ? text('plugins.github.ui.alert.scope.runtime', 'Runtime')
      : d.dependencyScope === 'development'
        ? text('plugins.github.ui.alert.scope.development', 'Development')
        : null;
  const fixed = d.nativeState === 'fixed';
  return (
    <Stack gap="large">
      <Step
        marker={{ kind: 'number', value: 1 }}
        title={text('plugins.github.ui.alert.exposed', 'What’s exposed')}
      >
        <Stack gap="medium">
          <Facts
            facts={[
              {
                id: 'package',
                label: text('plugins.github.ui.alert.fact.package', 'Package'),
                value: <Mono value={`${d.packageName} · ${d.ecosystem}`} />,
              },
              ...(d.affectedRange === null
                ? []
                : [
                    {
                      id: 'vulnerable',
                      label: text('plugins.github.ui.alert.fact.vulnerable', 'Vulnerable'),
                      value: <Mono value={d.affectedRange} />,
                    },
                  ]),
              ...(relationship === null
                ? []
                : [
                    {
                      id: 'relationship',
                      label: text('plugins.github.ui.alert.fact.relationship', 'Relationship'),
                      value: relationship,
                    },
                  ]),
              ...(scope === null
                ? []
                : [
                    {
                      id: 'scope',
                      label: text('plugins.github.ui.alert.fact.scope', 'Scope'),
                      value: scope,
                    },
                  ]),
            ]}
          />
          {/* The manifest takes the whole width, so a long path breaks at its separators rather than mid-name. */}
          <Stack gap="none">
            <Text variant="micro" tone="secondary" value={text('plugins.github.ui.alert.fact.manifest', 'Manifest')} />
            <Mono value={d.manifestPath} />
          </Stack>
          {/* An open fix pull request is drawn once, by Triage's fix step after this rail (owner 2026-10-31,
              c8-alert); while there is none this chapter says how one could come. */}
          {fixed ? (
            <Text variant="meta" tone="secondary" value={text(
              'plugins.github.ui.alert.fix.fixed',
              'GitHub marked this alert fixed when {package} was updated.',
              { package: d.packageName },
            )} />
          ) : !fixPullRequestsEmpty ? null : (
            <Text
              variant="meta"
              tone="secondary"
              value={
                d.patchedVersion === null
                  ? text(
                      'plugins.github.ui.alert.fix.noPatch',
                      'GitHub supplies no patched version of {package} yet.',
                      { package: d.packageName },
                    )
                  : d.relationship === 'transitive'
                  ? text(
                      'plugins.github.ui.alert.fix.transitiveHint',
                      'A transitive dependency often needs a code change to move, so it fits a session. You can also ask Dependabot for an update from the alert on GitHub.',
                    )
                  : text(
                      'plugins.github.ui.alert.fix.directHint',
                      'Updating {package} in {manifest} fixes it. You can also ask Dependabot for an update from the alert on GitHub.',
                      { package: d.packageName, manifest: d.manifestPath },
                    )
              }
            />
          )}
        </Stack>
      </Step>
      <DismissalHistory detail={d} />
      <Step
        marker={{ kind: 'number', value: 2 }}
        title={text('plugins.github.ui.alert.advisory', 'Advisory')}
        {...(d.advisoryId === null
          ? {}
          : {
              trailing: (
                <Text variant="micro" tone="secondary" value={d.advisoryId} />
              ),
            })}
      >
        <Stack gap="medium">
          <Facts
            facts={[
              {
                id: 'severity',
                label: text('plugins.github.ui.alert.fact.severity', 'Severity'),
                value: <SeverityWord severity={d.severity} />,
              },
              ...(d.patchedVersion === null
                ? []
                : [
                    {
                      id: 'patched',
                      label: text('plugins.github.ui.alert.fact.patched', 'Patched in'),
                      value: <Mono value={d.patchedVersion} />,
                    },
                  ]),
            ]}
          />
          {d.advisory.length === 0
            ? null
            : renderers.renderMarkdown(d.advisory)}
          {d.projectionTruncated ? (
            <Text
              variant="meta"
              tone="secondary"
              value={text(
                'plugins.github.ui.alert.truncated',
                'Shortened here. The whole advisory is on GitHub.',
              )}
            />
          ) : null}
        </Stack>
      </Step>
    </Stack>
  );
}

function ScanningOverview({
  alert,
  renderers,
}: Readonly<{
  alert: ScanningAlert;
  renderers: GithubSecurityAlertRenderersV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const d = alert.detail;
  const location = d.location;
  const tool =
    d.toolVersion === null ? d.toolName : `${d.toolName} ${d.toolVersion}`;
  return (
    <Stack gap="large">
      <Step
        marker={{ kind: 'number', value: 1 }}
        title={text('plugins.github.ui.alert.where', 'Where')}
        {...(location === null
          ? {}
          : {
              trailing: (
                <Text
                  variant="micro"
                  tone="secondary"
                  value={location.commitSha.slice(0, 7)}
                />
              ),
            })}
      >
        {location === null ? (
          <Text
            variant="body"
            tone="secondary"
            value={text(
              'plugins.github.ui.alert.where.none',
              'GitHub didn’t report where this was found.',
            )}
          />
        ) : (
          <Stack gap="xsmall">
            <Mono
              value={`${location.path}:${location.startLine}${location.endLine > location.startLine ? `–${location.endLine}` : ''}`}
            />
            <Text
              variant="meta"
              tone="secondary"
              value={text('plugins.github.ui.alert.where.ref', '{ref} · commit {commit}', {
                ref: location.ref,
                commit: location.commitSha.slice(0, 7),
              })}
            />
            <Text variant="reading" value={d.message} />
          </Stack>
        )}
      </Step>
      <DismissalHistory detail={d} />
      <Step
        marker={{ kind: 'number', value: 2 }}
        title={text('plugins.github.ui.alert.rule', 'Rule')}
        {...(d.ruleId === null
          ? {}
          : {
              trailing: (
                <Text variant="micro" tone="secondary" value={d.ruleId} />
              ),
            })}
      >
        <Stack gap="medium">
          <Stack gap="xsmall">
            <Text variant="label" value={d.ruleName} />
            {d.ruleDescription.length === 0 ||
            d.ruleDescription === d.ruleName ? null : (
              <Text variant="body" value={d.ruleDescription} />
            )}
          </Stack>
          <Facts
            facts={[
              {
                id: 'severity',
                label: text('plugins.github.ui.alert.fact.severity', 'Severity'),
                value: <SeverityWord severity={d.severity} />,
              },
              ...(d.ruleSeverity === null
                ? []
                : [
                    {
                      id: 'level',
                      label: text('plugins.github.ui.alert.fact.level', 'Rule level'),
                      value: d.ruleSeverity,
                    },
                  ]),
              {
                id: 'tool',
                label: text('plugins.github.ui.alert.fact.tool', 'Tool'),
                value: tool,
              },
            ]}
          />
          {d.ruleHelp === null || d.ruleHelp.length === 0
            ? null
            : renderers.renderMarkdown(d.ruleHelp)}
        </Stack>
      </Step>
    </Stack>
  );
}

function AlertRead({
  controller,
  children,
}: Readonly<{
  controller: GithubSecurityAlertControllerV1;
  children: (alert: Alert) => React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const state = controller.detail.state;
  const retainedFailure: GithubReadFailureV1 | null = controller.detail.failure;
  if (state.kind === 'loading')
    // One quiet line where the story will start, under an action row that already holds its places.
    return <Status tone="muted" pulsing label={text('plugins.github.ui.alert.reading', 'Reading this alert')} />;
  if (state.kind === 'unavailable') {
    const failure: GithubReadFailureV1 = state.failure;
    return (
      <Stack gap="small">
        <Status
          tone="warning"
          label={text('plugins.github.ui.alert.unavailable', 'This alert couldn’t be read')}
          value={describe(text, failure)}
          action={failure.retryable === false ? undefined : <Button
            title={text('plugins.github.ui.alert.reread', 'Try again')}
            variant="secondary" size="small" onPress={controller.detail.refresh}
          />}
        />
        <GithubReadFailureDetails failures={[failure]} />
      </Stack>
    );
  }
  return (
    <Stack gap="medium">
      {controller.detail.failure === null ? null : (
        <Stack gap="small"><Status
          tone="warning"
          label={text('plugins.github.ui.alert.retained', 'Showing the last read')}
          value={describe(text, controller.detail.failure)}
          action={retainedFailure?.retryable === false ? undefined :
            <Button
              title={text('plugins.github.ui.alert.reread', 'Try again')}
              variant="plain"
              size="small"
              onPress={controller.detail.refresh}
            />
          }
        /><GithubReadFailureDetails failures={[retainedFailure]} /></Stack>
      )}
      {children(state.value)}
    </Stack>
  );
}

function AlertOverview({
  controller,
  renderers,
}: Readonly<{
  controller: GithubSecurityAlertControllerV1;
  renderers: GithubSecurityAlertRenderersV1;
}>): React.ReactElement {
  return (
    <AlertRead controller={controller}>
      {(alert) =>
        alert.kindId === 'dependabot-alert' ? (
          <DependabotOverview alert={alert} renderers={renderers} />
        ) : (
          <ScanningOverview alert={alert} renderers={renderers} />
        )
      }
    </AlertRead>
  );
}

function locationKey(row: GithubSecurityAlertLocationRowV1): string {
  const l = row.location;
  return `${l.commitSha}:${l.path}:${l.startLine}:${l.endLine}:${l.startColumn ?? ''}:${l.analysisKey}`;
}

function AlertLocations({
  controller,
}: Readonly<{
  controller: GithubSecurityAlertControllerV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const theme = usePluginTheme();
  const host = usePluginHostApi();
  const walk = controller.locations.state;
  const rows = walk.rows;
  const selected = controller.selectedLocation ?? null;
  const keyed = React.useMemo(
    () => new Map(rows.map((row) => [locationKey(row), row])),
    [rows],
  );
  // The first location reads by itself once the list arrives; the reader moves the selection from there.
  const first = rows[0];
  const select = controller.selectLocation;
  React.useEffect(() => {
    if (selected === null && first !== undefined) select(first);
  }, [first, select, selected]);
  if (walk.kind === 'idle' || (walk.kind === 'loading' && rows.length === 0)) {
    return (
      <LoadingState
        title={text(
          'plugins.github.ui.alert.locations.reading',
          'Reading the locations GitHub reports for this alert',
        )}
      />
    );
  }
  if (walk.kind === 'unavailable' && rows.length === 0) {
    const failure: GithubReadFailureV1 | null = walk.failure;
    return (
      <Stack gap="small"><Status
        tone="warning"
        label={text(
          'plugins.github.ui.alert.locations.unavailable',
          'The locations couldn’t be read',
        )}
        value={failure === null ? undefined : describe(text, failure)}
        action={failure?.retryable === false ? undefined : <Button
          title={text('plugins.github.ui.alert.reread', 'Try again')}
          variant="secondary" size="small" onPress={controller.locations.refresh}
        />}
      /><GithubReadFailureDetails failures={[failure]} /></Stack>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title={text('plugins.github.ui.alert.locations.none', 'No locations reported')}
        description={text(
          'plugins.github.ui.alert.locations.none.description',
          'GitHub reports no instances of this alert on any branch it scanned.',
        )}
      />
    );
  }
  const snippet = controller.snippet.state;
  return (
    <Stack gap="large">
      <Stack gap="small">
        <Text
          variant="meta"
          tone="secondary"
          value={
            walk.canLoadMore
              ? text(
                  'plugins.github.ui.alert.locations.partial',
                  'The first locations GitHub reports. The selected one is read from its own commit, never the branch head.',
                )
              : text(
                  'plugins.github.ui.alert.locations.count',
                  'The selected location is read from its own commit, never the branch head.',
                )
          }
        />
        <HappierRadioChoiceList
          theme={theme}
          accessibilityLabel={text('plugins.github.ui.alert.locations', 'Locations')}
          options={rows.map((row) => ({
            id: locationKey(row),
            title: `${row.location.path}:${row.location.startLine}`,
          }))}
          value={selected === null ? null : locationKey(selected)}
          onChange={(id) => {
            const row = keyed.get(id);
            if (row !== undefined) select(row);
          }}
          renderTitle={(option) => {
            const row = keyed.get(option.id);
            return (
              <Stack gap="none">
                <Mono value={option.title} />
                {row === undefined ? null : (
                  <Text
                    variant="micro"
                    tone="secondary"
                    value={text('plugins.github.ui.alert.where.ref', '{ref} · commit {commit}', {
                      ref: row.location.ref,
                      commit: row.location.commitSha.slice(0, 7),
                    })}
                  />
                )}
              </Stack>
            );
          }}
        />
        {walk.canLoadMore ? (
          <Button
            title={text('plugins.github.ui.alert.locations.more', 'Show more locations')}
            variant="plain"
            size="small"
            busy={walk.pending}
            onPress={controller.locations.loadMore}
          />
        ) : null}
      </Stack>
      {selected === null ? null : snippet.kind === 'loading' ? (
        <LoadingState
          title={text(
            'plugins.github.ui.alert.code.reading',
            'Reading the code at commit {commit}',
            { commit: selected.location.commitSha.slice(0, 7) },
          )}
        />
      ) : snippet.kind === 'unavailable' ? (
        <Stack gap="small"><Status
          tone="neutral"
          label={text('plugins.github.ui.alert.code.unavailable', 'The code can’t be shown here')}
          value={describe(text, snippet.failure)}
        /><GithubReadFailureDetails failures={[snippet.failure]} /></Stack>
      ) : (
        <Stack gap="small">
          <Row gap="small" align="center">
            <Text
              variant="meta"
              tone="secondary"
              value={text('plugins.github.ui.alert.code.lines', 'Lines {first}–{last} of {path}', {
                first: String(snippet.value.firstLine),
                last: String(snippet.value.lastLine),
                path: snippet.value.location.path,
              })}
            />
            <Button
              title={text('plugins.github.ui.alert.code.open', 'Open file on GitHub')}
              variant="plain"
              size="small"
              onPress={() => {
                void host.openExternalLink(snippet.value.sourceUrl);
              }}
            />
          </Row>
          {snippet.value.code === null ? (
            <Text
              variant="meta"
              tone="secondary"
              value={
                snippet.value.codeUnavailable === undefined
                  ? text(
                      'plugins.github.ui.alert.code.none',
                      'GitHub didn’t return this file’s text. The location is exactly as GitHub reported it.',
                    )
                  : describe(text, snippet.value.codeUnavailable)
              }
            />
          ) : (
            <CodeBlock code={snippet.value.code} />
          )}
          {snippet.value.projectionTruncated ? (
            <Text
              variant="micro"
              tone="secondary"
              value={text(
                'plugins.github.ui.alert.code.truncated',
                'Only the lines around the location are shown.',
              )}
            />
          ) : null}
          <Text variant="body" value={snippet.value.location.message} />
        </Stack>
      )}
    </Stack>
  );
}

function AlertActions({
  controller,
  renderers,
}: Readonly<{
  controller: GithubSecurityAlertControllerV1;
  renderers: GithubSecurityAlertRenderersV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const theme = usePluginTheme();
  const m = controller.mutations;
  const [reason, setReason] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState('');
  const cancel = useTriageDetailPanelOpener('overview');
  const outcome =
    m.outcome === null ? null : renderers.renderOutcome(m.outcome);
  if (m.canDismiss) {
    return (
      <WidgetFrame
        frameStyle="card"
        placement="companion"
        title={text('plugins.github.ui.alert.dismiss.frame', 'Dismiss on GitHub')}
      >
      <Stack gap="medium">
        <Stack gap="xsmall">
          <Text
            variant="label"
            value={text('plugins.github.ui.alert.dismiss.title', 'Why dismiss it?')}
          />
          <Text
            variant="meta"
            tone="secondary"
            value={text(
              'plugins.github.ui.alert.dismiss.description',
              'GitHub keeps the reason. The alert is hidden there and here, not fixed, and you can reopen it.',
            )}
          />
        </Stack>
        <HappierRadioChoiceList
          theme={theme}
          accessibilityLabel={text('plugins.github.ui.alert.dismiss.reason', 'Reason')}
          options={m.reasons.map((id) => ({
            id,
            title: reasonLabel(text, id),
          }))}
          value={reason}
          onChange={setReason}
          disabled={m.pending}
        />
        <Stack gap="xsmall">
          <Text variant="meta" tone="secondary" value={text(
            'plugins.github.ui.alert.dismiss.comment',
            'Comment (optional, shown on GitHub)',
          )} />
          <TextField
            presentation="field"
            label={text(
              'plugins.github.ui.alert.dismiss.comment',
              'Comment (optional, shown on GitHub)',
            )}
            value={comment}
            onChange={setComment}
            multiline
            minLines={2}
          />
        </Stack>
        <Form
          hints={{ fields: [], submitLabel: text('plugins.github.ui.alert.dismiss.submit', 'Dismiss alert') }}
          value={{ reason, comment }}
          onChange={() => {}}
          disabled={m.pending}
          busy={m.pending}
          submitDisabled={reason === null}
          submitVariant="secondary"
          onCancel={() => {
            setReason(null);
            setComment('');
            cancel?.();
          }}
          onSubmit={() => {
            if (reason !== null) return m.dismiss(reason, comment.trim() || undefined);
          }}
        />
        {outcome}
      </Stack>
      </WidgetFrame>
    );
  }
  return (
    <AlertRead controller={controller}>
      {(alert) => {
        const state = alert.detail.nativeState;
        return (
          <Stack gap="small">
            {m.canReopen ? (
              <Row gap="small" align="center">
                <Text
                  variant="meta"
                  tone="secondary"
                  value={text(
                    'plugins.github.ui.alert.dismissed.line',
                    'Dismissed · stays dismissed on GitHub until reopened',
                  )}
                />
                <Action.Control
                  action={m.reopenAction}
                  controller={m.reopenControl}
                  signal={m.signal}
                  title={text('plugins.github.ui.alert.reopen', 'Reopen')}
                  variant="secondary"
                  disabled={m.pending}
                />
              </Row>
            ) : state === 'fixed' ? (
              <Text
                variant="meta"
                tone="secondary"
                value={text(
                  'plugins.github.ui.alert.fixed.line',
                  'Fixed by GitHub. A fixed alert can’t be reopened from here.',
                )}
              />
            ) : (
              <Text
                variant="meta"
                tone="secondary"
                value={text(
                  'plugins.github.ui.alert.noChange',
                  'GitHub allows no change to this alert from here.',
                )}
              />
            )}
            {outcome}
          </Stack>
        );
      }}
    </AlertRead>
  );
}

/**
 * The entry header opens the existing dismissal form; only submitting that form writes to GitHub.
 * Reopen remains a direct state change for an already dismissed alert.
 */
function useGithubSecurityAlertHeaderWrite(
  panel: TriageDetailSurfaceInputV1['panel'],
  controller: GithubSecurityAlertControllerV1,
  renderers: GithubSecurityAlertRenderersV1,
): void {
  const text = usePluginTranslation();
  const openDismissForm = useTriageDetailPanelOpener('actions');
  const offer = useTriageEvidenceDisclosure().primaryWrite?.offer;
  // The header sits outside the body tabs; the actions panel draws its own form, so only the other mount offers.
  const publishes = offer !== undefined && panel !== undefined && panel !== 'actions';
  // The controller rebuilds its mutations record each render; the offer follows only the facts it shows, so the
  // header is not re-offered (and re-rendered) on every render of this body.
  const { canDismiss, canReopen, pending, outcome, reopen, reopenAction, reopenControl, signal } = controller.mutations;
  const reading = controller.detail.state.kind === 'loading';
  const write = React.useMemo((): TriageDetailPrimaryWriteV1 | null => {
    const feedback = outcome === null ? undefined : renderers.renderOutcome(outcome);
    const common = { disabledReason: null, pending, ...(feedback === undefined ? {} : { feedback }) };
    // Before the alert is read Dismiss… keeps its place, disabled, so nothing moves when the answer arrives.
    if (reading && openDismissForm !== undefined) return {
      ...common, id: 'alertDismiss', reading: true,
      title: text('plugins.github.ui.alert.dismiss.menu', 'Dismiss…'),
      execute: async () => {},
    };
    if (canDismiss && openDismissForm !== undefined) return {
      ...common, id: 'alertDismiss',
      title: text('plugins.github.ui.alert.dismiss.menu', 'Dismiss…'),
      execute: async () => { openDismissForm(); },
    };
    if (canReopen) return {
      ...common, id: 'alertReopen', actionRef: reopenAction, controllerFor: () => reopenControl, signal,
      title: text('plugins.github.ui.alert.reopen', 'Reopen'),
      execute: async () => { await reopen(); },
    };
    return null;
  }, [canDismiss, canReopen, openDismissForm, outcome, pending, reading, renderers, reopen, reopenAction, reopenControl, signal, text]);
  React.useLayoutEffect(() => {
    if (!publishes) return undefined;
    offer(write);
    return () => { offer(null); };
  }, [offer, publishes, write]);
}

/** One selected alert's detail: the panel the Triage frame asked for, over one controller for this mount. */
export function GithubSecurityAlertBody({ input, renderers, detailActivity }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  renderers: GithubSecurityAlertRenderersV1;
  /** The mount's own activity, so reads end when the frame hides this panel. */
  detailActivity: ReturnType<typeof useTabPanelActivity>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useGithubSecurityAlertDetail(input, { activity: detailActivity, locationsActive: input.panel === 'locations' });
  useGithubSecurityAlertHeaderWrite(input.panel, controller, renderers);
  const scanning = input.observation.entryRef.kindId === 'code-scanning-alert';
  return (
    <TriageDetailPanel
      scrollOwner={input.panelScrollOwner}
      panel={input.panel ?? 'overview'}
      ariaLabel={text('plugins.github.ui.alert.detail', 'GitHub alert detail')}
      panels={{
        overview: (
          <AlertOverview controller={controller} renderers={renderers} />
        ),
        ...(scanning
          ? { locations: <AlertLocations controller={controller} /> }
          : {}),
        actions: <AlertActions controller={controller} renderers={renderers} />,
      }}
    />
  );
}

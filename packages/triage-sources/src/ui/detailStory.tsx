import * as React from 'react';
import { ScrollArea, Stack, Step, usePluginTranslation } from '@happier-dev/plugin-ui';

/** Composition only: the source retains ownership of evidence and its read lifecycle. */
export function TriageDetailStory({ kind, children, changes, checks, trailing }: Readonly<{
  kind?: 'ask' | 'report' | undefined;
  children: React.ReactNode;
  changes?: React.ReactNode;
  checks?: React.ReactNode;
  trailing?: React.ReactNode;
}>): React.ReactElement {
  if (kind === undefined) return <ScrollArea><Stack gap="large">{children}</Stack></ScrollArea>;
  return <Stack gap="large">
    <Step marker={{ kind: 'number', value: 1 }}
      title={kind === 'ask' ? 'The ask' : 'The report'}
      titleKey={`plugins.triage.detailStory.${kind}`} trailing={trailing}>
      <Stack gap="large">{children}</Stack>
    </Step>
    {changes}
    {checks}
  </Stack>;
}

export function TriageDetailChanges({ children, trailing, titleKey = 'plugins.triage.detailStory.changed' }: Readonly<{
  children: React.ReactNode;
  trailing?: React.ReactNode;
  titleKey?: string;
}>): React.ReactElement {
  return <Step marker={{ kind: 'number', value: 2 }} title="What changed"
    titleKey={titleKey} trailing={trailing}><Stack gap="small">{children}</Stack></Step>;
}

/** Counts are canonical provider rollups, never inferred from the currently loaded page. */
export function TriageDetailChecks({ title, titleKey, rollup, children }: Readonly<{
  title: string;
  titleKey: string;
  rollup: Readonly<{ failingCount?: number; runningCount?: number; passingCount?: number }> | null;
  children?: React.ReactNode;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (rollup?.failingCount === undefined || rollup.runningCount === undefined
    || rollup.passingCount === undefined) return null;
  const state = rollup.failingCount > 0 ? 'failed' : rollup.runningCount > 0 ? 'running'
    : rollup.passingCount > 0 ? 'passed' : null;
  if (state === null) return null;
  const label = text(`plugins.triage.detailStory.${state}`,
    state === 'failed' ? '{count} failed' : state === 'running' ? 'Running' : 'Passed',
    { count: rollup.failingCount });
  return <Step title={title} titleKey={titleKey} marker={{ kind: 'state', state, label }}>{children}</Step>;
}

export function TriageDetailActivity({ children }: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return <Step marker={{ kind: 'number', value: 1 }} title="Activity"
    titleKey="plugins.triage.detailStory.activity">
    <Stack gap="large" style={{ flex: 1, minHeight: 0 }}>{children}</Stack>
  </Step>;
}

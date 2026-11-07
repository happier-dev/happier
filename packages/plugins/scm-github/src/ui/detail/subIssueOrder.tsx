import * as React from 'react';
import { Row, Stack, Text } from '@happier-dev/plugin-ui';
import { EntityFlatReorderList } from '@happier-dev/plugin-ui/components';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { buildGithubSubIssueReprioritizeInputV1 } from './mutations.js';

type ReprioritizeInput = NonNullable<ReturnType<typeof buildGithubSubIssueReprioritizeInputV1>>;

/** Presentation comes from the relation read; the registered Action owns each native move. */
export function GithubSubIssueOrder({ input, reorder, disabledReason }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  reorder(payload: ReprioritizeInput): Promise<boolean>;
  disabledReason?: string;
}>): React.ReactElement | null {
  const children = input.observation.snapshot.relations?.children;
  const entries = children?.entries;
  const items = React.useMemo(() => entries?.map(entry => ({
    id: JSON.stringify([entry.source.pluginId, entry.source.localId, entry.kindId, entry.collisionScope, entry.entryId]),
    title: `#${entry.entryId}${entry.title === undefined ? '' : ` ${entry.title}`}`,
  })) ?? [], [entries]);
  const move = React.useCallback(async (id: string, beforeId: string | null) => {
    const child = entries?.[items.findIndex(item => item.id === id)];
    const before = beforeId === null ? null : entries?.[items.findIndex(item => item.id === beforeId)];
    if (child === undefined || before === undefined) return false;
    const payload = buildGithubSubIssueReprioritizeInputV1(input, child, before);
    return payload !== null && await reorder(payload);
  }, [entries, input, items, reorder]);
  if (items.length === 0) return null;
  return <Stack gap="small">
    <EntityFlatReorderList localId="sub-issues" testID="github-sub-issue-order" items={items}
      {...(children?.complete === true && disabledReason === undefined ? { onReorder: move } : {})}
      renderItem={(item, controls) => <Row align="center" gap="small">
        <Stack grow><Text value={item.title} variant="body" /></Stack>
        {controls.renderHandle()}
      </Row>} />
    {children?.complete === true ? null : <Text valueKey="plugins.github.ui.parity.partialSubIssues"
      fallback="Showing the first {count}" values={{ count: String(items.length) }} tone="muted" />}
    {disabledReason === undefined ? null : <Text value={disabledReason} variant="micro" tone="neutral" />}
  </Stack>;
}

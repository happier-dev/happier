import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { SelectionListOption } from './_types';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { PlanSuccessRows } = await import('./SelectionListOptionRow');
const { flattenRenderPlanForVirtualizedList } = await import('./SelectionListVirtualizedBody');
const { Item } = await import('@/components/ui/lists/Item');

// WAVE-ACCEPT-1118D (Artifacts Kind): only "Documents" carries a mark, and the other rows started 36 px left of it.
const MIXED: readonly SelectionListOption[] = [
  { id: 'files', label: 'Documents & files' },
  { id: 'all', label: 'All kinds' },
  { id: 'documents', label: 'Documents', icon: <View testID="documents-mark" /> },
];
const UNMARKED: readonly SelectionListOption[] = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'title', label: 'Title' },
];

async function renderSection(options: readonly SelectionListOption[]) {
  const screen = await renderScreen(
    <PlanSuccessRows
      plan={{ id: 'section', options }}
      rootTestID="kind"
      stepId="root"
      selectedOptionIds={new Set([options[0]!.id])}
      focusedOptionId={null}
      onSelect={() => {}}
      onPushStep={() => {}}
    />,
  );
  return screen.findAllByType(Item);
}

describe('a section keeps one text edge', () => {
  it('reserves the mark column for every row when only some rows carry a mark', async () => {
    const rows = await renderSection(MIXED);
    expect(rows.map((row) => row.props.title)).toEqual(['Documents & files', 'All kinds', 'Documents']);
    expect(rows.every((row) => row.props.icon != null)).toBe(true);
  });

  it('starts a section with no marks at the text edge', async () => {
    const rows = await renderSection(UNMARKED);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.props.icon == null)).toBe(true);
  });

  it('tells each virtualized row whether its section reserves the column', () => {
    const items = flattenRenderPlanForVirtualizedList([
      { id: 'kind', options: MIXED },
      { id: 'sort', options: UNMARKED },
    ]).filter((item) => item.kind === 'option');
    expect(items.map((item) => [item.option.id, item.reservesLeadingSlot])).toEqual([
      ['files', true], ['all', true], ['documents', true], ['updated', false], ['title', false],
    ]);
  });
});

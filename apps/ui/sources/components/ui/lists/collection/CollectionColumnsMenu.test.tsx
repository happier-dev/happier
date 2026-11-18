import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  EMPTY_NAVIGATION_PLACEMENT_PREFERENCES,
  updateNavigationPlacement,
  type NavigationPlacementPreferences,
} from '@/sync/domains/settings/navigationPlacement';

import {
  CollectionColumnsMenuView,
  collectionColumnsMenuColumns,
} from './CollectionColumnsMenu';
import { resolveCollectionColumns } from './collectionColumns';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-gesture-handler', async () =>
  (
    await import('@/dev/testkit/mocks/gestureHandler')
  ).createGestureHandlerMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);

afterEach(standardCleanup);

const COLUMNS = collectionColumnsMenuColumns(
  { id: 'title', title: 'Environment' },
  [
    {
      key: 'lastDeploy',
      title: 'Last deploy',
      description: 'Version, time and who',
    },
    { key: 'runsOn', title: 'Runs on', description: 'Machine or platform' },
    {
      key: 'requests',
      title: 'Requests',
      description: 'Per second, with the last 24 h',
      source: 'Telemetry',
      defaultHidden: true,
    },
    { key: 'state', title: 'State', description: 'Deploy and check state' },
  ],
);

/** The menu over the real column resolver; the preference write is the boundary, held here instead of the Account. */
function Harness(
  props: Readonly<{
    fittedIds?: readonly string[] | null;
    writes: NavigationPlacementPreferences[];
  }>,
) {
  const [preferences, setPreferences] =
    React.useState<NavigationPlacementPreferences>(
      EMPTY_NAVIGATION_PLACEMENT_PREFERENCES,
    );
  const resolved = resolveCollectionColumns(COLUMNS, preferences);
  const commit = (next: NavigationPlacementPreferences) => {
    props.writes.push(next);
    setPreferences(next);
    return Promise.resolve(true);
  };
  const controller = {
    ...resolved,
    setVisible: (id: string, visible: boolean) =>
      commit(
        updateNavigationPlacement(
          preferences,
          id,
          visible ? 'pinned' : 'hidden',
        ),
      ),
    reset: () => commit(EMPTY_NAVIGATION_PLACEMENT_PREFERENCES),
  };
  const reorder = {
    scope: null,
    kind: 'navigation-item' as const,
    items: [],
    getItem: () => null,
    getSourceId: () => null,
    resolve: () => ({
      status: 'refused' as const,
      reason: { code: 'same-position', message: '' },
    }),
    execute: async () => ({ status: 'applied' as const }),
  };
  return (
    <CollectionColumnsMenuView
      columns={COLUMNS}
      controller={controller}
      reorder={reorder as never}
      fittedIds={props.fittedIds ?? null}
      testID="columns"
    />
  );
}

const rowIds = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
  screen.tree.root
    .findAll(
      (node) =>
        typeof node.props.testID === 'string' &&
        /^columns\.column:[^.]+$/.test(node.props.testID) &&
        typeof node.type !== 'string',
    )
    .map((node) => node.props.testID.slice('columns.column:'.length))
    .filter((id, index, all) => all.indexOf(id) === index);

const row = (screen: Awaited<ReturnType<typeof renderScreen>>, id: string) =>
  screen.tree.root.findAll(
    (node) =>
      node.props.testID === `columns.column:${id}` &&
      typeof node.props.onPress === 'function',
  )[0];

describe('CollectionColumnsMenuView', () => {
  it('lists the primary column first and fixed, then the shown columns in table order, then hidden ones by source; Reset is quiet at the default', async () => {
    const writes: NavigationPlacementPreferences[] = [];
    const screen = await renderScreen(<Harness writes={writes} />);
    expect(rowIds(screen)).toEqual([
      'title',
      'lastDeploy',
      'runsOn',
      'state',
      'requests',
    ]);
    const reset = screen.tree.root.findAll(
      (node) =>
        node.props.testID === 'columns.reset' && 'disabled' in node.props,
    )[0];
    expect(reset?.props.disabled).toBe(true);
    // The fixed primary row offers nothing to press.
    expect(row(screen, 'title')).toBeUndefined();
  });

  it('shows a hidden column and hides a built-in through one write each, then Reset returns the default', async () => {
    const writes: NavigationPlacementPreferences[] = [];
    const screen = await renderScreen(<Harness writes={writes} />);
    await act(async () => {
      row(screen, 'requests')!.props.onPress();
    });
    await act(async () => {
      row(screen, 'runsOn')!.props.onPress();
    });
    expect(writes).toHaveLength(2);
    expect(rowIds(screen)).toEqual([
      'title',
      'lastDeploy',
      'requests',
      'state',
      'runsOn',
    ]);
    const reset = screen.tree.root.findAll(
      (node) =>
        node.props.testID === 'columns.reset' &&
        typeof node.props.onPress === 'function',
    )[0]!;
    expect(reset.props.disabled).not.toBe(true);
    await act(async () => {
      reset.props.onPress();
    });
    expect(writes.at(-1)).toEqual(EMPTY_NAVIGATION_PLACEMENT_PREFERENCES);
    expect(rowIds(screen)).toEqual([
      'title',
      'lastDeploy',
      'runsOn',
      'state',
      'requests',
    ]);
  });

  it('says a shown column the width cannot hold is hidden for want of room, and keeps it checked', async () => {
    const screen = await renderScreen(
      <Harness writes={[]} fittedIds={['lastDeploy', 'state']} />,
    );
    const runsOn = row(screen, 'runsOn')!;
    expect(JSON.stringify(screen.tree.toJSON())).toContain(
      'collectionColumns.tooNarrow',
    );
    expect(
      runsOn.props.accessibilityChecked ??
        runsOn.props.accessibilityState?.checked ??
        runsOn.props['aria-checked'],
    ).toBe(true);
  });

    it('keeps a contributed column qualifier beside its short title', () => {
        const columns = collectionColumnsMenuColumns({ id: 'title', title: 'Environment' }, [
            { key: 'telemetry.requests', title: 'Requests', description: '24 h', source: 'Telemetry', defaultHidden: true },
        ]);
        expect(columns[1]).toEqual({ id: 'telemetry.requests', title: 'Requests', description: '24 h', source: 'Telemetry', defaultHidden: true });
    });
});

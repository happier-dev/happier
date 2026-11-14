import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';
import { createDeploymentReadControllerV1, type DeploymentReadTransportV1 } from '@happier-dev/deployments';
import { act, renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
afterEach(standardCleanup);

const { DeploymentEnvironmentCollection, DeploymentEnvironmentChooser, useDeploymentEnvironmentRowParts } = await import('./DeploymentEnvironmentCollection');
const { AllDeploymentsView } = await import('./AllDeploymentsScreen');
const { CollectionNavigationRow } = await import('@/components/ui/lists/collection/CollectionList');
const { Item } = await import('@/components/ui/lists/Item');

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];
type RowParts = ReturnType<typeof useDeploymentEnvironmentRowParts>[number];
const fixture = (count: number): EnvironmentItem[] => Array.from({ length: count }, (_, index) => ({
  environment: createDeploymentEnvironmentHeaderV1({ id: `environment-${index}`, updatedAtMs: 1000 }),
  title: `Environment ${index}`,
  projectSourceName: 'Storefront',
  currentDeployment: index % 3 === 2
    ? { ...createDeploymentReceiptHeaderV1({ state: 'running' }), steps: [{ id: 'build', label: 'Build', state: 'running' as const }] }
    : index % 2 ? createDeploymentReceiptHeaderV1({ state: 'failed' }) : null,
}));

it('E500: two unrelated arrivals and thirteen receipt batches render zero unaffected rows; a changed row renders once', async () => {
  let items = fixture(500);
  let publish: (next: EnvironmentItem[]) => void = () => {};
  const renders = new Map<string, number>();
  const Consumer = React.memo(function Consumer({ row }: { row: RowParts }) {
    renders.set(row.environmentId, (renders.get(row.environmentId) ?? 0) + 1);
    return <Item testID={`row.${row.environmentId}`} title={row.title} subtitleLeading={row.subtitleLeading} mode="info" />;
  });
  function Producer() {
    const [value, setValue] = React.useState(items);
    publish = setValue;
    const rows = useDeploymentEnvironmentRowParts(value, 'identity');
    return <>{rows.map(row => <Consumer key={row.environmentId} row={row} />)}</>;
  }
  const screen = await renderScreen(<Producer />);
  renders.clear();
  for (let arrival = 0; arrival < 2; arrival++) {
    await act(async () => publish(items.map(item => ({ ...item }))));
  }
  expect([...renders.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
  for (let receipt = 0; receipt < 13; receipt++) {
    items = items.map((item, index) => index === 0 ? { ...item, title: `Release ${receipt}` } : { ...item });
    await act(async () => publish(items));
  }
  expect(renders.get('environment-0')).toBe(13);
  expect([...renders].filter(([id]) => id !== 'environment-0')).toEqual([]);
  expect(screen.getTextContent()).toContain('Release 12');
  items = items.map((item, index) => index === 2
    ? { ...item, currentDeployment: createDeploymentReceiptHeaderV1({ state: 'failed' }) } : item);
  await act(async () => publish(items));
  expect(renders.get('environment-2')).toBe(1);
  expect([...renders].filter(([id]) => id !== 'environment-0' && id !== 'environment-2')).toEqual([]);
});

it('navigation producers keep row callbacks, glyphs and icons stable across sibling changes', async () => {
  let items = fixture(8);
  let publish: (next: EnvironmentItem[]) => void = () => {};
  const select = vi.fn();
  const refresh = async () => {};
  const previousPage = () => {};
  const nextPage = () => {};
  function Fixture() {
    const [value, setValue] = React.useState(items);
    publish = setValue;
    const read = { snapshot: { status: 'ready' as const, value: { items: value.map(item => ({ ...item, chip: null })), hasNextPage: false, hasPreviousPage: false }, failure: null },
      refresh, hasNextPage: false, hasPreviousPage: false, previousPage, nextPage };
    return <>
      <DeploymentEnvironmentCollection items={value} selectedId={null} stale={null} onSelect={select} drafting={false} onAdd={null} />
      <AllDeploymentsView read={read} serverId="home" />
    </>;
  }
  const screen = await renderScreen(<Fixture />);
  const navigation = () => screen.findAllByType(CollectionNavigationRow).map(node => node.props);
  // Services → Apps draws the same rows through the shared Collection, whose own row identity contract covers them.
  const before = [navigation()];
  items = items.map((item, index) => index === 0 ? { ...item, title: 'New release' } : { ...item });
  await act(async () => publish(items));
  expect(screen.getTextContent()).toContain('New release');
  for (const [surface, rows] of [navigation()].entries()) {
    expect(rows[0].title).toBe('New release');
    for (let index = 1; index < rows.length; index++) {
      expect(rows[index].onPress).toBe(before[surface][index].onPress);
      expect(rows[index].icon).toBe(before[surface][index].icon);
      expect(rows[index].subtitleLeading).toBe(before[surface][index].subtitleLeading);
    }
  }
  await screen.pressByTestIdAsync('project-deployments.rail.row.environment-1');
  expect(select).toHaveBeenCalledWith('environment-1');
});

it('chooser receipt updates retain sibling callbacks and select the changed current item', async () => {
  let items = fixture(8);
  const unavailable = async () => ({ ok: false as const, failure: { code: 'deployment_unavailable', retryable: true } });
  const transport: DeploymentReadTransportV1 = {
    listEnvironments: async () => ({ ok: true, value: { items, nextCursor: null } }),
    readEnvironment: unavailable, listHistory: unavailable, readReceipt: unavailable,
  };
  const controller = createDeploymentReadControllerV1({ scope: { serverId: 'home', accountId: 'account-owner' }, transport });
  const select = vi.fn();
  const screen = await renderScreen(<DeploymentEnvironmentChooser controller={controller} testID="chooser" title="Destination"
    eligible={() => true} selectedId={null} onSelect={select} disabled={false}
    loadFailedTitle="Unavailable" emptyTitle="Empty" emptyBody="No environments" />);
  await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.findByTestId('chooser:environment-0'), node => node !== null); });
  const before = screen.findAllByType(Item).filter(node => node.props.testID?.startsWith('chooser:')).map(node => node.props);
  const lease = controller.acquireCollection({}, { mounted: true, visible: true, focused: true });
  for (let batch = 0; batch < 13; batch++) {
    items = items.map((item, index) => index === 0 ? { ...item, title: `Release ${batch}` } : item);
    await act(async () => lease.refresh());
  }
  const after = screen.findAllByType(Item).filter(node => node.props.testID?.startsWith('chooser:')).map(node => node.props);
  expect(after[0].title).toBe('Release 12');
  for (let index = 1; index < after.length; index++) expect(after[index].onPress).toBe(before[index].onPress);
  // A revision-only change must replace the selected operand even though the rendered title is unchanged.
  items = items.map((item, index) => index === 0 ? { ...item, environment: { ...item.environment, revision: 2 } } : item);
  await act(async () => lease.refresh());
  await screen.pressByTestIdAsync('chooser:environment-0');
  expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Release 12', environment: expect.objectContaining({ revision: 2 }) }));
  lease.release();
  controller.retire();
});

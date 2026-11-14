import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { storage } = await import('@/sync/domains/state/storage');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { DeploymentMachinesEmpty } = await import('./DeploymentMachinesEmpty');

afterEach(async () => { await standardCleanup(); });

// The sync owner publishes the Machine list and its read state; deploy surfaces consume both.
function publish(status: 'loading' | 'idle' | 'error' | 'signedOut', machines: readonly unknown[] | null) {
  storage.setState(state => ({
    machineListByServerId: { ...state.machineListByServerId, 'server-a': machines as never },
    machineListStatusByServerId: { ...state.machineListStatusByServerId, 'server-a': status },
  }));
}

describe('a deploy surface with no Machine to offer', () => {
  it.each([
    ['still reading', 'loading', null, 'loading'],
    ['the read failed', 'error', null, 'unavailable'],
    ['signed out of the Home', 'signedOut', null, 'unavailable'],
    ['truly no Machines', 'idle', [], 'empty'],
  ] as const)('says what it knows when %s', async (_name, status, machines, kind) => {
    publish(status, machines);
    const screen = await renderScreen(<DeploymentMachinesEmpty serverId="server-a" testID="project-deployments.link"
      empty={<SurfaceStateCard testID="project-deployments.link.noMachine" size="line" kind="empty" title="No Machine" />} />);
    const card = screen.findAllByType(SurfaceStateCard)[0];
    expect(card?.props.kind).toBe(kind);
    // A failed read offers its way forward; retrying is the Machine list owner's refresh.
    if (kind === 'unavailable') expect(card?.props.action?.label).toBeTruthy();
    await screen.unmount();
  });
});

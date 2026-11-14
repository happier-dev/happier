import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DeploymentDataCard } = await import('./DeploymentDataCard');
const { Item } = await import('@/components/ui/lists/Item');
afterEach(async () => { standardCleanup(); await homes.reset(); });

/** The read projection the card receives: an opened detail without a linked runtime or retained receipts. */
function readDetail(overrides: Parameters<typeof createDeploymentEnvironmentDetailV1>[0]) {
  return { ...createDeploymentEnvironmentDetailV1(overrides), runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
}

it('presents the provider-produced database engine after association and keeps legacy links recognizable', async () => {
  const serverId = await homes.addHome({ name: 'Database console', serverUrl: 'https://database-console.test', accountId: 'owner', currentAccount: true });
  const scope = { serverId, accountId: 'owner' };
  const provider = { data: { engine: 'postgres', version: '17',
    providerConsole: { url: 'https://console.example.test/project', label: 'Open console' } } };
  const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'database', role: 'data', targetKind: 'example-database', machines: [], members: [], source: { kind: 'plugin', contribution: { pluginId: 'com.example.database', localId: 'database' } } });
  const detail = readDetail({ targetLinks: [{ targetLink, content: provider }] });
  const screen = await renderScreen(<DeploymentDataCard scope={scope} detail={detail} onAdd={() => {}} onBackups={() => {}} />);
  try {
    expect(screen.findAllByType(Item).some(row => row.props.title === 'PostgreSQL 17')).toBe(true);
    const providerConsole = screen.findByTestId('project-deployments.environment.data.providerConsole.database');
    expect(providerConsole).not.toBeNull();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    try {
      await homes.setActionPolicy(serverId, 'links.openExternal', 'ui', 'off');
      await act(async () => { await providerConsole!.props.onPress(); });
      expect(open).not.toHaveBeenCalled();
      await homes.setActionPolicy(serverId, 'links.openExternal', 'ui', 'allowed');
      await act(async () => { await providerConsole!.props.onPress(); });
      expect(open.mock.calls.map(call => call[0])).toEqual(['https://console.example.test/project']);
    } finally { vi.unstubAllGlobals(); }
    await act(async () => screen.update(<DeploymentDataCard scope={scope} detail={readDetail({ targetLinks: [{ targetLink,
      content: { ...provider, data: { engine: 'postgres', version: '17' } } }] })} onAdd={() => {}} onBackups={() => {}} />));
    expect(screen.findAllByType(Item).some(row => row.props.title === 'PostgreSQL 17')).toBe(true);
    expect(screen.findByTestId('project-deployments.environment.data.providerConsole.database')).toBeNull();
    await act(async () => screen.update(<DeploymentDataCard scope={scope} detail={readDetail({ targetLinks: [{ targetLink, content: { ...provider, data: undefined } }] })}
      onAdd={() => {}} onBackups={() => {}} />));
    expect(screen.findAllByType(Item).some(row => row.props.title === 'example-database')).toBe(true);
  } finally { await screen.unmount(); }
});

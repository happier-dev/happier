import { expect, it, vi } from 'vitest';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarationProjection';
import { createServiceColumnSource } from '../../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/list-extension-source';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { normalizePluginInstalledUiDeclarations } from '@/sync/domains/plugins/ui/projection';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const { deploymentEnvironmentColumns } = await import('./deploymentEnvironmentColumns');

it('Services admits public service columns under qualified field identity without acquiring their Resource', () => {
  let reads = 0;
  const source = createServiceColumnSource(() => reads++);
  const projection = normalizePluginInstalledUiDeclarations(projectPluginPortableUiDeclarationsV1(PluginManifestV2Schema.parse(source.manifest)));
  const columns = deploymentEnvironmentColumns(false, projection);
  expect(columns.map(column => column.key)).toEqual(['lastDeploy', 'runsOn', 'state', 'com.acme.requests/requests']);
  expect(columns.at(-1)).toMatchObject({ title: 'Requests', minWidth: 112, align: 'end', priority: 20, defaultHidden: true });
  expect(deploymentEnvironmentColumns(false, normalizePluginInstalledUiDeclarations({})).map(column => column.key))
    .toEqual(['lastDeploy', 'runsOn', 'state']);
  expect(reads).toBe(0);
});

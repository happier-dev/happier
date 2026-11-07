import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, expect, it, onTestFinished, vi } from 'vitest';
import * as React from 'react';
import 'fake-indexeddb/auto';
import { reloadConfiguration } from '@/configuration';
import { createCliRegistryHostV1 } from './createCliRegistryHost';
import { createPluginCompatibilityProjectionV1 } from '@happier-dev/protocol/plugins/availability/compatibilityProjectionV1';
import { createMarketplaceNpmDiscoveryProjectionV1 } from '@happier-dev/protocol/marketplace';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { BotTemplatePreviewInputV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { installVitestRnShim } from '../../../ui/sources/dev/vitestRnShim';
import { installLocalStorageMock } from '../../../ui/sources/auth/storage/tokenStorage.web.testHelpers';
import { BotTemplateReleaseV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import type { RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';

import { createNpmPluginDistributionIdentity, createPluginTrustRecord } from '@/plugins/store/install/trustIdentity';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readPluginRegistryCommitRecord, replacePluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import { persistInstallationStateRevision, readInstallationStateRevision } from '@/plugins/store/registry/generationStore';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const source = { id: 'templates', title: 'Templates', format: 'happier-npm', kinds: ['plugin'],
  url: 'https://registry.example.test', enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true } satisfies RegistrySourceDescriptorV1;
const pointer = { sourceId: source.id, itemId: '@acme/garden', version: '1.0.0' };
const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;

async function installedTemplate() {
  const home = await mkdtemp(join(tmpdir(), 'happier-installed-template-preview-')); roots.push(home);
  const pluginRoot = join(home, 'source');
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await mkdir(join(pluginRoot, 'templates'));
  const release = BotTemplateReleaseV1Schema.parse({ v: 1, version: '2.0.0', releasedAtMs: 1, changelog: 'Garden update',
    content: { v: 1, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Use native plants.' },
      memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } });
  const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({ id: 'acme.garden', version: '1.0.0',
    contributes: { botTemplates: [{ id: 'garden', path: './templates/garden.json' }] } }));
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestDigest = `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`;
  await writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), manifestBytes);
  await writeFile(join(pluginRoot, 'daemon.mjs'), 'throw new Error("must-never-activate")');
  await writeFile(join(pluginRoot, 'templates/garden.json'), JSON.stringify(release));
  const distribution = createNpmPluginDistributionIdentity({ registryOrigin: source.url, packageName: pointer.itemId });
  await writeCommittedLocalPathPluginFixture({ happyHomeDir: home, pluginId: manifest.id, sourceRootPath: pluginRoot,
    plugin: {
      source: { kind: 'package', locator: pointer.itemId, resolvedVersion: pointer.version, trustPolicy: 'prompt',
        installPolicy: 'managed_install', resolvedPath: pluginRoot, manifestPath: join(pluginRoot, '.happier-plugin/plugin.json') },
      compatibility: { status: 'compatible', diagnostics: [] },
      install: { mode: 'managed_install', manifestVersion: manifest.version,
        trust: createPluginTrustRecord({ pluginId: manifest.id, distribution, approvedAtMs: 0 }) },
      state: { enabled: false },
    } });
  const paths = resolvePluginStorePaths({ happyHomeDir: home });
  const commit = await readPluginRegistryCommitRecord(paths);
  if (!commit) throw new Error('Fixture has no committed installation');
  const revision = await readInstallationStateRevision({ paths, reference: commit.installationState });
  const installationState = await persistInstallationStateRevision({ paths, state: { ...revision, revisionId: `state-${randomUUID()}`,
    plugins: { ...revision.plugins, [manifest.id]: { ...revision.plugins[manifest.id]!, source: { distribution, admittedIntegrity: integrity } } } } });
  await replacePluginRegistryCommitRecord({ paths, expectedCurrent: commit, next: { ...commit, revision: commit.revision + 1,
    baseRevision: commit.revision, transactionId: `fixture-${randomUUID()}`, installationState } });
  return { home, manifest, manifestDigest };
}

vi.mock('../../../ui/sources/text', async () => (await import('../../../ui/sources/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('../../../ui/sources/modal', async () => (await import('../../../ui/sources/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('../../../ui/sources/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('../../../ui/sources/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('../../../ui/sources/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('../../../ui/sources/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('@react-navigation/native', async () => (await import('../../../ui/sources/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@shopify/react-native-skia', async () => (await import('../../../ui/sources/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('expo-updates', async () => (await import('../../../ui/sources/dev/testkit/mocks/expoUpdates')).createExpoUpdatesMock());
vi.mock('expo-file-system', async () => (await import('../../../ui/sources/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
vi.mock('react-native-typography', async () => (await import('../../../ui/sources/dev/testkit/mocks/reactNativeTypography')).createReactNativeTypographyMock());
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
vi.stubGlobal('__DEV__', true);
vi.stubGlobal('self', globalThis);
installVitestRnShim();
const browserStorage = installLocalStorageMock();
afterAll(() => browserStorage.restore());
const { createPlainArtifactHomeFixture } = await import('../../../ui/sources/dev/testkit/harness/artifactStoreBoundary');
const { createPromptLibraryCatalogBoundary } = await import('../../../ui/sources/dev/testkit/harness/promptLibraryCatalogBoundary');
const { setServerProfileIdentityForUrl } = await import('../../../ui/sources/sync/domains/server/serverProfiles');
const { renderScreen } = await import('../../../ui/sources/dev/testkit/render/renderScreen');
const { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } = await import('../../../ui/sources/dev/testkit/fixtures/machineFixtures');
const { InjectedAuthProvider } = await import('../../../ui/sources/auth/context/AuthContext');
const { TokenStorage } = await import('../../../ui/sources/auth/storage/tokenStorage');
const { storage } = await import('../../../ui/sources/sync/domains/state/storage');
const { captureLazyActionAccountContext } = await import('../../../ui/sources/sync/ops/actions/actionAccountContext');
const { BotTemplateRecipientScreen } = await import('../../../ui/sources/components/sessions/bots/templates/BotTemplateRecipientScreen');

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadConfiguration(); });

it('acquires an installed plugin template for Store preview and offers unavailable / Retry when acquisition fails', async () => {
  const fixture = await installedTemplate();
  vi.stubEnv('HAPPIER_HOME_DIR', fixture.home);
  reloadConfiguration();
  const host = createCliRegistryHostV1({ readSources: async () => [source] });
  const templateSource = { kind: 'plugin' as const, registryItem: pointer, contributionId: 'garden' };
  const machine = createMachineFixture({ id: 'garden-carrier', activeAt: Date.now() });
  const machineRow = createPlainMachineRowFixture({ id: machine.id, accountId: 'artifact-account', machine });
  const { origin: _origin, removable: _removable, ...storedSource } = source;
  const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources',
    value: { v: 2, sources: [storedSource], disabledSourceIds: [] } }] });
  // The HTTP boundary stands in for Home and daemon transport; both template readers remain real.
  const home = await createPlainArtifactHomeFixture('https://installed-template-preview.test', { currentAccount: true,
    handleRequest: async (path, init) => {
      const catalogResponse = await catalog.handle(path, init);
      if (catalogResponse) return catalogResponse;
      if (path === '/v1/machines') return Response.json([machineRow]);
      if (path === '/v1/machines/garden-carrier') return Response.json({ machine: machineRow });
      if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, id => id === machine.id ? machineRow : null);
      if (path !== '/v1/actions/template.preview') return null;
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
      const input = BotTemplatePreviewInputV1Schema.parse(envelope.input);
      if (input.source.kind !== 'plugin') throw new Error('Expected plugin template');
      try {
        const result = await host.readBotTemplate(input.source.registryItem, input.source.contributionId);
        return Response.json({ v: 1, actionId: 'template.preview', requestId: envelope.requestId, execution: { ok: true, result } });
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error)) throw error;
        expect(error.code).toBe('unreachable');
        return Response.json({ v: 1, actionId: 'template.preview', requestId: envelope.requestId,
          execution: { ok: false, errorCode: error.code, error: 'Acquisition unavailable' } });
      }
    } });
  onTestFinished(() => home.dispose());
  const homeFetch = globalThis.fetch;
  let acquisitions = 0;
  const compatibility = createPluginCompatibilityProjectionV1({ manifest: fixture.manifest, uiArtifacts: { version: 2, entries: [] } });
  const discovery = createMarketplaceNpmDiscoveryProjectionV1({ compatibility, manifestDigest: fixture.manifestDigest });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    if (target.origin !== source.url) return homeFetch(url, init);
    if (target.pathname.endsWith('.tgz')) { acquisitions++; return new Response(null, { status: 503 }); }
    return Response.json({ name: pointer.itemId, versions: { [pointer.version]: { name: pointer.itemId, version: pointer.version,
      _npmUser: { name: 'acme' }, dist: { integrity, tarball: `${source.url}/garden.tgz` },
      happier: { compatibilityProjection: compatibility, marketplaceDiscovery: discovery } } } });
  }));
  // Approved X1 glitch: installed bytes cannot satisfy an unavailable acquisition.
  await expect(host.readBotTemplate(pointer, 'garden')).rejects.toMatchObject({ code: 'unreachable' });
  expect(acquisitions).toBe(1);
  await setServerProfileIdentityForUrl(home.home.serverUrl, 'srv_installed_template');
  const account = await captureLazyActionAccountContext(home.home.id);
  onTestFinished(() => account.dispose());
  const scope = { serverId: account.serverId, accountId: account.accountId };
  await storage.getState().activateSettingsScope(scope);
  storage.getState().applySettingsForScope(scope, storage.getState().settings, 1);
  const admittedMachine = { ...machine, kind: 'persistent' as const, revokedAt: null, replacedByMachineId: null,
    installationId: machineRow.installationId, access: machineRow.access };
  storage.setState({ profileScope: scope, machines: { [machine.id]: admittedMachine },
    machineListByServerId: { ...storage.getState().machineListByServerId, [account.serverId]: [admittedMachine] },
    machineListStatusByServerId: { ...storage.getState().machineListStatusByServerId, [account.serverId]: 'idle' } });
  const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
  const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
    <BotTemplateRecipientScreen source={templateSource} serverId={home.home.id} />
  </InjectedAuthProvider>);
  onTestFinished(() => screen.unmount());
  await vi.waitFor(() => expect(screen.getTextContent()).toContain('botTemplates.unavailable'));
  expect(acquisitions, JSON.stringify(home.requests)).toBe(2);
  expect(screen.getTextContent()).toContain('common.retry');
  const beforeRetry = acquisitions;
  await screen.pressByTestIdAsync('bot-template-recipient-load-action');
  await vi.waitFor(() => expect(acquisitions).toBe(beforeRetry + 1));
});

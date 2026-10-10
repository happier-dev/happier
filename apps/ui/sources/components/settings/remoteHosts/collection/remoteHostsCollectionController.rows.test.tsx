import * as React from 'react';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { createDeferred, createExpoRouterMock, createModalModuleMock, createPlainAccountEncryptionCurrentnessFixture, renderHook, renderScreen, renderInCollectionLayout, standardCleanup } from '@/dev/testkit';
import type { IModal } from '@/modal';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { RemoteHostCatalogRowMutationV1Schema, type RemoteHostCatalogRowReadResponseV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
let currentPathname = '/';
const navigationBoundary = createExpoRouterMock({ pathname: () => currentPathname });
vi.doMock('expo-router', () => navigationBoundary.module);
const modalBoundary = createModalModuleMock();
vi.doMock('@/modal', () => modalBoundary.module);
let nativeStorage: typeof import('react-native-mmkv');
let disposeNativeStorage: (() => void) | undefined;
beforeAll(async () => {
  // Metro's call-time require must use the same genuine native boundary as Vitest imports.
  const native = await loadVitestModuleForNodeRequire(pathToFileURL(createRequire(import.meta.url).resolve('react-native-mmkv')),
    () => import('react-native-mmkv'));
  nativeStorage = native.module;
  disposeNativeStorage = native.dispose;
});
afterAll(() => { disposeNativeStorage?.(); });

// Install boundaries before importing real owners. The temporary source diagnostic
// established this collection order; concurrent root imports did not settle.
// Cold module evaluation is not a user's catalog operation.
await import('@/sync/domains/state/storageStore');
await import('@/sync/store/hooks');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { storage } = await import('@/sync/domains/state/storage');
const { applyRemoteHostCatalogSnapshot, getRemoteHostCatalogSnapshot, resetRemoteHostCatalogSnapshotsForTests } = await import('@/sync/store/settings/remoteHostCatalogSnapshot');
const { getRemoteHostLocalOverrides, upsertRemoteHostLocalOverrides, deleteRemoteHostLocalOverrides } = await import('@/sync/domains/remoteHosts/remoteHostLocalOverrides');
const { getDefaultSystemTaskRunner } = await import('@/components/systemTasks');
const { useRemoteHostsCollectionController, RemoteHostsCollectionProvider } = await import('./remoteHostsCollectionController');
const { RemoteHostPage } = await import('./RemoteHostPage');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { RemoteHostsCollectionList, RemoteHostsSettingsIndex } = await import('./RemoteHostsCollection');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { refreshRemoteHostCatalog, resetRemoteHostCatalogEngineForTests } = await import('@/sync/engine/settings/remoteHostCatalogEngine');
const { SharedSavedSecretCreateInputV1Schema } = await import('@happier-dev/protocol/account/settings/savedSecretResourceActionsV1');
const { SavedSecretResourceMaterialV1Schema } = await import('@happier-dev/protocol/account/settings/savedSecretCatalogV1');
const { formatSharedSavedSecretRefV1 } = await import('@happier-dev/protocol/account/settings/savedSecretReferenceV1');
const { t } = await import('@/text');

afterEach(async () => {
  await standardCleanup();
  publishAppliedActiveServerRuntimeAvailability(false);
  currentPathname = '/';
  await home.reset();
});

it('admits collection menus and device-local edits when the complete destination has only history cleanup pending', async () => {
  const serverId = await home.addHome({ name: 'Captured', serverUrl: 'https://remote-host-controller.test', accountId: 'account' });
  const scope = { serverId, accountId: 'account' };
  const host = { id: 'row-host', name: 'Row host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
    ssh: { target: 'dev@private.example', authMode: 'agent' as const } };
  resetRemoteHostCatalogSnapshotsForTests();
  storage.setState({ profileScope: scope });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
  applyRemoteHostCatalogSnapshot(scope, { status: 'ready', revision: 4, hosts: [host], diagnostics: [] }, true);
  home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {} } } });
  home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
  home.answer(serverId, '/v2/account/settings/history', { status: 503, body: {} });
  home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
  home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: {
    status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, hosts: [host] } },
  } });
  const hook = await renderHook(() => useRemoteHostsCollectionController({ availability: 'available',
    runner: getDefaultSystemTaskRunner(), secretMaterialAllowed: false, remoteSshMachineSetupAllowed: false,
    nativeSshTransportAllowed: false, supportsWholeRowPress: false }));
  expect(hook.getCurrent().hosts.map(host => host.id)).toEqual(['row-host']);
  expect(hook.getCurrent().remoteHosts).toEqual([host]);
  await act(async () => { await refreshRemoteHostCatalog(scope); });
  await vi.waitFor(() => { expect(getRemoteHostCatalogSnapshot(scope)?.catalog).toMatchObject({ status: 'ready', cleanup: 'pending' }); });
  expect(hook.getCurrent().canMutate).toBe(true);
  expect(hook.getCurrent().buildHostActions(host).length).toBeGreaterThan(0);
  expect(await hook.getCurrent().saveHost({ remoteHost: host, accountDirty: false, localOverrides: { identityFilePath: '/device/key' } }))
    .toMatchObject({ ok: true, revision: 4, localOverrides: 'saved' });
  deleteRemoteHostLocalOverrides(host.id);
  await hook.unmount();
  resetRemoteHostCatalogSnapshotsForTests();
});

it('keeps a new-host editor on its draft until the Account acknowledges Save', async () => {
  navigationBoundary.spies.replace.mockClear();
  const serverId = await home.addHome({ name: 'Draft Home', serverUrl: 'https://remote-host-draft.test', accountId: 'account' });
  const scope = { serverId, accountId: 'account' };
  const settings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'remote_hosts.save': ['ui'] } } };
  resetRemoteHostCatalogSnapshotsForTests();
  storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse(settings) });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
  applyRemoteHostCatalogSnapshot(scope, { status: 'ready', revision: 4, hosts: [], diagnostics: [] }, true);
  home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: settings } } });
  home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
  home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
  home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
  let row: RemoteHostCatalogRowReadResponseV1 = {
    status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, hosts: [] } },
  };
  home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { select: () => ({ body: row }) });
  const acknowledgement = createDeferred<void>();
  home.answer(serverId, 'POST /v1/account/entity-rows/remote-hosts', { select: async input => {
    if (!input || typeof input !== 'object' || !('mutation' in input)) throw new Error('invalid_host_mutation');
    const mutation = RemoteHostCatalogRowMutationV1Schema.parse(input.mutation);
    await acknowledgement.promise;
    row = { status: 'present', revision: 5, content: mutation.content };
    return { body: { status: 'updated', revision: 5, cursor: 1 } };
  } });
  function DraftPage() {
    const controller = useRemoteHostsCollectionController({ availability: 'available', runner: getDefaultSystemTaskRunner(),
      secretMaterialAllowed: false, remoteSshMachineSetupAllowed: false, nativeSshTransportAllowed: false, supportsWholeRowPress: false });
    return <RemoteHostsCollectionProvider value={controller}><RemoteHostPage hostId={null} /></RemoteHostsCollectionProvider>;
  }
  const screen = await renderScreen(<DraftPage />);
  try {
    await act(async () => {
      screen.changeTextByTestId('remote-host-form-name', 'New host');
      screen.changeTextByTestId('remote-host-form-ssh-sshHostInput', 'private.example');
      screen.changeTextByTestId('remote-host-form-ssh-sshUsernameInput', 'dev');
    });
    await vi.waitFor(() => { expect(getRemoteHostCatalogSnapshot(scope)?.stale).toBe(false); });
    await act(async () => { screen.pressByTestId('settings.remoteHosts.host.save'); });
    expect(navigationBoundary.spies.replace).not.toHaveBeenCalled();
    acknowledgement.resolve();
    await vi.waitFor(() => { expect(navigationBoundary.spies.replace).toHaveBeenCalled(); });
    expect(getRemoteHostCatalogSnapshot(scope)?.data?.[0]?.name).toBe('New host');
  } finally {
    acknowledgement.resolve();
    await screen.unmount();
    resetRemoteHostCatalogSnapshotsForTests();
  }
});

it('keeps device overrides unchanged until the captured row save is acknowledged', async () => {
  const serverId = await home.addHome({ name: 'Save Home', serverUrl: 'https://remote-host-save.test', accountId: 'account' });
  const scope = { serverId, accountId: 'account' };
  const host = { id: 'ack-host', name: 'Host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
    ssh: { target: 'dev@private.example', authMode: 'agent' as const } };
  resetRemoteHostCatalogSnapshotsForTests();
  deleteRemoteHostLocalOverrides(host.id);
  const settings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'remote_hosts.save': ['ui'] } } };
  storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse(settings) });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
  applyRemoteHostCatalogSnapshot(scope, { status: 'ready', revision: 4, hosts: [host], diagnostics: [] }, true);
  home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: settings } } });
  home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
  home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
  home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
  const acknowledgement = createDeferred<void>();
  let saved = false;
  home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { select: () => ({ body: {
    status: 'present', revision: saved ? 5 : 4,
    content: { t: 'plain', v: { v: 1, hosts: [saved ? { ...host, name: 'Edited' } : host] } },
  } }) });
  home.answer(serverId, 'POST /v1/account/entity-rows/remote-hosts', { select: async () => {
    await acknowledgement.promise;
    saved = true;
    return { body: { status: 'updated', revision: 5, cursor: 1 } };
  } });
  const hook = await renderHook(() => useRemoteHostsCollectionController({ availability: 'available',
    runner: getDefaultSystemTaskRunner(), secretMaterialAllowed: false, remoteSshMachineSetupAllowed: false,
    nativeSshTransportAllowed: false, supportsWholeRowPress: false }));
  await vi.waitFor(() => { expect(getRemoteHostCatalogSnapshot(scope)?.stale).toBe(false); });
  const receipt = hook.getCurrent().saveHost({ remoteHost: { ...host, name: 'Edited' },
    localOverrides: { identityFilePath: '/device/key', sshConfigFilePath: null } });
  try {
    expect(getRemoteHostLocalOverrides(host.id)).toBeNull();
    acknowledgement.resolve();
    expect(await receipt).toMatchObject({ ok: true, revision: 5, localOverrides: 'saved' });
    expect(getRemoteHostLocalOverrides(host.id)?.identityFilePath).toBe('/device/key');
    expect(home.requestsFor('/v1/account/entity-rows/remote-hosts').map(request => request.input)).toContainEqual({
      mutation: { expectedRevision: 4, referencedSavedSecretRevisions: [],
        content: { t: 'plain', v: { v: 1, hosts: [{ ...host, name: 'Edited' }] } } },
    });
  } finally {
    acknowledgement.resolve();
    await receipt;
    await hook.unmount();
    deleteRemoteHostLocalOverrides(host.id);
    resetRemoteHostCatalogSnapshotsForTests();
  }
});

it('keeps the host and its device overrides until the Account acknowledges deletion', async () => {
  const serverId = await home.addHome({ name: 'Delete Home', serverUrl: 'https://remote-host-delete.test', accountId: 'account' });
  const scope = { serverId, accountId: 'account' };
  const host = { id: 'delete-host', name: 'Delete host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
    ssh: { target: 'dev@private.example', authMode: 'agent' as const } };
  const settings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'remote_hosts.delete': ['ui'] } } };
  resetRemoteHostCatalogSnapshotsForTests();
  upsertRemoteHostLocalOverrides(host.id, { identityFilePath: '/device/key' });
  storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse(settings) });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
  applyRemoteHostCatalogSnapshot(scope, { status: 'ready', revision: 4, hosts: [host], diagnostics: [] }, true);
  home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: settings } } });
  home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
  home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
  home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
  const acknowledgement = createDeferred<void>();
  let removed = false;
  home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { select: () => ({ body: {
    status: 'present', revision: removed ? 5 : 4,
    content: { t: 'plain', v: { v: 1, hosts: removed ? [] : [host] } },
  } }) });
  home.answer(serverId, 'POST /v1/account/entity-rows/remote-hosts', { select: async () => {
    await acknowledgement.promise;
    removed = true;
    return { body: { status: 'updated', revision: 5, cursor: 1 } };
  } });
  const hook = await renderHook(() => useRemoteHostsCollectionController({ availability: 'available',
    runner: getDefaultSystemTaskRunner(), secretMaterialAllowed: false, remoteSshMachineSetupAllowed: false,
    nativeSshTransportAllowed: false, supportsWholeRowPress: false }));
  await vi.waitFor(() => { expect(getRemoteHostCatalogSnapshot(scope)?.stale).toBe(false); });
  const receipt = hook.getCurrent().deleteHost(host.id);
  try {
    expect(getRemoteHostLocalOverrides(host.id)?.identityFilePath).toBe('/device/key');
    expect(getRemoteHostCatalogSnapshot(scope)?.data?.map(entry => entry.id)).toEqual([host.id]);
    acknowledgement.resolve();
    expect(await receipt).toBe(true);
    expect(getRemoteHostLocalOverrides(host.id)).toBeNull();
    expect(getRemoteHostCatalogSnapshot(scope)?.data).toEqual([]);
  } finally {
    acknowledgement.resolve();
    await receipt;
    await hook.unmount();
    deleteRemoteHostLocalOverrides(host.id);
    resetRemoteHostCatalogSnapshotsForTests();
  }
});

it.each(['save', 'delete'] as const)('keeps an acknowledged %s successful when device-local override storage fails', async operation => {
  const serverId = await home.addHome({ name: 'Acknowledged Home', serverUrl: `https://remote-host-ack-${operation}.test`, accountId: 'account' });
  const scope = { serverId, accountId: 'account' };
  const host = { id: `local-failure-${operation}`, name: 'Host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
    ssh: { target: 'dev@private.example', authMode: 'agent' as const } };
  const settings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { [`remote_hosts.${operation}`]: ['ui'] } } };
  resetRemoteHostCatalogSnapshotsForTests();
  storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse(settings) });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
  upsertRemoteHostLocalOverrides(host.id, { identityFilePath: '/device/old-key' });
  applyRemoteHostCatalogSnapshot(scope, { status: 'ready', revision: 4, hosts: [host], diagnostics: [] }, true);
  home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: settings } } });
  home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
  home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
  home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
  let row: RemoteHostCatalogRowReadResponseV1 = { status: 'present', revision: 4,
    content: { t: 'plain', v: { v: 1, hosts: [host] } } };
  home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { select: () => ({ body: row }) });
  home.answer(serverId, 'POST /v1/account/entity-rows/remote-hosts', { select: input => {
    if (!input || typeof input !== 'object' || !('mutation' in input)) throw new Error('invalid_host_mutation');
    const mutation = RemoteHostCatalogRowMutationV1Schema.parse(input.mutation);
    row = { status: 'present', revision: 5, content: mutation.content };
    return { body: { status: 'updated', revision: 5, cursor: 1 } };
  } });
  const hook = await renderHook(() => useRemoteHostsCollectionController({ availability: 'available',
    runner: getDefaultSystemTaskRunner(), secretMaterialAllowed: false, remoteSshMachineSetupAllowed: false,
    nativeSshTransportAllowed: false, supportsWholeRowPress: false }));
  await vi.waitFor(() => { expect(getRemoteHostCatalogSnapshot(scope)?.stale).toBe(false); });
  const originalSet = nativeStorage.MMKV.prototype.set;
  const originalDelete = nativeStorage.MMKV.prototype.delete;
  let localWriteFailed = false;
  const nativeWrite = vi.spyOn(nativeStorage.MMKV.prototype, 'set').mockImplementation(function (this: InstanceType<typeof nativeStorage.MMKV>, key, value) {
    if (key.startsWith('remote-host-local-overrides-v1')) {
      localWriteFailed = true;
      throw new Error('Native storage write failed');
    }
    originalSet.call(this, key, value);
  });
  const nativeDelete = vi.spyOn(nativeStorage.MMKV.prototype, 'delete').mockImplementation(function (this: InstanceType<typeof nativeStorage.MMKV>, key) {
    if (key.startsWith('remote-host-local-overrides-v1')) {
      localWriteFailed = true;
      throw new Error('Native storage delete failed');
    }
    originalDelete.call(this, key);
  });
  modalBoundary.spies.alert.mockClear();
  try {
    const receipt = operation === 'save'
      ? hook.getCurrent().saveHost({ remoteHost: { ...host, name: 'Acknowledged edit' }, localOverrides: { identityFilePath: '/device/new-key' } })
      : hook.getCurrent().deleteHost(host.id);
    const outcome = await receipt.then(value => ({ value }), error => ({ error }));
    expect(row).toMatchObject({ status: 'present', revision: 5 });
    expect(home.requestsFor('/v1/account/entity-rows/remote-hosts').filter(request => request.input !== null)).toHaveLength(1);
    expect(localWriteFailed).toBe(true);
    if (operation === 'save') expect(outcome).toEqual({ value: { ok: true, revision: 5,
      host: { ...host, name: 'Acknowledged edit' }, localOverrides: 'pending' } });
    else expect(outcome).toEqual({ value: true });
    expect(modalBoundary.spies.alert).toHaveBeenCalled();
    expect(getRemoteHostCatalogSnapshot(scope)?.catalog).toMatchObject({ status: 'ready', revision: 5 });
  } finally {
    nativeWrite.mockRestore();
    nativeDelete.mockRestore();
    await hook.unmount();
    deleteRemoteHostLocalOverrides(host.id);
    resetRemoteHostCatalogSnapshotsForTests();
  }
});

it('preserves the Page device-path draft after durable Save when native override storage fails', async () => {
  const serverId = await home.addHome({ name: 'Device draft Home', serverUrl: 'https://remote-host-device-draft.test', accountId: 'account' });
  const scope = { serverId, accountId: 'account' };
  const host = { id: 'device-draft-host', name: 'Host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
    ssh: { target: 'dev@private.example', authMode: 'keyfile' as const } };
  const settings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'remote_hosts.save': ['ui'] } } };
  resetRemoteHostCatalogSnapshotsForTests();
  storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse(settings) });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
  upsertRemoteHostLocalOverrides(host.id, { identityFilePath: '/device/old-key' });
  applyRemoteHostCatalogSnapshot(scope, { status: 'ready', revision: 4, hosts: [host], diagnostics: [] }, true);
  home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: settings } } });
  home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
  home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
  home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
  let row: RemoteHostCatalogRowReadResponseV1 = { status: 'present', revision: 4,
    content: { t: 'plain', v: { v: 1, hosts: [host] } } };
  home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { select: () => ({ body: row }) });
  home.answer(serverId, 'POST /v1/account/entity-rows/remote-hosts', { select: input => {
    if (!input || typeof input !== 'object' || !('mutation' in input)) throw new Error('invalid_host_mutation');
    const mutation = RemoteHostCatalogRowMutationV1Schema.parse(input.mutation);
    const revision = row.status === 'present' ? row.revision + 1 : 1;
    row = { status: 'present', revision, content: mutation.content };
    return { body: { status: 'updated', revision, cursor: revision } };
  } });
  function DeviceDraftPage() {
    const controller = useRemoteHostsCollectionController({ availability: 'available', runner: getDefaultSystemTaskRunner(),
      secretMaterialAllowed: false, remoteSshMachineSetupAllowed: false, nativeSshTransportAllowed: false, supportsWholeRowPress: false });
    return <RemoteHostsCollectionProvider value={controller}><RemoteHostPage hostId={host.id} /></RemoteHostsCollectionProvider>;
  }
  const screen = await renderScreen(<DeviceDraftPage />);
  await vi.waitFor(() => { expect(getRemoteHostCatalogSnapshot(scope)?.stale).toBe(false); });
  const originalSet = nativeStorage.MMKV.prototype.set;
  let localWriteFailed = false;
  const nativeWrite = vi.spyOn(nativeStorage.MMKV.prototype, 'set').mockImplementation(function (this: InstanceType<typeof nativeStorage.MMKV>, key, value) {
    if (key.startsWith('remote-host-local-overrides-v1')) {
      localWriteFailed = true;
      throw new Error('Native storage write failed');
    }
    originalSet.call(this, key, value);
  });
  try {
    await act(async () => {
      screen.changeTextByTestId('remote-host-form-name', 'Acknowledged Account edit');
      screen.changeTextByTestId('remote-host-form-ssh-sshIdentityFile', '/device/new-key');
    });
    await act(async () => { screen.pressByTestId('settings.remoteHosts.host.save'); });
    await vi.waitFor(() => { expect(localWriteFailed).toBe(true); });
    expect(row).toMatchObject({ status: 'present', revision: 5 });
    expect(getRemoteHostLocalOverrides(host.id)?.identityFilePath).toBe('/device/old-key');
    await vi.waitFor(() => { expect(getRemoteHostCatalogSnapshot(scope)?.catalog).toMatchObject({ status: 'ready', revision: 5 }); });
    expect(getRemoteHostCatalogSnapshot(scope)?.data?.[0]?.name).toBe('Acknowledged Account edit');
    expect(screen.root.findAll(node => node.props.testID === 'remote-host-form-ssh-sshIdentityFile'
      && node.props.value === '/device/new-key').length).toBeGreaterThan(0);
    // Acknowledging Account fields must not label the unpersisted device draft clean.
    await vi.waitFor(() => { expect(screen.root.findAll(node => node.props.testID === 'settings.remoteHosts.host.save'
      && node.props.disabled === false).length).toBeGreaterThan(0); });
    // A manual retry of only the retained device draft must not repeat the
    // already acknowledged Account mutation.
    nativeWrite.mockRestore();
    const beforeLocalRetry = home.requests.length;
    await act(async () => { screen.pressByTestId('settings.remoteHosts.host.save'); });
    await vi.waitFor(() => { expect(getRemoteHostLocalOverrides(host.id)?.identityFilePath).toBe('/device/new-key'); });
    await vi.waitFor(() => { expect(screen.root.findAll(node => node.props.testID === 'settings.remoteHosts.host.save'
      && node.props.disabled === true).length).toBeGreaterThan(0); });
    expect(home.requestsFor('/v1/account/entity-rows/remote-hosts').filter(request => request.input !== null)).toHaveLength(1);
    // Currentness and the pure destination census may read HTTP. Device-only
    // continuation must not write Settings, history, or any Account resource.
    expect(home.requests.slice(beforeLocalRetry).filter(request => request.input !== null)).toEqual([]);
  } finally {
    nativeWrite.mockRestore();
    await screen.unmount();
    deleteRemoteHostLocalOverrides(host.id);
    resetRemoteHostCatalogSnapshotsForTests();
  }
});

it('retains the new Page host credential identity after an acknowledged Save and a later Account edit', async () => {
  navigationBoundary.spies.replace.mockClear();
  const serverId = await home.addHome({ name: 'Credential draft Home', serverUrl: 'https://remote-host-credential-draft.test',
    accountId: 'account', credentialResourcesEnabled: true });
  const scope = { serverId, accountId: 'account' };
  const settings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'remote_hosts.save': ['ui'] } } };
  resetRemoteHostCatalogSnapshotsForTests();
  storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse(settings) });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
  applyRemoteHostCatalogSnapshot(scope, { status: 'ready', revision: 4, hosts: [], diagnostics: [] }, true);
  home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: settings } } });
  home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
  home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
  home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
  let row: RemoteHostCatalogRowReadResponseV1 = { status: 'present', revision: 4,
    content: { t: 'plain', v: { v: 1, hosts: [] } } };
  const resources: Array<ReturnType<typeof SavedSecretResourceMaterialV1Schema.parse>> = [];
  const createdResourceIds: string[] = [];
  home.answer(serverId, '/v1/account/saved-secrets/resources/materials', { select: () => ({ body: { resources } }) });
  home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { select: () => ({ body: row }) });
  home.answer(serverId, 'POST /v1/account/entity-rows/remote-hosts', { select: input => {
    if (!input || typeof input !== 'object' || !('mutation' in input)) throw new Error('invalid_host_mutation');
    const mutation = RemoteHostCatalogRowMutationV1Schema.parse(input.mutation);
    if ('savedSecretResources' in input) {
      if (!Array.isArray(input.savedSecretResources)) throw new Error('invalid_saved_secret_resources');
      // The HTTP boundary admits the actual canonical sealed resource produced by
      // the editor's captured Account save, then serves that same stored material.
      for (const value of input.savedSecretResources) {
        const resource = SharedSavedSecretCreateInputV1Schema.parse(value);
        createdResourceIds.push(resource.resourceId);
        resources.push(SavedSecretResourceMaterialV1Schema.parse({ resourceId: resource.resourceId,
          encryptionMode: resource.encryptionMode, recipientEnvelope: null, storedContent: resource.storedContent,
          entry: { ref: formatSharedSavedSecretRefV1(resource.resourceId), source: 'shared_resource', relationship: 'owner',
            name: resource.displayName, kind: resource.kind, encryptionMode: resource.encryptionMode,
            ownerAccountId: scope.accountId, revision: 1, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }));
      }
    }
    const revision = row.status === 'present' ? row.revision + 1 : 1;
    row = { status: 'present', revision, content: mutation.content };
    return { body: { status: 'updated', revision, cursor: revision } };
  } });
  function CredentialDraftPage() {
    const controller = useRemoteHostsCollectionController({ availability: 'available', runner: getDefaultSystemTaskRunner(),
      secretMaterialAllowed: true, remoteSshMachineSetupAllowed: false, nativeSshTransportAllowed: false, supportsWholeRowPress: false });
    return <RemoteHostsCollectionProvider value={controller}><RemoteHostPage hostId={null} /></RemoteHostsCollectionProvider>;
  }
  const screen = await renderScreen(<CredentialDraftPage />);
  const originalSet = nativeStorage.MMKV.prototype.set;
  let localWriteFailures = 0;
  const nativeWrite = vi.spyOn(nativeStorage.MMKV.prototype, 'set').mockImplementation(function (this: InstanceType<typeof nativeStorage.MMKV>, key, value) {
    if (key.startsWith('remote-host-local-overrides-v1')) {
      localWriteFailures += 1;
      throw new Error('Native storage write failed');
    }
    originalSet.call(this, key, value);
  });
  let acknowledgedHostId: string | undefined;
  try {
    await vi.waitFor(() => { expect(getRemoteHostCatalogSnapshot(scope)?.stale).toBe(false); });
    await act(async () => {
      screen.changeTextByTestId('remote-host-form-name', 'New credential host');
      screen.changeTextByTestId('remote-host-form-ssh-sshHostInput', 'private.example');
      screen.changeTextByTestId('remote-host-form-ssh-sshUsernameInput', 'dev');
    });
    await screen.pressByTestIdAsync('remote-host-form-ssh-sshAuthKeyfile');
    await act(async () => {
      screen.changeTextByTestId('remote-host-form-ssh-sshIdentityFile', '/device/new-key');
      screen.root.find(node => node.props.title === t('settings.remoteHostsStorePrivateKeyLabel')
        && typeof node.props.onPress === 'function').props.onPress();
    });
    await act(async () => { screen.changeTextByTestId('remote-host-form-private-key', 'private-key-fixture'); });
    await screen.pressByTestIdAsync('settings.remoteHosts.host.save');
    await vi.waitFor(() => { expect(localWriteFailures).toBe(1); });
    await vi.waitFor(() => { expect(getRemoteHostCatalogSnapshot(scope)?.catalog).toMatchObject({ status: 'ready', revision: 5 }); });
    const acknowledged = getRemoteHostCatalogSnapshot(scope)?.data?.[0];
    if (!acknowledged) throw new Error('The first durable host acknowledgement is missing');
    acknowledgedHostId = acknowledged.id;
    expect(resources).toHaveLength(1);
    const [createdResourceId] = createdResourceIds;
    if (!createdResourceId) throw new Error('The atomic SavedSecret creation is missing');
    expect(acknowledged.ssh.identityPrivateKeySecretRef).toBe(formatSharedSavedSecretRefV1(createdResourceId));
    expect(getRemoteHostLocalOverrides(acknowledged.id)).toBeNull();
    expect(navigationBoundary.spies.replace).not.toHaveBeenCalled();
    expect(screen.root.findAll(node => node.props.testID === 'remote-host-form-ssh-sshIdentityFile'
      && node.props.value === '/device/new-key').length).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(screen.root.findAll(node => node.props.testID === 'settings.remoteHosts.host.save'
        && node.props.disabled === false).length).toBeGreaterThan(0);
      expect(screen.root.findAll(node => node.props.testID === 'remote-host-form-private-key'
        && node.props.value === '').length).toBeGreaterThan(0);
    });
    await act(async () => { screen.changeTextByTestId('remote-host-form-name', 'Renamed acknowledged host'); });
    await screen.pressByTestIdAsync('settings.remoteHosts.host.save');
    await vi.waitFor(() => { expect(localWriteFailures).toBe(2); });
    await vi.waitFor(() => { expect(getRemoteHostCatalogSnapshot(scope)?.catalog).toMatchObject({ status: 'ready', revision: 6 }); });
    const edited = getRemoteHostCatalogSnapshot(scope)?.data?.[0];
    expect(edited).toMatchObject({ id: acknowledged.id, createdAt: acknowledged.createdAt, name: 'Renamed acknowledged host',
      ssh: { identityPrivateKeySecretRef: acknowledged.ssh.identityPrivateKeySecretRef } });
    expect(resources).toHaveLength(1);
    expect(getRemoteHostCatalogSnapshot(scope)?.data).toHaveLength(1);
  } finally {
    nativeWrite.mockRestore();
    await screen.unmount();
    if (acknowledgedHostId) deleteRemoteHostLocalOverrides(acknowledgedHostId);
    resetRemoteHostCatalogSnapshotsForTests();
  }
});

it('uses Account Action policy before navigating from add and saved-host affordances', async () => {
  navigationBoundary.spies.push.mockClear();
  navigationBoundary.spies.replace.mockClear();
  const serverId = await home.addHome({ name: 'Navigation Home', serverUrl: 'https://remote-host-navigation.test', accountId: 'account' });
  const scope = { serverId, accountId: 'account' };
  const host = { id: 'navigation-host', name: 'Navigation host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
    ssh: { target: 'dev@private.example', authMode: 'agent' as const } };
  const settings = { actionsSettingsV1: { v: 1, actions: {
    'remote_hosts.add': { enabled: false }, 'remote_hosts.edit': { enabled: false },
  } } };
  currentPathname = '/settings/remote-hosts/navigation-host';
  resetRemoteHostCatalogSnapshotsForTests();
  storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse(settings) });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
  applyRemoteHostCatalogSnapshot(scope, { status: 'ready', revision: 4, hosts: [host], diagnostics: [] }, true);
  home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: settings } } });
  home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
  home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
  home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
  home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
    content: { t: 'plain', v: { v: 1, hosts: [host] } } } });
  function NavigationCollection() {
    const controller = useRemoteHostsCollectionController({ availability: 'available', runner: getDefaultSystemTaskRunner(),
      secretMaterialAllowed: false, remoteSshMachineSetupAllowed: false, nativeSshTransportAllowed: false, supportsWholeRowPress: false });
    return <RemoteHostsCollectionProvider value={controller}><RemoteHostsCollectionList variant="rail" /></RemoteHostsCollectionProvider>;
  }
  const screen = await renderScreen(<NavigationCollection />);
  try {
    await vi.waitFor(() => { expect(getRemoteHostCatalogSnapshot(scope)?.stale).toBe(false); });
    await screen.pressByTestIdAsync('settings.remoteHosts.add');
    expect(navigationBoundary.spies.push).not.toHaveBeenCalled();
    expect(navigationBoundary.spies.replace).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync(`settings.remoteHosts.hostRow.${host.id}`);
    expect(navigationBoundary.spies.push).not.toHaveBeenCalled();
    expect(navigationBoundary.spies.replace).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
    resetRemoteHostCatalogSnapshotsForTests();
  }
});

it('does not land an unavailable or partial catalog as a verified empty collection', async () => {
  const serverId = await home.addHome({ name: 'Unavailable Home', serverUrl: 'https://remote-host-availability.test', accountId: 'account' });
  const scope = { serverId, accountId: 'account' };
  const host = { id: 'available-row', name: 'Available row', createdAt: 1, updatedAt: 2, lastUsedAt: null,
    ssh: { target: 'dev@private.example', authMode: 'agent' as const } };
  resetRemoteHostCatalogEngineForTests();
  resetRemoteHostCatalogSnapshotsForTests();
  storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse({}) });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
  home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {} } } });
  home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
  home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
  home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
  home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { status: 503 });
  await refreshRemoteHostCatalog(scope);
  expect(getRemoteHostCatalogSnapshot(scope)?.catalog.status).toBe('unavailable');
  function LandingCollection() {
    const controller = useRemoteHostsCollectionController({ availability: 'available', runner: getDefaultSystemTaskRunner(),
      secretMaterialAllowed: false, remoteSshMachineSetupAllowed: false, nativeSshTransportAllowed: false, supportsWholeRowPress: false });
    return <RemoteHostsCollectionProvider value={controller}><RemoteHostsSettingsIndex /></RemoteHostsCollectionProvider>;
  }
  const screen = await renderInCollectionLayout(<LandingCollection />, 'split');
  try {
    // Redirect is the genuine Expo SDK boundary installed above, not a mocked
    // collection decision: no navigation intent is valid while rows are unknown.
    expect(screen.root.findAllByType('Redirect')).toHaveLength(0);
    home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
      content: { t: 'plain', v: { v: 1, hosts: [host, { id: 'unreadable-row' }] } } } });
    await act(async () => { await refreshRemoteHostCatalog(scope); });
    expect(getRemoteHostCatalogSnapshot(scope)?.catalog.status).toBe('partial');
    expect(getRemoteHostCatalogSnapshot(scope)?.data?.map(row => row.id)).toEqual([host.id]);
    expect(screen.root.findAllByType('Redirect')).toHaveLength(0);
    home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'absent' } });
    await act(async () => { await refreshRemoteHostCatalog(scope); });
    await vi.waitFor(() => { expect(getRemoteHostCatalogSnapshot(scope)?.stale).toBe(false); });
    expect(getRemoteHostCatalogSnapshot(scope)?.catalog.status).toBe('ready');
    expect(screen.root.findByType('Redirect').props.href).toBe('/settings/remote-hosts/new');
  } finally {
    await screen.unmount();
    resetRemoteHostCatalogEngineForTests();
    resetRemoteHostCatalogSnapshotsForTests();
  }
});

it('refuses finite-Home navigation into another applied Account editor', async () => {
  navigationBoundary.spies.push.mockClear();
  navigationBoundary.spies.replace.mockClear();
  const serverId = await home.addHome({ name: 'Requested Home', serverUrl: 'https://remote-host-requested.test', accountId: 'requested', active: false });
  const appliedId = await home.addHome({ name: 'Editor Home', serverUrl: 'https://remote-host-editor.test', accountId: 'editor' });
  const appliedScope = { serverId: appliedId, accountId: 'editor' };
  const host = { id: 'requested-host', name: 'Requested host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
    ssh: { target: 'dev@private.example', authMode: 'agent' as const } };
  storage.setState({ profileScope: appliedScope, settingsScope: appliedScope, settings: settingsParse({}) });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
  home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {} } } });
  home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
  home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
  home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
  home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
    content: { t: 'plain', v: { v: 1, hosts: [host] } } } });
  const executor = createDefaultActionExecutor();
  const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: 'requested' };
  expect(await executor.execute('remote_hosts.add', {}, context)).toMatchObject({
    ok: true, result: { status: 'unavailable', reason: 'active_home_required' },
  });
  expect(await executor.execute('remote_hosts.edit', { hostId: host.id, expectedRevision: 4 }, context)).toMatchObject({
    ok: true, result: { status: 'unavailable', reason: 'active_home_required' },
  });
  expect(navigationBoundary.spies.push).not.toHaveBeenCalled();
  expect(navigationBoundary.spies.replace).not.toHaveBeenCalled();
});

it('does not navigate a retired Account after its real unsaved-draft decision resolves', async () => {
  navigationBoundary.spies.push.mockClear();
  navigationBoundary.spies.replace.mockClear();
  const serverId = await home.addHome({ name: 'Guarded Home', serverUrl: 'https://remote-host-guarded.test', accountId: 'original' });
  const scope = { serverId, accountId: 'original' };
  resetRemoteHostCatalogSnapshotsForTests();
  storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse({}) });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
  applyRemoteHostCatalogSnapshot(scope, { status: 'ready', revision: 4, hosts: [], diagnostics: [] }, true);
  home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {} } } });
  home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
  home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
  home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
  home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
    content: { t: 'plain', v: { v: 1, hosts: [] } } } });
  const decisionShown = createDeferred<void>();
  let decisionButtons: Parameters<IModal['alert']>[2];
  // The native dialog presentation is a boundary. The Page, dirty editor,
  // canonical guard and its actual discard continuation remain real.
  modalBoundary.spies.alert.mockImplementation((_title, _message, buttons) => {
    if (!buttons?.some(button => button.style === 'destructive')) return;
    decisionButtons = buttons;
    decisionShown.resolve();
  });
  function GuardedDraft() {
    const controller = useRemoteHostsCollectionController({ availability: 'available', runner: getDefaultSystemTaskRunner(),
      secretMaterialAllowed: false, remoteSshMachineSetupAllowed: false, nativeSshTransportAllowed: false, supportsWholeRowPress: false });
    return <RemoteHostsCollectionProvider value={controller}><RemoteHostPage hostId={null} /></RemoteHostsCollectionProvider>;
  }
  const screen = await renderScreen(<GuardedDraft />);
  let settled: ReturnType<ReturnType<typeof createDefaultActionExecutor>['execute']> | undefined;
  try {
    await act(async () => { screen.changeTextByTestId('remote-host-form-name', 'Unsaved host'); });
    settled = createDefaultActionExecutor().execute('remote_hosts.add', {}, {
      surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'original',
    });
    expect(await Promise.race([decisionShown.promise.then(() => true), settled.then(() => false)])).toBe(true);
    expect(navigationBoundary.spies.push).not.toHaveBeenCalled();
    await home.switchAccount(serverId, 'replacement');
    await act(async () => { decisionButtons?.find(button => button.style === 'destructive')?.onPress?.(); });
    expect(await settled).not.toMatchObject({ ok: true, result: { status: 'opened' } });
    expect(navigationBoundary.spies.push).not.toHaveBeenCalled();
    expect(navigationBoundary.spies.replace).not.toHaveBeenCalled();
  } finally {
    decisionButtons?.find(button => button.style === 'destructive')?.onPress?.();
    await settled;
    modalBoundary.spies.alert.mockReset();
    await screen.unmount();
    resetRemoteHostCatalogSnapshotsForTests();
  }
});

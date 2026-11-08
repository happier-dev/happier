import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { getSavedSecretCatalogSnapshot, resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { resetTeamActionClientForTests } from '@/sync/ops/teams/teamActionClient';
import { settingsParse } from '@/sync/domains/settings/settings';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { createSecretSettingsTestHarness } from './secretSettingsTestHarness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const alert = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
// One route for the test and the screen: the file's mock and the settings helper's must not each build their own.
const expoRouterModule = vi.hoisted(() => {
    let module: Promise<unknown> | null = null;
    return () => module ??= import('@/dev/testkit/mocks/router').then(({ createExpoRouterMock }) => createExpoRouterMock().module);
});
vi.mock('expo-router', () => expoRouterModule());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
installSettingsViewCommonModuleMocks({ storage: 'real', router: expoRouterModule,
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true, spies: { alert, confirm } }).module,
});
let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | null = null;

beforeEach(async () => {
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    resetTeamActionClientForTests();
    clearActiveUnsavedChangesGuard();
    alert.mockReset();
    confirm.mockReset();
    confirm.mockResolvedValue(true);
    // A secret's page is the route's `secret`; no test inherits the previous one's.
    const { router } = await import('expo-router');
    router.setParams({ secret: undefined, add: undefined });
    vi.mocked(router.push).mockClear();
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.alert).mockImplementation(alert);
    vi.mocked(Modal.confirm).mockImplementation(confirm);
});
afterEach(async () => {
    standardCleanup();
    clearActiveUnsavedChangesGuard();
    resetSavedSecretCatalogEngineForTests();
    await home?.dispose();
    home = null;
});

it('renames and replaces an imported private resource directly, but confirms deletion once', async () => {
    const secret = { id: 'personal-inline', name: 'Personal key', kind: 'apiKey' as const,
        encryptedValue: { _isSecretValue: true as const, value: 'original-personal-secret' }, createdAt: 1, updatedAt: 1 };
    const settings = settingsParse({ secrets: [secret],
        actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'secrets.shared.promote': ['ui'] },
        }),
    });
    // This fixture supplies Home-stored Plain content before device key setup.
    home = await createSecretSettingsTestHarness({ settings, rawSettings: settings });
    const ref = `happier:shared-secret:v1:${deriveSavedSecretImportResourceIdV1({ accountId: home.scope.accountId,
        source: { kind: 'personal-saved-secret', secretId: secret.id } })}`;
    const screen = await renderSecretPage(ref);
    await vi.waitFor(() => expect(home?.promotions).toHaveLength(1));
    await waitForSecretPage(ref, screen);
    expect(home.persistedSettings.secrets).toEqual([]);
    const settingsWritesBeforeEdit = home.settingsWrites.length;
    confirm.mockClear();

    await screen.pressByTestIdAsync(`saved-secret:${ref}:rename`);
    await act(async () => screen.changeTextByTestId(`saved-secret:${ref}:edit-input`, '  Personal renamed  '));
    expect(home.updates).toEqual([]);
    await screen.pressByTestIdAsync(`saved-secret:${ref}:edit-save`);
    expect(confirm).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(home?.updates).toHaveLength(1));
    await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${ref}:edit-input`)).toBeNull());
    await screen.pressByTestIdAsync(`saved-secret:${ref}:rotate`);
    await act(async () => screen.changeTextByTestId(`saved-secret:${ref}:edit-input`, '  personal replacement\n'));
    await screen.pressByTestIdAsync(`saved-secret:${ref}:edit-save`);
    await vi.waitFor(() => expect(home?.updates).toHaveLength(2));
    const replacement = home.updates[1]!;
    const opened = openSavedSecretResourceStoredContentV1({ resourceId: replacement.resourceId, mode: 'plain', storedContent: replacement.storedContent });
    expect(opened).toMatchObject({ v: 1, name: 'Personal renamed', value: '  personal replacement\n' });
    expect(confirm).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync(`saved-secret:${ref}:delete`);
    await vi.waitFor(() => expect(home?.deletes).toHaveLength(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    // The Action policy asks, and the question names the secret and says what deleting it does.
    expect(confirm.mock.calls[0]?.[0]).toContain('Personal renamed');
    expect(confirm.mock.calls[0]?.[1]).toContain('secretsSettings.deleteNote');
    expect(confirm.mock.calls[0]?.[2]).toMatchObject({ destructive: true });
    expect(home.persistedSettings.secrets).toEqual([]);
    expect(home.settingsWrites).toHaveLength(settingsWritesBeforeEdit);
    expect(alert).not.toHaveBeenCalled();
});

it('retains a refused replacement and saves the same draft on retry', async () => {
    let refuseUpdate = true;
    home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }), handleRequest: async path => {
        if (path !== '/v1/account/saved-secrets/resources/update' || !refuseUpdate) return null;
        refuseUpdate = false;
        return Response.json({ error: 'forbidden' }, { status: 403 });
    } });
    const { entry } = await home.addOwnerResource();
    const screen = await renderSecretPage(entry.ref);
    await waitForSecretPage(entry.ref, screen);
    await screen.pressByTestIdAsync(`saved-secret:${entry.ref}:rotate`);
    await act(async () => screen.changeTextByTestId(`saved-secret:${entry.ref}:edit-input`, 'synthetic-replacement'));
    await screen.pressByTestIdAsync(`saved-secret:${entry.ref}:edit-save`);
    await vi.waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    expect(home.updates).toHaveLength(0);
    expect(screen.findByTestId(`saved-secret:${entry.ref}:edit-input`)?.props.value).toBe('synthetic-replacement');
    alert.mockClear();
    await screen.pressByTestIdAsync(`saved-secret:${entry.ref}:edit-save`);
    await vi.waitFor(() => expect(home?.updates).toHaveLength(1));
    await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${entry.ref}:edit-input`)).toBeNull());
    const written = home.updates[0]!;
    expect(openSavedSecretResourceStoredContentV1({ resourceId: written.resourceId, mode: 'plain', storedContent: written.storedContent }))
        .toMatchObject({ value: 'synthetic-replacement' });
    expect(alert).not.toHaveBeenCalled();
});

it.each([
    { mode: 'plain', stale: 'revision' },
    { mode: 'e2ee', stale: 'settings' },
    { mode: 'e2ee', stale: 'references' },
] as const)('deletes a pushed $mode creation without reloading with stale $stale', async ({ mode, stale }) => {
    let conflict = stale === 'references';
    home = await createSecretSettingsTestHarness({ mode, settings: settingsParse({ secrets: [] }), handleRequest: async path => {
        if (path !== '/v1/account/saved-secrets/resources/delete' || !conflict) return null;
        conflict = false;
        home!.replaceSettings(home!.persistedSettings, { version: 2, publish: false });
        return Response.json({ error: 'references_conflict' }, { status: 409 });
    } });
    const ref = 'happier:shared-secret:v1:resource-a';
    const screen = await renderSecretPage(ref);
    await vi.waitFor(() => expect(getSavedSecretCatalogSnapshot(home!.scope)).toMatchObject({ status: 'ready', data: [] }));
    // The other client creates while this page is mounted. Its Home change must reach this subscriber.
    await act(async () => {
        await home!.addOwnerResource();
        publishHomeAccountChange(home!.scope.serverId, ['resource-a'], { changeKinds: ['savedSecretResource'] });
    });
    await waitForSecretPage(ref, screen);
    const resource = home.resources[0]!;
    if (!('resourceId' in resource)) throw new Error('Expected the created resource');
    expect(resource.entry.revision).toBe(3);
    if (stale === 'revision') {
        // A later receipt has not reached the page yet.
        home.resources[0] = { ...resource, entry: { ...resource.entry, revision: 4 } };
    } else if (stale === 'settings') {
        // Agent activity can advance Settings before this client receives that push.
        home.replaceSettings(home.persistedSettings, { version: 2, publish: false });
    }
    await screen.pressByTestIdAsync(`saved-secret:${ref}:delete`);
    await vi.waitFor(() => expect(home?.deletes).toHaveLength(1));
    expect(home.deletes[0]).toMatchObject({ expectedRevision: stale === 'revision' ? 4 : 3,
        expectedSettingsVersion: stale === 'revision' ? 1 : 2 });
    // The Action policy owns whether to ask; currentness recovery must never ask twice.
    expect(confirm.mock.calls.length).toBeLessThanOrEqual(1);
    expect(alert).not.toHaveBeenCalled();
    expect(home.resources).toHaveLength(0);
    expect(home.settingsWrites).toHaveLength(0);
});

it.each([
    { status: 409, error: 'resource_changed', attempts: 2 },
    { status: 409, error: 'references_conflict', attempts: 2 },
    { status: 403, error: 'forbidden', attempts: 1 },
])('settles a persistent $error refusal without looping or repeating confirmation', async ({ status, error, attempts }) => {
    let deletes = 0;
    home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }), handleRequest: async path => {
        if (path !== '/v1/account/saved-secrets/resources/delete') return null;
        deletes += 1;
        return Response.json({ error }, { status });
    } });
    const { entry } = await home.addOwnerResource();
    const screen = await renderSecretPage(entry.ref);
    await waitForSecretPage(entry.ref, screen);
    await screen.pressByTestIdAsync(`saved-secret:${entry.ref}:delete`);
    await vi.waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    expect(deletes).toBe(attempts);
    expect(confirm.mock.calls.length).toBeLessThanOrEqual(1);
    expect(home.resources).toHaveLength(1);
    expect(home.deletes).toHaveLength(0);
});

it('names the Provider connection in a deletion refusal without exposing its binding path', async () => {
    home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
    const { entry } = await home.addOwnerResource();
    const { ProviderConnectionsCatalogV1Schema, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } = await import(
        '@happier-dev/protocol/providers/connections/connectionRowsV1');
    const { buildCustomProviderTemplate, createCustomProviderDraft } = await import('@/providers/authoring/state');
    const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [{
        v: 1, id: 'pc_work', source: { kind: 'custom', template: buildCustomProviderTemplate({
            ...createCustomProviderDraft('openai-chat'), name: 'Studio models', baseUrl: 'https://models.example.test/v1',
        }) }, role: 'named', displayName: 'Studio models', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
    }], secretBindingsByConnectionId: { pc_work: { account: { apiKey: entry.ref } } } });
    home.catalogRows.set(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, {
        status: 'present', revision: 1, content: { t: 'plain', v: catalog },
    });
    const screen = await renderSecretPage(entry.ref);
    await waitForSecretPage(entry.ref, screen);
    await screen.pressByTestIdAsync(`saved-secret:${entry.ref}:delete`);
    await vi.waitFor(() => expect(alert).toHaveBeenCalled());
    const body: string = alert.mock.calls.at(-1)![1];
    expect(body).toContain('Studio models');
    expect(body).not.toContain('secretBindingsByConnectionId');
    expect(body).not.toContain('pc_work');
    expect(home.deletes).toHaveLength(0);
});

it('asks each catalog owner for what the Used by census needs when a secret page opens cold', async () => {
    home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
    const { entry } = await home.addOwnerResource();
    const census = ['/v1/account/entity-rows/mcp', '/v1/account/entity-rows/acp', '/v1/account/entity-rows/provider-connections',
        '/v1/account/entity-rows/connected-accounts/configurations', '/v1/account/entity-rows/connected-accounts/purposes'];
    const reads = (path: string) => home!.request.mock.calls.filter(([input]) => new URL(String(input), 'http://home.test').pathname === path).length;
    const screen = await renderSecretPage(entry.ref);
    await waitForSecretPage(entry.ref, screen);
    await vi.waitFor(() => expect(census.filter((path) => reads(path) === 0)).toEqual([]));
});

// Native filesystem classes are an OS boundary, not part of this source-driven UI journey.
vi.mock('expo-file-system', async () =>
    (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);

/** A secret's own page is the route's `secret`, as when the Credentials rail or the Secrets list opens it. */
async function renderSecretPage(ref: string) {
    (await import('expo-router')).router.setParams({ secret: ref });
    const { SecretsSettingsScreen } = await import('./SecretsSettingsScreen');
    return renderScreen(<SecretsSettingsScreen />);
}

async function waitForSecretPage(ref: string, screen: Awaited<ReturnType<typeof renderScreen>>) {
    await vi.waitFor(() => expect(screen.findAll(node => node.props.testID === `saved-secret:${ref}:page-header`).length).toBeGreaterThan(0));
}

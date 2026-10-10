import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createPlainPromptLibraryCatalogHomeFixture, createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createPromptMachineTransferFixture, installPromptMachineSocketBoundary } from '@/dev/testkit/harness/promptMachineTransferBoundary';
import { installPromptLibrarySettingsCommonModuleMocks } from '../promptLibrarySettingsTestHelpers';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@happier-dev/iroh-native', async original =>
    (await import('@/dev/testkit/harness/promptMachineTransferBoundary')).createPromptNativeTransferModuleBoundary(original));
installPromptMachineSocketBoundary();
installPromptLibrarySettingsCommonModuleMocks({ storage: importOriginal => importOriginal(), reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: ({ ios, default: fallback }: { ios?: unknown; default?: unknown }) => ios ?? fallback } });
}, router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: { sourceId: 'catalog-source', itemId: 'catalog-source:review' } }).module;
} });
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { applyPromptLibraryCatalogSnapshot } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { PromptRegistriesScreen } = await import('./PromptRegistriesScreen');
const { WorkspaceRouteBody } = await import('@/app/(app)/settings/prompts/registries/item');

async function createImporterFixture(serverUrl: string) {
    const catalog = createPromptLibraryCatalogBoundary({ revision: 4 });
    const fixture = await createPromptMachineTransferFixture({ serverUrl, serverIdentityId: 'srv_registry_import_library',
        selectionKey: MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptRegistries, types: [],
        registryItem: { sourceId: 'catalog-source', itemId: 'catalog-source:review', title: 'Review', bundleSchemaId: 'skills.skill_md_v1',
            bundleBody: { v: 1, entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('# Review').toString('base64'), contentKind: 'utf8' }], createdAtMs: 1, updatedAtMs: 1 } },
        handleHomeRequest: catalog.handle });
    onTestFinished(fixture.dispose);
    let machineHome: Awaited<ReturnType<typeof fixture.addMachineHome>> | undefined;
    let failure: unknown;
    const admission = fixture.addMachineHome('https://registry-import-machine.test', 'srv_registry_import_machine')
        .then(value => { machineHome = value; }, error => { failure = error; });
    await vi.waitFor(() => {
        if (failure) throw failure;
        expect(machineHome, JSON.stringify(fixture.diagnostic())).toBeDefined();
    });
    await admission;
    if (!machineHome) throw new Error('Independent registry import Machine was not admitted');
    return { fixture, machineHome, catalog };
}

describe('registry source catalog mutation', () => {
    it('imports a browsed registry item into the displayed library rather than the independent Machine Home', async () => {
        const { fixture, machineHome } = await createImporterFixture('https://registry-import-library.test');
        const { importPromptRegistrySkillItem } = await import('@/sync/ops/promptLibrary/promptRegistrySkillImports');
        const imported = await importPromptRegistrySkillItem({ machineId: 'machine-1', serverId: machineHome.serverId,
            sourceId: 'catalog-source', itemId: 'catalog-source:review', configuredSources: [] });
        expect(imported, JSON.stringify({ imported, ...fixture.diagnostic() })).toMatchObject({ ok: true });
        expect(fixture.artifacts.list()).toHaveLength(1);
        expect(machineHome.artifacts.list()).toEqual([]);
        expect(storage.getState().settingsScope).toEqual(fixture.scope);
    });

    it('refuses registry import adoption when the displayed Account retires during the independent Machine read', async () => {
        const { fixture, machineHome, catalog } = await createImporterFixture('https://registry-retired-import-library.test');
        const { importPromptRegistrySkillItem } = await import('@/sync/ops/promptLibrary/promptRegistrySkillImports');
        fixture.afterNextExport(async () => { await fixture.homes.switchAccount(fixture.serverId, 'replacement-account'); });
        await expect(importPromptRegistrySkillItem({ machineId: 'machine-1', serverId: machineHome.serverId,
            sourceId: 'catalog-source', itemId: 'catalog-source:review', configuredSources: [] }))
            .rejects.toMatchObject({ message: 'action_account_scope_changed' });
        expect(fixture.artifacts.list()).toEqual([]);
        expect(machineHome.artifacts.list()).toEqual([]);
        expect(catalog.requests).toEqual([]);
    });

    it('uses catalog sources at the existing registry item route when requesting its daemon item', async () => {
        const sources = [{ id: 'catalog-source', title: 'Catalog source', adapterId: 'git' as const, enabled: true,
            config: { repositoryUrl: 'https://catalog.test/skills.git' } }];
        const catalog = createPromptLibraryCatalogBoundary({ records: [{
            key: 'registry-sources', value: { v: 1, sources },
        }], revision: 4 });
        const fixture = await createPromptMachineTransferFixture({ serverUrl: 'https://registry-item-row.test', serverIdentityId: 'srv_registry_item',
            selectionKey: MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptRegistries, types: [],
            registryItem: { sourceId: 'catalog-source', itemId: 'catalog-source:review', title: 'Review', bundleSchemaId: 'skills.skill_md_v1',
                bundleBody: { v: 1, entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('# Review').toString('base64'), contentKind: 'utf8' }], createdAtMs: 1, updatedAtMs: 1 } },
            handleHomeRequest: catalog.handle });
        onTestFinished(fixture.dispose);
        const { refreshPromptLibraryCatalog } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
        await refreshPromptLibraryCatalog(fixture.scope);
        const { getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
        expect(getPromptLibraryCatalogValue(fixture.scope, 'registry-sources'), JSON.stringify(fixture.diagnostic())).toMatchObject({ status: 'ready', stale: false,
            value: { sources } });
        expect(storage.getState().settingsScope).toEqual(fixture.scope);
        await renderScreen(<WorkspaceRouteBody />);
        await vi.waitFor(() => expect(fixture.daemonRequests.find(request => request.method.endsWith(':daemon.directTransfer.export.prepare'))?.params)
            .toMatchObject({ sourceId: 'catalog-source', itemId: 'catalog-source:review', configuredSources: sources }));
        expect(fixture.homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
    });

    it.each(['updated', 'conflict'] as const)('keeps catalog neighbors and clears only an acknowledged Git source draft: %s', async outcome => {
        const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://registry-row-${outcome}.test`, {
            key: 'registry-sources', value: { v: 1, sources: [{ id: 'catalog-source', title: 'Catalog source',
                adapterId: 'git', enabled: true, config: { repositoryUrl: 'https://catalog.test/skills.git' } }] },
        }, outcome);
        onTestFinished(fixture.dispose);
        const scope = storage.getState().settingsScope;
        if (!scope) throw new Error('Missing admitted Account');
        storage.setState({ settings: settingsDefaults, settingsVersion: 7 });
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [fixture.read()],
            tombstones: fixture.tombstones, diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        const screen = await renderScreen(<PromptRegistriesScreen />);
        await screen.pressByTestIdAsync('promptRegistries.addGitSource');
        await act(async () => {
            screen.changeTextByTestId('promptRegistries.sourceTitle', 'New source');
            screen.changeTextByTestId('promptRegistries.sourceUrl', 'https://new.test/skills.git');
        });
        const save = screen.findAll(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === 'common.save'
            && typeof node.props.onPress === 'function')[0];
        if (!save) throw new Error('Missing source save control');
        await act(async () => { await save.props.onPress(); });
        if (outcome === 'updated') {
            await vi.waitFor(() => expect(fixture.read().record.value).toMatchObject({ sources: [
                expect.objectContaining({ id: 'catalog-source' }), expect.objectContaining({ title: 'New source' }),
            ] }));
            expect(screen.findByTestId('promptRegistries.sourceTitle')).toBeNull();
        } else expect(screen.findByTestId('promptRegistries.sourceTitle')?.props.value).toBe('New source');
        expect(fixture.mutations[0]).toMatchObject({ expectedRevision: 4 });
        expect(fixture.settingsWrites()).toBe(0);
        expect(storage.getState().settingsVersion).toBe(7);
    });
});

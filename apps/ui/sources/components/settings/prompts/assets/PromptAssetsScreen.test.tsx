import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptAssetTypeDescriptorV1 } from '@happier-dev/protocol';
import type { IModal } from '@/modal';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createPromptMachineTransferFixture, installPromptMachineSocketBoundary } from '@/dev/testkit/harness/promptMachineTransferBoundary';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { installPromptAssetsCommonModuleMocks, promptAssetsRouterPushSpy } from './promptAssetsScreenTestHelpers';

const deletionConfirmation = vi.hoisted(() => vi.fn<IModal['confirm']>(async () => true));
const deletionAlert = vi.hoisted(() => vi.fn<IModal['alert']>());
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@happier-dev/iroh-native', async original => (await import('@/dev/testkit/harness/promptMachineTransferBoundary')).createPromptNativeTransferModuleBoundary(original));
installPromptMachineSocketBoundary();
installPromptAssetsCommonModuleMocks({ storage: original => original(), modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: deletionConfirmation, alert: deletionAlert } }).module;
}, reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: ({ ios, default: fallback }: { ios?: unknown; default?: unknown }) => ios ?? fallback } });
} });
const { storage } = await import('@/sync/domains/state/storage');
const { refreshPromptLibraryCatalog } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { PromptAssetsScreen } = await import('./PromptAssetsScreen');
const skillType: PromptAssetTypeDescriptorV1 = { id: 'agents.skill', providerId: 'agents', title: 'Agent skills', description: 'Portable skills', libraryKind: 'bundle',
    supportsScope: { user: true, project: true }, supportsFiles: true, formatId: 'skill_md_v1', defaultRoots: [], capabilities: { supportsSymlinkInstall: true } };
const docType: PromptAssetTypeDescriptorV1 = { ...skillType, id: 'claude.command', providerId: 'claude', libraryKind: 'doc', supportsFiles: false, formatId: 'markdown_utf8_v1' };
const skill = { assetTypeId: skillType.id, scope: 'project' as const, externalRef: { name: 'refactor' }, title: 'Refactor', libraryKind: 'bundle' as const,
    bundleSchemaId: 'skills.skill_md_v1' as const, digest: 'digest-1', displayPath: '/repo/.agents/skills/refactor' };
const doc = { assetTypeId: docType.id, scope: 'project' as const, externalRef: { relativePath: 'review/code.md' }, title: 'review/code', libraryKind: 'doc' as const,
    digest: 'digest-doc', displayPath: '/repo/.claude/commands/review/code.md' };
let fixture: Awaited<ReturnType<typeof createPromptMachineTransferFixture>>;
let catalog: ReturnType<typeof createPromptLibraryCatalogBoundary>;
let previousState: ReturnType<typeof storage.getState>;
async function setup(workspacePath = '/repo') {
    catalog = createPromptLibraryCatalogBoundary({ records: [
        { key: 'contexts', value: { v: 1, selectionsByKey: { 'promptAssets.externalAssets': { machineId: 'machine-2', workspacePath } } } },
        { key: 'external-links', value: { v: 1, links: [] } },
    ], revision: 4 });
    fixture = await createPromptMachineTransferFixture({ serverUrl: 'https://prompt-assets-screen.test', serverIdentityId: 'srv_prompt_assets_screen',
        selectionKey: MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptAssets, types: [skillType], discoveries: [skill],
        asset: { ...skill, bundleBody: { v: 1, entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('# Refactor').toString('base64'), contentKind: 'utf8' }], createdAtMs: 1, updatedAtMs: 1 } },
        handleHomeRequest: catalog.handle });
    await refreshPromptLibraryCatalog(fixture.scope);
    expect(getPromptLibraryCatalogValue(fixture.scope, 'contexts'), JSON.stringify(fixture.diagnostic())).toMatchObject({ status: 'ready', stale: false,
        value: { selectionsByKey: { 'promptAssets.externalAssets': { workspacePath } } } });
    expect(getPromptLibraryCatalogValue(fixture.scope, 'external-links'), JSON.stringify(fixture.diagnostic())).toMatchObject({ status: 'ready', stale: false });
    expect(storage.getState().settingsScope).toEqual(fixture.scope);
}
function requests(method: string) { return fixture.daemonRequests.filter(request => request.method.endsWith(':' + method)); }
async function waitForAsset(screen: Awaited<ReturnType<typeof renderScreen>>, itemId: string) {
    await vi.waitFor(() => {
        const diagnostic = JSON.stringify({ ...fixture.diagnostic(), contexts: getPromptLibraryCatalogValue(fixture.scope, 'contexts'),
            renderedText: screen.findAll(node => typeof node.props.children === 'string').map(node => node.props.children),
            directory: screen.findByTestId('promptAssets.directoryInput')?.props.value });
        expect(screen.findByTestId('promptAssets.directoryInput')?.props.value, diagnostic).toBe('/repo');
        expect(screen.findByTestId(itemId), diagnostic).not.toBeNull();
    });
}
beforeEach(() => {
    previousState = storage.getState(); promptAssetsRouterPushSpy.mockReset();
    deletionConfirmation.mockReset(); deletionConfirmation.mockResolvedValue(true); deletionAlert.mockReset();
});
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); storage.setState(previousState, true); });

describe('PromptAssetsScreen through Home and daemon boundaries', () => {
    it.each(['bundle', 'doc'] as const)('loads project assets and imports %s into the captured Account catalog', async kind => {
        await setup();
        if (kind === 'doc') {
            fixture.setTypes([docType]); fixture.setDiscoveries([doc]);
            fixture.setAsset({ ...doc, markdown: 'Review code carefully.' });
        }
        const screen = await renderScreen(<PromptAssetsScreen />);
        const type = kind === 'doc' ? docType : skillType;
        const itemId = 'promptAssets.item.project.' + type.id + '.0';
        await waitForAsset(screen, itemId);
        expect(requests('daemon.promptAssets.discover').at(-1)?.params).toMatchObject({ assetTypeId: type.id, scope: 'project', directory: '/repo' });
        await screen.pressByTestIdAsync(itemId);
        await vi.waitFor(() => expect(fixture.artifacts.list()).toHaveLength(1));
        const created = fixture.artifacts.list()[0]!;
        expect(fixture.artifacts.readPlainBody(created.id)).toContain(kind === 'doc' ? 'Review code carefully.' : 'SKILL.md');
        await vi.waitFor(() => expect(catalog.read('external-links').value).toMatchObject({ links: [{ artifactId: created.id, assetTypeId: type.id, machineId: 'machine-1',
            workspacePath: '/repo', scope: 'project', syncMode: 'manual' }] }));
        expect(catalog.requests.find(request => request.key === 'external-links')?.expectedRevision).toBe(4);
        await vi.waitFor(() => expect(promptAssetsRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining(created.id)));
        expect(fixture.homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
    });
    it('uses Administration rather than Context machine and clears project discovery after a target switch', async () => {
        await setup(); const screen = await renderScreen(<PromptAssetsScreen />);
        await waitForAsset(screen, 'promptAssets.item.project.agents.skill.0');
        expect(requests('daemon.promptAssets.discover')[0]?.method).toMatch(/^machine-1:/);
        const discoveriesBeforeSwitch = requests('daemon.promptAssets.discover').length;
        await act(async () => { fixture.selectMachine('machine-2'); });
        await vi.waitFor(() => expect(screen.findByTestId('promptAssets.item.project.agents.skill.0'), JSON.stringify({ ...fixture.diagnostic(),
            contexts: getPromptLibraryCatalogValue(fixture.scope, 'contexts'),
            directory: screen.findByTestId('promptAssets.directoryInput')?.props.value })).toBeNull());
        expect(requests('daemon.promptAssets.discover')).toHaveLength(discoveriesBeforeSwitch);
        await vi.waitFor(() => expect(catalog.read('contexts').value).toMatchObject({ selectionsByKey: { 'promptAssets.externalAssets': { workspacePath: '' } } }));
    });
    it('does not discover a project before choosing its workspace', async () => {
        await setup(''); await renderScreen(<PromptAssetsScreen />);
        await vi.waitFor(() => expect(requests('daemon.promptAssets.listTypes').length).toBeGreaterThan(0));
        expect(requests('daemon.promptAssets.discover')).toEqual([]);
    });
    it('fails closed without an Administration target rather than falling back to Context', async () => {
        await setup(); fixture.selectMachine(null); await renderScreen(<PromptAssetsScreen />);
        await act(async () => {});
        expect(fixture.daemonRequests).toEqual([]);
        expect(catalog.requests).toEqual([]);
    });
    it('does not persist an empty Context when no Machine inventory is available', async () => {
        await setup('');
        storage.setState({ machines: {}, machineListByServerId: {}, machineListStatusByServerId: {} });
        await renderScreen(<PromptAssetsScreen />); await act(async () => {});
        expect(catalog.requests).toEqual([]);
    });
    async function prepareLinkedArtifact(serverIdentityId?: string) {
        const { createPromptBundleArtifact } = await import('@/sync/ops/promptLibrary/promptBundles');
        const artifactId = await createPromptBundleArtifact({ title: skill.title, bundleSchemaId: 'skills.skill_md_v1', origin: 'imported',
            entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('# Refactor').toString('base64'), contentKind: 'utf8' }] });
        expect(storage.getState().artifacts[artifactId]?.header?.title).toBe(skill.title);
        const { writePromptLibraryRecord, requireUpdatedPromptLibraryMutation } = await import('@/sync/api/account/apiPromptLibraryCatalog');
        requireUpdatedPromptLibraryMutation(await writePromptLibraryRecord(fixture.scope, {
            record: { key: 'external-links', value: { v: 1, links: [{ id: 'link-1', artifactId, assetTypeId: skillType.id,
                machineId: 'machine-1', ...(serverIdentityId ? { serverIdentityId } : {}),
                scope: 'project', workspacePath: '/repo', externalRef: skill.externalRef }] } }, expectedRevision: 4,
        }));
        await refreshPromptLibraryCatalog(fixture.scope);
        return artifactId;
    }

    it('shows linked management and deletes only the external asset and its acknowledged link without creating another Artifact', async () => {
        await setup();
        const artifactId = await prepareLinkedArtifact();
        const screen = await renderScreen(<PromptAssetsScreen />);
        await waitForAsset(screen, 'promptAssets.item.project.agents.skill.0');
        const manage = screen.findAll(node => Array.isArray(node.props.actions) && node.props.actions.some((action: { id?: string }) => action.id === 'manage'))[0];
        if (!manage) throw new Error('Missing linked management');
        expect(manage.props.actions.map((action: { id: string }) => action.id)).toEqual(['open', 'manage', 'delete']);
        await act(async () => { manage.props.actions.find((action: { id: string }) => action.id === 'delete').onPress(); });
        await vi.waitFor(() => expect(catalog.read('external-links').value).toEqual({ v: 1, links: [] }));
        expect(requests('daemon.promptAssets.delete').map(request => request.params)).toMatchObject([{
            assetTypeId: skillType.id, scope: 'project', directory: '/repo', externalRef: skill.externalRef, previewOnly: false,
        }]);
        expect(catalog.requests.at(-1)).toMatchObject({ key: 'external-links', expectedRevision: 5 });
        expect(fixture.artifacts.list().map(artifact => artifact.id)).toEqual([artifactId]);
    });

    it('does not delete an independent Machine asset after the library Account retires during confirmation', async () => {
        await setup();
        const artifactId = await prepareLinkedArtifact('srv_asset_delete_machine');
        let machineHome: Awaited<ReturnType<typeof fixture.addMachineHome>> | undefined;
        let failure: unknown;
        const admission = fixture.addMachineHome('https://asset-delete-machine.test', 'srv_asset_delete_machine')
            .then(value => { machineHome = value; }, error => { failure = error; });
        await vi.waitFor(() => { if (failure) throw failure; expect(machineHome, JSON.stringify(fixture.diagnostic())).toBeDefined(); });
        await admission;
        if (!machineHome) throw new Error('Independent deletion Machine admission did not settle');
        const screen = await renderScreen(<PromptAssetsScreen />);
        await waitForAsset(screen, 'promptAssets.item.project.agents.skill.0');
        const manage = screen.findAll(node => Array.isArray(node.props.actions)
            && node.props.actions.some((action: { id?: string }) => action.id === 'delete'))[0];
        if (!manage) throw new Error('Missing real linked deletion action');
        let confirm: ((value: boolean) => void) | undefined;
        deletionConfirmation.mockImplementationOnce(() => new Promise<boolean>(resolve => { confirm = resolve; }));
        await act(async () => { manage.props.actions.find((action: { id: string }) => action.id === 'delete').onPress(); });
        await vi.waitFor(() => expect(confirm).toBeDefined());
        await act(async () => { await fixture.homes.switchAccount(fixture.serverId, 'replacement-account'); });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://asset-delete-machine.test', { serverId: machineHome.serverId });
        if (!credentials) throw new Error('Independent Machine credentials were retired');
        expect(parseToken(credentials.token)).toBe('account-b');
        await act(async () => { confirm?.(true); });
        await vi.waitFor(() => expect(deletionAlert).toHaveBeenCalled());
        expect(requests('daemon.promptAssets.delete'), JSON.stringify(fixture.diagnostic())).toEqual([]);
        expect(catalog.requests).toMatchObject([{ key: 'external-links', expectedRevision: 4 }]);
        expect(catalog.read('external-links').value).toMatchObject({ links: [{ id: 'link-1', artifactId }] });
        expect(fixture.artifacts.list().map(artifact => artifact.id)).toEqual([artifactId]);
        expect(machineHome.artifacts.list()).toEqual([]);
    });

    it('does not adopt a bare original-Home link for the same Machine id on an independent Home', async () => {
        await setup();
        const originalArtifactId = await prepareLinkedArtifact();
        let machineHome: Awaited<ReturnType<typeof fixture.addMachineHome>> | undefined;
        let failure: unknown;
        const admission = fixture.addMachineHome('https://asset-collision-machine.test', 'srv_asset_collision_machine')
            .then(value => { machineHome = value; }, error => { failure = error; });
        await vi.waitFor(() => { if (failure) throw failure; expect(machineHome, JSON.stringify(fixture.diagnostic())).toBeDefined(); });
        await admission;
        if (!machineHome) throw new Error('Independent colliding Machine admission did not settle');
        const screen = await renderScreen(<PromptAssetsScreen />);
        await waitForAsset(screen, 'promptAssets.item.project.agents.skill.0');
        const actions = screen.findAll(node => Array.isArray(node.props.actions)
            && node.props.actions.some((action: { id?: string }) => action.id === 'import'))[0];
        expect(actions?.props.actions.map((action: { id: string }) => action.id), JSON.stringify(fixture.diagnostic())).toEqual(['import']);
        await screen.pressByTestIdAsync('promptAssets.item.project.agents.skill.0');
        await vi.waitFor(() => expect(fixture.artifacts.list()).toHaveLength(2));
        const imported = fixture.artifacts.list().find(artifact => artifact.id !== originalArtifactId);
        if (!imported) throw new Error('Independent Machine import was not acknowledged');
        await vi.waitFor(() => expect(catalog.read('external-links').value).toMatchObject({ links: [
            { id: 'link-1', artifactId: originalArtifactId },
            { artifactId: imported.id, machineId: 'machine-1', serverIdentityId: 'srv_asset_collision_machine' },
        ] }));
        expect(machineHome.artifacts.list()).toEqual([]);
        expect(requests('daemon.promptAssets.delete')).toEqual([]);
    });
});

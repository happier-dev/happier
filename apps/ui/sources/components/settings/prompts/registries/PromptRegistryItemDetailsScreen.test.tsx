import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptAssetTypeDescriptorV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createPromptMachineTransferFixture, installPromptMachineSocketBoundary } from '@/dev/testkit/harness/promptMachineTransferBoundary';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { installPromptRegistriesCommonModuleMocks, promptRegistriesRouterPushSpy } from './promptRegistriesScreenTestHelpers';

const installAlert = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@happier-dev/iroh-native', async original => (await import('@/dev/testkit/harness/promptMachineTransferBoundary')).createPromptNativeTransferModuleBoundary(original));
installPromptMachineSocketBoundary();
installPromptRegistriesCommonModuleMocks({ storage: original => original(), reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: ({ ios, default: fallback }: { ios?: unknown; default?: unknown }) => ios ?? fallback } });
}, modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true, spies: { alert: installAlert } }).module;
} });
const { storage } = await import('@/sync/domains/state/storage');
const { refreshPromptLibraryCatalog } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { PromptRegistryItemDetailsScreen } = await import('./PromptRegistryItemDetailsScreen');
const projectType: PromptAssetTypeDescriptorV1 = { id: 'agents.skill', providerId: 'agents', title: 'Agent skills', description: 'Portable skills', libraryKind: 'bundle',
    supportsScope: { user: true, project: true }, supportsFiles: true, formatId: 'skill_md_v1', defaultRoots: [], capabilities: { supportsCatalogInstall: true, supportsSymlinkInstall: true } };
const userType: PromptAssetTypeDescriptorV1 = { ...projectType, id: 'claude.user.skill', supportsScope: { user: true, project: false } };
const item = { sourceId: 'skills_sh:featured', itemId: 'skills_sh:featured:item-1', title: 'frontend-design', description: 'Private skill',
    bundleSchemaId: 'skills.skill_md_v1' as const, bundleBody: { v: 1 as const,
        entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('# Frontend design — café').toString('base64'), contentKind: 'utf8' as const },
            { path: 'templates/review.md', contentBase64: Buffer.from('review').toString('base64'), contentKind: 'utf8' as const }],
        createdAtMs: 1, updatedAtMs: 1 } };
let fixture: Awaited<ReturnType<typeof createPromptMachineTransferFixture>>;
let catalog: ReturnType<typeof createPromptLibraryCatalogBoundary>;
let previousState: ReturnType<typeof storage.getState>;
async function setup(mutationOutcome: 'updated' | 'conflict' = 'updated') {
    catalog = createPromptLibraryCatalogBoundary({ records: [
        { key: 'contexts', value: { v: 1, selectionsByKey: {} } },
        { key: 'external-links', value: { v: 1, links: [] } },
    ], revision: 4, mutationOutcome });
    fixture = await createPromptMachineTransferFixture({ serverUrl: 'https://prompt-registry-details.test', serverIdentityId: 'srv_prompt_registry_details',
        selectionKey: MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptRegistries, types: [userType, projectType], registryItem: item,
        handleHomeRequest: catalog.handle });
    await refreshPromptLibraryCatalog(fixture.scope);
    for (const key of ['contexts', 'external-links'] as const) {
        expect(getPromptLibraryCatalogValue(fixture.scope, key), JSON.stringify(fixture.diagnostic())).toMatchObject({ status: 'ready', stale: false });
    }
    expect(storage.getState().settingsScope).toEqual(fixture.scope);
}
function requests(method: string) { return fixture.daemonRequests.filter(request => request.method.endsWith(':' + method)); }
async function mount() {
    const screen = await renderScreen(<PromptRegistryItemDetailsScreen sourceId={item.sourceId} itemId={item.itemId}
        configuredSources={[]} workspacePath="/repo" />);
    await vi.waitFor(() => expect(screen.findAll(node => typeof node.props.children === 'string' &&
        node.props.children.includes('# Frontend design — café')).length).toBeGreaterThan(0));
    return screen;
}
async function waitForInstall(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await vi.waitFor(() => {
        const diagnostic = JSON.stringify({ ...fixture.diagnostic(), links: getPromptLibraryCatalogValue(fixture.scope, 'external-links'),
            directory: screen.findByTestId('promptRegistries.details.directoryInput')?.props.value,
            target: screen.findByTestId('promptRegistries.details.targetInput')?.props.value,
            renderedText: screen.findAll(node => typeof node.props.children === 'string').map(node => node.props.children) });
        expect(screen.findByTestId('promptRegistries.details.directoryInput')?.props.value, diagnostic).toBe('/repo');
        expect(screen.findByTestId('promptRegistries.details.targetInput')?.props.value, diagnostic).toBeTruthy();
        const control = screen.findAll(node => node.props.testID === 'promptRegistries.details.install' && typeof node.props.disabled === 'boolean')[0];
        expect(control?.props.disabled, diagnostic).toBe(false);
    });
}
async function addIndependentMachineHome(serverUrl: string, serverIdentityId: string) {
    let result: Awaited<ReturnType<typeof fixture.addMachineHome>> | undefined;
    let failure: unknown;
    const admission = fixture.addMachineHome(serverUrl, serverIdentityId).then(value => { result = value; }, error => { failure = error; });
    // Use the runner's existing prerequisite wait, not the whole test's 60 s limit.
    await vi.waitFor(() => {
        if (failure) throw failure;
        expect(result, JSON.stringify(fixture.diagnostic())).toBeDefined();
    });
    await admission;
    if (!result) throw new Error('Independent Machine admission did not settle');
    return result;
}
beforeEach(() => { previousState = storage.getState(); promptRegistriesRouterPushSpy.mockReset(); installAlert.mockReset(); });
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); storage.setState(previousState, true); });
describe('PromptRegistryItemDetailsScreen through Home and daemon boundaries', () => {
    it('loads the addressed registry item and renders its UTF-8 supporting preview', async () => {
        await setup(); await mount();
        expect(requests('daemon.directTransfer.export.prepare')[0]?.params).toMatchObject({ sourceId: item.sourceId, itemId: item.itemId, configuredSources: [] });
        expect(fixture.artifacts.list()).toEqual([]);
    });
    it('imports the fetched skill into the real Account Artifact store', async () => {
        await setup(); const screen = await mount();
        await screen.pressByTestIdAsync('promptRegistries.details.import');
        await vi.waitFor(() => expect(fixture.artifacts.list()).toHaveLength(1));
        const artifact = fixture.artifacts.list()[0]!;
        expect(fixture.artifacts.readPlainBody(artifact.id)).toContain('templates/review.md');
        await vi.waitFor(() => expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining(artifact.id)));
    });
    it('previews and installs to a scope-compatible target, then acknowledges the exact external-links row', async () => {
        await setup(); const screen = await mount();
        await waitForInstall(screen);
        await screen.pressByTestIdAsync('promptRegistries.details.install');
        await vi.waitFor(() => expect(requests('daemon.promptRegistry.install')).toHaveLength(2));
        expect(requests('daemon.promptRegistry.install').map(request => request.params)).toMatchObject([
            { sourceId: item.sourceId, itemId: item.itemId, previewOnly: true, installTarget: { assetTypeId: projectType.id, scope: 'project', directory: '/repo', installMode: 'symlink' } },
            { previewOnly: false, installTarget: { assetTypeId: projectType.id, scope: 'project' } },
        ]);
        await vi.waitFor(() => expect(catalog.requests.find(request => request.key === 'external-links')).toMatchObject({ expectedRevision: 4 }));
        const artifact = fixture.artifacts.list()[0]!;
        await vi.waitFor(() => expect(catalog.read('external-links').value).toMatchObject({ links: [{ artifactId: artifact.id, assetTypeId: projectType.id, machineId: 'machine-1' }] }));
        await vi.waitFor(() => expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining(artifact.id)));
    });
    it('does not use route state as a fallback when the Administration target is unavailable', async () => {
        await setup(); fixture.selectMachine(null);
        await renderScreen(<PromptRegistryItemDetailsScreen sourceId={item.sourceId} itemId={item.itemId} configuredSources={[]} />);
        await act(async () => {});
        expect(fixture.daemonRequests).toEqual([]);
        expect(fixture.artifacts.list()).toEqual([]);
    });
    it('keeps the displayed library Account when installing through an independent Machine Home', async () => {
        await setup();
        const machineHome = await addIndependentMachineHome('https://registry-machine-only.test', 'srv_registry_machine_only');
        const screen = await mount();
        await waitForInstall(screen);
        await screen.pressByTestIdAsync('promptRegistries.details.install');
        await vi.waitFor(() => expect(requests('daemon.promptRegistry.install')).toHaveLength(2));
        await vi.waitFor(() => expect(promptRegistriesRouterPushSpy).toHaveBeenCalled());
        expect(fixture.artifacts.list()).toHaveLength(1);
        expect(machineHome.artifacts.list()).toEqual([]);
        expect(storage.getState().settingsScope).toEqual(fixture.scope);
        const artifact = fixture.artifacts.list()[0]!;
        expect(catalog.read('external-links').value).toMatchObject({ links: [{ artifactId: artifact.id }] });
    });
    it('refuses external installation when the displayed Account retires during the Machine read', async () => {
        await setup();
        const machineHome = await addIndependentMachineHome('https://registry-retired-machine.test', 'srv_registry_retired_machine');
        const screen = await mount();
        await waitForInstall(screen);
        let retired = false;
        fixture.afterNextExport(async () => { await fixture.homes.switchAccount(fixture.serverId, 'replacement-account'); retired = true; });
        await screen.pressByTestIdAsync('promptRegistries.details.install');
        await vi.waitFor(() => expect(retired).toBe(true));
        await vi.waitFor(() => expect(screen.findAll(node => node.props.testID === 'promptRegistries.details.install' && node.props.loading === true)).toHaveLength(0));
        expect(requests('daemon.promptRegistry.install')).toEqual([]);
        expect(fixture.artifacts.list()).toEqual([]);
        expect(machineHome.artifacts.list()).toEqual([]);
        expect(catalog.requests).toEqual([]);
        expect(promptRegistriesRouterPushSpy).not.toHaveBeenCalled();
    });
    it('retains the committed Machine receipt when the library Account retires before Artifact creation', async () => {
        await setup();
        const machineHome = await addIndependentMachineHome('https://registry-ack-machine.test', 'srv_registry_ack_machine');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { createUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
        const { installPromptRegistryItem } = await import('@/sync/ops/promptLibrary/installPromptRegistryItem');
        const account = await captureLazyActionAccountContext(fixture.scope.serverId);
        try {
            // Artifact HTTP admission occurs only after the adapter has consumed
            // the Machine install ACK. Retirement here is not a pending-RPC abort.
            fixture.homes.answer(fixture.serverId, 'POST /v1/artifacts', { select: async () => {
                await fixture.homes.switchAccount(fixture.serverId, 'replacement-account');
                return { status: 401, body: { error: 'unauthorized' } };
            } });
            if (!account.serverIdentityId) throw new Error('Missing admitted library identity');
            const result = await installPromptRegistryItem({ machineId: 'machine-1', serverId: machineHome.serverId,
                machineTarget: { serverIdentityId: 'srv_registry_ack_machine', machineId: 'machine-1' }, libraryServerIdentityId: account.serverIdentityId,
                sourceId: item.sourceId, itemId: item.itemId, configuredSources: [], previewOnly: false,
                installTarget: { assetTypeId: projectType.id, scope: 'project', directory: '/repo', targetName: 'review', installMode: 'symlink' },
                promptExternalLinks: { v: 1, links: [] } }, createUiPromptLibraryArtifactStore(account.workflowArtifacts, account));
            expect(requests('daemon.promptRegistry.install'), JSON.stringify({ result, ...fixture.diagnostic() })).toHaveLength(1);
            expect(result, JSON.stringify({ result, ...fixture.diagnostic() })).toMatchObject({ ok: false, exported: true,
                response: { ok: true, externalRef: { skillName: 'review' }, digest: 'digest-1' } });
            expect(fixture.artifacts.list()).toEqual([]);
            expect(machineHome.artifacts.list()).toEqual([]);
            expect(catalog.requests).toEqual([]);
            expect(promptRegistriesRouterPushSpy).not.toHaveBeenCalled();
        } finally { account.dispose(); }
    });
    it('reports the committed Machine target when external-link CAS conflicts without navigating or claiming linkage', async () => {
        await setup('conflict');
        const screen = await mount(); await waitForInstall(screen);
        await screen.pressByTestIdAsync('promptRegistries.details.install');
        await vi.waitFor(() => expect(requests('daemon.promptRegistry.install')).toHaveLength(2));
        await vi.waitFor(() => expect(installAlert.mock.calls.at(-1)?.[1]).toContain('.agents/skills/review'));
        expect(catalog.requests).toMatchObject([{ key: 'external-links', expectedRevision: 4 }]);
        expect(catalog.read('external-links').value).toEqual({ v: 1, links: [] });
        expect(fixture.artifacts.list()).toHaveLength(1);
        expect(promptRegistriesRouterPushSpy).not.toHaveBeenCalled();
    });
});

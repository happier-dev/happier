import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptAssetTypeDescriptorV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPromptMachineTransferFixture, installPromptMachineSocketBoundary } from '@/dev/testkit/harness/promptMachineTransferBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { installPromptAssetsCommonModuleMocks } from './promptAssetsScreenTestHelpers';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@happier-dev/iroh-native', async original => (await import('@/dev/testkit/harness/promptMachineTransferBoundary')).createPromptNativeTransferModuleBoundary(original));
installPromptMachineSocketBoundary();
installPromptAssetsCommonModuleMocks({ storage: original => original(), reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: ({ ios, default: fallback }: { ios?: unknown; default?: unknown }) => ios ?? fallback } });
} });
const { storage } = await import('@/sync/domains/state/storage');
const { PromptAssetExportScreen } = await import('./PromptAssetExportScreen');
const docType: PromptAssetTypeDescriptorV1 = { id: 'claude.command', providerId: 'claude', title: 'Commands', description: 'Markdown',
    libraryKind: 'doc', supportsScope: { user: true, project: true }, supportsFiles: false, formatId: 'markdown_utf8_v1',
    defaultRoots: [], capabilities: {} };
const userType: PromptAssetTypeDescriptorV1 = { ...docType, id: 'claude.user.command', supportsScope: { user: true, project: false } };
const skillType: PromptAssetTypeDescriptorV1 = { id: 'agents.skill', providerId: 'agents', title: 'Skills', description: 'Portable skills',
    libraryKind: 'bundle', supportsScope: { user: true, project: true }, supportsFiles: true, formatId: 'skill_md_v1',
    defaultRoots: [], capabilities: { supportsSymlinkInstall: true } };
const artifactId = 'library-entry';
let fixture: Awaited<ReturnType<typeof createPromptMachineTransferFixture>>;
let catalog: ReturnType<typeof createPromptLibraryCatalogBoundary>;
let previousState: ReturnType<typeof storage.getState>;
beforeEach(() => { previousState = storage.getState(); });
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); storage.setState(previousState, true); });

async function setup(kind: 'doc' | 'bundle' | 'broken' = 'doc', workspacePath = '/repo', linked = false) {
    catalog = createPromptLibraryCatalogBoundary({ revision: 4, records: [
        { key: 'contexts', value: { v: 1, selectionsByKey: { ['promptAssets.export.' + artifactId]: { machineId: 'machine-2', workspacePath } } } },
        { key: 'external-links', value: { v: 1, links: linked ? [{ id: 'link-1', artifactId, assetTypeId: docType.id,
            machineId: 'machine-1', scope: 'project', workspacePath: '/repo', externalRef: { relativePath: 'review/code.md' },
            lastExternalDigest: 'digest-previous' }] : [] } },
    ] });
    fixture = await createPromptMachineTransferFixture({ serverUrl: 'https://prompt-export-screen.test', serverIdentityId: 'srv_prompt_export_screen',
        selectionKey: MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptAssets, types: [userType, docType, skillType],
        handleHomeRequest: catalog.handle });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(fixture.scope.serverId);
    try {
        await account.workflowArtifacts.create({ artifactId, header: kind === 'bundle'
            ? { v: 1, kind: 'prompt_bundle.v2', title: 'reviewer', bundleSchemaId: 'skills.skill_md_v1' }
            : { v: 1, kind: 'prompt_doc.v2', title: 'review/code' },
            body: kind === 'broken' ? '{not-json' : kind === 'bundle'
                ? JSON.stringify({ v: 1, entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('# Reviewer').toString('base64'), contentKind: 'utf8' }], createdAtMs: 1, updatedAtMs: 1 })
                : JSON.stringify({ v: 1, markdown: 'Review code carefully.', createdAtMs: 1, updatedAtMs: 1 }) });
    } finally { account.dispose(); }
    const { refreshPromptLibraryCatalog } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
    await refreshPromptLibraryCatalog(fixture.scope);
    const { getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
    expect(getPromptLibraryCatalogValue(fixture.scope, 'external-links'), JSON.stringify(fixture.diagnostic())).toMatchObject({ status: 'ready', stale: false });
}
function uploads() { return fixture.daemonRequests.filter(request => request.method.endsWith(':daemon.directTransfer.import.prepare')); }
function deletes() { return fixture.daemonRequests.filter(request => request.method.endsWith(':daemon.promptAssets.delete')); }
async function mountReady() {
    const screen = await renderScreen(<PromptAssetExportScreen artifactId={artifactId} />);
    await vi.waitFor(() => expect(screen.findByTestId('promptAssetExport.export')?.props.disabled, JSON.stringify({
        ...fixture.diagnostic(), target: screen.findByTestId('promptAssetExport.targetInput')?.props.value,
        directory: screen.findByTestId('promptAssetExport.directoryInput')?.props.value,
        renderedText: screen.findAll(node => typeof node.props.children === 'string').map(node => node.props.children),
    })).toBe(false));
    return screen;
}

describe('PromptAssetExportScreen through Home and native daemon boundaries', () => {
    it('exports a scope-compatible document through Administration, not Context, and acknowledges its qualified link', async () => {
        await setup();
        const screen = await mountReady();
        await screen.pressByTestIdAsync('promptAssetExport.export');
        await vi.waitFor(() => expect(fixture.uploadedRequests.some(request => request.previewOnly === false)).toBe(true));
        expect(uploads().length).toBeGreaterThan(0);
        expect(uploads().every(request => request.method === 'machine-1:daemon.directTransfer.import.prepare')).toBe(true);
        expect(fixture.uploadedRequests.find(request => request.previewOnly === false)).toMatchObject({
            assetTypeId: docType.id, scope: 'project', directory: '/repo', targetPath: 'review/code.md',
            markdown: 'Review code carefully.',
        });
        await vi.waitFor(() => expect(catalog.read('external-links').value).toMatchObject({ links: [{ artifactId,
            assetTypeId: docType.id, machineId: 'machine-1', serverIdentityId: 'srv_prompt_export_screen',
            syncMode: 'manual', baseDigest: 'digest-1', lastExternalDigest: 'digest-1' }] }));
        expect(catalog.requests).toMatchObject([{ key: 'external-links', expectedRevision: 4 }]);
        expect(fixture.artifacts.list().map(artifact => artifact.id)).toEqual([artifactId]);
    });

    it('defaults a portable bundle to the supported symlink install mode', async () => {
        await setup('bundle');
        const screen = await mountReady();
        await screen.pressByTestIdAsync('promptAssetExport.export');
        await vi.waitFor(() => expect(fixture.uploadedRequests.some(request => request.previewOnly === false)).toBe(true));
        expect(fixture.uploadedRequests.find(request => request.previewOnly === false)).toMatchObject({
            assetTypeId: skillType.id, scope: 'project', installMode: 'symlink', bundleBody: { entries: [{ path: 'SKILL.md' }] },
        });
        await vi.waitFor(() => expect(catalog.read('external-links').value).toMatchObject({ links: [{ artifactId, assetTypeId: skillType.id }] }));
    });

    it('deletes a stored external target and its acknowledged link while retaining the library document', async () => {
        await setup('doc', '/repo', true);
        const screen = await mountReady();
        await vi.waitFor(() => expect(screen.findByTestId('promptAssetExport.linked')).not.toBeNull());
        const menu = screen.findAll(node => Array.isArray(node.props.actions)
            && node.props.actions.some((action: { testID?: string }) => action.testID === 'promptAssetExport.delete'))[0];
        if (!menu) throw new Error('Missing real linked deletion action');
        await act(async () => { menu.props.actions.find((action: { testID?: string }) => action.testID === 'promptAssetExport.delete').onSelect(); });
        await vi.waitFor(() => expect(catalog.read('external-links').value).toEqual({ v: 1, links: [] }));
        expect(deletes().map(request => request.params)).toMatchObject([{ assetTypeId: docType.id,
            scope: 'project', directory: '/repo', externalRef: { relativePath: 'review/code.md' }, expectedDigest: 'digest-previous' }]);
        expect(catalog.requests).toMatchObject([{ key: 'external-links', expectedRevision: 4 }]);
        expect(fixture.artifacts.list().map(artifact => artifact.id)).toEqual([artifactId]);
    });

    it('requires a project workspace for export and refuses a stored project deletion for a blank workspace', async () => {
        await setup('doc', '', true);
        const screen = await renderScreen(<PromptAssetExportScreen artifactId={artifactId} />);
        await vi.waitFor(() => expect(fixture.homes.requestsFor('/v1/artifacts/' + artifactId).length).toBeGreaterThan(0));
        expect(screen.findByTestId('promptAssetExport.export')?.props.disabled).toBe(true);
        expect(screen.findByTestId('promptAssetExport.linked')).toBeNull();
        expect(screen.findAll(node => Array.isArray(node.props.actions) && node.props.actions.some(
            (action: { testID?: string }) => action.testID === 'promptAssetExport.delete'))).toEqual([]);
        expect(uploads()).toEqual([]);
        expect(deletes()).toEqual([]);
        expect(catalog.requests).toEqual([]);
    });

    it('fails closed without exporting malformed document content', async () => {
        await setup('broken');
        const screen = await renderScreen(<PromptAssetExportScreen artifactId={artifactId} />);
        await vi.waitFor(() => expect(fixture.homes.requestsFor('/v1/artifacts/' + artifactId).length).toBeGreaterThan(0));
        expect(screen.findByTestId('promptAssetExport.export')?.props.disabled).toBe(true);
        expect(uploads()).toEqual([]);
        expect(catalog.requests).toEqual([]);
    });
});

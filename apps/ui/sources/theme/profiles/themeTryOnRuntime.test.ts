import { afterEach, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { getStorage } from '@/sync/domains/state/storageStore';
import { standardCleanup } from '@/dev/testkit';
import { createPlainPromptLibraryCatalogHomeFixture } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

// Keep storage, Sync and acquisition real beneath the native and network boundaries.
const { getThemeTryOnOwner, getThemeRegistryLifecycle } = await import('./themeTryOnRuntime');
await initializeArtifactInventoryDemandHarness();
const previousScope = getStorage().getState().settingsScope;
afterEach(() => { getStorage().setState({ settingsScope: previousScope }); });

it('shares one visible overlay and retires its Account presentation through the sole owner', () => {
    const owner = getThemeTryOnOwner();
    getStorage().setState({ settingsScope: { serverId: 'home', accountId: 'alice' } });
    const receipt = owner.begin({ document: null, selection: null, mode: 'dark', origin: { kind: 'editor' } });
    expect(getThemeTryOnOwner().read()).toBe(receipt);
    getStorage().setState({ settingsScope: { serverId: 'home', accountId: 'bob' } });
    expect(owner.read()).toBeNull();
    owner.revert(receipt.previewRef);
    getStorage().setState({ settingsScope: { serverId: 'home', accountId: 'alice' } });
    expect(owner.read()).toBeNull();
});

it('opens an unversioned listing with one detail, manifest, package and checksum acquisition', async () => {
    let phase = 'build selected package';
    onTestFailed(() => console.error('Runtime acquisition phase:', phase));
    const manifest = { publisher: 'sample', name: 'palette', version: '1.0.0', contributes: {
        themes: [{ label: 'Night', uiTheme: 'vs-dark', path: './themes/night.json' }],
    } };
    const writer = new ZipWriter(new Uint8ArrayWriter());
    for (const [path, value] of Object.entries({ 'extension/package.json': manifest,
        'extension/themes/night.json': { colors: { 'editor.background': '#123456' } } })) {
        await writer.add(path, new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(value))), { useWebWorkers: false });
    }
    const bytes = await writer.close();
    const counts = { detail: 0, manifest: 0, package: 0, checksum: 0 };
    phase = 'admit the real Home';
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://theme-acquisition.example.test', {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    }, 'updated', { handleExternalRequest: async url => {
        if (url.startsWith('https://open-vsx.org/api/sample/palette/')) {
            counts.detail++;
            return Response.json({ namespace: 'sample', name: 'palette', version: '1.0.0', files: {
                manifest: 'https://open-vsx.org/manifest.json', download: 'https://open-vsx.org/package.vsix', sha256: 'https://open-vsx.org/package.sha256',
            } });
        }
        if (url === 'https://open-vsx.org/manifest.json') { counts.manifest++; return Response.json(manifest); }
        if (url === 'https://open-vsx.org/package.vsix') { counts.package++; return new Response(Uint8Array.from(bytes).buffer); }
        if (url === 'https://open-vsx.org/package.sha256') { counts.checksum++; return new Response(bytesToHex(sha256(bytes))); }
        return null;
    } });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    phase = 'acquire selected listing';
    const acquired = await getThemeRegistryLifecycle().get({ sourceId: 'builtin:open-vsx', itemId: 'sample/palette' },
        { expectedScope: getStorage().getState().settingsScope });
    expect(acquired.item.summary.version).toBe('1.0.0');
    expect(acquired.item.payload.themes[0]?.document.profile.overrides.dark).toMatchObject({ 'background.canvas': '#123456' });
    expect(counts).toEqual({ detail: 1, manifest: 1, package: 1, checksum: 1 });
});

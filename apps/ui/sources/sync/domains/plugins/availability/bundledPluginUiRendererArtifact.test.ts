import { afterEach, expect, it } from 'vitest';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { BUNDLED_PLUGIN_UI_APP_DECLARATIONS, installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { resolveBundledPluginUiRendererArtifact as resolveRenderer } from './bundledPluginUiRendererArtifact';
import { createPluginAccountAvailabilityReader } from './reader';

function resolveBundledPluginUiRendererArtifact(entry: Parameters<typeof resolveRenderer>[0]) {
    const reader = createPluginAccountAvailabilityReader({ scope: { serverId: 'server', accountId: 'account' },
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] },
        hostBundledUi: BUNDLED_PLUGIN_UI_APP_DECLARATIONS });
    return resolveRenderer(entry, reader.readAccountUiProjection());
}

const pluginId = 'happier.fixture';
const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0',
    displayName: 'Fixture', runtime: { apiVersion: 1 }, contributes: { ui: {
        renderers: [{ id: 'card', kind: 'reactNative', artifact: 'card', requiredHostMethods: [] }],
    } } });
function declarations(digest: string) {
    const graph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'card', tier: 'reactNative', digest,
        entry: 'react-native/card/entry.cjs.bundle', files: [{ relativePath: 'react-native/card/entry.cjs.bundle', digest, byteSize: 1 }],
        executable: { exports: ['renderSurface'] }, builtWith: { bundler: 'esbuild', version: '0.27.2' }, hostUiApiRange: '^1.0.0' });
    return { pluginId, pluginVersion: manifest.version, packageName: '@happier-dev/plugins-fixture', displayName: 'Fixture',
        normalizedManifest: manifest, artifactGraphs: [graph], entriesById: projectPluginPortableUiDeclarationsV1(manifest, [graph]) };
}
const current = declarations(`sha256:${'a'.repeat(64)}`);
const retained = declarations(`sha256:${'b'.repeat(64)}`);
const entryId = `reactNativeBundle:${pluginId}:card`;
const oldEntry = { ...retained.entriesById[entryId], artifactSelectionOwner: 'daemonProjection', occurrenceId: 'daemon-old' };
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

it('uses the current app renderer instead of the retained Machine graph after a bundled update', () => {
    restore = installBundledPluginUiDeclarationsForTests([current]);
    const selected = resolveBundledPluginUiRendererArtifact(oldEntry);
    expect(selected).toMatchObject(current.entriesById[entryId]!);
    expect(selected?.artifactGraph).toEqual(current.artifactGraphs[0]);
    expect(selected?.artifactSelectionOwner).toBeUndefined();
});

it('does not require retained renderer metadata to reclassify the current app renderer', () => {
    restore = installBundledPluginUiDeclarationsForTests([current]);
    const { generatedOwnerKind: _owner, artifactSelectionOwner: _selection, ...legacyEntry } = oldEntry;
    expect(resolveBundledPluginUiRendererArtifact(legacyEntry)).toMatchObject(current.entriesById[entryId]!);
});

it('consumes the selected renderer from the current projection regardless of a retained selection stamp', () => {
    restore = installBundledPluginUiDeclarationsForTests([retained]);
    expect(resolveBundledPluginUiRendererArtifact(current.entriesById[entryId]!)?.artifactGraph).toEqual(retained.artifactGraphs[0]);
    restore();
    restore = installBundledPluginUiDeclarationsForTests([current]);
    const account = { ...oldEntry, artifactSelectionOwner: 'accountRelease' };
    expect(resolveBundledPluginUiRendererArtifact(account)?.artifactGraph).toEqual(current.artifactGraphs[0]);
});

it('withdraws a removed bundled renderer instead of admitting retained Machine bytes', () => {
    const emptyManifest = PluginPortableReleaseManifestV1Schema.parse({ ...manifest, contributes: { ui: { renderers: [] } } });
    restore = installBundledPluginUiDeclarationsForTests([{ ...current,
        normalizedManifest: emptyManifest, entriesById: projectPluginPortableUiDeclarationsV1(emptyManifest, []) }]);
    expect(resolveBundledPluginUiRendererArtifact(oldEntry)).toBeNull();
});

it('leaves Machine Action and Voice executable graphs with their execution owner', () => {
    restore = installBundledPluginUiDeclarationsForTests([current]);
    for (const generatedOwnerKind of ['clientContribution', 'voiceProvider']) {
        const executable = { ...oldEntry, generatedOwnerKind };
        expect(resolveBundledPluginUiRendererArtifact(executable)).toBe(executable);
    }
});

it('preserves a disabled renderer and plugins absent from this app inventory', () => {
    restore = installBundledPluginUiDeclarationsForTests([current]);
    const disabled = { ...oldEntry, runtime: { decision: { state: 'disabled', reason: 'crash_loop' } } };
    expect(resolveBundledPluginUiRendererArtifact(disabled)).toBe(disabled);
    const external = { ...oldEntry, pluginId: 'external.fixture' };
    expect(resolveBundledPluginUiRendererArtifact(external)).toBe(external);
});

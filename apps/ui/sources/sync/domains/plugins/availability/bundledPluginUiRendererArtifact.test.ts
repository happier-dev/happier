import { afterEach, expect, it, onTestFinished } from 'vitest';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { BUNDLED_PLUGIN_UI_APP_DECLARATIONS, installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { readCurrentPluginUiRendererProjection, resolveBundledPluginUiRendererArtifact as resolveRenderer } from './bundledPluginUiRendererArtifact';
import { createPluginAccountAvailabilityReader } from './reader';
import { clearPluginAccountAvailabilityProjection, readPluginAccountAvailability, replacePluginAccountAvailabilityProjection } from './projection';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { mergeInstalledPluginUiProjections } from '../ui/projectionUnion';

function resolveBundledPluginUiRendererArtifact(entry: Parameters<typeof resolveRenderer>[0]) {
    const reader = createPluginAccountAvailabilityReader({ scope: { serverId: 'server', accountId: 'account' },
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] },
        hostBundledUi: BUNDLED_PLUGIN_UI_APP_DECLARATIONS });
    const accountProjection = reader.readAccountUiProjection();
    return resolveRenderer(entry, { accountProjection, selectedProjection: accountProjection });
}

const pluginId = 'happier.fixture';
const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0',
    displayName: 'Fixture', runtime: { apiVersion: 1 }, contributes: { ui: {
        renderers: [{ id: 'card', kind: 'reactNative', artifact: 'card', requiredHostMethods: [] }],
    } } });
function declarations(digest: string, version = manifest.version, declarationPluginId = pluginId) {
    const releaseManifest = PluginPortableReleaseManifestV1Schema.parse({ ...manifest, version, id: declarationPluginId });
    const graph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'card', tier: 'reactNative', digest,
        entry: 'react-native/card/entry.cjs.bundle', files: [{ relativePath: 'react-native/card/entry.cjs.bundle', digest, byteSize: 1 }],
        executable: { exports: ['renderSurface'] }, builtWith: { bundler: 'esbuild', version: '0.27.2' }, hostUiApiRange: '^1.0.0' });
    return { pluginId: declarationPluginId, pluginVersion: version, packageName: '@happier-dev/plugins-fixture', displayName: 'Fixture',
        normalizedManifest: releaseManifest, artifactGraphs: [graph], entriesById: projectPluginPortableUiDeclarationsV1(releaseManifest, [graph]) };
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

it.each([false, true])('retains Machine A v1 for an external plugin when the global Machine B v2 omits its renderer: %s', (omitRenderer) => {
    const scope = { serverId: 'server', accountId: 'account' };
    // The packaged inventory is acquired once per app process. Keep the app
    // fixture constant while the two Machine installations vary independently.
    restore = installBundledPluginUiDeclarationsForTests([current]);
    clearPluginAccountAvailabilityProjection();
    onTestFinished(clearPluginAccountAvailabilityProjection);
    replacePluginAccountAvailabilityProjection({ scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const externalPluginId = 'external.fixture';
    const externalEntryId = `reactNativeBundle:${externalPluginId}:card`;
    const machineA = { ...declarations(`sha256:${'b'.repeat(64)}`, '1.0.0', externalPluginId).entriesById[externalEntryId],
        artifactSelectionOwner: 'daemonProjection', occurrenceId: 'machine-a-v1' };
    const machineB = createPluginAccountAvailabilityReader({ scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] },
        hostBundledUi: [declarations(`sha256:${'c'.repeat(64)}`, '2.0.0', externalPluginId)] }).readAccountUiProjection()!;
    const global = mergeInstalledPluginUiProjections([], omitRenderer
        ? { ...machineB, reactNativeBundlesById: {} } : machineB);
    onTestFinished(publishCommittedAppShellPluginUiProjection(() => global));

    expect(readPluginAccountAvailability(scope).readAccountUiProjection()?.installedPackagesById[externalPluginId]).toBeUndefined();
    expect(global?.installedPackagesById[externalPluginId]?.version).toBe('2.0.0');
    expect(resolveRenderer(machineA, readCurrentPluginUiRendererProjection(scope))).toBe(machineA);
});

it('keeps the current Account renderer when a retained Machine supplies an older graph in AppShell', () => {
    const scope = { serverId: 'server', accountId: 'account' };
    restore = installBundledPluginUiDeclarationsForTests([current]);
    clearPluginAccountAvailabilityProjection();
    onTestFinished(clearPluginAccountAvailabilityProjection);
    replacePluginAccountAvailabilityProjection({ scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const account = createPluginAccountAvailabilityReader({ scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] },
        hostBundledUi: [current] }).readAccountUiProjection()!;
    const machine = createPluginAccountAvailabilityReader({ scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] },
        hostBundledUi: [retained] }).readAccountUiProjection()!;
    const global = mergeInstalledPluginUiProjections([account], machine);
    onTestFinished(publishCommittedAppShellPluginUiProjection(() => global));

    expect(readPluginAccountAvailability(scope).readAccountUiProjection()?.installedPackagesById[pluginId]).toBeDefined();
    expect(resolveRenderer(oldEntry, readCurrentPluginUiRendererProjection(scope))?.artifactGraph).toEqual(current.artifactGraphs[0]);
});

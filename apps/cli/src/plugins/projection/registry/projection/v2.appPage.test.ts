import { describe, expect, it } from 'vitest';
import { manifest as INSPECTOR_PLUGIN_MANIFEST } from '@happier-dev/plugins-inspector';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

import { buildPluginProjectionV2 } from './v2';

/**
 * EU-5b gate, daemon half — an external manifest declaring a full-page plugin
 * destination reaches the client projection as a mounted `appPage` binding.
 *
 * This is the first half of the gate chain (manifest -> projection); the client
 * half (page catalog -> host navigation -> real renderer -> destination context)
 * is proven at its own owner in `apps/ui`
 * (`components/appShell/plugins/PluginAppPageScreen.test.tsx`). The two join at
 * the wire projection asserted here, exactly as the EU-5c semantic-surface gate
 * does — the split is a package boundary, not a gap.
 */

function manifestText(input: Readonly<{
    pluginId: string;
    container?: string;
    target?: Readonly<Record<string, unknown>>;
    legacyPlacement?: string;
    extraView?: Readonly<Record<string, unknown>>;
}>): string {
    return JSON.stringify({
        schemaVersion: 2,
        id: input.pluginId,
        version: '1.0.0',
        displayName: 'Notes',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        contributes: {
            ui: {
                views: [{
                    id: 'notes',
                    container: input.container ?? 'appPage',
                    target: input.target ?? { kind: 'app' },
                    renderer: 'notes-renderer',
                    title: 'Notes',
                    ...(input.legacyPlacement === undefined ? {} : { placement: input.legacyPlacement }),
                    ...(input.extraView ?? {}),
                }],
                renderers: [{
                    id: 'notes-renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'notes' },
                }],
            },
        },
    });
}

function loadedPlugin(
    pluginId: string,
    text: string,
    options: Readonly<{ bundledFirstParty?: boolean }> = {},
): LoadedPlugin {
    const ingested = ingestCanonicalPluginManifest(text, options.bundledFirstParty
        ? { sourceProvenance: 'localSource', manifestAuthority: 'bundled_first_party' }
        : { sourceProvenance: 'registryCustodied' });
    if (!ingested.ok) {
        throw new Error(ingested.diagnostics.map((item) => `${item.code}: ${item.message}`).join('\n'));
    }
    return {
        pluginId,
        pluginRootPath: `/plugins/${pluginId}`,
        manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
        daemonEntryPath: `/plugins/${pluginId}/daemon.mjs`,
        devDaemonEntryPath: null,
        sourceSpec: {
            kind: 'path',
            locator: `/plugins/${pluginId}`,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest: ingested.manifest,
    };
}

function resolveRegistry(
    loadedPlugins: readonly LoadedPlugin[],
    provenance: 'first_party' | 'external' = 'external',
): ResolvedContributionRegistry {
    return createResolvedContributionRegistry(projectLoadedPluginContributes({
        loadResult: { loadedPlugins, diagnosticsByPluginId: {} },
        provenance,
    }));
}

function projectUiEntries(
    loadedPlugins: readonly LoadedPlugin[],
    provenance: 'first_party' | 'external' = 'external',
) {
    const projection = buildPluginProjectionV2({
        registry: resolveRegistry(loadedPlugins, provenance),
        generation: 1,
        pluginUiHostRuntime: { declarative: { modelsByRendererKey: {} } } as never,
    });
    return projection.familiesById.pluginUi?.entriesById ?? {};
}

/**
 * Zod collapses a failed view union into one opaque `Invalid input` diagnostic
 * at `contributes.ui.views.0` — byte-identical for a bad container, a retired
 * `placement` and an author-selected `path`. Scanning the serialized result for
 * the field name therefore asserts a precision the owner does not have: two of
 * those scans were red, and `toContain('path')` passed only because every
 * diagnostic object carries a `path` key at all.
 *
 * The discriminating fact that IS available: the same fixture without the
 * offending field is accepted, so the rejection is attributable to that field
 * rather than to a broken fixture or to any rejection whatsoever.
 */
function expectViewFieldRejected(overrides: Parameters<typeof manifestText>[0]): void {
    const accepted = ingestCanonicalPluginManifest(manifestText({ pluginId: overrides.pluginId }), { sourceProvenance: 'registryCustodied' });
    expect(accepted.ok).toBe(true);

    const rejected = ingestCanonicalPluginManifest(manifestText(overrides), { sourceProvenance: 'registryCustodied' });
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? [] : rejected.diagnostics).toContainEqual(expect.objectContaining({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'ui', 'views', 0],
    }));
}

describe('EU-5b app-page projection', () => {
    it('projects the maintained public Inspector Browser and Services declarations into mounted bindings', () => {
        const entries = projectUiEntries([
            loadedPlugin(INSPECTOR_PLUGIN_MANIFEST.id, JSON.stringify(INSPECTOR_PLUGIN_MANIFEST), { bundledFirstParty: true }),
        ], 'first_party');

        expect(entries['surfacePlacement:happier.inspector:inspector-browser-panel']).toEqual(expect.objectContaining({
            pluginId: 'happier.inspector',
            descriptorId: 'inspector-browser-panel',
            container: 'browserPanel',
            target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
            binding: expect.objectContaining({
                container: 'browserPanel',
                targetKind: 'browser',
                destination: { pluginId: 'happier.inspector', localId: 'inspector-browser-panel' },
            }),
        }));
        expect(entries['surfacePlacement:happier.inspector:inspector-services-panel']).toEqual(expect.objectContaining({
            pluginId: 'happier.inspector',
            descriptorId: 'inspector-services-panel',
            container: 'servicesPanel',
            target: { kind: 'services' },
            binding: expect.objectContaining({
                container: 'servicesPanel',
                targetKind: 'services',
                destination: { pluginId: 'happier.inspector', localId: 'inspector-services-panel' },
            }),
        }));
        expect((entries['surfacePlacement:happier.inspector:inspector-browser-panel'] as { availability: { reason: string } }).availability.reason)
            .not.toBe('placement_unmounted');
        expect((entries['surfacePlacement:happier.inspector:inspector-services-panel'] as { availability: { reason: string } }).availability.reason)
            .not.toBe('placement_unmounted');
    });

    it('carries an external app-page declaration to a mounted binding bound to the app target', () => {
        const entries = projectUiEntries([loadedPlugin('acme.notes', manifestText({ pluginId: 'acme.notes' }))]);

        expect(entries['surfacePlacement:acme.notes:notes']).toEqual(expect.objectContaining({
            pluginId: 'acme.notes',
            contributionKind: 'surfacePlacement',
            descriptorId: 'notes',
            container: 'appPage',
            target: { kind: 'app' },
            binding: expect.objectContaining({
                container: 'appPage',
                targetKind: 'app',
                destination: { pluginId: 'acme.notes', localId: 'notes' },
            }),
        }));
        expect(entries['surfacePlacement:acme.notes:notes']).not.toHaveProperty('placement');
        // Reaching the client at all is the point of the gate.
        expect((entries['surfacePlacement:acme.notes:notes'] as { availability: { reason: string } }).availability.reason)
            .not.toBe('placement_unmounted');
        // A page is not a right-sidebar tab, so it carries no tab metadata.
        expect(entries['surfacePlacement:acme.notes:notes']).not.toHaveProperty('rightSidebar');
    });

    it('keeps two plugins declaring the same local page id as two distinct entries', () => {
        const entries = projectUiEntries([
            loadedPlugin('acme.notes', manifestText({ pluginId: 'acme.notes' })),
            loadedPlugin('acme.journal', manifestText({ pluginId: 'acme.journal' })),
        ]);

        // `toBeDefined()` alone would also pass an owner that keyed both slots
        // off one plugin's page, so each entry is pinned to its own pluginId.
        expect(entries['surfacePlacement:acme.notes:notes']).toEqual(expect.objectContaining({
            pluginId: 'acme.notes',
            descriptorId: 'notes',
        }));
        expect(entries['surfacePlacement:acme.journal:notes']).toEqual(expect.objectContaining({
            pluginId: 'acme.journal',
            descriptorId: 'notes',
        }));
    });

    it('rejects a container the surface registry does not own', () => {
        expectViewFieldRejected({ pluginId: 'acme.notes', container: 'appRoute' });
    });

    it('rejects a retired placement field even beside an otherwise valid V2 binding', () => {
        expectViewFieldRejected({ pluginId: 'acme.notes', legacyPlacement: 'app.page' });
    });

    it('rejects an author-selected path on the view declaration', () => {
        expectViewFieldRejected({ pluginId: 'acme.notes', extraView: { path: 'notes' } });
    });
});

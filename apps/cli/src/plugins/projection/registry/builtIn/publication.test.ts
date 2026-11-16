import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH, readBundledPluginUiArtifactsDigest } from '@happier-dev/cli-common/bundledPluginPublicationPolicy';

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
const roots: string[] = [];

/** A self-contained runtime root holding only the given publication record (filesystem boundary). */
async function loadPublicationWithRecord(record: readonly unknown[]) {
    const root = mkdtempSync(join(tmpdir(), 'happier-publication-scope-'));
    roots.push(root);
    Object.defineProperty(process, 'execPath', { ...execPathDescriptor, value: join(root, 'happier') });
    writeFileSync(join(root, 'package.json'), '{}');
    const failurePath = join(root, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH);
    mkdirSync(dirname(failurePath), { recursive: true });
    writeFileSync(failurePath, JSON.stringify(record));
    vi.resetModules();
    return await import('./publication');
}

function uiRecord(packageId: string, pluginId: string, uiArtifactsDigest?: string | null) {
    return {
        packageName: `@happier-dev/plugins-${packageId}`, pluginId,
        diagnostic: { code: 'plugin_ui_artifact_invalid', message: `Bundled Plugin UI artifact manifest is missing for '${pluginId}'` },
        ...(uiArtifactsDigest === undefined ? {} : { uiArtifactsDigest }),
    };
}

afterEach(() => {
    Object.defineProperty(process, 'execPath', execPathDescriptor);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bundled plugin publication record scope', () => {
    it('does not let a stale per-host UI record stop the runtime or withdraw a package', async () => {
        // The 11-12 mac-host record: UI-only rows written before records carried their graph.
        const publication = await loadPublicationWithRecord([
            uiRecord('codex', 'happier.agent.codex'),
            uiRecord('inspector', 'happier.inspector'),
        ]);
        expect(publication.readCurrentBundledPluginPublicationFailures()).toEqual([]);
        expect(publication.readAdmittedBundledPluginPublicationFailures()).toBe('[]\n');
    });

    it('applies a UI record only to the graph it evaluated, and never withdraws a required package', async () => {
        const probe = await loadPublicationWithRecord([]);
        const currentDigest = (packageName: string) => {
            const root = probe.resolveInstalledBundledPluginRootPath(packageName);
            return root === null ? null : readBundledPluginUiArtifactsDigest(root);
        };
        const olderGraph = `sha256:${'0'.repeat(64)}`;
        const publication = await loadPublicationWithRecord([
            uiRecord('inspector', 'happier.inspector', currentDigest('@happier-dev/plugins-inspector')),
            uiRecord('triage', 'happier.triage', olderGraph),
            uiRecord('xai', 'happier.voice.xai', currentDigest('@happier-dev/plugins-xai')),
        ]);
        expect(publication.readCurrentBundledPluginPublicationFailures()).toEqual([
            expect.objectContaining({ pluginId: 'happier.inspector' }),
        ]);
    });
});

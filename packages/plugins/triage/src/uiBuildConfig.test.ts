import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import {
    TRIAGE_ENTRIES_COMPACT_ARTIFACT_ID_V1,
    TRIAGE_ENTRIES_COMPACT_RENDERER_ID_V1,
    TRIAGE_ENTRY_PICKER_ARTIFACT_ID_V1,
    TRIAGE_ENTRY_PICKER_RENDERER_ID_V1,
    TRIAGE_LIST_PAGE_ARTIFACT_ID_V1,
    TRIAGE_LIST_PAGE_RENDERER_ID_V1,
    TRIAGE_SESSION_ENTRIES_ARTIFACT_ID_V1,
    TRIAGE_SESSION_ENTRIES_RENDERER_ID_V1,
} from './ui/contributions.js';

type BuildTarget = Readonly<{
    rendererId: string;
    entry: string;
    kind: string;
    platforms?: readonly string[];
    module?: Readonly<{ containerName: string; modulePath: string; exportName: string }>;
}>;

type BuildConfig = Readonly<{
    projectRoot?: string;
    outDir?: string;
    targets: readonly BuildTarget[];
}>;

async function loadBuildConfig(): Promise<BuildConfig> {
    const loaded = await import('../happier-plugin-ui.config.mjs');
    return loaded.default as BuildConfig;
}

/**
 * The named export the React Native web loader resolves when no module identity
 * is available — which on web is always, since web artifacts may not declare
 * one. Every plugin in the repository keeps this contract.
 */
const WEB_SURFACE_EXPORT_NAME = 'renderSurface';

describe('PRs & Issues UI build configuration', () => {
    it('builds one artifact for every manifest renderer, on every client platform', async () => {
        const config = await loadBuildConfig();

        expect(config.projectRoot).toBe('.');
        expect(config.outDir).toBe('node_modules/.cache/happier-plugin-ui');
        for (const target of config.targets) {
            expect(target.kind).toBe('reactNative');
            // Web, iOS and Android are all first-class; a missing platform is a
            // host that mounts nothing rather than a host that degrades.
            expect(target.platforms).toEqual(['web', 'ios', 'android']);
        }

        // The build-config field is spelled `rendererId` and carries the
        // ARTIFACT id. A manifest naming an artifact no target produces passes
        // contribution conformance and then fails at mount, which is exactly the
        // failure this assertion exists to make loud.
        expect(config.targets.map((target) => target.rendererId).sort()).toEqual([
            TRIAGE_ENTRIES_COMPACT_ARTIFACT_ID_V1,
            TRIAGE_ENTRY_PICKER_ARTIFACT_ID_V1,
            TRIAGE_LIST_PAGE_ARTIFACT_ID_V1,
            TRIAGE_SESSION_ENTRIES_ARTIFACT_ID_V1,
        ].sort());
    }, 180_000);

    it('binds every declared renderer to the artifact its own entry module produces', async () => {
        const config = await loadBuildConfig();
        const entryByArtifact = new Map(
            config.targets.map((target) => [target.rendererId, target.entry] as const),
        );

        const expected: readonly (readonly [string, string, string])[] = [
            [TRIAGE_LIST_PAGE_RENDERER_ID_V1, TRIAGE_LIST_PAGE_ARTIFACT_ID_V1, 'src/ui/surface.tsx'],
            [TRIAGE_ENTRY_PICKER_RENDERER_ID_V1, TRIAGE_ENTRY_PICKER_ARTIFACT_ID_V1, 'src/composer/entryPicker.tsx'],
            [TRIAGE_ENTRIES_COMPACT_RENDERER_ID_V1, TRIAGE_ENTRIES_COMPACT_ARTIFACT_ID_V1, 'src/composer/controlCompact.tsx'],
            [
                TRIAGE_SESSION_ENTRIES_RENDERER_ID_V1,
                TRIAGE_SESSION_ENTRIES_ARTIFACT_ID_V1,
                'src/sessions/cockpit/sessionLinkedEntriesSurface.tsx',
            ],
        ];

        for (const [rendererId, artifactId, entry] of expected) {
            expect(PLUGIN_MANIFEST.contributes.ui.renderers).toContainEqual(
                expect.objectContaining({ id: rendererId, kind: 'reactNative', artifact: artifactId }),
            );
            expect(entryByArtifact.get(artifactId)).toBe(entry);
        }
    }, 180_000);

    it('gives each artifact its own Module Federation container', async () => {
        const config = await loadBuildConfig();
        const containers = config.targets.map((target) => target.module?.containerName);

        expect(containers.every((name) => typeof name === 'string' && name.length > 0)).toBe(true);
        expect(new Set(containers).size).toBe(config.targets.length);
    }, 180_000);

    it('names every surface export `renderSurface`, the only name web can load', async () => {
        const config = await loadBuildConfig();

        // On web the export name is unconfigurable by construction: a
        // `platform:'web'` artifact is forbidden from declaring Re.Pack module
        // identity, so the RN-web loader falls back to its hard default. A
        // surface whose source exports any other name resolves to nothing and
        // throws `invalid_surface_module` instead of mounting — while native,
        // which does carry `exportName`, keeps working and hides the break.
        for (const target of config.targets) {
            expect(target.module?.exportName, target.rendererId).toBe(WEB_SURFACE_EXPORT_NAME);

            const source = await readFile(new URL(`../${target.entry}`, import.meta.url), 'utf8');
            expect(
                new RegExp(`^export const ${WEB_SURFACE_EXPORT_NAME}\\b`, 'm').test(source),
                `${target.entry} must export ${WEB_SURFACE_EXPORT_NAME}`,
            ).toBe(true);
        }
    }, 180_000);

    it('leaves the bundler configuration to the canonical build owner', async () => {
        for (const configPath of ['vite.config.ts', 'rspack.config.mjs', 'react-native.config.cjs']) {
            await expect(readFile(new URL(`../${configPath}`, import.meta.url), 'utf8'))
                .rejects.toMatchObject({ code: 'ENOENT' });
        }
    });
});

import { readFileSync } from 'node:fs';

import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import {
    TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
    TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
} from './actions/actionsCatalogProtocol.js';
import { TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1, TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1 } from './composer/attachmentValue.js';
import { TRIAGE_APP_PAGE_LOCAL_ID_V1 } from './composer/openEntryDetails.js';
import {
    TRIAGE_ENTRIES_COMPACT_ARTIFACT_ID_V1,
    TRIAGE_ENTRIES_COMPACT_RENDERER_ID_V1,
    TRIAGE_ENTRY_PICKER_ARTIFACT_ID_V1,
    TRIAGE_ENTRY_PICKER_RENDERER_ID_V1,
    TRIAGE_LIST_PAGE_ARTIFACT_ID_V1,
    TRIAGE_LIST_PAGE_RENDERER_ID_V1,
    TRIAGE_SESSION_ENTRIES_ARTIFACT_ID_V1,
    TRIAGE_SESSION_ENTRIES_RENDERER_ID_V1,
    TRIAGE_SESSION_ENTRIES_VIEW_ID_V1,
} from './ui/contributions.js';
import {
    CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_SESSION_LINKS_FIELD,
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCES_FIELD,
    CORPUS_USER_MARKS_COLLECTION_ID,
    CORPUS_USER_MARKS_FIELD,
} from './corpus/collections/ids.js';

/**
 * The packaged artifact, not the source module.
 *
 * `src/manifest.ts` being right proves nothing about what a host installs: the
 * host reads `.happier-plugin/plugin.json`, and this package shipped one with
 * `ui.views`, `ui.renderers`, `composerAttachments` and `composerControls` all
 * empty while every source test was green. Importing the TypeScript manifest
 * here would reproduce exactly that blindness, so this file reads the generated
 * bytes and nothing else.
 */

type PackagedManifest = Readonly<{
    contributes: Readonly<{
        ui: Readonly<{
            views: readonly Readonly<{ id: string; container: string; renderer: string }>[];
            renderers: readonly Readonly<{ id: string; kind: string; artifact?: string }>[];
        }>;
        composerAttachments: readonly Readonly<{
            id: string;
            picker?: Readonly<{ renderer: string }>;
            runtime?: Readonly<Record<string, boolean>>;
        }>[];
        composerControls: readonly Readonly<{
            id: string;
            interaction: Readonly<{ kind: string; attachment?: string }>;
            compactRenderer?: Readonly<{ renderer: string }>;
        }>[];
        pluginContributionPoints: readonly Readonly<{ id: string }>[];
        actions: readonly Readonly<{ id: string }>[];
        settings: readonly Readonly<{
            id: string;
            fields: readonly Readonly<{ id: string; presentation?: Readonly<{ hidden?: boolean }> }>[];
        }>[];
        accountCollections: readonly Readonly<{
            id: string;
            identityFields?: readonly string[];
        }>[];
    }>;
}>;

function readPackagedManifest(): PackagedManifest {
    return JSON.parse(
        readFileSync(new URL('../.happier-plugin/plugin.json', import.meta.url), 'utf8'),
    ) as PackagedManifest;
}

describe('packaged PRs & Issues manifest', () => {
    it('ships exactly what the source manifest projects, fact for fact', () => {
        // The package-local half of `yarn test:migration:bundled-plugin-projections`.
        // That governance lane regenerates every bundled artifact and owns the
        // repository verdict, but it runs neither in this package's suite nor in
        // seconds — so an author changing the manifest, or moving the package
        // onto a different author path, learns nothing here until CI.
        //
        // Every other assertion in this file names one hand-picked fact and is
        // therefore blind to the rest. This one is the whole artifact: it fails
        // for any fact the source projection adds, drops or renames, which is
        // what makes it evidence that an author-path migration changed nothing
        // the host installs.
        const projected = parsePluginManifest(PLUGIN_MANIFEST);
        if (!projected.ok) {
            throw new Error(projected.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
        }

        expect(projected.manifest).toEqual(readPackagedManifest());
    });

    it('ships the aggregate app page and the Session-targeted panel', () => {
        const views = readPackagedManifest().contributes.ui.views;

        expect(views).toContainEqual(expect.objectContaining({
            id: TRIAGE_APP_PAGE_LOCAL_ID_V1,
            container: 'appPage',
            renderer: TRIAGE_LIST_PAGE_RENDERER_ID_V1,
        }));
        expect(views).toContainEqual(expect.objectContaining({
            id: TRIAGE_SESSION_ENTRIES_VIEW_ID_V1,
            container: 'rightSidebarTab',
            renderer: TRIAGE_SESSION_ENTRIES_RENDERER_ID_V1,
        }));
    });

    it('ships one built artifact for every renderer a declaration names', () => {
        const contributes = readPackagedManifest().contributes;
        const artifactByRenderer = new Map(
            contributes.ui.renderers.map((renderer) => [renderer.id, renderer.artifact] as const),
        );

        expect(artifactByRenderer.get(TRIAGE_LIST_PAGE_RENDERER_ID_V1))
            .toBe(TRIAGE_LIST_PAGE_ARTIFACT_ID_V1);
        expect(artifactByRenderer.get(TRIAGE_ENTRY_PICKER_RENDERER_ID_V1))
            .toBe(TRIAGE_ENTRY_PICKER_ARTIFACT_ID_V1);
        expect(artifactByRenderer.get(TRIAGE_ENTRIES_COMPACT_RENDERER_ID_V1))
            .toBe(TRIAGE_ENTRIES_COMPACT_ARTIFACT_ID_V1);
        expect(artifactByRenderer.get(TRIAGE_SESSION_ENTRIES_RENDERER_ID_V1))
            .toBe(TRIAGE_SESSION_ENTRIES_ARTIFACT_ID_V1);

        // Every renderer a view or a composer declaration names must exist.
        for (const view of contributes.ui.views) {
            expect(artifactByRenderer.has(view.renderer)).toBe(true);
        }
        for (const attachment of contributes.composerAttachments) {
            if (attachment.picker) expect(artifactByRenderer.has(attachment.picker.renderer)).toBe(true);
        }
        for (const control of contributes.composerControls) {
            if (control.compactRenderer) {
                expect(artifactByRenderer.has(control.compactRenderer.renderer)).toBe(true);
            }
        }
    });

    it('ships the Composer attachment, its picker and the control that opens it', () => {
        const contributes = readPackagedManifest().contributes;

        expect(contributes.composerAttachments).toContainEqual(expect.objectContaining({
            id: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
            picker: { renderer: TRIAGE_ENTRY_PICKER_RENDERER_ID_V1 },
            // Without the pre-dispatch role the draft carries an identity the
            // model can never read.
            runtime: expect.objectContaining({ resolveForDispatch: true }),
        }));
        expect(contributes.composerControls).toContainEqual(expect.objectContaining({
            id: TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1,
            interaction: expect.objectContaining({
                kind: 'attachmentPicker',
                attachment: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
            }),
            compactRenderer: { renderer: TRIAGE_ENTRIES_COMPACT_RENDERER_ID_V1 },
        }));
    });

    it('ships the mode-derived identity declaration of all three durable Collections', () => {
        // The Account encryption-transition owner refuses to relocate a live
        // row only for a Collection whose *admitted* contract declares
        // `identityFields`, and the admitted contract comes from these bytes.
        // A packaged manifest that omits the declaration admits a contract the
        // transition owner reads as ordinary, so a mode change rekeys past a
        // pin, a Session link and a configured source and strands all three at
        // addresses the plugin can no longer derive. `src/corpus/collections/
        // definitions.ts` being right is not evidence about this file.
        const collections = readPackagedManifest().contributes.accountCollections;
        const identityFieldsById = new Map(
            collections.map((collection) => [collection.id, collection.identityFields] as const),
        );

        expect(identityFieldsById.get(CORPUS_SOURCE_INSTANCES_COLLECTION_ID))
            .toEqual([CORPUS_SOURCE_INSTANCES_FIELD.instanceTag]);
        expect(identityFieldsById.get(CORPUS_SESSION_LINKS_COLLECTION_ID))
            .toEqual(expect.arrayContaining([
                CORPUS_SESSION_LINKS_FIELD.linkTag,
                CORPUS_SESSION_LINKS_FIELD.entryTag,
            ]));
        expect(identityFieldsById.get(CORPUS_USER_MARKS_COLLECTION_ID))
            .toEqual([CORPUS_USER_MARKS_FIELD.markTag]);
    });

    it('ships Account-KV-backed catalog Actions without a competing Settings contribution', () => {
        const contributes = readPackagedManifest().contributes;
        expect(contributes.settings).toEqual([]);
        expect(contributes.actions.map((action) => action.id))
            .toEqual(expect.arrayContaining([
                TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
                TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
            ]));
    });

    it('remains the target of the source contribution point rather than a contributor to one', () => {
        // Triage owns the point; sources are what carry
        // `targetedPluginContributions`. An empty one here is correct, and
        // asserting it keeps a later lane from "fixing" it by making the
        // aggregate contribute to itself.
        const contributes = readPackagedManifest().contributes as PackagedManifest['contributes']
            & Readonly<{ targetedPluginContributions: readonly unknown[] }>;

        expect(contributes.pluginContributionPoints).toHaveLength(1);
        expect(contributes.targetedPluginContributions).toEqual([]);
    });
});

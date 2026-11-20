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
    CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_SESSION_LINKS_FIELD,
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCES_FIELD,
    CORPUS_USER_MARKS_COLLECTION_ID,
    CORPUS_USER_MARKS_FIELD,
} from './corpus/collections/ids.js';

// CLI projection governance owns authored-to-packaged manifest equivalence.
function readManifest() {
    const projected = parsePluginManifest(PLUGIN_MANIFEST);
    if (!projected.ok) {
        throw new Error(projected.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
    }
    return projected.manifest;
}

describe('PRs & Issues manifest', () => {

    it('ships the aggregate app page and the Session-targeted panel', () => {
        const views = readManifest().contributes.ui.views;

        expect(views).toContainEqual(expect.objectContaining({
            id: TRIAGE_APP_PAGE_LOCAL_ID_V1,
            container: 'appPage',
            renderer: 'list-page',
        }));
        expect(views).toContainEqual(expect.objectContaining({
            id: 'session-entries',
            container: 'rightSidebarTab',
            renderer: 'session-entries-panel',
        }));
    });

    it('ships one built artifact for every renderer a declaration names', () => {
        const contributes = readManifest().contributes;
        const artifactByRenderer = new Map(
            contributes.ui.renderers.map((renderer) => [renderer.id, renderer.artifact] as const),
        );

        expect(artifactByRenderer.get('list-page'))
            .toBe('triage-list-page-native');
        expect(artifactByRenderer.get('entry-picker'))
            .toBe('triage-entry-picker-native');
        expect(artifactByRenderer.get('entries-compact'))
            .toBe('triage-entries-compact-native');
        expect(artifactByRenderer.get('session-entries-panel'))
            .toBe('triage-session-entries-native');

        // Every renderer a view or a composer declaration names must exist.
        for (const view of contributes.ui.views) {
            expect(artifactByRenderer.has(view.renderer)).toBe(true);
            if (view.column) expect(artifactByRenderer.has(view.column.renderer)).toBe(true);
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
        const contributes = readManifest().contributes;

        expect(contributes.composerAttachments).toContainEqual(expect.objectContaining({
            id: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
            picker: { renderer: 'entry-picker' },
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
            compactRenderer: { renderer: 'entries-compact' },
        }));
    });

    it('ships the mode-derived identity declaration of all three durable Collections', () => {
        // The Account encryption-transition owner refuses to relocate a live
        // row only for a Collection whose admitted contract declares
        // `identityFields`. A manifest that omits the declaration admits a contract the
        // transition owner reads as ordinary, so a mode change rekeys past a
        // pin, a Session link and a configured source and strands all three at
        // addresses the plugin can no longer derive.
        const collections = readManifest().contributes.accountCollections;
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
        const contributes = readManifest().contributes;
        expect(contributes.settings).toEqual([]);
        expect(contributes.actions.map((action) => action.id))
            .toEqual(expect.arrayContaining([
                TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
                TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
            ]));
    });

    it('owns the source contribution point and contributes the built-in personal task source', () => {
        // The aggregate owns the point; personal Account tasks use the same
        // admitted source contract as external trackers, not a bypass.
        const contributes = readManifest().contributes;

        // Sources, and the agent-actions point plugins declare agent action records at.
        expect(contributes.pluginContributionPoints.map((point) => point.id))
            .toEqual(['sources', 'agent-actions']);
        expect(contributes.targetedPluginContributions).toMatchObject([{
            id: 'internal',
            target: { pluginId: PLUGIN_MANIFEST.id, pointId: 'sources' },
            operations: {
                listInstances: 'internal/tasks/list-instances-v1',
                scan: 'internal/tasks/scan-v1',
                get: 'internal/tasks/get-v1',
            },
        }]);
    });
});

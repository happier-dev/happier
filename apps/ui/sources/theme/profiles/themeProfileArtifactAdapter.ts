import type { ArtifactIdScopeV1 } from '@happier-dev/protocol/artifacts/idScope';
import { THEME_ARTIFACT_KIND } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import type { ThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { HappyError } from '@/utils/errors/errors';
import { deleteArtifact } from '@/sync/api/artifacts/apiArtifacts';
import { createArtifactWithHeaderResultViaApi, fetchAndApplyArtifactChanges, fetchAndApplyArtifactsList, fetchArtifactWithBodyFromApi, updateArtifactWithHeaderViaApi } from '@/sync/engine/artifacts/syncArtifacts';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { projectThemeLibraryEntry, projectThemeMiniaturePalette, projectThemeProfileDocumentPresentation } from './themeProfilePresentation';
import { projectThemeProfileArtifactSummary, readThemeProfileArtifactDocument } from './themeProfileArtifactProjection';
import type { ThemeProfileArtifactAdapter, ThemeProfileArtifactRecord, ThemeProfileArtifactSummary } from './themeProfileLibrary';

export type ThemeProfileArtifactContext = Pick<Parameters<typeof createArtifactWithHeaderResultViaApi>[0],
    'credentials' | 'request' | 'readTransport' | 'serverId' | 'signal' | 'encryption' | 'artifactDataKeys'> & Readonly<{
    serverId: string;
    ownerAccountId: string;
    artifactIdScopes?: ReadonlyMap<string, ArtifactIdScopeV1>;
    readArtifacts(): Readonly<Record<string, DecryptedArtifact>>;
    applyArtifacts(rows: DecryptedArtifact[]): void;
    applyInventory?: Parameters<typeof fetchAndApplyArtifactsList>[0]['applyArtifacts'];
    isLoaded(): boolean;
    deleteArtifact(id: string): void;
}>;
/** Captured Account/transport scope is supplied once by Sync's existing Artifact admission. */
export function createThemeProfileArtifactAdapter(context: ThemeProfileArtifactContext): ThemeProfileArtifactAdapter {
    const get = async (id: string): Promise<ThemeProfileArtifactRecord | null> => {
        let row = context.readArtifacts()[id];
        if (!row?.isDecrypted || row.body === undefined) {
            const opened = await fetchArtifactWithBodyFromApi({ ...context, artifactId: id, ownerOnly: true, previousArtifacts: context.readArtifacts() });
            if (!opened) return null;
            const sourced = { ...opened, sourceServerId: context.serverId };
            context.applyArtifacts([sourced]); row = sourced;
        }
        return readThemeProfileArtifactDocument(row, { serverId: context.serverId, accountId: context.ownerAccountId });
    };
    const revision = (id: string, expectedRevision?: number) => {
        const row = context.readArtifacts()[id];
        if (!row) throw new Error('Theme Artifact is not loaded');
        // Theme writes always replace header and body together. The ordinary Artifact writer
        // enforces both revision numbers; use the captured body revision for Undo.
        return { headerVersion: row.headerVersion, bodyVersion: expectedRevision ?? row.bodyVersion ?? 0 };
    };
    return {
        async load() {
            if (context.isLoaded()) return;
            await fetchAndApplyArtifactsList({ ...context, kinds: [THEME_ARTIFACT_KIND], getCurrentArtifacts: context.readArtifacts, applyArtifacts: context.applyInventory ?? context.applyArtifacts });
            if (!context.isLoaded()) throw new HappyError('Theme library is unavailable', false, { code: 'artifact_content_unavailable' });
        },
        list() {
            const result: ThemeProfileArtifactSummary[] = [];
            for (const row of Object.values(context.readArtifacts())) {
                const summary = projectThemeProfileArtifactSummary(row, { serverId: context.serverId, accountId: context.ownerAccountId });
                if (summary) result.push(summary);
            }
            return result;
        },
        get,
        async getSummary(id) {
            const cached = context.readArtifacts()[id];
            const summary = cached ? projectThemeProfileArtifactSummary(cached, { serverId: context.serverId, accountId: context.ownerAccountId }) : null;
            if (summary) return summary;
            await fetchAndApplyArtifactChanges({ ...context, artifactIds: [id], getCurrentArtifacts: context.readArtifacts });
            const row = context.readArtifacts()[id];
            return row ? projectThemeProfileArtifactSummary(row, { serverId: context.serverId, accountId: context.ownerAccountId }) : null;
        },
        async save(document: ThemeProfileDocument, expectedRevision?: number) {
            const entry = projectThemeLibraryEntry(document);
            const palettes = Object.fromEntries(entry.modes!.map(mode => [mode, projectThemeMiniaturePalette(document.profile, mode)]));
            const header = { v: 1, kind: THEME_ARTIFACT_KIND, title: entry.name, mode: entry.mode, themeSource: entry.source,
                compatibility: entry.compatibility, palette: palettes[entry.mode], palettes };
            const body = JSON.stringify(document.raw);
            const id = document.profile.id;
            let created: boolean | undefined;
            let acknowledged: ThemeProfileArtifactRecord | null = null;
            if (expectedRevision === undefined) {
                const acknowledgement = await createArtifactWithHeaderResultViaApi({ ...context, idScope: context.artifactIdScopes?.get(id), artifactId: id, header, body, addArtifact: row => context.applyArtifacts([{ ...row, sourceServerId: context.serverId }]) });
                created = acknowledgement.created;
                acknowledged = readThemeProfileArtifactDocument({ ...acknowledgement.artifact, sourceServerId: context.serverId },
                    { serverId: context.serverId, accountId: context.ownerAccountId });
            } else {
                await updateArtifactWithHeaderViaApi({ ...context, artifactId: id, expectedRevision: revision(id, expectedRevision), header, body,
                    getArtifact: id => context.readArtifacts()[id], updateArtifact: row => {
                        context.applyArtifacts([{ ...row, sourceServerId: context.serverId }]);
                        acknowledged = { document: projectThemeProfileDocumentPresentation(document),
                            revision: row.bodyVersion ?? 0, headerVersion: row.headerVersion };
                    } });
            }
            if (!acknowledged) throw new Error('Theme Artifact acknowledgement missing document');
            return { id, ...acknowledged, ...(created === undefined ? {} : { created }) };
        },
        async delete(id, expectedRevision) {
            await deleteArtifact(context.credentials, id, { ...context, ...(expectedRevision === undefined ? {} : { expectedRevision: revision(id, expectedRevision) }) });
            context.deleteArtifact(id);
        },
    };
}

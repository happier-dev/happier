import { ThemeProfileArtifactHeaderSchema } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import { parseThemeProfileDocument, type ThemeLibraryEntry } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ThemeProfileArtifactRecord, ThemeProfileArtifactSummary } from './themeProfileLibrary';
import { projectThemeMiniature, projectThemeProfileDocumentPresentation } from './themeProfilePresentation';

// Artifact ingress retains structurally equal private headers. Preserve the projection identity
// across body/revision publications without parsing CSS or rebuilding a miniature per reader.
const entries = new WeakMap<object, ThemeLibraryEntry>();
export function readThemeProfileArtifactDocument(row: DecryptedArtifact, scope: ServerAccountScope): ThemeProfileArtifactRecord | null {
    if (!row.isDecrypted || row.ownerAccountId !== scope.accountId || row.access !== 'owner'
        || row.sourceServerId !== scope.serverId || typeof row.body !== 'string'
        || !ThemeProfileArtifactHeaderSchema.safeParse(row.rawHeader ?? row.header).success) return null;
    let raw: unknown;
    try { raw = JSON.parse(row.body); } catch { return null; }
    const parsed = parseThemeProfileDocument(raw);
    return parsed.ok && parsed.document.profile.id === row.id
        ? { document: projectThemeProfileDocumentPresentation(parsed.document), revision: row.bodyVersion ?? 0, headerVersion: row.headerVersion } : null;
}
export function projectThemeProfileArtifactSummary(row: DecryptedArtifact, scope: ServerAccountScope): ThemeProfileArtifactSummary | null {
    if (!row.isDecrypted || row.ownerAccountId !== scope.accountId || row.access !== 'owner' || row.sourceServerId !== scope.serverId) return null;
    const header = row.rawHeader ?? row.header;
    if (!header) return null;
    let entry = entries.get(header);
    if (entry?.id !== row.id) entry = undefined;
    if (!entry) {
        const parsed = ThemeProfileArtifactHeaderSchema.safeParse(header);
        if (!parsed.success) return null;
        const value = parsed.data;
        entry = { id: row.id, reference: { kind: 'artifact', id: row.id }, name: value.title, mode: value.mode, source: value.themeSource,
            editable: value.themeSource.kind === 'yours', deletable: value.themeSource.kind === 'yours' || value.themeSource.kind === 'store',
            compatibility: value.compatibility, miniature: projectThemeMiniature({
                assetAppearance: value.mode, overrides: { light: {}, dark: {}, [value.mode]: value.palette.overrides },
                seeds: value.palette.seeds, style: { radius: value.palette.radius } }) };
        entries.set(header, entry);
    }
    return { entry, revision: row.bodyVersion ?? 0, headerVersion: row.headerVersion };
}

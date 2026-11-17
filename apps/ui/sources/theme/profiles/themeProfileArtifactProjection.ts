import { ThemeProfileArtifactHeaderSchema } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import { parseThemeProfileDocument, type ThemeLibraryEntry, type ThemeMiniatureData, type ThemeProfileMode } from '@happier-dev/protocol/account/settings/themeProfiles';
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
        const palettes = { ...value.palettes, [value.mode]: value.palette };
        const modes = (['light', 'dark'] as const).filter(mode => palettes[mode] !== undefined);
        const miniatures: Partial<Record<ThemeProfileMode, ThemeMiniatureData>> = {};
        for (const mode of modes) {
            const palette = palettes[mode]!;
            miniatures[mode] = projectThemeMiniature({ assetAppearance: value.mode,
                overrides: { light: {}, dark: {}, [mode]: palette.overrides },
                seeds: palette.seeds, style: { radius: palette.radius } }, mode);
        }
        entry = { id: row.id, reference: { kind: 'artifact', id: row.id }, name: value.title, mode: value.mode, source: value.themeSource,
            editable: value.themeSource.kind === 'yours', deletable: value.themeSource.kind === 'yours' || value.themeSource.kind === 'store',
            compatibility: value.compatibility, miniature: miniatures[value.mode]!, modes, miniatures };
        entries.set(header, entry);
    }
    return { entry, revision: row.bodyVersion ?? 0, headerVersion: row.headerVersion };
}

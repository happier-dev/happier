import { ThemeProfileArtifactHeaderSchema, type ThemeProfileArtifactHeader } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import { parseThemeProfileDocument, type ThemeLibraryEntry, type ThemeMiniatureData, type ThemeProfileMode } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ThemeProfileArtifactRecord, ThemeProfileArtifactSummary } from './themeProfileLibrary';
import { projectThemeMiniature, projectThemeProfileDocumentPresentation } from './themeProfilePresentation';

// Artifact ingress retains structurally equal private headers. Preserve the projection identity
// across body/revision publications without parsing CSS or rebuilding a miniature per reader.
type AdmittedHeader = { header: ThemeProfileArtifactHeader; entry?: ThemeLibraryEntry };
const admittedHeaders = new WeakMap<object, AdmittedHeader>();

function readAdmittedHeader(row: DecryptedArtifact, scope: ServerAccountScope): AdmittedHeader | null {
    if (!row.isDecrypted || row.ownerAccountId !== scope.accountId || row.access !== 'owner' || row.sourceServerId !== scope.serverId) return null;
    const raw = row.rawHeader ?? row.header;
    if (!raw) return null;
    const admitted = admittedHeaders.get(raw);
    if (admitted) return admitted;
    const parsed = ThemeProfileArtifactHeaderSchema.safeParse(raw);
    if (!parsed.success) return null;
    const value = { header: parsed.data };
    admittedHeaders.set(raw, value);
    return value;
}

export function readThemeProfileArtifactHeader(row: DecryptedArtifact, scope: ServerAccountScope): ThemeProfileArtifactHeader | null {
    return readAdmittedHeader(row, scope)?.header ?? null;
}

export function readThemeProfileArtifactDocument(row: DecryptedArtifact, scope: ServerAccountScope): ThemeProfileArtifactRecord | null {
    if (typeof row.body !== 'string' || !readAdmittedHeader(row, scope)) return null;
    let raw: unknown;
    try { raw = JSON.parse(row.body); } catch { return null; }
    const parsed = parseThemeProfileDocument(raw);
    return parsed.ok && parsed.document.profile.id === row.id
        ? { document: projectThemeProfileDocumentPresentation(parsed.document), revision: row.bodyVersion ?? 0, headerVersion: row.headerVersion } : null;
}
export function projectThemeProfileArtifactSummary(row: DecryptedArtifact, scope: ServerAccountScope): ThemeProfileArtifactSummary | null {
    const admitted = readAdmittedHeader(row, scope);
    if (!admitted) return null;
    if (admitted.entry?.id !== row.id) {
        const value = admitted.header;
        const palettes = { ...value.palettes, [value.mode]: value.palette };
        const modes = (['light', 'dark'] as const).filter(mode => palettes[mode] !== undefined);
        const miniatures: Partial<Record<ThemeProfileMode, ThemeMiniatureData>> = {};
        for (const mode of modes) {
            const palette = palettes[mode]!;
            miniatures[mode] = projectThemeMiniature({ assetAppearance: value.mode,
                overrides: { light: {}, dark: {}, [mode]: palette.overrides },
                seeds: palette.seeds, style: { radius: palette.radius } }, mode);
        }
        admitted.entry = { id: row.id, reference: { kind: 'artifact', id: row.id }, name: value.title, mode: value.mode, source: value.themeSource,
            editable: value.themeSource.kind === 'yours', deletable: value.themeSource.kind === 'yours' || value.themeSource.kind === 'store',
            compatibility: value.compatibility, miniature: miniatures[value.mode]!, modes, miniatures };
    }
    return { entry: admitted.entry, revision: row.bodyVersion ?? 0, headerVersion: row.headerVersion };
}

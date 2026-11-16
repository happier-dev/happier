import { describe, expect, it } from 'vitest';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { projectThemeProfileArtifactSummary, readThemeProfileArtifactDocument } from './themeProfileArtifactProjection';

import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { ThemeProfileArtifactHeaderSchema } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import { projectThemeLibraryEntry, projectThemeMiniaturePalette } from './themeProfilePresentation';

const scope = { serverId: 'home', accountId: 'account' };
describe('theme Artifact header projection', () => {
    it('opens an admitted retained document with an unseeded miniature header', () => {
        const parsed = parseThemeProfileDocument({ schemaVersion: 2, id: '11111111-1111-4111-8111-111111111111', name: 'Retained',
            createdAt: 'old', updatedAt: 'old', base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
            style: { futurePresentation: { glow: true } }, css: '.surface { color: red; }' });
        if (!parsed.ok) throw new Error(parsed.error);
        const entry = projectThemeLibraryEntry(parsed.document);
        const rawHeader = { v: 1, kind: 'theme_profile.v1', title: entry.name, mode: entry.mode, themeSource: entry.source,
            compatibility: entry.compatibility, palette: projectThemeMiniaturePalette(parsed.document.profile) };
        expect(ThemeProfileArtifactHeaderSchema.safeParse(rawHeader)).toMatchObject({ success: true });
        const row: DecryptedArtifact = { id: parsed.document.profile.id, title: entry.name, rawHeader,
            body: JSON.stringify(parsed.document.raw), isDecrypted: true, ownerAccountId: scope.accountId, access: 'owner',
            sourceServerId: scope.serverId, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 0, updatedAt: 0 };
        expect(readThemeProfileArtifactDocument(row, scope)?.document.raw).toEqual(parsed.document.raw);
    });
    it('derives forty miniatures from headers without reading bodies, retaining their identity', () => {
        let bodyReads = 0;
        const rows = Array.from({ length: 40 }, (_, index): DecryptedArtifact => ({ id: `theme-${index}`, sourceServerId: scope.serverId,
            ownerAccountId: scope.accountId, access: 'owner', isDecrypted: true, title: 'Theme', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 0, updatedAt: 0,
            rawHeader: { v: 1, kind: 'theme_profile.v1', title: 'Theme', mode: 'dark', themeSource: { kind: 'yours' },
                compatibility: { status: 'supported', unsupportedPaths: [] }, palette: { seeds: { canvas: '#172033', accent: '#aabbcc' }, overrides: { 'text.secondary': '#999999' }, radius: 'sharp' } },
            get body() { bodyReads++; return '.surface { color: red; }'.repeat(1000); } }));
        const entries = rows.map(row => projectThemeProfileArtifactSummary(row, scope)!);
        expect(entries).toHaveLength(40);
        expect(entries[0].entry.miniature).toMatchObject({ canvas: '#172033', accent: '#aabbcc', mutedText: '#999999', radius: 'sharp' });
        rows[0].bodyVersion = 2;
        expect(projectThemeProfileArtifactSummary(rows[0], scope)?.entry).toBe(entries[0].entry);
        expect(bodyReads).toBe(0);
        expect(projectThemeProfileArtifactSummary(rows[0], { ...scope, accountId: 'other' })).toBeNull();
    });
});

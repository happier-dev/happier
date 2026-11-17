import { describe, expect, it } from 'vitest';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import type { RegistryProvenanceV1 } from '@happier-dev/protocol/registries';
import { projectStoreThemeCard, projectStoreThemeCoverageFacts, themeSummaryMatchesMode, groupInstalledStoreThemes, projectInstalledStoreThemeRows } from './storeThemes';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { projectThemeLibraryEntry } from '@/theme/profiles/themeProfilePresentation';
import { t } from '@/text';

const summary: RegistryCatalogItemSummary = { kind: 'theme', sourceId: 'open-vsx', itemId: 'publisher/theme', title: 'A theme', version: '1.0.0' };
const provenance = { sourceId: 'catalog', format: 'happier-catalog', sourceUrl: 'https://catalog.example.test', itemId: 'paper', ref: { kind: 'version', version: '1.0.0' }, importedAt: 0 } satisfies RegistryProvenanceV1;
function entry(id: string, contributionId: string, own = false) {
    const parsed = parseThemeProfileDocument({ schemaVersion: 1, id: `store-${id}`, name: id, createdAt: '2026-11-16', updatedAt: '2026-11-16', base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, assetAppearance: contributionId === 'light' ? 'light' : 'dark', source: own ? { kind: 'yours' } : { kind: 'store', provenance, contributionId } });
    if (!parsed.ok) throw new Error('Invalid fixture');
    return projectThemeLibraryEntry(parsed.document);
}

describe('Store theme metadata projection', () => {
    it('keeps unknown-mode listings in Any without claiming either mode or inventing a miniature', () => {
        expect(themeSummaryMatchesMode(summary, null)).toBe(true);
        expect(themeSummaryMatchesMode(summary, 'light')).toBe(false);
        expect(themeSummaryMatchesMode(summary, 'dark')).toBe(false);
        expect(projectStoreThemeCard(summary, 'Open VSX').faces).toEqual([]);
        const unknown = { ...summary, themeMetadata: { includes: [{ key: 'unclassified', label: 'Unclassified' }] } };
        expect(themeSummaryMatchesMode(unknown, 'dark')).toBe(false);
        expect(projectStoreThemeCard(unknown, 'Open VSX').summary).toBe('');
    });

    it('uses published face modes and miniatures without loading documents', () => {
        const dark = entry('dark', 'dark').miniature;
        const item = { ...summary, themeMetadata: { includes: [{ key: 'dark', label: 'Midnight', mode: 'dark' as const }], preview: [dark] } };
        expect(themeSummaryMatchesMode(item, 'dark')).toBe(true);
        expect(themeSummaryMatchesMode(item, 'light')).toBe(false);
        expect(projectStoreThemeCard(item, 'Catalog').faces).toBe(item.themeMetadata.preview);
        expect(projectStoreThemeCard(item, 'Catalog').summary).toBe(t('themeCard.dark'));
    });

    it('groups installed faces into one source-qualified update demand and leaves editable duplicates out', () => {
        const dark = entry('dark', 'dark');
        const light = entry('light', 'light');
        const duplicate = entry('copy', 'dark', true);
        const groups = groupInstalledStoreThemes([dark, light, duplicate]);
        expect(groups).toHaveLength(1);
        expect(groups[0]?.entries).toEqual([dark, light]);
        expect(groups[0]?.listing).toEqual({ sourceId: 'catalog', itemId: 'paper' });
        const sibling = { ...dark, source: { kind: 'store' as const, provenance: { ...provenance, sourceId: 'another-catalog' }, contributionId: 'dark' } };
        expect(groupInstalledStoreThemes([dark, sibling])).toHaveLength(2);
    });

    it('projects installed listings with captured Account scope and every face provenance', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const dark = entry('dark', 'dark');
        const light = entry('light', 'light');
        const rows = projectInstalledStoreThemeRows([dark, light, entry('copy', 'dark', true)], scope);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'theme', scope,
            native: { listing: { sourceId: 'catalog', itemId: 'paper' }, entries: [dark, light] } });
        expect(projectInstalledStoreThemeRows([dark], { ...scope, accountId: 'other' })[0]?.key).not.toBe(rows[0]?.key);
    });
});

describe('Store theme modes', () => {
    it('says a two-face listing covers light and dark once, not as two facts', () => {
        const both = { ...summary, themeMetadata: { includes: [{ key: 'day', label: 'Day', mode: 'light' as const }, { key: 'night', label: 'Night', mode: 'dark' as const }] } };
        expect(projectStoreThemeCard(both, 'Open VSX').summary).toBe(t('themeStore.lightAndDark'));
        const dark = { ...summary, themeMetadata: { includes: [{ key: 'night', label: 'Night', mode: 'dark' as const }] } };
        expect(projectStoreThemeCard(dark, 'Open VSX').summary).toBe(t('themeCard.dark'));
    });
});

describe('Store theme listing coverage facts', () => {
    it('says a colours-only theme works everywhere, without zero rule counts', () => {
        const facts = projectStoreThemeCoverageFacts({ total: 0, native: 0, webOnly: 0, affectedSurfaces: [] });
        expect(facts.changes).toBe(t('themeStore.colorsOnly'));
        expect(facts.worksOn).toEqual({ value: t('themeStore.everywhere') });
    });

    it('names what CSS reshapes and counts phone rules only when some stay on web and desktop', () => {
        const reshaping = projectStoreThemeCoverageFacts({ total: 14, native: 11, webOnly: 3, affectedSurfaces: [{ surface: 'session-row' }] });
        expect(reshaping.changes).toContain(t('themeCard.reshapes', { areas: 'session list' }));
        expect(reshaping.worksOn).toEqual({ value: t('themeStore.everywhere'), note: t('themeCard.coverage', { native: 11, total: 14 }) });
        const portable = projectStoreThemeCoverageFacts({ total: 2, native: 2, webOnly: 0, affectedSurfaces: [{ surface: 'composer' }] });
        expect(portable.worksOn).toEqual({ value: t('themeStore.everywhere') });
    });
});

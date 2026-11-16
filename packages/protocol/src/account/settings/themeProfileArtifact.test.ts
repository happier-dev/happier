import { describe, expect, it } from 'vitest';
import { withArtifactExcerptV1 } from '../../artifacts/artifactExcerptV1.js';
import { getArtifactKindPolicyV1 } from '../../artifacts/artifactSharingV1.js';
import { THEME_ARTIFACT_KIND, ThemeProfileArtifactHeaderSchema } from './themeProfileArtifact.js';

describe('theme Artifact header and kind policy', () => {
    it('keeps themes out of Docs/public sharing and uses bodyless Account-change delivery', () => {
        expect(getArtifactKindPolicyV1(THEME_ARTIFACT_KIND)).toMatchObject({ browserListed: false, ownerDeleteAllowed: true,
            publicLinkAllowed: false, peopleSharingAllowed: false, legacySocketPublication: false });
        expect(getArtifactKindPolicyV1('ordinary-document')).toMatchObject({ browserListed: true, legacySocketPublication: true });
    });
    it('does not append theme CSS as a generic Doc excerpt', () => {
        expect(withArtifactExcerptV1({ kind: THEME_ARTIFACT_KIND, title: 'Theme' }, JSON.stringify({ css: 'body { color: red; }' }))).not.toHaveProperty('excerpt');
        expect(withArtifactExcerptV1({ title: 'Doc' }, 'Hello')).toHaveProperty('excerpt', 'Hello');
    });
    it('accepts compact authored palette inputs, with CSS absent from the header', () => {
        const header = ThemeProfileArtifactHeaderSchema.parse({ v: 1, kind: THEME_ARTIFACT_KIND, title: 'Theme', mode: 'dark', themeSource: { kind: 'yours' },
            compatibility: { status: 'supported', unsupportedPaths: [] }, palette: { seeds: { canvas: '#112233', accent: '#aabbcc' }, overrides: { 'text.primary': '#eeeeee' }, radius: 'round' } });
        expect(header.palette.seeds?.canvas).toBe('#112233');
        expect(header).not.toHaveProperty('miniature');
    });
});

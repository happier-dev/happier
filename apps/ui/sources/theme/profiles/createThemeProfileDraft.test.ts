import { describe, expect, it } from 'vitest';

import { createThemeProfileDraft, resetThemeProfileDraftMode, resetThemeProfileDraftToken, updateThemeProfileDraftColor } from './createThemeProfileDraft';
import { THEME_PROFILE_MAX_OVERRIDES_PER_MODE } from './themeProfileConstants';
import type { ThemeProfileV1 } from './themeProfileTypes';

const now = '2026-05-11T12:00:00.000Z';
const sourceProfile: ThemeProfileV1 = {
    schemaVersion: 1,
    id: 'source',
    name: 'Source',
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    base: { light: 'light', dark: 'dark' },
    overrides: {
        light: { 'background.canvas': '#fafafa' },
        dark: { 'background.canvas': '#0A0A0B' },
    },
};
const sourceProfileWithDarkAssets: ThemeProfileV1 & { assetAppearance: 'dark' } = {
    ...sourceProfile,
    assetAppearance: 'dark',
};

describe('createThemeProfileDraft', () => {
    it('creates a draft profile from base canonical themes', () => {
        const draft = createThemeProfileDraft({ id: 'draft', name: 'Draft', now });

        expect(draft).toEqual({
            schemaVersion: 1,
            id: 'draft',
            name: 'Draft',
            createdAt: now,
            updatedAt: now,
            base: { light: 'light', dark: 'dark' },
            overrides: { light: {}, dark: {} },
        });
    });

    it('clones an existing profile without retaining identity or timestamps', () => {
        const draft = createThemeProfileDraft({ id: 'clone', name: 'Clone', now, sourceProfile: sourceProfileWithDarkAssets });

        expect(draft.id).toBe('clone');
        expect(draft.name).toBe('Clone');
        expect(draft.createdAt).toBe(now);
        expect(draft.updatedAt).toBe(now);
        expect(draft.overrides).toEqual(sourceProfile.overrides);
        expect(draft.overrides).not.toBe(sourceProfile.overrides);
        expect((draft as ThemeProfileV1 & { assetAppearance?: string }).assetAppearance).toBe('dark');
    });

    it('updates, resets one token, and resets one mode immutably', () => {
        const draft = createThemeProfileDraft({ id: 'draft', name: 'Draft', now, sourceProfile });
        const edited = updateThemeProfileDraftColor(draft, 'light', 'surface.base', '#eeeeee', '2026-05-11T12:01:00.000Z');
        const resetToken = resetThemeProfileDraftToken(edited, 'light', 'background.canvas', '2026-05-11T12:02:00.000Z');
        const resetMode = resetThemeProfileDraftMode(resetToken, 'light', '2026-05-11T12:03:00.000Z');

        expect(edited.overrides.light).toEqual({ 'background.canvas': '#fafafa', 'surface.base': '#eeeeee' });
        expect(draft.overrides.light).toEqual({ 'background.canvas': '#fafafa' });
        expect(resetToken.overrides.light).toEqual({ 'surface.base': '#eeeeee' });
        expect(resetMode.overrides.light).toEqual({});
        expect(resetMode.overrides.dark).toEqual({ 'background.canvas': '#0A0A0B' });
    });

    it('does not add draft overrides beyond the per-mode limit', () => {
        const fullOverrides = Object.fromEntries(
            Array.from({ length: THEME_PROFILE_MAX_OVERRIDES_PER_MODE }, (_, index) => [`legacy.${index}`, '#ffffff']),
        );
        const draft: ThemeProfileV1 = {
            ...sourceProfile,
            overrides: { light: fullOverrides, dark: {} },
        };

        const edited = updateThemeProfileDraftColor(draft, 'light', 'background.canvas', '#eeeeee', '2026-05-11T12:01:00.000Z');

        expect(edited).toBe(draft);
    });
});

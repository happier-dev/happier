import { describe, expect, it } from 'vitest';

import { createThemeProfileDraft, resetThemeProfileDraftMode, resetThemeProfileDraftToken, updateThemeProfileDraftColor } from './createThemeProfileDraft';
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

    it('clones all presentation fields while replacing identity, timestamps and provenance', () => {
        const richerSource = {
            ...sourceProfileWithDarkAssets,
            seeds: { canvas: '#101010', accent: '#fedcba' },
            style: { radius: 'round' as const, fontFamily: 'system' },
            css: '[data-happier-surface] { opacity: 0.9; }',
            futurePresentation: { texture: 'paper' },
            source: { kind: 'plugin' as const, pluginId: 'custom-theme', contributionId: 'midnight' },
        };
        const draft = createThemeProfileDraft({ id: 'clone', name: 'Clone', now, sourceProfile: richerSource });

        expect(draft.id).toBe('clone');
        expect(draft.name).toBe('Clone');
        expect(draft.createdAt).toBe(now);
        expect(draft.updatedAt).toBe(now);
        expect(draft).toMatchObject({
            seeds: richerSource.seeds, style: richerSource.style, css: richerSource.css,
            futurePresentation: richerSource.futurePresentation, source: { kind: 'yours' },
        });
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

    it('edits a visible token while retaining 300 opaque draft overrides', () => {
        const fullOverrides = Object.fromEntries(
            Array.from({ length: 300 }, (_, index) => [`legacy.${index}`, '#ffffff']),
        );
        const draft: ThemeProfileV1 = {
            ...sourceProfile,
            overrides: { light: fullOverrides, dark: {} },
        };

        const edited = updateThemeProfileDraftColor(draft, 'light', 'background.canvas', '#eeeeee', '2026-05-11T12:01:00.000Z');

        expect(edited.overrides.light).toEqual({ ...fullOverrides, 'background.canvas': '#eeeeee' });
        expect(draft.overrides.light).toEqual(fullOverrides);
    });
});

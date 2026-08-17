import { describe, expect, it } from 'vitest';

import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import { readThemeProfilePathValue } from '@/theme/profiles/themeProfilePathAccess';
import { getThemeProfileTokenDefinition } from '@/theme/profiles/themeProfileTokenRegistry';
import type { ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';

import {
    PLUGIN_UI_THEME_COLOR_TOKEN_IDS,
    projectPluginUiTheme,
} from './pluginUiThemeProjection';

function themeFor(profile: ThemeProfileV1 | null, mode: ThemeProfileMode = 'light') {
    return resolveThemeProfile({ mode, profile });
}

function builtInProfile(index: number): ThemeProfileV1 {
    const definition = BUILT_IN_THEME_PROFILES[index];
    if (!definition) throw new Error('missing built-in theme profile fixture');
    return definition.profile;
}

describe('plugin UI semantic theme projection (§3.3, UI-D12)', () => {
    it('projects every colour field from the canonical token it names', () => {
        for (const profile of [null, builtInProfile(0), builtInProfile(1)]) {
            for (const mode of ['light', 'dark'] as const) {
                const theme = themeFor(profile, mode);
                const projected = projectPluginUiTheme(theme);
                for (const [field, tokenId] of Object.entries(PLUGIN_UI_THEME_COLOR_TOKEN_IDS)) {
                    const definition = getThemeProfileTokenDefinition(tokenId);
                    expect(definition, `${tokenId} must be a canonical editable theme token`).toBeDefined();
                    const canonical = readThemeProfilePathValue(theme.colors, definition?.path ?? []);
                    expect(canonical, `${tokenId} must resolve on the active theme`).toBeTruthy();
                    expect(
                        projected.colors[field as keyof typeof PLUGIN_UI_THEME_COLOR_TOKEN_IDS],
                        `theme.colors.${field} must project ${tokenId}`,
                    ).toBe(canonical);
                }
            }
        }
    });

    it('follows the ACTIVE theme profile, not only the light/dark base', () => {
        // Two real built-in profiles resolved in the SAME mode: a projection
        // wired to a static generated default — or keyed on `theme.dark` alone —
        // cannot tell them apart.
        const first = projectPluginUiTheme(themeFor(builtInProfile(0), 'dark'));
        const second = projectPluginUiTheme(themeFor(builtInProfile(1), 'dark'));
        const changedFields = Object.keys(PLUGIN_UI_THEME_COLOR_TOKEN_IDS).filter((field) => (
            first.colors[field as keyof typeof first.colors]
                !== second.colors[field as keyof typeof second.colors]
        ));
        expect(changedFields.length).toBeGreaterThan(0);
    });

    it('projects a per-token profile override through to the snapshot', () => {
        // The strongest form of the same claim: one edited token moves exactly
        // the field that names it, so the projection reads the resolved profile
        // rather than a snapshot taken elsewhere.
        const base = builtInProfile(0);
        const overridden: ThemeProfileV1 = {
            ...base,
            id: `${base.id}-plugin-theme-fixture`,
            updatedAt: `${base.updatedAt}-plugin-theme-fixture`,
            overrides: {
                ...base.overrides,
                dark: { ...base.overrides.dark, [PLUGIN_UI_THEME_COLOR_TOKEN_IDS.canvas]: '#123456' },
            },
        };
        expect(projectPluginUiTheme(themeFor(overridden, 'dark')).colors.canvas).toBe('#123456');
        expect(projectPluginUiTheme(themeFor(base, 'dark')).colors.canvas).not.toBe('#123456');
    });

    it('exposes bounded geometry and typography and no elevation token', () => {
        const theme = themeFor(null);
        const projected = projectPluginUiTheme(theme);
        expect(projected.version).toBe(1);
        expect(projected.spacing).toEqual({
            xsmall: theme.margins.xs,
            small: theme.margins.sm,
            medium: theme.margins.md,
            large: theme.margins.lg,
            xlarge: theme.margins.xl,
        });
        expect(projected.radii.small).toBe(theme.borderRadius.sm);
        expect(projected.radii.control).toBe(theme.borderRadius.md);
        expect(projected.radii.panel).toBe(theme.borderRadius.xl);
        expect(projected.radii.pill).toBeGreaterThan(projected.radii.panel);
        for (const style of ['body', 'label', 'title', 'caption', 'code'] as const) {
            const entry = projected.typography[style];
            expect(entry.fontSize, `${style} font size`).toBeGreaterThan(0);
            expect(entry.lineHeight, `${style} line height`).toBeGreaterThanOrEqual(entry.fontSize);
        }
        expect(projected.typography.code.fontFamily).toBeTruthy();
        expect(projected).not.toHaveProperty('elevation');
    });
});

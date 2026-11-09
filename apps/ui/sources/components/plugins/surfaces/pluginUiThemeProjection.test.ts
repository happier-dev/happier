import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { GlassBackedInkContext, glassQuietThemeInks, resolveGlassBackedInk } from '@/components/ui/glass/glassBackedInk';

import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import { readThemeProfilePathValue } from '@/theme/profiles/themeProfilePathAccess';
import { getThemeProfileTokenDefinition } from '@/theme/profiles/themeProfileTokenRegistry';
import type { ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';

import { shadowLevelStyle } from '@/shadowElevation';

import {
    PLUGIN_UI_THEME_COLOR_TOKEN_IDS,
    projectPluginUiHostPalette,
    projectPluginUiTheme,
    usePluginUiHostPalette,
    readPluginUiHostTypography,
    usePluginUiTheme,
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
    it('retains same-realm and SDK theme inputs across Unistyles wrapper replacement, without losing profile geometry', async () => {
        const theme = themeFor(null, 'dark');
        const palette = await renderHook((input: typeof theme) => usePluginUiHostPalette(new Proxy(input, {})), { initialProps: theme });
        const firstPalette = palette.getCurrent();
        expect(await palette.rerender(theme)).toBe(firstPalette);
        const hook = await renderHook((input: typeof theme) => usePluginUiTheme(new Proxy(input, {})), { initialProps: theme });
        const initial = hook.getCurrent();
        expect(await hook.rerender(theme)).toBe(initial);
        const resized = { ...theme, borderRadius: { ...theme.borderRadius, lg: theme.borderRadius.lg + 2 } };
        const scoped = await renderHook(() => usePluginUiHostPalette(new Proxy(resized, {})));
        expect(scoped.getCurrent().searchFieldRadiusPx).toBe(resized.borderRadius.lg);
        expect(await palette.rerender(theme)).toBe(firstPalette);
        expect((await palette.rerender(resized)).searchFieldRadiusPx).toBe(resized.borderRadius.lg);
        const changed = { ...theme, space: { ...theme.space, s4: theme.space.s4 + 1 } };
        expect((await hook.rerender(changed)).spacing.xsmall).toBe(changed.space.s4);
        await hook.unmount();
        await palette.unmount();
        await scoped.unmount();
    });
    it('gives every plugin UI theme on backed glass the material\'s stronger faint ink, and the theme\'s own ink elsewhere', async () => {
        // A Home card's table, metric or snapshot draws its column headers and captions in this theme's quiet inks:
        // on glass with a picture behind it they take the same step core text takes there (FA22 GL1e).
        const theme = themeFor(null, 'dark');
        const projected = projectPluginUiTheme(theme);
        const backed = resolveGlassBackedInk(theme.colors.text.primary, theme.colors.text.secondary, glassQuietThemeInks(theme.colors));
        const onGlass = await renderHook(() => usePluginUiTheme(theme), {
            wrapper: ({ children }) => React.createElement(GlassBackedInkContext.Provider, { value: backed }, children),
        });
        const stepped = onGlass.getCurrent();
        expect(stepped.colors.secondaryText).toBe(backed.secondary);
        expect(stepped.colors.secondaryText).not.toBe(theme.colors.text.secondary);
        expect(stepped.colors.mutedText).toBe(backed.quiet?.ink);
        expect(stepped.colors.text).toBe(projected.colors.text);
        const plain = await renderHook(() => usePluginUiTheme(theme));
        expect(plain.getCurrent()).toEqual(projected);
        expect(plain.getCurrent().colors.secondaryText).toBe(theme.colors.text.secondary);
    });

    it('projects the host-selected spinner style and timing without replacing its semantic theme', () => {
        const theme = themeFor(null, 'dark');
        const spinner = { style: 'hWave', speed: 'slow', pause: 'long' };
        const projected = projectPluginUiTheme(theme, spinner);
        expect(projected.spinner).toEqual(spinner);
        expect(Reflect.set(projected.spinner!, 'style', 'changed plugin preference')).toBe(false);
        spinner.style = 'classicRing';
        expect(projected.spinner?.style).toBe('hWave');
        expect(projected.colors).toEqual(projectPluginUiTheme(theme).colors);
    });
    it('projects status text ink separately from marker colors for same-realm and hosted badges', () => {
        for (const mode of ['light', 'dark'] as const) {
            const theme = themeFor(null, mode);
            const projected = projectPluginUiTheme(theme);
            expect(projected.statusText).toBeDefined();
            for (const variant of ['success', 'warning', 'attention', 'danger', 'info', 'neutral'] as const) {
                expect(projected.statusText?.[variant]).toBe(theme.colors.state[variant].textForeground);
            }
            // The tints behind status words are the host's state backgrounds; attention borrows the warning tint.
            for (const variant of ['success', 'warning', 'danger', 'info', 'neutral'] as const) {
                expect(projected.statusTint?.[variant]).toBe(theme.colors.state[variant].background);
            }
            expect(projected.statusTint?.attention).toBe(theme.colors.state.warning.background);
        }
    });
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

    it('projects a real blue and purple for marks a person colours, in every built-in profile, never the accent and never each other', () => {
        for (const profile of [null, ...BUILT_IN_THEME_PROFILES.map((definition) => definition.profile)]) {
            for (const mode of ['light', 'dark'] as const) {
                const theme = themeFor(profile, mode);
                const projected = projectPluginUiTheme(theme);
                expect(projected.colors.blue).toBe(theme.colors.accent.blue);
                expect(projected.colors.blue).not.toBe(projected.colors.accent);
                expect(projected.colors.purple).toBe(theme.colors.accent.purple);
                expect(projected.colors.purple).not.toBe(projected.colors.blue);
            }
        }
    });

    it('projects the "needs you" attention ink — Brand\'s amber, not the system warning — to plugin surfaces', () => {
        for (const mode of ['light', 'dark'] as const) {
            const theme = themeFor(null, mode);
            const projected = projectPluginUiTheme(theme).colors as Record<string, string>;
            expect(projected.attention).toBe(theme.colors.state.attention.foreground);
        }
        expect(PLUGIN_UI_THEME_COLOR_TOKEN_IDS).toMatchObject({ attention: 'state.attention.foreground' });
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
            xsmall: theme.space.s4,
            small: theme.space.s8,
            medium: theme.space.s12,
            large: theme.space.s16,
            xlarge: theme.space.s20,
        });
        expect(projected.radii.small).toBe(theme.borderRadius.sm);
        expect(projected.radii.control).toBe(theme.borderRadius.md);
        expect(projected.radii.panel).toBe(theme.borderRadius.xl);
        expect(projected.radii.pill).toBeGreaterThan(projected.radii.panel);
        for (const style of ['body', 'reading', 'label', 'title', 'caption', 'code'] as const) {
            const entry = projected.typography[style];
            expect(entry.fontSize, `${style} font size`).toBeGreaterThan(0);
            expect(entry.lineHeight, `${style} line height`).toBeGreaterThanOrEqual(entry.fontSize);
        }
        expect(projected.typography.code.fontFamily).toBeTruthy();
        expect(projected).not.toHaveProperty('elevation');
    });

    it('projects a descending type ramp whose same-realm role styles agree with the snapshot', () => {
        const { typography } = projectPluginUiTheme(themeFor(null));
        const PLUGIN_UI_HOST_TYPOGRAPHY = readPluginUiHostTypography();
        // Headings over row titles over their own context line over metadata:
        // a row title smaller than its subtitle is the inversion this guards.
        expect(PLUGIN_UI_HOST_TYPOGRAPHY.title.fontSize).toBeGreaterThan(typography.title.fontSize);
        expect(typography.title.fontSize).toBeGreaterThan(typography.label.fontSize);
        expect(typography.label.fontSize).toBeGreaterThan(typography.body.fontSize);
        expect(typography.body.fontSize).toBeGreaterThan(typography.caption.fontSize);
        for (const [snapshot, role] of [['title', 'heading'], ['label', 'label'], ['body', 'body'], ['caption', 'micro']] as const) {
            expect(PLUGIN_UI_HOST_TYPOGRAPHY[role].fontSize, `${role} size`).toBe(typography[snapshot].fontSize);
            expect(PLUGIN_UI_HOST_TYPOGRAPHY[role].lineHeight, `${role} line height`).toBe(typography[snapshot].lineHeight);
        }
    });
    it('gives core and plugin page sheets the one W3 card: card fill, its own lip and grounding, and the card finish', () => {
        for (const mode of ['light', 'dark'] as const) {
            const theme = themeFor(null, mode);
            const palette = projectPluginUiHostPalette(theme);
            expect(palette.sheet).toBe(theme.colors.edge.cardFill);
            expect(palette.rowDivider).toBe(theme.colors.border.subtle);
            expect(palette.sheetEdge).toEqual({
                side: mode === 'light' ? 'bottom' : 'top',
                color: theme.colors.edge.surface,
                lift: shadowLevelStyle(theme.colors.shadowCard),
            });
            const finish = projectPluginUiTheme(theme).surfaceFinish;
            expect(finish?.card?.colors).toEqual([...theme.colors.edge.cardFinishGradient!.colors]);
            expect(finish?.floating?.colors).toEqual([...theme.colors.edge.finishGradient!.colors]);
        }
    });
});

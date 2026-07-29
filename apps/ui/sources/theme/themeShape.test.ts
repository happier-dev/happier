import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '.';

function collectLeafPaths(value: unknown, prefix = ''): string[] {
    if (value === null || typeof value !== 'object') {
        return [prefix];
    }

    if (Array.isArray(value)) {
        return value.flatMap((item, index) => collectLeafPaths(item, `${prefix}[${index}]`));
    }

    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
        const nextPrefix = prefix ? `${prefix}.${key}` : key;
        return collectLeafPaths(child, nextPrefix);
    });
}

describe('canonical theme color shape', () => {
    it('keeps the root theme module as a compatibility re-export', () => {
        const rootThemeModulePath = path.resolve(process.cwd(), 'sources/theme.ts');

        expect(statSync(rootThemeModulePath).isFile()).toBe(true);

        const contents = readFileSync(rootThemeModulePath, 'utf8');
        expect(contents).toMatch(/export\s+\*\s+from\s+['"]\.\/theme\/index['"]/);
        expect(contents).not.toMatch(/groupped|surfaceHigh|surfaceHighest|warningCritical|deleteAction/);
    });

    it('uses the public canvas, surface, border, effect, and chrome token shape', () => {
        expect(lightTheme.colors.background.canvas).toBe('#F5F5F5');
        expect(darkTheme.colors.background.canvas).toBe('#131111');

        expect(lightTheme.colors.surface.base).toBe('#ffffff');
        expect(lightTheme.colors.surface.inset).toBe('#F8F8F8');
        expect(lightTheme.colors.surface.elevated).toBe('#f0f0f0');
        expect(darkTheme.colors.surface.base).toBe('#191717');
        expect(darkTheme.colors.surface.inset).toBe('#171515');
        expect(darkTheme.colors.surface.elevated).toBe('#221C1C');

        expect(lightTheme.colors.surface.pressed).toBe('#fafafa');
        expect(lightTheme.colors.surface.selected).toBe('#f8f8f8');
        expect(lightTheme.colors.surface.pressedOverlay).toBe('#fafafa');
        expect(lightTheme.colors.surface.ripple).toBe('rgba(0, 0, 0, 0.08)');

        expect(lightTheme.colors.border.default).toBe('#eaeaea');
        expect(lightTheme.colors.border.surface).toBe('transparent');
        expect(lightTheme.colors.border.modal).toBe('rgba(0, 0, 0, 0.1)');
        expect(darkTheme.colors.border.default).toBe('rgba(255,255,255,0.050)');
        expect(darkTheme.colors.border.surface).toBe('rgba(255,255,255,0.056)');
        expect(darkTheme.colors.border.modal).toBe('rgba(255,255,255,0.064)');

        expect(lightTheme.colors.effect.surfaceHighlight).toBe('transparent');
        expect(darkTheme.colors.effect.surfaceHighlight).toBe('transparent');
        expect(lightTheme.colors.chrome.header.background).toBe('#ffffff');
        expect(lightTheme.colors.chrome.header.foreground).toBe('#18171C');
        expect(darkTheme.colors.chrome.header.background).toBe('#131111');
        expect(darkTheme.colors.chrome.header.foreground).toBe('#EFEFEF');

        expect(lightTheme.colors.composer.chipTint).toBe('#767676');
        expect(darkTheme.colors.composer.chipTint).toBe('#A79D97');
    });

    it('uses action foreground tokens for backgroundless permission buttons', () => {
        expect(lightTheme.colors.permissionButton.allow.text).toBe('#34C759');
        expect(lightTheme.colors.permissionButton.deny.text).toBe('#FF3B30');
        expect(lightTheme.colors.permissionButton.allowAll.text).toBe('#007AFF');

        expect(darkTheme.colors.permissionButton.allow.text).toBe('#66DC7E');
        expect(darkTheme.colors.permissionButton.deny.text).toBe('#EE6E6C');
        expect(darkTheme.colors.permissionButton.allowAll.text).toBe('#9EB9FF');
    });

    it('does not expose legacy groupped or flat surface tokens in the canonical color shape', () => {
        expect(lightTheme.colors).not.toHaveProperty('groupped');
        expect(lightTheme.colors).not.toHaveProperty('surfaceHigh');
        expect(lightTheme.colors).not.toHaveProperty('surfaceHighest');
        expect(lightTheme.colors).not.toHaveProperty('surfacePressed');
        expect(lightTheme.colors).not.toHaveProperty('surfaceSelected');
        expect(lightTheme.colors).not.toHaveProperty('surfacePressedOverlay');
        expect(lightTheme.colors).not.toHaveProperty('surfaceRipple');
        expect(lightTheme.colors).not.toHaveProperty('divider');
        expect(lightTheme.colors).not.toHaveProperty('header');
        expect(lightTheme.colors).not.toHaveProperty('modal');
    });

    it('uses canonical semantic, text, message, syntax, version-control, and diff color groups', () => {
        expect(darkTheme.colors).toHaveProperty('text.primary', '#EFEFEF');
        expect(darkTheme.colors).toHaveProperty('text.secondary', '#8A817C');
        expect(darkTheme.colors).toHaveProperty('text.tertiary', '#6C625D');
        expect(darkTheme.colors).toHaveProperty('text.link', '#9EB9FF');
        expect(darkTheme.colors).toHaveProperty('text.destructive', '#EE6E6C');
        expect(darkTheme.colors).toHaveProperty('composer.chipTint', '#A79D97');

        expect(darkTheme.colors).toHaveProperty('state.success.foreground', '#66DC7E');
        expect(darkTheme.colors).toHaveProperty('state.warning.foreground', '#E0B65A');
        expect(darkTheme.colors).toHaveProperty('state.danger.foreground', '#EE6E6C');
        expect(darkTheme.colors).toHaveProperty('state.info.foreground', '#9EB9FF');
        expect(darkTheme.colors).toHaveProperty('state.neutral.foreground', '#8A817C');
        expect(darkTheme.colors).toHaveProperty('state.active.foreground', '#9EB9FF');
        expect(darkTheme.colors).toHaveProperty('state.active.background', 'rgba(158, 185, 255, 0.12)');
        expect(darkTheme.colors).toHaveProperty('state.active.border', 'rgba(158, 185, 255, 0.50)');

        expect(darkTheme.colors).toHaveProperty('message.user.background', '#221C1C');
        expect(darkTheme.colors).toHaveProperty('message.user.foreground', '#EFEFEF');
        expect(darkTheme.colors).toHaveProperty('message.agent.foreground', '#EFEFEF');
        expect(darkTheme.colors).toHaveProperty('message.event.foreground', '#8A817C');

        expect(darkTheme.colors).toHaveProperty('syntax.keyword', '#9EB9FF');
        expect(darkTheme.colors).toHaveProperty('syntax.default', '#EFEFEF');
        expect(darkTheme.colors).toHaveProperty('versionControl.added.foreground', '#66DC7E');
        expect(darkTheme.colors).toHaveProperty('versionControl.removed.foreground', '#EE6E6C');
        expect(darkTheme.colors).toHaveProperty('diff.added.background', 'rgba(102, 220, 126, 0.12)');
        expect(darkTheme.colors).toHaveProperty('diff.removed.background', 'rgba(238, 110, 108, 0.12)');
        expect(darkTheme.colors).toHaveProperty('diff.hunk.background', 'rgba(158, 185, 255, 0.10)');
        expect(darkTheme.colors).toHaveProperty('diff.inlineAdded.background', 'rgba(102, 220, 126, 0.16)');
        expect(darkTheme.colors).toHaveProperty('diff.inlineRemoved.background', 'rgba(238, 110, 108, 0.16)');
    });

    it('does not expose legacy destructive, message, syntax, version-control, or terminal color fields', () => {
        expect(lightTheme.colors).not.toHaveProperty('textDestructive');
        expect(lightTheme.colors).not.toHaveProperty('deleteAction');
        expect(lightTheme.colors).not.toHaveProperty('warningCritical');
        expect(lightTheme.colors).not.toHaveProperty('warning');
        expect(lightTheme.colors).not.toHaveProperty('success');
        expect(lightTheme.colors).not.toHaveProperty('userMessageBackground');
        expect(lightTheme.colors).not.toHaveProperty('userMessageText');
        expect(lightTheme.colors).not.toHaveProperty('agentMessageText');
        expect(lightTheme.colors).not.toHaveProperty('agentEventText');
        expect(lightTheme.colors).not.toHaveProperty('syntaxKeyword');
        expect(lightTheme.colors).not.toHaveProperty('syntaxString');
        expect(lightTheme.colors).not.toHaveProperty('syntaxDefault');
        expect(lightTheme.colors).not.toHaveProperty('gitAddedText');
        expect(lightTheme.colors).not.toHaveProperty('gitRemovedText');
        expect(lightTheme.colors).not.toHaveProperty('terminal');
    });

    it('keeps light and dark color leaf shapes aligned', () => {
        expect(collectLeafPaths(darkTheme.colors).sort()).toEqual(collectLeafPaths(lightTheme.colors).sort());
    });
});

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
    it('uses the public canvas, surface, border, effect, and chrome token shape', () => {
        expect(lightTheme.colors.background.canvas).toBe('#F5F5F5');
        expect(darkTheme.colors.background.canvas).toBe('#181818');

        expect(lightTheme.colors.surface.base).toBe('#ffffff');
        expect(lightTheme.colors.surface.inset).toBe('#F8F8F8');
        expect(lightTheme.colors.surface.elevated).toBe('#f0f0f0');
        expect(darkTheme.colors.surface.base).toBe('#202020');
        expect(darkTheme.colors.surface.inset).toBe('#171717');
        expect(darkTheme.colors.surface.elevated).toBe('#292929');

        expect(lightTheme.colors.surface.pressed).toBe('#fafafa');
        expect(lightTheme.colors.surface.selected).toBe('#f8f8f8');
        expect(lightTheme.colors.surface.pressedOverlay).toBe('#fafafa');
        expect(lightTheme.colors.surface.ripple).toBe('rgba(0, 0, 0, 0.08)');

        expect(lightTheme.colors.border.default).toBe('#eaeaea');
        expect(lightTheme.colors.border.surface).toBe('transparent');
        expect(lightTheme.colors.border.modal).toBe('rgba(0, 0, 0, 0.1)');
        expect(darkTheme.colors.border.default).toBe('#292929');
        expect(darkTheme.colors.border.surface).toBe('transparent');
        expect(darkTheme.colors.border.modal).toBe('rgba(255, 255, 255, 0.1)');

        expect(lightTheme.colors.effect.surfaceHighlight).toBe('transparent');
        expect(darkTheme.colors.effect.surfaceHighlight).toBe('transparent');
        expect(lightTheme.colors.chrome.header.background).toBe('#ffffff');
        expect(lightTheme.colors.chrome.header.foreground).toBe('#18171C');
        expect(darkTheme.colors.chrome.header.background).toBe('#202020');
        expect(darkTheme.colors.chrome.header.foreground).toBe('#ffffff');
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
        expect(lightTheme.colors).toHaveProperty('text.primary', '#000000');
        expect(lightTheme.colors).toHaveProperty('text.secondary', '#6c6c70');
        expect(lightTheme.colors).toHaveProperty('text.tertiary', '#99999d');
        expect(lightTheme.colors).toHaveProperty('text.link', '#2BACCC');
        expect(lightTheme.colors).toHaveProperty('text.destructive', '#FF3B30');

        expect(lightTheme.colors).toHaveProperty('state.success.foreground', '#34C759');
        expect(lightTheme.colors).toHaveProperty('state.warning.foreground', '#FF9500');
        expect(lightTheme.colors).toHaveProperty('state.danger.foreground', '#FF3B30');
        expect(lightTheme.colors).toHaveProperty('state.info.foreground', lightTheme.colors.accent.indigo);
        expect(lightTheme.colors).toHaveProperty('state.neutral.foreground', '#8E8E93');
        expect(lightTheme.colors).toHaveProperty('state.active.foreground', '#007AFF');
        expect(lightTheme.colors).toHaveProperty('state.active.background', 'rgba(0, 122, 255, 0.10)');
        expect(lightTheme.colors).toHaveProperty('state.active.border', 'rgba(0, 122, 255, 0.40)');

        expect(lightTheme.colors).toHaveProperty('message.user.background', '#f0eee6');
        expect(lightTheme.colors).toHaveProperty('message.user.foreground', '#000000');
        expect(lightTheme.colors).toHaveProperty('message.agent.foreground', '#000000');
        expect(lightTheme.colors).toHaveProperty('message.event.foreground', '#666666');

        expect(lightTheme.colors).toHaveProperty('syntax.keyword', '#1d4ed8');
        expect(lightTheme.colors).toHaveProperty('syntax.default', '#374151');
        expect(lightTheme.colors).toHaveProperty('versionControl.added.foreground', '#22c55e');
        expect(lightTheme.colors).toHaveProperty('versionControl.removed.foreground', '#ef4444');
        expect(lightTheme.colors).toHaveProperty('diff.added.background', '#E6FFED');
        expect(lightTheme.colors).toHaveProperty('diff.removed.background', '#FFEEF0');
        expect(lightTheme.colors).toHaveProperty('diff.hunk.background', '#F1F8FF');
        expect(lightTheme.colors).toHaveProperty('diff.inlineAdded.background', '#ACFFA6');
        expect(lightTheme.colors).toHaveProperty('diff.inlineRemoved.background', '#FFCECB');
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

import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '@/theme';
import * as themeColorTokenDefinitionsModule from './themeColorTokenDefinitions';
import {
    EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS,
    getEditableThemeColorTokenDefinition,
    resolveThemeColorTokenBaseValue,
} from './themeColorTokenDefinitions';

type ThemeColorTokenClassification = Readonly<{
    path: readonly string[];
    status: 'internal' | 'derived' | 'deprecated';
    reason: string;
}>;

const tokenDefinitionsModule = themeColorTokenDefinitionsModule as typeof themeColorTokenDefinitionsModule & Readonly<{
    THEME_COLOR_TOKEN_CLASSIFICATIONS?: readonly ThemeColorTokenClassification[];
}>;

const requiredTokenIds = [
    'background.canvas',
    'surface.base',
    'surface.inset',
    'surface.elevated',
    'surface.pressed',
    'surface.selected',
    'surface.pressedOverlay',
    'surface.ripple',
    'border.default',
    'border.surface',
    'border.strong',
    'border.modal',
    'effect.surfaceHighlight',
    'chrome.header.background',
    'chrome.header.foreground',
    'text.primary',
    'text.secondary',
    'text.tertiary',
    'text.link',
    'text.destructive',
    'text.placeholder',
    'text.disabled',
    'state.success.foreground',
    'state.success.background',
    'state.success.border',
    'state.warning.foreground',
    'state.warning.background',
    'state.warning.border',
    'state.danger.foreground',
    'state.danger.background',
    'state.danger.border',
    'state.info.foreground',
    'state.info.background',
    'state.info.border',
    'state.neutral.foreground',
    'state.neutral.background',
    'state.neutral.border',
    'state.active.foreground',
    'state.active.background',
    'state.active.border',
    'control.button.primary.background',
    'control.button.primary.foreground',
    'control.button.primary.disabled',
    'control.button.secondary.background',
    'control.button.secondary.foreground',
    'control.input.background',
    'control.input.foreground',
    'control.input.placeholder',
    'control.switch.track.active',
    'control.switch.track.inactive',
    'control.switch.thumb.active',
    'control.switch.thumb.inactive',
    'control.radio.active',
    'control.radio.inactive',
    'control.radio.dot',
    'control.segmentedControl.trackBackground',
    'control.segmentedControl.activeBackground',
    'control.fab.background',
    'control.fab.backgroundPressed',
    'control.fab.foreground',
    'control.permissionButton.allow.background',
    'control.permissionButton.allow.foreground',
    'control.permissionButton.deny.background',
    'control.permissionButton.deny.foreground',
    'control.permissionButton.allowAll.background',
    'control.permissionButton.allowAll.foreground',
    'control.permissionButton.inactive.background',
    'control.permissionButton.inactive.border',
    'control.permissionButton.inactive.foreground',
    'control.permissionButton.selected.background',
    'control.permissionButton.selected.border',
    'control.permissionButton.selected.foreground',
    'message.user.background',
    'message.user.foreground',
    'message.agent.foreground',
    'message.event.foreground',
    'syntax.keyword',
    'syntax.string',
    'syntax.comment',
    'syntax.number',
    'syntax.function',
    'syntax.default',
    'versionControl.added.foreground',
    'versionControl.removed.foreground',
    'versionControl.added.background',
    'versionControl.removed.background',
    'diff.added.background',
    'diff.added.foreground',
    'diff.removed.background',
    'diff.removed.foreground',
    'diff.hunk.background',
    'diff.hunk.foreground',
    'diff.context.foreground',
    'diff.inlineAdded.background',
    'diff.inlineAdded.foreground',
    'diff.inlineRemoved.background',
    'diff.inlineRemoved.foreground',
    'permission.default',
    'permission.acceptEdits',
    'permission.bypass',
    'permission.plan',
    'permission.readOnly',
    'permission.safeYolo',
    'permission.yolo',
    'overlay.scrimSoft',
    'overlay.scrim',
    'overlay.scrimStrong',
    'overlay.scrimWizard',
    'overlay.foreground',
    'overlay.secondaryForeground',
] as const;

const legacyFragments = [
    'groupped',
    'surfaceHigh',
    'surfaceHighest',
    'surfacePressed',
    'surfaceSelected',
    'surfacePressedOverlay',
    'surfaceRipple',
    'divider',
    'header.tint',
    'modal.border',
    'warningCritical',
    'deleteAction',
    'textDestructive',
    'userMessageBackground',
    'syntaxKeyword',
    'gitAddedText',
    'terminal',
    'accent',
    'status',
] as const;

describe('editable theme color token definitions', () => {
    it('declares the public token contract for canvas, surface, state, controls, message, syntax, version control, diff, permission, and overlay colors', () => {
        const ids = EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS.map((definition) => definition.id);

        for (const tokenId of requiredTokenIds) {
            expect(ids).toContain(tokenId);
        }
    });

    it('maps every editable public token to concrete light and dark base theme values', () => {
        for (const definition of EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS) {
            expect(definition.label).toBeTruthy();
            expect(definition.description).toBeTruthy();
            expect(definition.group).toBeTruthy();
            expect(definition.path.length).toBeGreaterThan(0);
            expect(resolveThemeColorTokenBaseValue(lightTheme, definition.id)).toEqual(expect.any(String));
            expect(resolveThemeColorTokenBaseValue(darkTheme, definition.id)).toEqual(expect.any(String));
        }
    });

    it('does not expose legacy aliases or non-color theme values as editable public token ids', () => {
        const ids = EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS.map((definition) => definition.id);

        for (const id of ids) {
            const pathSegments = id.split('.');
            for (const legacyFragment of legacyFragments) {
                if (legacyFragment.includes('.')) {
                    expect(id).not.toBe(legacyFragment);
                } else {
                    expect(pathSegments).not.toContain(legacyFragment);
                }
            }
        }

        expect(getEditableThemeColorTokenDefinition('margins.lg')).toBeUndefined();
        expect(getEditableThemeColorTokenDefinition('borderRadius.md')).toBeUndefined();
        expect(getEditableThemeColorTokenDefinition('shadowLevels.0.boxShadow')).toBeUndefined();
        expect(getEditableThemeColorTokenDefinition('fab.gradient')).toBeUndefined();
    });

    it('classifies every base theme string color leaf as public editable, internal, derived, or deprecated', () => {
        const editablePaths = new Set(
            EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS.map((definition) => definition.path.join('.')),
        );
        const classifiedPaths = new Set(
            (tokenDefinitionsModule.THEME_COLOR_TOKEN_CLASSIFICATIONS ?? []).map((classification) => {
                expect(classification.reason).toBeTruthy();
                expect(['internal', 'derived', 'deprecated']).toContain(classification.status);
                return classification.path.join('.');
            }),
        );
        const stringLeafPaths = new Set([
            ...collectStringLeafPaths(lightTheme.colors),
            ...collectStringLeafPaths(darkTheme.colors),
        ]);

        const unclassifiedPaths = [...stringLeafPaths]
            .filter((leafPath) => !editablePaths.has(leafPath) && !classifiedPaths.has(leafPath))
            .sort();

        expect(unclassifiedPaths).toEqual([]);
    });

    it('exposes surface highlight as an editable color token with transparent base defaults', () => {
        const definition = getEditableThemeColorTokenDefinition('effect.surfaceHighlight');

        expect(definition?.valueKind).toBe('color');
        expect(resolveThemeColorTokenBaseValue(lightTheme, 'effect.surfaceHighlight')).toBe('transparent');
        expect(resolveThemeColorTokenBaseValue(darkTheme, 'effect.surfaceHighlight')).toBe('transparent');
    });

    it('records contrast guidance for foreground tokens that depend on another editable color', () => {
        expect(getEditableThemeColorTokenDefinition('chrome.header.foreground')?.contrastPairs).toEqual([
            { tokenId: 'chrome.header.background', minRatio: 4.5 },
        ]);
        expect(getEditableThemeColorTokenDefinition('text.primary')?.contrastPairs).toEqual(
            expect.arrayContaining([
                { tokenId: 'background.canvas', minRatio: 4.5 },
                { tokenId: 'surface.base', minRatio: 4.5 },
            ]),
        );
        expect(getEditableThemeColorTokenDefinition('state.danger.foreground')?.contrastPairs).toEqual([
            { tokenId: 'state.danger.background', minRatio: 4.5 },
        ]);
    });
});

function collectStringLeafPaths(value: unknown, path: readonly string[] = []): string[] {
    if (typeof value === 'string') return [path.join('.')];
    if (value === null || value === undefined || typeof value !== 'object') return [];
    if (Array.isArray(value)) {
        return value.flatMap((entry, index) => collectStringLeafPaths(entry, [...path, String(index)]));
    }
    return Object.entries(value).flatMap(([key, entry]) => collectStringLeafPaths(entry, [...path, key]));
}

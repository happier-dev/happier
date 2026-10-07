import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from '@/components/sessions/transcript/messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The settings store is the boundary: every settings hook a preview mounts is recorded here, with the
 * real store hooks still answering underneath.
 *
 * A preview may read only the rendering environment every real component honours: the text scale
 * (the app `Text` primitive), the content width (row max width) and the syntax-tokenization budget
 * (a size cap that never changes a short sample). Any other setting would make the tile follow the
 * account's live choices instead of the option it shows.
 */
const RENDERING_ENVIRONMENT_READS = new Set([
    'useLocalSetting:uiFontScale',
    'useLocalSetting:uiContentWidthMode',
    'useSetting:filesDiffTokenizationMaxBytes',
]);
const settingsReads = vi.hoisted(() => ({ keys: [] as string[] }));

function recordingSettingsHooks<T extends Record<string, any>>(actual: T): Partial<T> {
    const wrap = (name: string) => (...args: unknown[]) => {
        settingsReads.keys.push(`${name}:${String(args[0] ?? '')}`);
        return actual[name](...args);
    };
    return {
        useSetting: wrap('useSetting'),
        useSettings: wrap('useSettings'),
        useSettingMutable: wrap('useSettingMutable'),
        useLocalSetting: wrap('useLocalSetting'),
        useLocalSettingMutable: wrap('useLocalSettingMutable'),
    } as unknown as Partial<T>;
}

installMessageViewCommonModuleMocks({
    storage: async (importOriginal) => {
        const actual = await importOriginal<Record<string, any>>();
        return { ...actual, ...recordingSettingsHooks(actual) };
    },
});

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<Record<string, any>>();
    return { ...actual, ...recordingSettingsHooks(actual) };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

// Keep the existing full preview graph's import order before list-only cases;
// its real storage graph contains reciprocal facade imports.
await import('./SessionSettingPreviews');

afterEach(() => {
    standardCleanup();
    settingsReads.keys.length = 0;
});

describe('Session settings previews', () => {
    it.each(['density', 'layout'] as const)('does not repeat real %s preview work when a parent recreates unchanged tile props', async (kind) => {
        const { SessionListDensityPreview, SessionListLayoutPreview } = await import('./SessionListPreview');
        // A selection-ring update recreates JSX at both real callers. Observe
        // descendant hooks without replacing their store or presentation logic.
        const preview = () => kind === 'density'
            ? <SessionListDensityPreview density="detailed" />
            : <SessionListLayoutPreview layout="layout:projects" />;
        const screen = await renderScreen(preview());
        expect(settingsReads.keys).toContain('useLocalSetting:uiFontScale');
        settingsReads.keys.length = 0;

        await screen.update(preview());

        expect(settingsReads.keys).toEqual([]);
    });

    it('keeps changed list-preview choices and descendant font-scale subscriptions responsive', async () => {
        const { SessionListDensityPreview, SessionListLayoutPreview } = await import('./SessionListPreview');
        const { getStorage } = await import('@/sync/domains/state/storage');
        const { Platform, StyleSheet } = await import('react-native');
        const originalPlatform = Platform.OS;
        const originalScale = getStorage().getState().localSettings.uiFontScale;
        // The real Text adapter scales host metrics on native. Platform is the
        // external boundary; keep the store hooks and Text implementation real.
        Platform.OS = 'ios';
        try {
            await act(async () => { getStorage().getState().applyLocalSettings({ uiFontScale: 1 }, { persist: false }); });
            const screen = await renderScreen(<>
                <SessionListDensityPreview density="detailed" />
                <SessionListLayoutPreview layout="layout:projects" />
            </>);
            const text = () => screen.findAllByType('Text')[0];
            const detailedSize = StyleSheet.flatten(text().props.style).fontSize;
            expect(detailedSize).toBeGreaterThan(0);
            expect(screen.getTextContent()).toContain('~/website');

            await screen.update(<>
                <SessionListDensityPreview density="narrow" />
                <SessionListLayoutPreview layout="layout:active_inactive" />
            </>);
            expect(screen.getTextContent()).not.toContain('~/website');
            const originalSize = StyleSheet.flatten(text().props.style).fontSize;
            expect(originalSize).toBeGreaterThan(0);
            expect(originalSize).toBeLessThan(detailedSize);
            settingsReads.keys.length = 0;

            await act(async () => { getStorage().getState().applyLocalSettings({ uiFontScale: 1.4 }, { persist: false }); });

            expect(settingsReads.keys).toContain('useLocalSetting:uiFontScale');
            expect(StyleSheet.flatten(text().props.style).fontSize).toBeCloseTo(originalSize * 1.4);
        } finally {
            await act(async () => { getStorage().getState().applyLocalSettings({ uiFontScale: originalScale }, { persist: false }); });
            Platform.OS = originalPlatform;
        }
    });

    it('renders real list, transcript and composer pieces from static props without reading display settings', async () => {
        const previews = await import('./SessionSettingPreviews');
        const listPreviews = await import('./SessionListPreview');
        const { SessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/SessionTranscriptSourceContext');
        const screen = await renderScreen(
            <>
                <listPreviews.SessionListDensityPreview density="detailed" />
                <listPreviews.SessionListDensityPreview density="cozy" />
                <listPreviews.SessionListDensityPreview density="narrow" />
                <listPreviews.SessionListLayoutPreview layout="layout:projects" />
                <listPreviews.SessionListLayoutPreview layout="layout:recent_activity" />
                <listPreviews.SessionListLayoutPreview layout="layout:active_inactive" />
                <previews.TranscriptLayoutPreview layout="linear" />
                <previews.TranscriptLayoutPreview layout="turns" />
                <previews.ThinkingDisplayPreview mode="inline_summary" inlineChrome="plain" />
                <previews.ThinkingDisplayPreview mode="inline_full" inlineChrome="card" />
                <previews.ThinkingDisplayPreview mode="tool" inlineChrome="plain" />
                <previews.ThinkingDisplayPreview mode="hidden" inlineChrome="plain" />
                <previews.ToolStylePreview style="cards" />
                <previews.ToolStylePreview style="activity_feed" />
                <previews.ComposerActionBarPreview layout="collapsed" />
                <previews.ComposerChipDensityPreview density="icons" />
                <previews.EmbeddedChatPreview />
            </>,
        );

        const sources = screen.findAllByType(SessionTranscriptSourceProvider).map((root) => root.props.source);
        expect(sources.length).toBeGreaterThan(0);
        for (const source of sources) {
            expect(source).toMatchObject({ kind: 'readOnly', sessionId: 'settings-preview', actions: null, navigate: null });
        }
        expect([...new Set(settingsReads.keys.filter((key) => !RENDERING_ENVIRONMENT_READS.has(key)))]).toEqual([]);
    });
});

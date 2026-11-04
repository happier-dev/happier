import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from '@/components/sessions/transcript/messageViewTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Observational spies record settings reads without replacing the real store hooks.
 *
 * A preview may read only the rendering environment every real component honours: the text scale
 * (the app `Text` primitive), locale, the content width (row max width) and the syntax-tokenization budget
 * (a size cap that never changes a short sample). Any other setting would make the tile follow the
 * account's live choices instead of the option it shows.
 */
const RENDERING_ENVIRONMENT_READS = new Set([
    'useLocalSetting:uiFontScale',
    'useLocalSetting:uiContentWidthMode',
    'useSetting:filesDiffTokenizationMaxBytes',
]);
installMessageViewCommonModuleMocks();
// Language changes are the behavior under test; keep the canonical locale and
// Settings owners real instead of the message-view helper's key-only text port.
vi.doUnmock('@/text');
vi.doUnmock('@/sync/domains/state/storage');

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Keep the existing full preview graph's import order before list-only cases;
// its real storage graph contains reciprocal facade imports.
await import('./SessionSettingPreviews');
// The browser loads locale chunks before publishing the ready language. Keep
// that external chunk ready so these cases isolate mounted locale consumers.
await (await import('@/text')).preloadTranslationsForSettings('fr');
const hooks = await import('@/sync/store/hooks');
// Display-setting reads live in the leaf module that Text and the previews import directly;
// only the mutable variants are still owned by the facade.
const readHooks = await import('@/sync/store/settingsReadHooks');
// Observe the settled real modules. A partial-module replacement during the reciprocal
// imports leaves already-loaded Text adapters holding unobserved original hooks.
const settingsHookSpies = [
    ['useSetting', vi.spyOn(readHooks, 'useSetting')],
    ['useSettings', vi.spyOn(readHooks, 'useSettings')],
    ['useSettingMutable', vi.spyOn(hooks, 'useSettingMutable')],
    ['useLocalSetting', vi.spyOn(readHooks, 'useLocalSetting')],
    ['useLocalSettingMutable', vi.spyOn(hooks, 'useLocalSettingMutable')],
] as const;
function readSettingsKeys() {
    return settingsHookSpies.flatMap(([name, spy]) => spy.mock.calls.map(args => `${name}:${String(args[0] ?? '')}`));
}
function clearSettingsReads() {
    for (const [, spy] of settingsHookSpies) spy.mockClear();
}

afterEach(() => {
    standardCleanup();
    clearSettingsReads();
});

describe('Session settings previews', () => {
    it('updates the mounted Session settings choices after the admitted Account language changes without a parent rerender', async () => {
        const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { getStorage } = await import('@/sync/domains/state/storage');
        const { getPreferredLanguage, t } = await import('@/text');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { renderSettingsView } = await import('@/dev/testkit/harness/settingsViewHarness');
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ preferredLanguage: 'en' }), sharedEnabled: false });
        const serve = account.request.getMockImplementation();
        if (!serve) throw new Error('The Account HTTP fixture must have its canonical handler');
        let releaseAck!: () => void;
        let languageWriteIssued = false;
        const ackHeld = new Promise<void>(resolve => { releaseAck = resolve; });
        try {
            const { WorkspaceRouteBody } = await import('@/app/(app)/settings/session');
            const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={account.credentials}>{children}</InjectedAuthProvider>;
            const screen = await renderSettingsView(<WorkspaceRouteBody />, { wrapper });
            const paintedText = () => screen.getTextContent();
            const english = t('settingsAppearance.sessionListDensity.detailed');
            expect(paintedText()).toContain(english);
            const { sync } = await import('@/sync/sync');
            await sync.prepareAccountSettingsForDaemonSpawn();
            account.request.mockImplementation(async (input, init) => {
                if (new URL(String(input)).pathname === '/v2/account/settings' && init?.method === 'POST') {
                    languageWriteIssued = true;
                    await ackHeld;
                }
                return serve(input, init);
            });
            await act(async () => { sync.applySettings({ preferredLanguage: 'fr' }, { expectedSettingsScope: getStorage().getState().settingsScope }); });
            await vi.waitFor(() => expect(getPreferredLanguage()).toBe('fr'));
            await vi.waitFor(() => expect(languageWriteIssued).toBe(true));
            expect(account.persistedSettings.preferredLanguage).toBe('en');
            const french = t('settingsAppearance.sessionListDensity.detailed');
            expect(french).not.toBe(english);
            await vi.waitFor(() => expect(paintedText()).toContain(french));
            expect(paintedText()).not.toContain(english);
            releaseAck();
            await act(async () => { await sync.prepareAccountSettingsForDaemonSpawn(); });
            expect(account.persistedSettings.preferredLanguage).toBe('fr');
        } finally {
            releaseAck();
            standardCleanup();
            await account.dispose();
        }
    });

    it.each(['density', 'layout'] as const)('updates the mounted %s preview after the canonical preferred language changes without a parent rerender', async kind => {
        const { SessionListDensityPreview, SessionListLayoutPreview } = await import('./SessionListPreview');
        const { getStorage } = await import('@/sync/domains/state/storage');
        const { getPreferredLanguage, t } = await import('@/text');
        const store = getStorage();
        const previous = store.getState().settings.preferredLanguage;
        try {
            await act(async () => { store.getState().applySettingsLocal({ preferredLanguage: 'en' }); });
            const screen = await renderScreen(kind === 'density'
                ? <SessionListDensityPreview density="detailed" />
                : <SessionListLayoutPreview layout="layout:projects" />);
            // Density draws placeholder rows; the layout preview draws the arrangement's sample sessions.
            const probeKey = kind === 'density' ? 'settingsSessionPages.preview.userMessage' : 'personalize.sampleSessionReconnect';
            const english = t(probeKey);
            expect(screen.getTextContent()).toContain(english);
            await act(async () => { store.getState().applySettingsLocal({ preferredLanguage: 'fr' }); });
            await vi.waitFor(() => expect(getPreferredLanguage()).toBe('fr'));
            const french = t(probeKey);
            expect(french).not.toBe(english);
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(french));
            expect(screen.getTextContent()).not.toContain(english);
        } finally {
            await act(async () => { store.getState().applySettingsLocal({ preferredLanguage: previous }); });
        }
    });

    it.each(['density', 'layout'] as const)('does not repeat real %s preview work when a parent recreates unchanged tile props', async (kind) => {
        const { SessionListDensityPreview, SessionListLayoutPreview } = await import('./SessionListPreview');
        // A selection-ring update recreates JSX at both real callers. Observe
        // descendant hooks without replacing their store or presentation logic.
        const preview = () => kind === 'density'
            ? <SessionListDensityPreview density="detailed" />
            : <SessionListLayoutPreview layout="layout:projects" />;
        const screen = await renderScreen(preview());
        expect(readSettingsKeys()).toContain('useLocalSetting:uiFontScale');
        clearSettingsReads();

        await screen.update(preview());

        expect(readSettingsKeys()).toEqual([]);
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
            expect(screen.getTextContent()).toContain('website');

            await screen.update(<>
                <SessionListDensityPreview density="narrow" />
                <SessionListLayoutPreview layout="layout:recent_activity" />
            </>);
            expect(screen.getTextContent()).not.toContain('website');
            expect(screen.getTextContent()).toContain((await import('@/text')).t('sessionHistory.today'));
            const originalSize = StyleSheet.flatten(text().props.style).fontSize;
            expect(originalSize).toBeGreaterThan(0);
            expect(originalSize).toBeLessThan(detailedSize);
            clearSettingsReads();

            await act(async () => { getStorage().getState().applyLocalSettings({ uiFontScale: 1.4 }, { persist: false }); });

            expect(readSettingsKeys()).toContain('useLocalSetting:uiFontScale');
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
                <previews.TranscriptLayoutPreview layout="linear" />
                <previews.TranscriptLayoutPreview layout="turns" />
                <previews.ThinkingDisplayPreview mode="inline_summary" inlineChrome="plain" />
                <previews.ThinkingDisplayPreview mode="inline_full" inlineChrome="card" />
                <previews.ThinkingDisplayPreview mode="tool" inlineChrome="plain" />
                <previews.ThinkingDisplayPreview mode="hidden" inlineChrome="plain" />
                <previews.ToolStylePreview style="cards" />
                <previews.ToolStylePreview style="activity_feed" />
                <previews.ComposerActionBarPreview layout="auto" />
                <previews.ComposerChipDensityPreview density="icons" />
                <previews.EmbeddedChatPreview />
            </>,
        );

        const sources = screen.findAllByType(SessionTranscriptSourceProvider).map((root) => root.props.source);
        expect(sources.length).toBeGreaterThan(0);
        for (const source of sources) {
            expect(source).toMatchObject({ kind: 'readOnly', sessionId: 'settings-preview', actions: null, navigate: null });
        }
        expect([...new Set(readSettingsKeys().filter((key) => !RENDERING_ENVIRONMENT_READS.has(key)))]).toEqual([]);
    });
});

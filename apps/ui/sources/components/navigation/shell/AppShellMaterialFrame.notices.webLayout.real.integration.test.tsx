// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { Header } from '@/components/navigation/Header';
import { PresentationNoticeHost } from '@/components/sessions/presentation/PresentationNoticeHost';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';

import { AppShellMaterialFrame } from './AppShellMaterialFrame';
import { AppShellColumnContext } from './appRail/appShellColumnContext';
import { AppShellTitleStrip } from './appRail/AppShellTitleStrip';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/utils/web/reactDomCjs', async () => {
    const dom = await import('react-dom');
    return { requireReactDOM: () => dom };
});

installWebLayoutBridge();

it.each([1440, 390])('draws a mounted notice below the navigation chrome and within the content at %i px', async (width) => {
    const desktop = width === 1440;
    const height = 900;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    setReducedMotionPreferenceOverride(true);
    try {
        await act(async () => {
            root.render(
                <SafeAreaInsetsContext.Provider value={{ top: desktop ? 0 : 47, bottom: 0, left: 0, right: 0 }}>
                    <View style={{ width, height }}>
                        <AppShellColumnContext.Provider value={{ present: desktop, columnVisible: desktop }}>
                            <AppShellMaterialFrame showChrome={desktop} dragEnabled={false} leftOffsetPx={0}
                                sidebarWidth={320} column={desktop ? <View /> : null} rail={null} peek={null}
                                titleStrip={desktop ? <AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}} /> : null}>
                                {desktop ? <View style={{ display: 'none' }}><PresentationNoticeHost /></View> : <>
                                    <Header title={<Text>Home</Text>} />
                                    <PresentationNoticeHost />
                                </>}
                            </AppShellMaterialFrame>
                        </AppShellColumnContext.Provider>
                    </View>
                </SafeAreaInsetsContext.Provider>
            );
            publishPresentationNotice({ key: 'shell-notice', message: 'Session is ready', severity: 'info', sticky: true });
        });
        const layout = await measureWebLayout(document.body, { viewport: { width, height }, settle: (replay) => act(replay) });
        const chrome = layout.rect(desktop ? 'app-shell-title-strip' : 'desktop-route-header-drag-region');
        const sheet = layout.rect('app-shell-content-sheet');
        const notice = layout.rect('current-session-presentation-notice');

        expect(chrome.height).toBeGreaterThan(0);
        expect(notice.height).toBeGreaterThan(0);
        expect(notice.top).toBeGreaterThanOrEqual(chrome.bottom);
        expect(notice.left).toBeGreaterThanOrEqual(sheet.left);
        expect(notice.right).toBeLessThanOrEqual(sheet.right);
    } finally {
        await act(async () => { root.unmount(); retirePresentationNotice(); });
        setReducedMotionPreferenceOverride(null);
        container.remove();
    }
});

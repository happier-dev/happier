import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BotFace, KeyboardStickyFooter, PageAsideColumns, PagePinnedBar, PlanChecklistCard } from '@happier-dev/plugin-ui/components';
import { PluginUiPresentationHostProviderInternal } from '../../../../../../packages/plugin-ui/src/presentationHost/context';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { BotFaceRasterView } from '@/components/sessions/bots/face/BotFaceRasterView';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Renderer, theme and canvas are platform boundaries; face resolution and layout remain real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));

describe('public Bot face and page composition through the app presentation host', () => {
    it('renders the public execution checklist with the deployment checklist owner and its disclosure and diagnostics', async () => {
        expect(PlanChecklistCard).toBeTypeOf('function');
        const { PlanChecklistCard: HostChecklist } = await import('@/components/systemTasks/planChecklist/PlanChecklistCard');
        const copy = vi.fn(async () => true);
        const toggle = vi.fn();
        const item = { id: 'build', title: 'Build', satisfied: false, disabled: false, details: 'Build context' };
        const screen = await renderScreen(<PluginUiPresentationHostProviderInternal host={createPluginUiPrivatePresentationHost(undefined)}>
            <PlanChecklistCard testID="public-checklist" items={[item]} phase="execute" selectedIds={['build']}
                expandedIds={['build']} executionById={{ build: { status: 'error', logs: [{ ts: 0, level: 'error', message: 'Build failed' }] } }}
                onToggleExpanded={toggle} onCopyDiagnostics={copy} />
        </PluginUiPresentationHostProviderInternal>);
        expect(screen.findAllByType(HostChecklist)).toHaveLength(1);
        expect(screen.getTextContent()).toContain('Build context');
        expect(screen.findByTestId('public-checklist-row-build-details')).toBeTruthy();
        await screen.pressByTestIdAsync('public-checklist-row-build-details-copy-diagnostics');
        expect(copy).toHaveBeenCalledWith(item);
        await screen.pressByTestIdAsync('public-checklist-row-build');
        expect(toggle).toHaveBeenCalledWith('build');
        await screen.unmount();
    });

    it('paints the public saved face exactly like a core Bot identity surface', async () => {
        const face = { style: 'solid', body: 'cat', palette: 'orchid', seed: 'saved-seed' } as const;
        const screen = await renderScreen(<PluginUiPresentationHostProviderInternal host={createPluginUiPrivatePresentationHost(undefined)}>
            <BotFace seed="public-bot" face={face} size={24} motion={false} accessibilityLabel="Garden Bot" testID="plugin-face" />
            <SessionBotFace facts={{ seed: 'public-bot', face }} size={24} motion={false} />
        </PluginUiPresentationHostProviderInternal>);
        expect(screen.findHostByTestId('plugin-face')?.props.accessibilityLabel).toBe('Garden Bot');
        const images = screen.findAllByType(BotFaceRasterView).map(node => node.props.image);
        expect(images).toHaveLength(2);
        expect(images[0].data.length).toBeGreaterThan(0);
        expect(images[0]).toEqual(images[1]);
        await screen.unmount();
    });

    it('keeps the closing row after a compact aside and the pinned actions outside the page body', async () => {
        const screen = await renderScreen(<PluginUiPresentationHostProviderInternal host={createPluginUiPrivatePresentationHost(undefined)}>
            <PageAsideColumns compact aside={<span>Receipt</span>} closing={<span>Leave page</span>}>
                {({ sideBySide }) => <span>{sideBySide ? 'Wide body' : 'Compact body'}</span>}
            </PageAsideColumns>
            <KeyboardStickyFooter offset={12} enabled={false} testID="plugin-footer">
                <PagePinnedBar testID="plugin-bar"><span>Save draft</span></PagePinnedBar>
            </KeyboardStickyFooter>
        </PluginUiPresentationHostProviderInternal>);
        const text = screen.getTextContent();
        expect(text.indexOf('Compact body')).toBeLessThan(text.indexOf('Receipt'));
        expect(text.indexOf('Receipt')).toBeLessThan(text.indexOf('Leave page'));
        expect(text.indexOf('Leave page')).toBeLessThan(text.indexOf('Save draft'));
        expect(screen.findHostByTestId('plugin-bar')).not.toBeNull();
        expect(screen.findHostByTestId('plugin-footer')).not.toBeNull();
        await screen.unmount();
    });
});

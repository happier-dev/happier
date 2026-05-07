import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: {
                    OS: 'ios',
                    select: (spec: any) => spec?.ios ?? spec?.default,
                },
            });
        },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: (key: string) => {
                return null;
            },
            useLocalSettingMutable: () => [false, vi.fn()],
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'scmReview:working',
                tabs: [
                    {
                        key: 'scmReview:working',
                        kind: 'scmReview',
                        title: 'Review',
                        isPinned: true,
                        isPreview: false,
                        resource: { kind: 'scmReview', scope: 'working' },
                    },
                ],
            },
        },
    }),
}));

const reviewViewSpy = vi.fn();
vi.mock('@/components/sessions/files/views/SessionScmReviewDetailsView', () => ({
    SessionScmReviewDetailsView: (props: any) => {
        reviewViewSpy(props);
        return React.createElement('SessionScmReviewDetailsView');
    },
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

describe('SessionDetailsPanel (scm review resource)', () => {
    it('renders SessionScmReviewDetailsView for scmReview tabs', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        reviewViewSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />)).tree;

        expect(tree).toBeTruthy();
        expect(reviewViewSpy).toHaveBeenCalledTimes(1);
        expect(reviewViewSpy.mock.calls[0]?.[0]?.sessionId).toBe('s1');
    });

    it('places the dedicated screen close action before the tab strip on native', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" presentation="screen" />);
        const root = screen.findByTestId('session-details-panel-root');
        if (!root) throw new Error('Expected session details panel root to render');

        const header = root.children[0];
        if (!header || typeof header !== 'object') throw new Error('Expected session details header to render');
        const headerChildren = Array.isArray((header as any).children) ? (header as any).children : [];
        expect(headerChildren[0]?.props?.testID).toBe('session-details-close');
    });
});

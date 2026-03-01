import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (_: any) => 1 },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
    View: 'View',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#eee',
                text: '#000',
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: { create: (value: any) => value },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('SessionDetailsPanel (scm review resource)', () => {
    it('renders SessionScmReviewDetailsView for scmReview tabs', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        reviewViewSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        expect(tree).toBeTruthy();
        expect(reviewViewSpy).toHaveBeenCalledTimes(1);
        expect(reviewViewSpy.mock.calls[0]?.[0]?.sessionId).toBe('s1');
    });
});

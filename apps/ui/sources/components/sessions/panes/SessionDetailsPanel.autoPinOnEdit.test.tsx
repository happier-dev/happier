import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (_: any) => 1 },
    View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
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
                shadow: { color: '#000', opacity: 0.2 },
            },
        },
    }),
    StyleSheet: {
        absoluteFillObject: {},
        create: (value: any) =>
            typeof value === 'function'
                ? value({
                    colors: {
                        surface: '#fff',
                        surfaceHigh: '#f5f5f5',
                        divider: '#eee',
                        text: '#000',
                        textSecondary: '#666',
                        shadow: { color: '#000', opacity: 0.2 },
                    },
                })
                : value,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

const SessionFileDetailsViewMock = vi.fn((props: any) => React.createElement('SessionFileDetailsView', props));
vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: (props: any) => SessionFileDetailsViewMock(props),
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionScmReviewDetailsView', () => ({
    SessionScmReviewDetailsView: () => React.createElement('SessionScmReviewDetailsView'),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'editorFocusModeEnabled') return false;
        return null;
    },
    useLocalSettingMutable: () => [false, vi.fn()],
}));

const pinDetailsTab = vi.fn();
const scopeState = {
    details: {
        isOpen: true,
        activeTabKey: 'file:a',
        tabs: [
            { key: 'file:a', kind: 'file', title: 'a.txt', isPinned: false, isPreview: true, resource: { kind: 'file', path: 'a.txt' } },
        ],
    },
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab,
        setActiveDetailsTab: vi.fn(),
        openDetailsTab: vi.fn(),
        scopeState,
    }),
}));

describe('SessionDetailsPanel (auto pin on edit)', () => {
    it('pins a preview file tab when editing begins', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        await act(async () => {
            renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        expect(SessionFileDetailsViewMock).toHaveBeenCalledTimes(1);
        const props = SessionFileDetailsViewMock.mock.calls[0]?.[0];
        expect(typeof props?.onStartEditingFile).toBe('function');

        act(() => {
            props.onStartEditingFile();
        });

        expect(pinDetailsTab).toHaveBeenCalledWith('file:a');
    });
});

import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (_: any) => 1 },
    View: 'View',
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
                shadow: { color: '#000' },
            },
        },
    }),
    StyleSheet: {
        create: (value: any) =>
            typeof value === 'function'
                ? value({
                    colors: {
                        surface: '#fff',
                        surfaceHigh: '#f5f5f5',
                        divider: '#eee',
                        text: '#000',
                        textSecondary: '#666',
                        shadow: { color: '#000' },
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

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
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

const scopeState = {
    details: {
        isOpen: true,
        activeTabKey: null,
        tabs: [
            { key: 'file:a', kind: 'file', title: 'a.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'a.txt' } },
            { key: 'file:b', kind: 'file', title: 'b.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'b.txt' } },
        ],
    },
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        scopeState,
    }),
}));

describe('SessionDetailsPanel (active tab fallback)', () => {
    it('marks only the last tab active when activeTabKey is missing', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        const tabButtons = tree!.root
            .findAllByType('Pressable')
            .filter((node: any) => node.props?.accessibilityLabel === 'session.detailsPanel.openTabA11y');
        expect(tabButtons).toHaveLength(2);
        expect(tabButtons[0]!.findAllByType('Pressable').length).toBe(1);
        expect(tabButtons[1]!.findAllByType('Pressable').length).toBe(1);

        const firstStyles = tabButtons[0]!.props.style;
        const secondStyles = tabButtons[1]!.props.style;

        const hasSurfaceHighBg = (styleProp: any) =>
            Array.isArray(styleProp) && styleProp.some((s: any) => s && s.backgroundColor === '#f5f5f5');
        expect(hasSurfaceHighBg(firstStyles)).toBe(false);
        expect(hasSurfaceHighBg(secondStyles)).toBe(true);
    });
});

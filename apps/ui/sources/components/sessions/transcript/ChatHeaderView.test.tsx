import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: {
            ...(actual.Platform ?? {}),
            OS: 'ios',
            select: (values: any) => values?.ios ?? values?.default,
        },
        View: 'View',
        Text: 'Text',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    };
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', () => ({
    useNavigation: () => ({ goBack: vi.fn() }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 44,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                header: { background: '#fff', tint: '#111' },
            },
        },
    }),
    StyleSheet: {
        create: (input: any) => {
            const theme = {
                colors: {
                    header: { background: '#fff', tint: '#111' },
                },
            };
            return typeof input === 'function' ? input(theme, {}) : input;
        },
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', props),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { headerMaxWidth: 1024 },
}));

describe('ChatHeaderView', () => {
    it('renders an optional rightElement', async () => {
        const { ChatHeaderView } = await import('./ChatHeaderView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ChatHeaderView
                    title="Title"
                    rightElement={React.createElement('Text', null, 'RIGHT')}
                />,
            );
        });

        expect(JSON.stringify(tree!.toJSON())).toContain('RIGHT');
    });
});

import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            border: { default: '#ccc' },
            surface: { base: '#fff', pressedOverlay: '#eee' },
            text: { primary: '#000' },
        },
    };
    return {
        StyleSheet: { create: (factory: (value: typeof theme) => unknown) => factory(theme) },
        useUnistyles: () => ({ theme }),
    };
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/components/sessions/context/SessionContextChips', () => ({
    SessionContextChips: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: Readonly<{ session?: string }>) =>
        key === 'inbox.openSession' ? `Open session: ${params?.session}` : key,
}));

describe('InboxSessionAttentionHeader', () => {
    it('names the destination and provides the Android minimum target after Voice ends', async () => {
        const { InboxSessionAttentionHeader } = await import('./InboxSessionAttentionHeader');
        let renderer: ReturnType<typeof create>;
        await act(async () => {
            renderer = create(
                <InboxSessionAttentionHeader
                    sessionTitle="Fix login"
                    machineLabel={null}
                    pathLabel={null}
                    onOpenSession={() => {}}
                />,
            );
        });

        const button = renderer!.root.findByType('Pressable' as any);
        const style = button.props.style({ pressed: false });
        const flattened = Object.assign({}, ...style.filter(Boolean));
        expect(button.props.accessibilityLabel).toBe('Open session: Fix login');
        expect(flattened.width).toBeGreaterThanOrEqual(48);
        expect(flattened.height).toBeGreaterThanOrEqual(48);
    });
});

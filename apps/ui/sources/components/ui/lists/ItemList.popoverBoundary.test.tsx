import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: false,
        colors: {
            groupped: { background: '#ffffff', sectionTitle: '#888888' },
            surface: '#ffffff',
            text: '#111111',
        },
    };

    return {
        StyleSheet: { create: (factory: any) => factory(theme, {}) },
        useUnistyles: () => ({ theme, rt: { themeName: 'light' } }),
    };
});

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'web', select: (m: any) => m?.web ?? m?.default ?? m?.ios },
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
        ScrollView: React.forwardRef((props: any, ref: any) => React.createElement('ScrollView', { ...props, ref }, props.children)),
    };
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1024 },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('ItemList + ItemGroup popover boundary', () => {
    it('prefers the screen/list boundary (ItemList) over the group boundary (ItemGroup)', async () => {
        const { ItemList } = await import('./ItemList');
        const { ItemGroup } = await import('./ItemGroup');
        const { usePopoverBoundaryRef } = await import('@/components/ui/popover/PopoverBoundary');

        const listBoundaryRef = React.createRef<any>();

        let seenBoundaryRef: any = undefined;
        function BoundarySpy() {
            seenBoundaryRef = usePopoverBoundaryRef();
            return null;
        }

        await act(async () => {
            renderer.create(
                <ItemList ref={listBoundaryRef}>
                    <ItemGroup title="Group" footer="Footer">
                        <BoundarySpy />
                    </ItemGroup>
                </ItemList>,
            );
        });

        expect(seenBoundaryRef).toBe(listBoundaryRef);
    });

    it('still provides a fallback boundary when ItemGroup is rendered outside an ItemList', async () => {
        const { ItemGroup } = await import('./ItemGroup');
        const { usePopoverBoundaryRef } = await import('@/components/ui/popover/PopoverBoundary');

        let seenBoundaryRef: any = undefined;
        function BoundarySpy() {
            seenBoundaryRef = usePopoverBoundaryRef();
            return null;
        }

        await act(async () => {
            renderer.create(
                <ItemGroup title="Group">
                    <BoundarySpy />
                </ItemGroup>,
            );
        });

        expect(seenBoundaryRef).not.toBe(null);
        expect(seenBoundaryRef).not.toBe(undefined);
    });
});

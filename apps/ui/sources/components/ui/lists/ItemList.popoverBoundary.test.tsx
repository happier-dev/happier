import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
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

        await renderScreen(
            <ItemList ref={listBoundaryRef}>
                <ItemGroup title="Group" footer="Footer">
                    <BoundarySpy />
                </ItemGroup>
            </ItemList>,
        );

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

        await renderScreen(
            <ItemGroup title="Group">
                <BoundarySpy />
            </ItemGroup>,
        );

        expect(seenBoundaryRef).not.toBe(null);
        expect(seenBoundaryRef).not.toBe(undefined);
    });
});

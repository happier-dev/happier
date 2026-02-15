import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('ItemList', () => {
    it('sets minHeight: 0 on web to allow flex scroll containers to shrink', async () => {
        const rn = await import('react-native');
        const originalPlatformOs = rn.Platform.OS;
        (rn.Platform as unknown as { OS: string }).OS = 'web';

        vi.resetModules();

        const { ItemList } = await import('./ItemList');

        try {
            let tree: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(
                    <ItemList>
                        <React.Fragment />
                    </ItemList>
                );
            });
            await act(async () => {});

            const scrollView = tree!.root.findByType('ScrollView');
            const styleProp = scrollView.props.style;
            expect(Array.isArray(styleProp)).toBe(true);
            expect(styleProp.some((entry: any) => entry?.minHeight === 0)).toBe(true);
        } finally {
            (rn.Platform as unknown as { OS: string }).OS = originalPlatformOs;
            vi.resetModules();
        }
    });
});

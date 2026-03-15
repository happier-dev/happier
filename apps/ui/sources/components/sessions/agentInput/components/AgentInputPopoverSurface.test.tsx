import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    View: 'View',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) =>
            typeof styles === 'function'
                ? styles({
                    colors: {
                        surface: '#fff',
                        modal: { border: '#eee' },
                        shadow: { color: '#000', opacity: 0.2 },
                    },
                })
                : styles,
    },
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: 'FloatingOverlay',
}));

import { AgentInputPopoverSurface } from './AgentInputPopoverSurface';

describe('AgentInputPopoverSurface', () => {
    it('applies maxHeight when scroll is disabled', () => {
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(
                <AgentInputPopoverSurface maxHeight={123} scrollEnabled={false}>
                    <Child />
                </AgentInputPopoverSurface>,
            );
        });

        const views = tree!.root.findAllByType('View');
        const sawMaxHeight = views.some((view) => {
            const style = view.props?.style;
            if (!Array.isArray(style)) return false;
            return style.some((entry) => entry && typeof entry === 'object' && 'maxHeight' in entry && entry.maxHeight === 123);
        });
        expect(sawMaxHeight).toBe(true);
    });
});

function Child() {
    return React.createElement('Child');
}

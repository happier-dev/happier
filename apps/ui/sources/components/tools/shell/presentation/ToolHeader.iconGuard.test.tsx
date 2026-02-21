import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, it, expect, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        'test-tool': {
            icon: true,
        },
    },
}));

describe('ToolHeader', () => {
    it('does not crash when knownTool.icon is present but not a function', async () => {
        const { ToolHeader } = await import('./ToolHeader');
        const tool = { name: 'test-tool' } as any;
        let tree: renderer.ReactTestRenderer | undefined;
        let thrown: unknown;
        try {
            await act(async () => {
                tree = renderer.create(<ToolHeader tool={tool} />);
            });
        } catch (error) {
            thrown = error;
        } finally {
            act(() => {
                tree?.unmount();
            });
        }

        expect(thrown).toBeUndefined();
    });
});

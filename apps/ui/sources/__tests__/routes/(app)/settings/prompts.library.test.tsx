import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', () => ({
    Redirect: (props: any) => React.createElement('Redirect', props),
}));

describe('legacy prompts library route', () => {
    it('redirects back to the prompts settings home', async () => {
        const module = await import('@/app/(app)/settings/prompts/library');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(module.default));
        });
        const redirect = tree.root.findByType('Redirect');

        expect(redirect.props.href).toBe('/(app)/settings/prompts');
    });
});

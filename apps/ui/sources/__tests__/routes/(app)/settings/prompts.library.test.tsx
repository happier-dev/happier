import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

describe('legacy prompts library route', () => {
    it('redirects back to the prompts settings home', async () => {
        const module = await import('@/app/(app)/settings/prompts/library');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(module.default))).tree;
        const redirect = tree.root.findByType('Redirect');

        expect(redirect.props.href).toBe('/(app)/settings/prompts');
    });
});

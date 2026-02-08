import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

describe('/friends redirect', () => {
    it('redirects /friends to /inbox', async () => {
        const replace = vi.fn();

        vi.doMock('expo-router', () => ({
            useRouter: () => ({ replace }),
        }));

        const Page = (await import('./index')).default;

        await act(async () => {
            renderer.create(React.createElement(Page));
        });
        await act(async () => {});

        expect(replace).toHaveBeenCalledWith('/inbox');
    });
});

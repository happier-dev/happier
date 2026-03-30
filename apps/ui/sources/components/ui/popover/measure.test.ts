import { describe, expect, it } from 'vitest';

import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web' },
        });
    },
});

describe('measureInWindow (web)', () => {
    it('can unwrap react-native-web style refs that expose getNode() to reach a DOM element', async () => {
        const { measureInWindow } = await import('./measure');

        const domEl = {
            getBoundingClientRect: () => ({
                left: 10,
                top: 20,
                width: 111,
                height: 222,
                x: 10,
                y: 20,
            }),
        };

        const wrapper = {
            getNode: () => domEl,
        };

        await expect(measureInWindow(wrapper)).resolves.toEqual({
            x: 10,
            y: 20,
            width: 111,
            height: 222,
        });
    });
});

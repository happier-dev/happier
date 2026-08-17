import { afterEach, describe, expect, it } from 'vitest';
import { Platform } from 'react-native';

import { resolveOverlayPointerEvents } from './resolveOverlayPointerEvents';

const originalPlatform = Platform.OS;

afterEach(() => {
    Platform.OS = originalPlatform;
});

describe('resolveOverlayPointerEvents', () => {
    it('keeps native responder ownership on the React Native prop', () => {
        Platform.OS = 'ios';

        expect(resolveOverlayPointerEvents('box-none')).toEqual({
            nativePointerEvents: 'box-none',
            webStyle: undefined,
        });
    });

    it('moves web responder ownership into styles without changing its mode', () => {
        Platform.OS = 'web';

        expect(resolveOverlayPointerEvents('none')).toEqual({
            nativePointerEvents: undefined,
            webStyle: { pointerEvents: 'none' },
        });
    });
});

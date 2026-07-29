import { describe, expect, it } from 'vitest';

import * as expo from './expoStub';

describe('expo vitest stub', () => {
    it('provides the optional native module bridge used by Expo packages', () => {
        expect(expo.requireOptionalNativeModule('ExpoHaptics')).toBeNull();
        expect(expo.default.requireOptionalNativeModule('ExpoHaptics')).toBeNull();
    });
});

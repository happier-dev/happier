import { describe, expect, it } from 'vitest';

import {
    resolveKeyboardAwareScrollViewDefaults,
    resolveKeyboardAwareScreenDefaults,
    resolveKeyboardStickyFooterOffset,
} from './keyboardAvoidanceGeometry';

describe('keyboard avoidance geometry', () => {
    it('uses RNKC padding behavior with explicit offsets for iOS form screens', () => {
        expect(resolveKeyboardAwareScreenDefaults({
            mode: 'form',
            platform: 'ios',
            keyboardVerticalOffset: 24,
        })).toEqual({
            behavior: 'padding',
            enabled: true,
            keyboardVerticalOffset: 24,
            useKeyboardController: true,
        });
    });

    it('uses RNKC height behavior for Android form screens', () => {
        expect(resolveKeyboardAwareScreenDefaults({
            mode: 'form',
            platform: 'android',
        })).toMatchObject({
            behavior: 'height',
            enabled: true,
            keyboardVerticalOffset: 0,
            useKeyboardController: true,
        });
    });

    it('keeps web screen avoidance as a no-op wrapper', () => {
        expect(resolveKeyboardAwareScreenDefaults({
            mode: 'form',
            platform: 'web',
            keyboardVerticalOffset: 24,
        })).toEqual({
            behavior: undefined,
            enabled: false,
            keyboardVerticalOffset: 0,
            useKeyboardController: false,
        });
    });

    it('enables automatic scroll inset adjustment only for iOS scroll forms', () => {
        expect(resolveKeyboardAwareScrollViewDefaults({
            mode: 'scrollForm',
            platform: 'ios',
            keyboardVerticalOffset: 12,
        })).toEqual({
            automaticallyAdjustKeyboardInsets: true,
            bottomOffset: 12,
            enabled: true,
            useKeyboardController: true,
        });

        expect(resolveKeyboardAwareScrollViewDefaults({
            mode: 'scrollForm',
            platform: 'android',
            keyboardVerticalOffset: 12,
        })).toMatchObject({
            automaticallyAdjustKeyboardInsets: undefined,
            bottomOffset: 12,
            enabled: true,
            useKeyboardController: true,
        });
    });

    it('normalizes sticky footer offsets into RNKC closed/opened offsets', () => {
        expect(resolveKeyboardStickyFooterOffset(18)).toEqual({
            closed: 0,
            opened: 18,
        });
        expect(resolveKeyboardStickyFooterOffset(-18)).toEqual({
            closed: 0,
            opened: 0,
        });
    });
});

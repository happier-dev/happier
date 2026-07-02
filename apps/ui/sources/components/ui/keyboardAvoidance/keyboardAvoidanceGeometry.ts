import {
    DEFAULT_KEYBOARD_STICKY_FOOTER_CLOSED_OFFSET,
    DEFAULT_KEYBOARD_VERTICAL_OFFSET,
} from './keyboardAvoidanceDefaults';

export type KeyboardAvoidancePlatform = 'ios' | 'android' | 'web' | 'native' | 'macos' | 'windows' | 'node';
export type KeyboardAwareScreenMode = 'form' | 'scrollForm' | 'centeredModal';
export type KeyboardAwareScreenBehavior = 'height' | 'padding' | 'position' | 'translate-with-padding';

export type KeyboardAwareScreenDefaultsInput = Readonly<{
    mode: KeyboardAwareScreenMode;
    platform: KeyboardAvoidancePlatform;
    keyboardVerticalOffset?: number;
}>;

export type KeyboardAwareScreenDefaults = Readonly<{
    behavior: KeyboardAwareScreenBehavior | undefined;
    enabled: boolean;
    keyboardVerticalOffset: number;
    useKeyboardController: boolean;
}>;

export type KeyboardAwareScrollViewDefaults = Readonly<{
    automaticallyAdjustKeyboardInsets: boolean | undefined;
    bottomOffset: number;
    enabled: boolean;
    useKeyboardController: boolean;
}>;

export type KeyboardStickyFooterOffset = Readonly<{
    closed: number;
    opened: number;
}>;

function normalizeOffset(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, value)
        : DEFAULT_KEYBOARD_VERTICAL_OFFSET;
}

function usesNativeKeyboardController(platform: KeyboardAvoidancePlatform): boolean {
    return platform === 'ios' || platform === 'android' || platform === 'native';
}

export function resolveKeyboardAwareScreenDefaults({
    platform,
    keyboardVerticalOffset,
}: KeyboardAwareScreenDefaultsInput): KeyboardAwareScreenDefaults {
    if (!usesNativeKeyboardController(platform)) {
        return {
            behavior: undefined,
            enabled: false,
            keyboardVerticalOffset: DEFAULT_KEYBOARD_VERTICAL_OFFSET,
            useKeyboardController: false,
        };
    }

    return {
        behavior: platform === 'android' ? 'height' : 'padding',
        enabled: true,
        keyboardVerticalOffset: normalizeOffset(keyboardVerticalOffset),
        useKeyboardController: true,
    };
}

export function resolveKeyboardAwareScrollViewDefaults({
    platform,
    keyboardVerticalOffset,
}: KeyboardAwareScreenDefaultsInput): KeyboardAwareScrollViewDefaults {
    const useKeyboardController = usesNativeKeyboardController(platform);

    return {
        automaticallyAdjustKeyboardInsets: platform === 'ios' ? true : undefined,
        bottomOffset: useKeyboardController ? normalizeOffset(keyboardVerticalOffset) : DEFAULT_KEYBOARD_VERTICAL_OFFSET,
        enabled: useKeyboardController,
        useKeyboardController,
    };
}

export function resolveKeyboardStickyFooterOffset(offset: number | undefined): KeyboardStickyFooterOffset {
    return {
        closed: DEFAULT_KEYBOARD_STICKY_FOOTER_CLOSED_OFFSET,
        opened: normalizeOffset(offset),
    };
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeModuleState = vi.hoisted(() => ({
    os: 'ios',
    addListener: vi.fn(),
    remove: vi.fn(),
    setHardwareKeyEventsEnabled: vi.fn(),
    setHardwareKeyConsumableEventSignatures: vi.fn(),
    setShiftEnterEnabled: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return nativeModuleState.os;
        },
    },
}));

vi.mock('expo-modules-core', () => ({
    requireOptionalNativeModule: () => ({
        addListener: nativeModuleState.addListener,
        setHardwareKeyEventsEnabled: nativeModuleState.setHardwareKeyEventsEnabled,
        setHardwareKeyConsumableEventSignatures: nativeModuleState.setHardwareKeyConsumableEventSignatures,
        setShiftEnterEnabled: nativeModuleState.setShiftEnterEnabled,
    }),
}));

type NativeHardwareKeyboardPayload = Readonly<{
    key: string;
    code?: string;
    characters?: string;
    modifiers: Readonly<{
        shift: boolean;
        ctrl: boolean;
        meta: boolean;
        alt: boolean;
    }>;
    repeat: boolean;
    target: string;
}>;

describe('native hardware keyboard subscriptions', () => {
    beforeEach(() => {
        nativeModuleState.os = 'ios';
        nativeModuleState.addListener.mockReset();
        nativeModuleState.addListener.mockReturnValue({ remove: nativeModuleState.remove });
        nativeModuleState.remove.mockReset();
        nativeModuleState.setHardwareKeyEventsEnabled.mockReset();
        nativeModuleState.setHardwareKeyConsumableEventSignatures.mockReset();
        nativeModuleState.setShiftEnterEnabled.mockReset();
        vi.resetModules();
    });

    afterEach(() => {
        vi.resetModules();
    });

    it('exposes a generic hardware key subscription for iOS and Android native registry integration without enabling consumption by default', async () => {
        nativeModuleState.os = 'android';

        const subscriptionModule: Record<string, unknown> = await import('./subscribeToIosHardwareShiftEnter');
        expect(subscriptionModule.subscribeToNativeHardwareKeyboardEvents).toBeTypeOf('function');

        const listener = vi.fn();
        const subscribeToNativeHardwareKeyboardEvents =
            subscriptionModule.subscribeToNativeHardwareKeyboardEvents as (next: (payload: NativeHardwareKeyboardPayload) => void) => { remove(): void } | null;

        const subscription = subscribeToNativeHardwareKeyboardEvents(listener);

        expect(subscription).not.toBeNull();
        expect(nativeModuleState.addListener).toHaveBeenCalledWith('hardwareKey', expect.any(Function));
        expect(nativeModuleState.setHardwareKeyEventsEnabled).toHaveBeenCalledWith(true);
        expect(nativeModuleState.setHardwareKeyConsumableEventSignatures).not.toHaveBeenCalled();

        const nativeListener = nativeModuleState.addListener.mock.calls[0]?.[1] as (payload: NativeHardwareKeyboardPayload) => void;
        const payload: NativeHardwareKeyboardPayload = {
            key: 'Escape',
            code: 'Escape',
            characters: '',
            modifiers: { shift: true, ctrl: false, meta: false, alt: false },
            repeat: false,
            target: 'activity',
        };

        nativeListener(payload);
        expect(listener).toHaveBeenCalledWith(payload);

        subscription?.remove();
        expect(nativeModuleState.setHardwareKeyEventsEnabled).toHaveBeenLastCalledWith(false);
        expect(nativeModuleState.remove).toHaveBeenCalledTimes(1);
    });

    it('exposes an explicit native-consumable signature configuration for registry-owned matched bindings', async () => {
        const { configureNativeHardwareKeyboardConsumableEventSignatures } = await import('./subscribeToIosHardwareShiftEnter');

        configureNativeHardwareKeyboardConsumableEventSignatures(['Enter|shift=false|ctrl=false|meta=true|alt=false']);

        expect(nativeModuleState.setHardwareKeyConsumableEventSignatures).toHaveBeenCalledWith([
            'Enter|shift=false|ctrl=false|meta=true|alt=false',
        ]);
    });

    it('keeps legacy iOS Shift+Enter wrapper ownership separate from generic shortcut consumption', async () => {
        const { subscribeToIosHardwareShiftEnter } = await import('./subscribeToIosHardwareShiftEnter');
        const listener = vi.fn();

        const subscription = subscribeToIosHardwareShiftEnter(listener);

        expect(subscription).not.toBeNull();
        expect(nativeModuleState.addListener).toHaveBeenCalledWith('shiftEnter', listener);
        expect(nativeModuleState.setShiftEnterEnabled).toHaveBeenCalledWith(true);
        expect(nativeModuleState.setHardwareKeyEventsEnabled).not.toHaveBeenCalled();
        expect(nativeModuleState.setHardwareKeyConsumableEventSignatures).not.toHaveBeenCalled();

        const legacyListener = nativeModuleState.addListener.mock.calls[0]?.[1] as () => void;
        legacyListener();

        expect(listener).toHaveBeenCalledTimes(1);

        subscription?.remove();
        expect(nativeModuleState.setShiftEnterEnabled).toHaveBeenLastCalledWith(false);
        expect(nativeModuleState.remove).toHaveBeenCalledTimes(1);
    });
});

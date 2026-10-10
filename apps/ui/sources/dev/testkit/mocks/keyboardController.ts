import { vi } from 'vitest';
import type * as KeyboardModule from 'react-native-keyboard-controller';
import { createReanimatedModuleMock } from './reanimated';

type KeyboardEventName = Parameters<typeof KeyboardModule.KeyboardEvents.addListener>[0];
type KeyboardEventListener = Parameters<typeof KeyboardModule.KeyboardEvents.addListener>[1];
type KeyboardEvent = Parameters<KeyboardEventListener>[0];
type FocusedInput = ReturnType<typeof KeyboardModule.useReanimatedFocusedInput>['input']['value'];

/**
 * Native keyboard/worklet port, following the installed 1.21 SDK's jest fixture.
 * Composer caret/keyboard owners remain real; tests can drive the captured OS
 * callbacks through the typed mocks or emit an SDK keyboard notification.
 */
export async function createKeyboardControllerModuleMock(overrides: Partial<Pick<typeof KeyboardModule,
    'useKeyboardHandler' | 'useFocusedInputHandler' | 'useKeyboardAnimation' | 'useReanimatedKeyboardAnimation'
>> = {}) {
    const { Animated, View, ScrollView } = await import('react-native');
    const reanimated = createReanimatedModuleMock();
    const animated = { progress: new Animated.Value(0), height: Animated.multiply(new Animated.Value(0), 1) };
    const shared = { progress: reanimated.makeMutable(0), height: reanimated.makeMutable(0) };
    const focusedInput = reanimated.makeMutable<FocusedInput>(null);
    const listeners = new Map<KeyboardEventName, Set<KeyboardEventListener>>();
    const event: KeyboardEvent = { height: 0, duration: 0, timestamp: 0, target: 0, type: 'default', appearance: 'light' };
    const KeyboardEvents = {
        addListener: vi.fn((name: KeyboardEventName, listener: KeyboardEventListener) => {
            const handlers = listeners.get(name) ?? new Set<KeyboardEventListener>();
            handlers.add(listener);
            listeners.set(name, handlers);
            return { remove: () => { handlers.delete(listener); } };
        }),
    };
    return {
        useKeyboardHandler: vi.fn<typeof KeyboardModule.useKeyboardHandler>(),
        useGenericKeyboardHandler: vi.fn<typeof KeyboardModule.useGenericKeyboardHandler>(),
        useFocusedInputHandler: vi.fn<typeof KeyboardModule.useFocusedInputHandler>(),
        useResizeMode: vi.fn<typeof KeyboardModule.useResizeMode>(),
        useKeyboardAnimation: vi.fn(() => animated),
        useReanimatedKeyboardAnimation: vi.fn(() => shared),
        useReanimatedFocusedInput: vi.fn(() => ({ input: focusedInput, update: async () => undefined })),
        useKeyboardState: <T>(selector?: (state: KeyboardEvent & { isVisible: boolean }) => T) => {
            const state = { ...event, isVisible: event.height > 0 };
            return selector ? selector(state) : state;
        },
        useKeyboardController: () => ({ enabled: true, setEnabled: vi.fn() }),
        KeyboardController: {
            setInputMode: vi.fn<typeof KeyboardModule.KeyboardController.setInputMode>(),
            setDefaultMode: vi.fn<typeof KeyboardModule.KeyboardController.setDefaultMode>(),
            preload: vi.fn<typeof KeyboardModule.KeyboardController.preload>(),
            dismiss: vi.fn(async () => undefined),
            setFocusTo: vi.fn<typeof KeyboardModule.KeyboardController.setFocusTo>(),
            isVisible: () => event.height > 0,
            state: () => ({ ...event }),
            viewPositionInWindow: async () => ({ x: 0, y: 0, width: 0, height: 0 }),
        },
        KeyboardEvents,
        KeyboardAvoidingView: View,
        KeyboardStickyView: View,
        KeyboardAwareScrollView: ScrollView,
        KeyboardChatScrollView: ScrollView,
        KeyboardProvider: View,
        ...overrides,
        /** Drives external notifications without replacing product keyboard logic. */
        emitKeyboardEvent(name: KeyboardEventName, next: KeyboardEvent) {
            Object.assign(event, next);
            shared.height.value = next.height;
            shared.progress.value = next.height > 0 ? 1 : 0;
            for (const listener of listeners.get(name) ?? []) listener(next);
        },
    };
}

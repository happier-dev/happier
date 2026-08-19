import * as React from 'react';
import { Platform } from 'react-native';

import type { MockComposerKeyboardScaffoldHarness } from '../harness/composerKeyboardScaffoldHarness';

export type {
    MockComposerKeyboardScaffoldHarness,
    MockComposerKeyboardScaffoldRender,
} from '../harness/composerKeyboardScaffoldHarness';

export type TestSharedValue<TValue> = {
    value: TValue;
    get: () => TValue;
    set: (value: TValue | ((value: TValue) => TValue)) => void;
    addListener: (listenerID: number, listener: (value: TValue) => void) => void;
    removeListener: (listenerID: number) => void;
    modify: (modifier?: (value: TValue) => TValue, forceUpdate?: boolean) => void;
};

const availablePanelHeightSubscribersByValue = new WeakMap<TestSharedValue<number>, Set<(height: number) => void>>();
const keyboardHeightSubscribersByValue = new WeakMap<TestSharedValue<number>, Set<(height: number) => void>>();
const listBottomInsetSubscribersByValue = new WeakMap<TestSharedValue<number>, Set<(height: number) => void>>();

export type ComposerKeyboardLayout = Readonly<{
    availablePanelHeight: TestSharedValue<number>;
    bottomInset: TestSharedValue<number>;
    composerHeight: TestSharedValue<number>;
    isKeyboardLiftSuppressed: TestSharedValue<boolean>;
    keyboardHeightForInset: TestSharedValue<number>;
    keyboardHeightLive: TestSharedValue<number>;
    keyboardProgress: TestSharedValue<number>;
    listBottomInset: TestSharedValue<number>;
    listBottomInsetAnimated: TestSharedValue<number>;
    getKeyboardHeight: () => number;
    retainKeyboardLift: () => () => void;
    setComposerMeasuredHeight: (height: number) => void;
    setScaffoldMeasuredHeight: (height: number) => void;
    subscribeAvailablePanelHeight: (listener: (height: number) => void) => () => void;
    subscribeKeyboardHeight: (listener: (height: number) => void) => () => void;
    subscribeListBottomInset: (listener: (height: number) => void) => () => void;
}>;

export type MockComposerKeyboardLayoutOverrides = Partial<Readonly<{
    availablePanelHeight: number;
    bottomInset: number;
    composerHeight: number;
    isKeyboardLiftSuppressed: boolean;
    keyboardHeightForInset: number;
    keyboardHeightLive: number;
    keyboardProgress: number;
    listBottomInset: number;
}>>;

export type MockComposerKeyboardScaffoldMode = 'session' | 'newSession';

export type MockComposerKeyboardScaffoldProps = Readonly<{
    accessibilityLabel?: string;
    accessibilityRole?: string;
    children?: React.ReactNode;
    composer: React.ReactNode;
    composerTestID?: string;
    contentProps?: Record<string, unknown>;
    contentStyle?: unknown;
    contentTestID?: string;
    availablePanelMaxHeight?: number;
    harness?: MockComposerKeyboardScaffoldHarness;
    headerHeight?: number;
    keyboardLiftSuppressed?: boolean;
    layoutBottomInset?: number;
    layout?: ComposerKeyboardLayout;
    mode: MockComposerKeyboardScaffoldMode;
    safeAreaTop?: number;
    safeAreaBottom?: number;
    style?: unknown;
    surface?: 'opaque' | 'transparent';
    testID?: string;
}>;

function createTestSharedValue<TValue>(value: TValue): TestSharedValue<TValue> {
    const listeners = new Map<number, (value: TValue) => void>();
    const sharedValue: TestSharedValue<TValue> = {
        value,
        get: () => sharedValue.value,
        set: (nextValue) => {
            sharedValue.value = typeof nextValue === 'function'
                ? (nextValue as (value: TValue) => TValue)(sharedValue.value)
                : nextValue;
            for (const listener of listeners.values()) {
                listener(sharedValue.value);
            }
        },
        addListener: (listenerID, listener) => {
            listeners.set(listenerID, listener);
        },
        removeListener: (listenerID) => {
            listeners.delete(listenerID);
        },
        modify: (modifier) => {
            if (!modifier) return;
            sharedValue.set(modifier(sharedValue.value));
        },
    };
    return sharedValue;
}

// The animated list inset is a derived value on both platform hooks: web reads the list inset
// directly, native recomputes the same total from the live keyboard geometry. Model it as a
// lazily evaluated shared value so a test can move the keyboard without a notification, the way
// the UI thread does.
function createDerivedTestSharedValue(read: () => number): TestSharedValue<number> {
    const derived = {
        get value() {
            return read();
        },
        set value(_next: number) {
            throw new Error('The animated list inset is derived; drive its inputs instead.');
        },
        get: () => read(),
        set: () => {
            throw new Error('The animated list inset is derived; drive its inputs instead.');
        },
        addListener: () => {},
        removeListener: () => {},
        modify: () => {},
    };
    return derived as TestSharedValue<number>;
}

export function createMockComposerKeyboardLayout(
    overrides: MockComposerKeyboardLayoutOverrides = {},
): ComposerKeyboardLayout {
    const composerHeight = createTestSharedValue(overrides.composerHeight ?? 0);
    const availablePanelHeight = createTestSharedValue(overrides.availablePanelHeight ?? 0);
    const keyboardHeightLive = createTestSharedValue(overrides.keyboardHeightLive ?? 0);
    const listBottomInset = createTestSharedValue(overrides.listBottomInset ?? 0);
    const availablePanelHeightSubscribers = new Set<(height: number) => void>();
    const keyboardHeightSubscribers = new Set<(height: number) => void>();
    const listBottomInsetSubscribers = new Set<(height: number) => void>();
    availablePanelHeightSubscribersByValue.set(availablePanelHeight, availablePanelHeightSubscribers);
    keyboardHeightSubscribersByValue.set(keyboardHeightLive, keyboardHeightSubscribers);
    listBottomInsetSubscribersByValue.set(listBottomInset, listBottomInsetSubscribers);
    const bottomInset = createTestSharedValue(overrides.bottomInset ?? 0);
    const keyboardHeightForInset = createTestSharedValue(overrides.keyboardHeightForInset ?? 0);
    const listBottomInsetAnimated = createDerivedTestSharedValue(() => (
        Platform.OS === 'web'
            ? Math.max(0, listBottomInset.value)
            : Math.max(0, composerHeight.value + Math.max(keyboardHeightForInset.value, bottomInset.value))
    ));

    return {
        availablePanelHeight,
        bottomInset,
        composerHeight,
        isKeyboardLiftSuppressed: createTestSharedValue(overrides.isKeyboardLiftSuppressed ?? false),
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardProgress: createTestSharedValue(overrides.keyboardProgress ?? 0),
        listBottomInset,
        listBottomInsetAnimated,
        getKeyboardHeight: () => keyboardHeightLive.value,
        retainKeyboardLift: () => () => {},
        setComposerMeasuredHeight: (height) => {
            composerHeight.value = height;
        },
        setScaffoldMeasuredHeight: () => {},
        subscribeAvailablePanelHeight: (listener) => {
            availablePanelHeightSubscribers.add(listener);
            listener(availablePanelHeight.value);
            return () => {
                availablePanelHeightSubscribers.delete(listener);
            };
        },
        subscribeKeyboardHeight: (listener) => {
            keyboardHeightSubscribers.add(listener);
            listener(keyboardHeightLive.value);
            return () => {
                keyboardHeightSubscribers.delete(listener);
            };
        },
        subscribeListBottomInset: (listener) => {
            listBottomInsetSubscribers.add(listener);
            listener(listBottomInset.value);
            return () => {
                listBottomInsetSubscribers.delete(listener);
            };
        },
    };
}

export function setMockComposerKeyboardLiveHeight(layout: ComposerKeyboardLayout, height: number): void {
    layout.keyboardHeightLive.value = height;
    const subscribers = keyboardHeightSubscribersByValue.get(layout.keyboardHeightLive);
    for (const listener of subscribers ?? []) {
        listener(height);
    }
}

export function setMockComposerKeyboardSettledHeight(layout: ComposerKeyboardLayout, height: number): void {
    layout.keyboardHeightForInset.value = height;
}

export function setMockComposerHeight(layout: ComposerKeyboardLayout, height: number): void {
    layout.setComposerMeasuredHeight(height);
}

export function setMockComposerAvailablePanelHeight(layout: ComposerKeyboardLayout, height: number): void {
    layout.availablePanelHeight.value = height;
    const subscribers = availablePanelHeightSubscribersByValue.get(layout.availablePanelHeight);
    for (const listener of subscribers ?? []) {
        listener(height);
    }
}

export function setMockComposerListBottomInset(layout: ComposerKeyboardLayout, height: number): void {
    layout.listBottomInset.value = height;
    const subscribers = listBottomInsetSubscribersByValue.get(layout.listBottomInset);
    for (const listener of subscribers ?? []) {
        listener(height);
    }
}

export function setMockComposerKeyboardSuppressed(layout: ComposerKeyboardLayout, isSuppressed: boolean): void {
    layout.isKeyboardLiftSuppressed.value = isSuppressed;
}

export function mockUseComposerKeyboardLayout(
    layoutOverrides?: MockComposerKeyboardLayoutOverrides,
): () => ComposerKeyboardLayout {
    const layout = createMockComposerKeyboardLayout(layoutOverrides);
    return () => layout;
}

export function MockComposerKeyboardScaffold(props: MockComposerKeyboardScaffoldProps): React.ReactElement {
    const {
        children,
        composer,
        contentProps,
        composerTestID,
        contentTestID,
        harness,
        layout = createMockComposerKeyboardLayout(),
        testID,
        ...rootProps
    } = props;
    harness?.recordRender({ layout, props });

    return React.createElement(
        'MockComposerKeyboardScaffold',
        { ...rootProps, testID },
        React.createElement('MockComposerKeyboardScaffoldContent', { ...contentProps, testID: contentTestID }, children),
        React.createElement('MockComposerKeyboardScaffoldComposer', { testID: composerTestID }, composer),
    );
}

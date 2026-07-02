import * as React from 'react';

type SharedValue<T> = { value: T };

type KeyboardAnimation = Readonly<{
    height: SharedValue<number>;
    progress: SharedValue<number>;
}>;

const defaultKeyboardAnimation: KeyboardAnimation = {
    height: { value: 0 },
    progress: { value: 0 },
};

type HostProps = Readonly<{
    children?: React.ReactNode;
    [key: string]: unknown;
}>;

function createHostComponent(displayName: string) {
    const Component = React.forwardRef<unknown, HostProps>(function KeyboardControllerHost(props, ref) {
        const { children, ...rest } = props;
        const hostProps: Record<string, unknown> & { ref?: React.ForwardedRef<unknown> } = { ...rest };
        if (ref != null) {
            hostProps.ref = ref;
        }
        return React.createElement(displayName, hostProps, children as React.ReactNode);
    });
    Component.displayName = displayName;
    return Component;
}

export const KeyboardAvoidingView = createHostComponent('KeyboardAvoidingView');
export const KeyboardStickyView = createHostComponent('KeyboardStickyView');
export const KeyboardAwareScrollView = createHostComponent('KeyboardAwareScrollView');

export function KeyboardProvider(props: React.PropsWithChildren): React.ReactNode {
    return React.createElement(React.Fragment, null, props.children);
}

export function useKeyboardState(): Readonly<{ height: number; isVisible: boolean; progress: number }> {
    return { height: 0, isVisible: false, progress: 0 };
}

export function useKeyboardHandler(): void {}

export function useReanimatedKeyboardAnimation(): KeyboardAnimation {
    return defaultKeyboardAnimation;
}

declare module 'react-native-web' {
    import type * as ReactNative from 'react-native';

    // `react-native-web` intentionally mirrors much of React Native's public API surface.
    // For UI typechecking we treat it as compatible with `react-native`.
    const ReactNativeWeb: typeof ReactNative;
    export default ReactNativeWeb;
    export * from 'react-native';
}

declare module 'react-native-web/dist/modules/forwardedProps' {
    /**
     * The prop whitelist `View` (and every primitive built on it) uses to decide what
     * reaches the DOM node — `pick(props, forwardPropsList)` in
     * `react-native-web/dist/exports/View/index.js`. A prop absent from these groups is
     * silently dropped, which is how a handler can look wired and never fire
     * (`onMouseDown` is forwarded; `onMouseDownCapture` is not).
     *
     * Declared here rather than reimplemented so tests that assert "the browser can
     * actually call this handler" read the installed package's own data.
     */
    type ForwardedPropGroup = Readonly<Record<string, true>>;

    export const defaultProps: ForwardedPropGroup;
    export const accessibilityProps: ForwardedPropGroup;
    export const clickProps: ForwardedPropGroup;
    export const focusProps: ForwardedPropGroup;
    export const keyboardProps: ForwardedPropGroup;
    export const mouseProps: ForwardedPropGroup;
    export const touchProps: ForwardedPropGroup;
    export const styleProps: ForwardedPropGroup;
}

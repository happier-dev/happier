declare module 'react-native-web' {
    import type * as ReactNative from 'react-native';

    // `react-native-web` intentionally mirrors much of React Native's public API surface.
    // For UI typechecking we treat it as compatible with `react-native`.
    const ReactNativeWeb: typeof ReactNative;
    export default ReactNativeWeb;
    export * from 'react-native';
}

// Vitest/node stub for React Native internal module paths like:
// - `react-native/Libraries/...`
// - `react-native/src/...`
//
// Many third-party RN libs import these internals (which contain Flow syntax in the real RN package).
// For unit tests we only need these imports to be parseable and non-throwing.

const proxy: any = new Proxy(function () {}, {
    get: () => proxy,
    apply: () => undefined,
    construct: () => proxy,
});

export default proxy;

export const customDirectEventTypes: any = {};
export const ReactNativeStyleAttributes: any = {};
export const NativeComponentRegistry: any = {};
export const UIManager: any = {};
export const RendererProxy: any = {};
export const BatchedBridge: any = {};
export const TextInputState: any = {};

export function codegenNativeComponent(..._args: any[]) {
    return 'NativeComponent' as any;
}

export function codegenNativeCommands(..._args: any[]) {
    return {} as any;
}

export function requireNativeComponent(..._args: any[]) {
    return 'requireNativeComponent' as any;
}

export function flattenStyle(style: any) {
    return style;
}

export function processColor(value: any) {
    return value;
}


import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

/** Read one winning property without enumerating away Unistyles' hidden values. */
export function readSurfaceStyleProperty<K extends keyof ViewStyle>(style: unknown, key: K): ViewStyle[K] | undefined {
    if (!style) return undefined;
    if (Array.isArray(style)) {
        return style.reduce<ViewStyle[K] | undefined>((value, entry: unknown) => readSurfaceStyleProperty(entry, key) ?? value, undefined);
    }
    // RNW's flatten enumerates even a single object; Unistyles exposes its
    // values as non-enumerable properties. Read that object before flattening.
    // This renderer boundary accepts both portable and native style arrays.
    if (typeof style === 'object') return (style as ViewStyle)[key];
    if (typeof style === 'number') return StyleSheet.flatten<ViewStyle>(style as StyleProp<ViewStyle>)?.[key];
    return undefined;
}

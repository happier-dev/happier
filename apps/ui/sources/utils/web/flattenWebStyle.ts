import { StyleSheet, type StyleProp } from 'react-native';

/** Resolve Unistyles web values before third-party flattening or DOM conversion. */
/** Nested style arrays may be readonly (a frozen `[base, override]`); React Native accepts both. */
export function flattenWebStyle<T extends object>(style: StyleProp<T> | ReadonlyArray<StyleProp<T>>): T | undefined {
    if (!style) return undefined;
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(value => flattenWebStyle<T>(value)));
    }
    const resolved = typeof style === 'object' ? style : StyleSheet.flatten(style);
    // Unistyles 3 web create/removeInlineStyles stores values as non-enumerable own properties.
    // Its enumerable marker is metadata, never a React Native style or CSS property.
    return Object.fromEntries(Object.getOwnPropertyNames(resolved)
        .filter(key => !key.startsWith('unistyles_'))
        .map(key => [key, Reflect.get(resolved, key)])) as T;
}

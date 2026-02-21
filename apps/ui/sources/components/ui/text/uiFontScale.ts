import type { StyleProp, TextStyle } from 'react-native';

function roundTo2(value: number): number {
    return Math.round(value * 100) / 100;
}

function clonePreservingOwnProps<T extends object>(entry: T): T {
    try {
        const proto = Object.getPrototypeOf(entry);
        const descriptors = Object.getOwnPropertyDescriptors(entry);
        return Object.create(proto, descriptors);
    } catch {
        return { ...(entry as any) };
    }
}

export function scaleTextStyle<T extends StyleProp<TextStyle> | undefined | null>(
    style: T,
    uiFontScale: number
): T {
    if (style == null) return style;
    if (typeof uiFontScale !== 'number' || !Number.isFinite(uiFontScale) || uiFontScale === 1) return style;

    const scaleOne = (entry: any): any => {
        if (!entry) return entry;
        if (typeof entry === 'number') {
            // Numeric style ids come from React Native's internal style registry, which isn't available
            // in this codebase (we avoid React Native's StyleSheet API in favor of Unistyles).
            // Fail closed and preserve the original value.
            return entry;
        }
        if (typeof entry !== 'object') return entry;

        const hasFontSize = typeof (entry as any).fontSize === 'number';
        const hasLineHeight = typeof (entry as any).lineHeight === 'number';
        const hasLetterSpacing = typeof (entry as any).letterSpacing === 'number';
        if (!hasFontSize && !hasLineHeight && !hasLetterSpacing) return entry;

        const next: any = clonePreservingOwnProps(entry as any);
        try {
            if (hasFontSize) next.fontSize = roundTo2(next.fontSize * uiFontScale);
            if (hasLineHeight) next.lineHeight = roundTo2(next.lineHeight * uiFontScale);
            if (hasLetterSpacing) next.letterSpacing = roundTo2(next.letterSpacing * uiFontScale);
            return next;
        } catch {
            // If the style object is non-writable (or uses accessors), avoid corrupting opaque metadata.
            return entry;
        }
    };

    if (Array.isArray(style)) {
        let changed = false;
        const next = (style as any[]).map((entry) => {
            const scaled = scaleOne(entry);
            if (scaled !== entry) changed = true;
            return scaled;
        });
        return (changed ? (next as any) : style) as any;
    }

    const scaled = scaleOne(style);
    return (scaled === style ? style : scaled) as any;
}

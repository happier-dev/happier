import type { StyleProp, TextStyle } from 'react-native';

const UNISTYLES_SECRET_KEY_PREFIX = 'unistyles_';

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

function setScaledMetric(target: any, key: string, value: number): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || (descriptor.writable === true && !descriptor.get && !descriptor.set)) {
        target[key] = value;
        return;
    }
    // Web Unistyles registers style values as non-enumerable, non-writable data properties
    // (see react-native-unistyles/src/web removeInlineStyles). Redefine the metric on the
    // clone while preserving its enumerability so CSS-class-driven rendering is unaffected.
    Object.defineProperty(target, key, {
        value,
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true,
    });
}

function scaleNumericTextMetrics(entry: any, uiFontScale: number): any {
    const hasFontSize = typeof entry?.fontSize === 'number';
    const hasLineHeight = typeof entry?.lineHeight === 'number';
    const hasLetterSpacing = typeof entry?.letterSpacing === 'number';
    if (!hasFontSize && !hasLineHeight && !hasLetterSpacing) return entry;

    const next: any = clonePreservingOwnProps(entry as any);
    try {
        if (hasFontSize) setScaledMetric(next, 'fontSize', roundTo2(entry.fontSize * uiFontScale));
        if (hasLineHeight) setScaledMetric(next, 'lineHeight', roundTo2(entry.lineHeight * uiFontScale));
        if (hasLetterSpacing) setScaledMetric(next, 'letterSpacing', roundTo2(entry.letterSpacing * uiFontScale));
        return next;
    } catch {
        // A non-configurable, non-writable metric cannot be scaled without corrupting opaque
        // metadata; fail closed to the unscaled style.
        return entry;
    }
}

function scaleResolvedTextStyle(entry: any, uiFontScale: number): any {
    if (!entry) return entry;
    if (Array.isArray(entry)) {
        let changed = false;
        const next = entry.map((nestedEntry) => {
            const scaledNestedEntry = scaleResolvedTextStyle(nestedEntry, uiFontScale);
            if (scaledNestedEntry !== nestedEntry) changed = true;
            return scaledNestedEntry;
        });
        return changed ? next : entry;
    }
    if (typeof entry !== 'object') return entry;
    const entryWithScaledSecrets = wrapUnistylesSecrets(entry, uiFontScale);
    return scaleNumericTextMetrics(entryWithScaledSecrets, uiFontScale);
}

function wrapUnistylesSecret(secret: any, uiFontScale: number): any {
    if (!secret || typeof secret !== 'object' || typeof secret.uni__getStyles !== 'function') {
        return secret;
    }

    const wrappedSecret: any = clonePreservingOwnProps(secret);
    const originalGetStyles = secret.uni__getStyles.bind(secret);
    wrappedSecret.uni__getStyles = () => scaleResolvedTextStyle(originalGetStyles(), uiFontScale);
    return wrappedSecret;
}

function wrapUnistylesSecrets(entry: any, uiFontScale: number): any {
    const secretKeys = Object.keys(entry).filter((key) => key.startsWith(UNISTYLES_SECRET_KEY_PREFIX));
    if (secretKeys.length === 0) return entry;

    let nextEntry: any = entry;
    let changed = false;

    for (const secretKey of secretKeys) {
        const scaledSecret = wrapUnistylesSecret(entry[secretKey], uiFontScale);
        if (scaledSecret === entry[secretKey]) continue;
        if (!changed) {
            nextEntry = clonePreservingOwnProps(entry);
            changed = true;
        }
        try {
            nextEntry[secretKey] = scaledSecret;
        } catch {
            return entry;
        }
    }

    return changed ? nextEntry : entry;
}

export function scaleTextStyle<T extends StyleProp<TextStyle> | undefined | null>(
    style: T,
    uiFontScale: number
): T {
    if (style == null) return style;
    if (typeof uiFontScale !== 'number' || !Number.isFinite(uiFontScale) || uiFontScale === 1) return style;

    const scaleOne = (entry: any): any => {
        if (!entry) return entry;
        if (Array.isArray(entry)) {
            return scaleResolvedTextStyle(entry, uiFontScale);
        }
        if (typeof entry === 'number') {
            // Numeric style ids come from React Native's internal style registry, which isn't available
            // in this codebase (we avoid React Native's StyleSheet API in favor of Unistyles).
            // Fail closed and preserve the original value.
            return entry;
        }
        if (typeof entry !== 'object') return entry;

        const entryWithScaledSecrets = wrapUnistylesSecrets(entry, uiFontScale);
        return scaleNumericTextMetrics(entryWithScaledSecrets, uiFontScale);
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

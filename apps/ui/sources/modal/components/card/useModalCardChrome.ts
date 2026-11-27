import * as React from 'react';
import { Platform } from 'react-native';

import type { CustomModalChromeCardConfig, CustomModalInjectedProps } from '../../types';

type ModalCardViewportMargin = NonNullable<CustomModalChromeCardConfig['dimensions']>['viewportMargin'];

function areViewportMarginsEqual(
    a: ModalCardViewportMargin,
    b: ModalCardViewportMargin,
): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;
    if (typeof a === 'number' || typeof b === 'number') {
        return typeof a === 'number' && typeof b === 'number' && a === b;
    }
    return a.horizontal === b.horizontal
        && a.vertical === b.vertical;
}

function areDimensionOptionsEqual(
    a: CustomModalChromeCardConfig['dimensions'],
    b: CustomModalChromeCardConfig['dimensions'],
): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;
    return a.size === b.size
        && a.width === b.width
        && a.maxHeightRatio === b.maxHeightRatio
        && areViewportMarginsEqual(a.viewportMargin, b.viewportMargin);
}

function areChromeFieldValuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;

    if (typeof a === 'function' || typeof b === 'function') {
        return false;
    }

    if (a == null || b == null) {
        return a == null && b == null;
    }

    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        return a.every((value, index) => areChromeFieldValuesEqual(value, b[index]));
    }

    if (React.isValidElement(a) && React.isValidElement(b)) {
        if (a.type !== b.type || a.key !== b.key) return false;

        const aProps = (a.props ?? {}) as Record<string, unknown>;
        const bProps = (b.props ?? {}) as Record<string, unknown>;
        const keys = new Set([...Object.keys(aProps), ...Object.keys(bProps)]);

        for (const key of keys) {
            if (!areChromeFieldValuesEqual(aProps[key], bProps[key])) {
                return false;
            }
        }

        return true;
    }

    if (typeof a === 'object' || typeof b === 'object') {
        if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) {
            return false;
        }

        const aRecord = a as Record<string, unknown>;
        const bRecord = b as Record<string, unknown>;
        const keys = new Set([...Object.keys(aRecord), ...Object.keys(bRecord)]);

        for (const key of keys) {
            if (!areChromeFieldValuesEqual(aRecord[key], bRecord[key])) {
                return false;
            }
        }

        return true;
    }

    if (typeof a === 'symbol' || typeof b === 'symbol') {
        return false;
    }

    return false;
}

function areChromeConfigsEquivalent(
    a: CustomModalChromeCardConfig | null | undefined,
    b: CustomModalChromeCardConfig | null,
): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;

    return areChromeFieldValuesEqual(a.title, b.title)
        && areChromeFieldValuesEqual(a.subtitle, b.subtitle)
        && areChromeFieldValuesEqual(a.leading, b.leading)
        && areChromeFieldValuesEqual(a.actions, b.actions)
        && areChromeFieldValuesEqual(a.footer, b.footer)
        && a.testID === b.testID
        && a.titleTestID === b.titleTestID
        && a.subtitleTestID === b.subtitleTestID
        && a.closeButtonTestID === b.closeButtonTestID
        && a.header === b.header
        && a.layout === b.layout
        && a.bodyScroll === b.bodyScroll
        && areDimensionOptionsEqual(a.dimensions, b.dimensions);
}

export function useModalCardChrome(
    setChrome: CustomModalInjectedProps['setChrome'] | undefined,
    chrome: CustomModalChromeCardConfig | null,
): void {
    const lastPublishedChromeRef = React.useRef<CustomModalChromeCardConfig | null | undefined>(undefined);
    const lastSetChromeRef = React.useRef<typeof setChrome>(setChrome);
    const useChromePublishEffect = Platform.OS === 'web' ? React.useEffect : React.useLayoutEffect;

    useChromePublishEffect(() => {
        if (!setChrome) return;
        if (lastSetChromeRef.current !== setChrome) {
            lastSetChromeRef.current = setChrome;
            lastPublishedChromeRef.current = undefined;
        }
        if (areChromeConfigsEquivalent(lastPublishedChromeRef.current, chrome)) {
            return;
        }
        lastPublishedChromeRef.current = chrome;
        setChrome(chrome);
    }, [chrome, setChrome]);
}

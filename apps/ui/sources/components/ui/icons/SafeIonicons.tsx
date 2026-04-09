import * as React from 'react';

import { Ionicons as IoniconsImport } from '@expo/vector-icons';
import { isRenderableElementType } from './isRenderableElementType';

export type SafeIoniconsName = React.ComponentProps<typeof IoniconsImport>['name'];

export type SafeIoniconsProps = Readonly<{
    name: SafeIoniconsName;
    size: number;
    color: string;
    style?: React.ComponentProps<typeof IoniconsImport>['style'];
}>;

let ioniconsFallback: unknown | null = null;

function requireIoniconsFallback(): unknown | null {
    if (ioniconsFallback !== null) {
        return ioniconsFallback;
    }

    try {
        // Some bundle configurations can make the named export from `@expo/vector-icons` undefined.
        // Fall back to the per-icon-set entrypoint, but only if we actually need it so test mocks
        // that provide `@expo/vector-icons` keep working without additional wiring.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('@expo/vector-icons/Ionicons') as { default?: unknown } | undefined;
        const resolved = mod?.default ?? mod ?? null;
        ioniconsFallback = resolved;
        return resolved;
    } catch {
        ioniconsFallback = null;
        return null;
    }
}

/**
 * In some desktop/Tauri bundle configurations, `@expo/vector-icons` can resolve a given icon set
 * export to `undefined`. Rendering an undefined element type crashes React.
 *
 * This wrapper fail-opens (renders nothing) when the icon set is unavailable.
 */
export const SafeIonicons = React.memo(function SafeIonicons(props: SafeIoniconsProps) {
    const Ionicons = isRenderableElementType(IoniconsImport)
        ? (IoniconsImport as unknown)
        : requireIoniconsFallback();
    if (!isRenderableElementType(Ionicons)) {
        return null;
    }

    return React.createElement(Ionicons, props);
});

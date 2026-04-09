import * as React from 'react';

const DIRECT_RENDERABLE_ELEMENT_TYPES = new Set<unknown>([
    React.Fragment,
    React.StrictMode,
    React.Profiler,
    React.Suspense,
]);

const RENDERABLE_ELEMENT_TYPE_SYMBOLS = new Set<symbol>([
    Symbol.for('react.context'),
    Symbol.for('react.consumer'),
    Symbol.for('react.forward_ref'),
    Symbol.for('react.lazy'),
    Symbol.for('react.memo'),
    Symbol.for('react.provider'),
]);

export function isRenderableElementType(value: unknown): value is React.ElementType {
    if (typeof value === 'function' || typeof value === 'string') {
        return true;
    }

    if (DIRECT_RENDERABLE_ELEMENT_TYPES.has(value)) {
        return true;
    }

    if (!value || typeof value !== 'object') {
        return false;
    }

    const typeMarker = (value as Record<string, unknown>).$$typeof;
    return typeof typeMarker === 'symbol' && RENDERABLE_ELEMENT_TYPE_SYMBOLS.has(typeMarker);
}

import * as React from 'react';

const MAX_COMPARE_DEPTH = 8;
const MAX_COMPARE_ARRAY_LENGTH = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function areReactNodeValuesEqual(a: unknown, b: unknown, depth: number): boolean {
    if (a == null && b == null) return true;
    if (Object.is(a, b)) return true;
    if (depth >= MAX_COMPARE_DEPTH) return false;
    if (typeof a !== typeof b) return false;
    if (a == null || b == null) return false;

    if (Array.isArray(a)) {
        if (!Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        if (a.length > MAX_COMPARE_ARRAY_LENGTH) return false;
        for (let i = 0; i < a.length; i += 1) {
            if (!areReactNodeValuesEqual(a[i], b[i], depth + 1)) return false;
        }
        return true;
    }

    if (React.isValidElement(a)) {
        if (!React.isValidElement(b)) return false;
        if (a.type !== b.type) return false;
        if (a.key !== b.key) return false;
        return areReactNodeValuesEqual(a.props, b.props, depth + 1);
    }

    if (isPlainObject(a)) {
        if (!isPlainObject(b)) return false;
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) return false;
        for (const key of aKeys) {
            if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
            if (!areReactNodeValuesEqual(a[key], b[key], depth + 1)) return false;
        }
        return true;
    }

    return false;
}

export function areReactNodesStructurallyEqual(a: React.ReactNode | null | undefined, b: React.ReactNode | null | undefined): boolean {
    return areReactNodeValuesEqual(a, b, 0);
}

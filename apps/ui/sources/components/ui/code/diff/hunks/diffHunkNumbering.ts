import * as React from 'react';
import type { DiffHunkNumbering } from '../diffViewerTypes';

const noSubscription = () => () => {};

/** Numbers that never move: the File page counts the changes within its one file. */
export function fixedDiffHunkNumbering(offset: number, total: number): DiffHunkNumbering {
    return { subscribe: noSubscription, offset: () => offset, total: () => total };
}

/** A change row's number and its comparison total, re-read only when the file's numbering publishes. */
export function useDiffHunkNumber(numbering: DiffHunkNumbering | undefined, index: number): Readonly<{ n: number; total: number }> {
    const subscribe = numbering?.subscribe ?? noSubscription;
    const offset = React.useSyncExternalStore(subscribe, () => numbering?.offset() ?? 0, () => numbering?.offset() ?? 0);
    const total = React.useSyncExternalStore(subscribe, () => numbering?.total() ?? null, () => numbering?.total() ?? null);
    const n = offset + index + 1;
    return { n, total: total ?? n };
}

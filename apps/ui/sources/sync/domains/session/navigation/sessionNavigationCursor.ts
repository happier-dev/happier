/**
 * A frozen snapshot of the session order the user last saw, plus the stepping rule
 * that walks it.
 *
 * Lateral session navigation must move through the order that was on screen when the
 * user left the list, not the order the live list happens to have now — a session that
 * reorders while a transcript is open must not change what "next" means. The cursor
 * captures that order once; every subsequent step reads it instead of the live list.
 *
 * Unlike `resolveVisibleSessionNavigation`, a missing anchor is `unavailable` rather
 * than a silent jump to an end entry: a step whose anchor is gone must do nothing.
 * Unlike `resolveSessionMruNavigation`, the walk clamps at both ends and never wraps.
 *
 * Pure module: no React, no `sync/store/**` dependency.
 */

import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';

import {
    buildVisibleSessionNavigationEntries,
    type SessionListLikeItem,
    type SessionNavigationDirection,
    type VisibleSessionNavigationEntry,
} from './sessionNavigationOrder';

export type SessionNavigationCursorOrigin = 'session-list' | 'archived' | 'recent';

export type SessionNavigationCursorIdentity = Readonly<{
    origin: SessionNavigationCursorOrigin;
    sourceScopeKey: string;
    storageKind: SessionListStorageFilter;
}>;

export type SessionNavigationCursor = Readonly<{
    identity: SessionNavigationCursorIdentity;
    entries: readonly VisibleSessionNavigationEntry[];
    capturedAtMs: number;
}>;

export type SessionNavigationCursorStep =
    | Readonly<{ kind: 'target'; entry: VisibleSessionNavigationEntry; cursorSessionKey: string }>
    | Readonly<{ kind: 'edge' }>
    | Readonly<{ kind: 'unavailable' }>;

const MINIMUM_NAVIGABLE_CURSOR_ENTRIES = 2;

/**
 * Freezes the currently visible session order. Returns null when the captured order
 * cannot support a step (fewer than two entries), so callers never hold a cursor that
 * can only ever report an edge.
 */
export function buildSessionNavigationCursor(params: Readonly<{
    identity: SessionNavigationCursorIdentity;
    items: readonly SessionListLikeItem[] | null | undefined;
    nowMs: number;
}>): SessionNavigationCursor | null {
    const entries = buildVisibleSessionNavigationEntries(params.items);
    if (entries.length < MINIMUM_NAVIGABLE_CURSOR_ENTRIES) return null;
    return {
        identity: params.identity,
        entries,
        capturedAtMs: params.nowMs,
    };
}

/**
 * Whether two cursors capture the same order from the same surface. A publisher re-runs whenever
 * its source array is rebuilt, which happens for reasons that do not change the order at all;
 * republishing then would re-stamp `capturedAtMs` and wake every subscriber for nothing.
 */
export function areSessionNavigationCursorsEquivalent(
    previous: SessionNavigationCursor | null | undefined,
    next: SessionNavigationCursor | null | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return false;
    if (
        previous.identity.origin !== next.identity.origin
        || previous.identity.sourceScopeKey !== next.identity.sourceScopeKey
        || previous.identity.storageKind !== next.identity.storageKind
    ) {
        return false;
    }
    if (previous.entries.length !== next.entries.length) return false;
    return previous.entries.every((entry, index) => entry.sessionKey === next.entries[index]?.sessionKey);
}

export function resolveSessionNavigationCursorStep(params: Readonly<{
    cursor: SessionNavigationCursor | null | undefined;
    anchorSessionKey: string | null;
    direction: SessionNavigationDirection;
    isEntryNavigable?: (entry: VisibleSessionNavigationEntry) => boolean;
}>): SessionNavigationCursorStep {
    const entries = params.cursor?.entries ?? null;
    if (!entries || entries.length === 0) return { kind: 'unavailable' };

    const anchorSessionKey = typeof params.anchorSessionKey === 'string'
        ? params.anchorSessionKey.trim()
        : '';
    if (!anchorSessionKey) return { kind: 'unavailable' };

    const anchorIndex = entries.findIndex((entry) => entry.sessionKey === anchorSessionKey);
    if (anchorIndex < 0) return { kind: 'unavailable' };

    const delta = params.direction === 'previous' ? -1 : 1;
    const isEntryNavigable = params.isEntryNavigable;
    for (let index = anchorIndex + delta; index >= 0 && index < entries.length; index += delta) {
        const entry = entries[index];
        if (!entry) continue;
        if (isEntryNavigable && !isEntryNavigable(entry)) continue;
        return { kind: 'target', entry, cursorSessionKey: entry.sessionKey };
    }

    return { kind: 'edge' };
}

import type { SessionListRenderableSession } from './sessionListRenderable';
import { didSessionListRenderableStructuralFieldsChange } from './sessionListRenderable';
import { resolveSessionListRenderableMeaningfulActivityAt } from './sessionListRenderableSorting';
import {
    resolveSessionListGroupingModes,
    type SessionListGroupingMode,
    type SessionListSectionMode,
} from './resolveSessionListGroupingModes';

export type SessionListIndexRebuildSettings = Readonly<{
    groupInactiveSessionsByProject: boolean;
    activeGroupingV1?: SessionListGroupingMode;
    inactiveGroupingV1?: SessionListGroupingMode;
    sectionModeV1?: SessionListSectionMode;
}>;

function doesSessionMeaningfulActivityAffectSessionListIndex(
    session: SessionListRenderableSession,
    settings: SessionListIndexRebuildSettings | null | undefined,
): boolean {
    if (!settings) {
        return false;
    }

    const groupingModes = resolveSessionListGroupingModes(settings);
    if (groupingModes.sectionMode === 'single') {
        return groupingModes.activeGrouping === 'date';
    }

    return session.active
        ? groupingModes.activeGrouping === 'date'
        : groupingModes.inactiveGrouping === 'date';
}

export function shouldRebuildSessionListIndexForRenderableChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
    settings?: SessionListIndexRebuildSettings | null,
): boolean {
    if (didSessionListRenderableStructuralFieldsChange(previous, next)) {
        return true;
    }
    const previousActivityAt = previous
        ? resolveSessionListRenderableMeaningfulActivityAt(previous)
        : null;
    const nextActivityAt = resolveSessionListRenderableMeaningfulActivityAt(next);
    if (!previous || previousActivityAt === nextActivityAt) {
        return false;
    }

    return (
        doesSessionMeaningfulActivityAffectSessionListIndex(previous, settings)
        || doesSessionMeaningfulActivityAffectSessionListIndex(next, settings)
    );
}

export function shouldRebuildSessionListIndexForRowStateChange(
    previousRows: Readonly<Record<string, SessionListRenderableSession>> | null | undefined,
    nextRows: Readonly<Record<string, SessionListRenderableSession>> | null | undefined,
    settings?: SessionListIndexRebuildSettings | null,
): boolean {
    if (previousRows === nextRows) {
        return false;
    }
    if (!previousRows || !nextRows) {
        return previousRows !== nextRows;
    }

    const previousIds = Object.keys(previousRows);
    const nextIds = Object.keys(nextRows);
    if (previousIds.length !== nextIds.length) {
        return true;
    }

    for (const sessionId of previousIds) {
        const previous = previousRows[sessionId];
        const next = nextRows[sessionId];
        if (!previous || !next) {
            return true;
        }
        if (shouldRebuildSessionListIndexForRenderableChange(previous, next, settings)) {
            return true;
        }
    }

    return false;
}

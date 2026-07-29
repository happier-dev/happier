import { z } from 'zod';

import {
    parseSplitCanvasPersistenceSnapshot,
    type SplitCanvasPersistenceSnapshot,
} from '@/components/appShell/splitCanvas/model/splitCanvasPersistence';
import type {
    SplitCanvasLeafNode,
    SplitCanvasNode,
    SplitCanvasSplitNode,
} from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import type { Settings } from '@/sync/domains/settings/settings';

export type SessionSplitCanvasLeafPayload = Readonly<{
    sessionId: string;
}>;

export type SessionSplitCanvasPersistenceSnapshot = SplitCanvasPersistenceSnapshot<SessionSplitCanvasLeafPayload>;

const SessionSplitCanvasLeafPayloadSchema: z.ZodType<SessionSplitCanvasLeafPayload> = z.object({
    sessionId: z.string(),
});

const SessionSplitCanvasLeafNodeSchema: z.ZodType<SplitCanvasLeafNode<SessionSplitCanvasLeafPayload>> = z.object({
    id: z.string(),
    kind: z.literal('leaf'),
    leafKind: z.literal('session'),
    payload: SessionSplitCanvasLeafPayloadSchema,
});

const SessionSplitCanvasNodeSchema: z.ZodType<SplitCanvasNode<SessionSplitCanvasLeafPayload>> = z.lazy(() => z.union([
    SessionSplitCanvasLeafNodeSchema,
    z.object({
        id: z.string(),
        kind: z.literal('split'),
        axis: z.enum(['row', 'column']),
        ratio: z.number(),
        first: SessionSplitCanvasNodeSchema,
        second: SessionSplitCanvasNodeSchema,
    }) satisfies z.ZodType<SplitCanvasSplitNode<SessionSplitCanvasLeafPayload>>,
]));

export const SessionSplitCanvasPersistenceSnapshotSchema: z.ZodType<SessionSplitCanvasPersistenceSnapshot> = z.object({
    version: z.literal(1),
    root: SessionSplitCanvasNodeSchema.nullable(),
    focusedLeafId: z.string().nullable(),
    maximizedLeafId: z.string().nullable(),
    maxLeaves: z.number(),
});

export const SessionSplitCanvasLayoutsSchema = z.record(
    z.string(),
    SessionSplitCanvasPersistenceSnapshotSchema,
).default({});

export function createSessionSplitCanvasLeafNode(sessionId: string): SplitCanvasLeafNode<SessionSplitCanvasLeafPayload> {
    return {
        id: `session-leaf:${sessionId}`,
        kind: 'leaf',
        leafKind: 'session',
        payload: {
            sessionId,
        },
    };
}

export function createInitialSessionSplitCanvasSnapshot(input: Readonly<{
    sessionId: string;
    maxLeaves: number;
}>): SessionSplitCanvasPersistenceSnapshot {
    const root = createSessionSplitCanvasLeafNode(input.sessionId);
    return {
        version: 1,
        root,
        focusedLeafId: root.id,
        maximizedLeafId: null,
        maxLeaves: input.maxLeaves,
    };
}

export function readPersistedSessionSplitCanvasSnapshot(input: Readonly<{
    settings: Pick<Settings, 'sessionSplitCanvasLayoutsV1'>;
    scopeKey: string | null | undefined;
}>): SessionSplitCanvasPersistenceSnapshot | null {
    const scopeKey = String(input.scopeKey ?? '').trim();
    if (!scopeKey) {
        return null;
    }

    const stored = input.settings.sessionSplitCanvasLayoutsV1?.[scopeKey];
    const parsed = SessionSplitCanvasPersistenceSnapshotSchema.safeParse(stored);
    if (!parsed.success) {
        return null;
    }

    return parseSplitCanvasPersistenceSnapshot<SessionSplitCanvasLeafPayload>(parsed.data);
}

export function areSessionSplitCanvasSnapshotsEqual(left: unknown, right: unknown): boolean {
    return areAccountSettingsJsonValuesEqual(left, right);
}

function readRouteOnlySessionId(value: unknown): string | null {
    const parsed = SessionSplitCanvasPersistenceSnapshotSchema.safeParse(value);
    if (!parsed.success) {
        return null;
    }

    const { root, focusedLeafId, maximizedLeafId } = parsed.data;
    if (maximizedLeafId !== null) {
        return null;
    }
    if (!root || root.kind !== 'leaf' || root.leafKind !== 'session') {
        return null;
    }
    if (focusedLeafId !== root.id) {
        return null;
    }

    return root.payload.sessionId;
}

export function shouldPersistSessionSplitCanvasSnapshot(input: Readonly<{
    persisted: unknown;
    snapshot: SessionSplitCanvasPersistenceSnapshot;
    routeSessionId: string;
}>): boolean {
    if (areSessionSplitCanvasSnapshotsEqual(input.persisted, input.snapshot)) {
        return false;
    }

    const routeSessionId = input.routeSessionId.trim();
    const snapshotRouteOnlySessionId = readRouteOnlySessionId(input.snapshot);
    if (routeSessionId && snapshotRouteOnlySessionId === routeSessionId) {
        const persistedRouteOnlySessionId = readRouteOnlySessionId(input.persisted);
        if (input.persisted == null || persistedRouteOnlySessionId !== null) {
            return false;
        }
    }

    return true;
}

export function writePersistedSessionSplitCanvasSnapshot(input: Readonly<{
    settings: Pick<Settings, 'sessionSplitCanvasLayoutsV1'>;
    scopeKey: string;
    snapshot: SessionSplitCanvasPersistenceSnapshot;
}>): Pick<Settings, 'sessionSplitCanvasLayoutsV1'> {
    const scopeKey = input.scopeKey.trim();
    if (!scopeKey) {
        return {
            sessionSplitCanvasLayoutsV1: input.settings.sessionSplitCanvasLayoutsV1,
        };
    }

    return {
        sessionSplitCanvasLayoutsV1: {
            ...(input.settings.sessionSplitCanvasLayoutsV1 ?? {}),
            [scopeKey]: input.snapshot,
        },
    };
}

import { describe, expect, it, vi } from 'vitest';
import { V2SessionRecordSchema } from '@happier-dev/protocol';

import { parseCompatSessionByIdResponse, scanSessionByIdFromCompatList } from './sessionHttpCompat';

/**
 * `coerceLegacySessionRecord` refuses outright any row that carries `ownerMetadata`
 * (a layout-1 owner envelope), so that field can never appear on a coerced record.
 * Every other declared field must have a carrier — see the KEYSTONE test below.
 */
const COERCION_STRUCTURALLY_ABSENT_FIELDS: ReadonlySet<string> = new Set(['ownerMetadata']);

/**
 * A row that carries every declared field but fails the v2 schema (object `metadata`
 * instead of a string), which is exactly what routes it through the legacy coercion.
 */
function buildFullyPopulatedLegacyRow() {
    return {
        id: 'session-full',
        seq: 42,
        createdAt: 1_699_000_000_000,
        updatedAt: 1_700_000_600_000,
        meaningfulActivityAt: 1_700_000_500_000,
        active: true,
        activeAt: 1_700_000_400_000,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: { path: '/repo/full' },
        metadataVersion: 7,
        metadataLayoutVersion: 0,
        agentState: { ready: true },
        agentStateVersion: 3,
        lastViewedSessionSeq: 4,
        pendingPermissionRequestCount: 1,
        pendingUserActionRequestCount: 2,
        pendingRequestObservedAt: 1_700_000_000_000,
        pendingCount: 5,
        pendingBlockedCount: 1,
        pendingVersion: 9,
        dataEncryptionKey: null,
        share: { accessLevel: 'edit', canApprovePermissions: true },
        latestTurnId: 'turn-9',
        latestTurnStatus: 'completed',
        latestTurnStatusObservedAt: 1_700_000_100_000,
        lastRuntimeIssue: null,
        runtimeActivityState: 'idle',
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: 1_700_000_200_000,
        runtimeActivityRevision: 11,
        rollbackEligibleTurnStarts: [3, 8],
        latestReadyEventSeq: 41,
        latestReadyEventAt: 1_700_000_300_000,
        thinking: true,
        thinkingAt: 1_700_000_350_000,
        currentStorageState: 'server_partial',
        acceptedThroughServerSeq: 40,
        materializedThroughSourceAt: 1_700_000_250_000,
        publishedThroughServerSeq: 39,
        transcriptShareable: true,
    };
}

function coerceFullyPopulatedLegacyRow(): Record<string, unknown> {
    const parsed = parseCompatSessionByIdResponse({ session: buildFullyPopulatedLegacyRow() });
    expect(parsed).not.toBeNull();
    return parsed!.session as unknown as Record<string, unknown>;
}

describe('legacy session record coercion', () => {
    it('KEYSTONE: rebuilds a carrier for every field the protocol record schema declares', () => {
        const record = coerceFullyPopulatedLegacyRow();

        const missing = Object.keys(V2SessionRecordSchema.shape)
            .filter((field) => !COERCION_STRUCTURALLY_ABSENT_FIELDS.has(field))
            .filter((field) => record[field] === undefined);

        expect(missing).toEqual([]);
    });

    it('carries the attention edge facts the placement key depends on', () => {
        const record = coerceFullyPopulatedLegacyRow();

        // Dropping these silently degrades attention ordering onto `updatedAt`,
        // a key that moves on every message to an already-promoted session.
        expect(record.pendingRequestObservedAt).toBe(1_700_000_000_000);
        expect(record.latestReadyEventAt).toBe(1_700_000_300_000);
        expect(record.latestReadyEventSeq).toBe(41);
        expect(record.latestTurnId).toBe('turn-9');
        expect(record.thinking).toBe(true);
        expect(record.thinkingAt).toBe(1_700_000_350_000);
        expect(record.transcriptShareable).toBe(true);
    });

    it('coerces absent or non-numeric edge facts to null rather than inventing a value', () => {
        const parsed = parseCompatSessionByIdResponse({
            session: {
                ...buildFullyPopulatedLegacyRow(),
                pendingRequestObservedAt: undefined,
                latestReadyEventAt: 'not-a-number',
                latestTurnId: 42,
            },
        });
        expect(parsed).not.toBeNull();
        const record = parsed!.session as unknown as Record<string, unknown>;

        expect(record.id).toBe('session-full');
        expect(record.pendingRequestObservedAt).toBeNull();
        expect(record.latestReadyEventAt).toBeNull();
        expect(record.latestTurnId).toBeNull();
    });
});

function buildLegacyCompatSession(id: string) {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ path: `/repo/${id}` }),
        metadataVersion: 1,
        agentState: JSON.stringify({}),
        agentStateVersion: 1,
        dataEncryptionKey: null,
        share: null,
    };
}

describe('scanSessionByIdFromCompatList', () => {
    it('falls back to /v1/sessions when older servers are missing both /v2 session routes', async () => {
        const request = vi.fn(async (path: string) => {
            if (path === '/v2/sessions?limit=200') {
                return new Response(JSON.stringify({
                    error: 'Not found',
                    path: '/v2/sessions',
                    method: 'GET',
                }), { status: 404 });
            }

            expect(path).toBe('/v1/sessions');
            return new Response(JSON.stringify({
                sessions: [buildLegacyCompatSession('older-session')],
            }), { status: 200 });
        });

        await expect(scanSessionByIdFromCompatList({
            request,
            token: 'token',
            sessionId: 'older-session',
        })).resolves.toEqual(expect.objectContaining({
            id: 'older-session',
        }));
    });
});

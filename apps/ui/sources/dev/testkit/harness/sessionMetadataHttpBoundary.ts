import { SessionCurrentProjectionRecordV1Schema, type SessionCurrentProjectionRecordV1 } from '@happier-dev/protocol/sessions/listing/response';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema, SessionOwnerMetadataEnvelopeV1Schema, SessionMetadataVersionConflictV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionDisplayProjectionV1Schema } from '@happier-dev/protocol/sessions';
import { z } from 'zod/mini';
import { UsageSessionTimingV1Schema } from '@happier-dev/protocol/usage/usageTimingV1';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { SessionInitialAccessMaterializedV1Schema } from '@happier-dev/protocol/sessions';
import { SessionOrganizationPlacementV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';

export interface SessionMetadataHttpBoundary {
    writes: string[];
    replaceSession(sessionId: string, record?: SessionCurrentProjectionRecordV1): void;
    updateAgentState(sessionId: string, agentState: Session['agentState'], version: number): void;
    createSessionFromPost(sessionId: string, init: RequestInit): Response;
    rejectNextPatch(sessionId: string): void;
    handle(input: URL | RequestInfo, init?: RequestInit): Response | null;
}

/** Home HTTP persistence boundary; the Sync metadata codec and writer stay real. */
export function createSessionMetadataHttpBoundary(readSessions: () => Readonly<Record<string, Session>>): SessionMetadataHttpBoundary {
    const records = new Map<string, ReturnType<typeof SessionCurrentProjectionRecordV1Schema.parse>>();
    let rejectPatchFor: string | null = null;
    const writes: string[] = [];
    return {
        writes,
        /** Replace a persisted seed after a test installs a new server-side fixture. */
        replaceSession(sessionId: string, record?: SessionCurrentProjectionRecordV1) {
            if (record) records.set(sessionId, SessionCurrentProjectionRecordV1Schema.parse(record));
            else records.delete(sessionId);
        },
        updateAgentState(sessionId, agentState, version) {
            const current = records.get(sessionId);
            // An unread Session is seeded from readSessions on its first HTTP read.
            if (!current) return;
            records.set(sessionId, SessionCurrentProjectionRecordV1Schema.parse({ ...current,
                agentState: agentState ? JSON.stringify(agentState) : null, agentStateVersion: version }));
        },
        /** Mirror the current /v1/sessions hosted create/load transport contract. */
        createSessionFromPost(sessionId: string, init: RequestInit): Response {
            const body = z.strictObject({ tag: z.string().check(z.minLength(1)), metadataLayoutVersion: z.literal(1),
                sharedMetadata: z.strictObject({ ciphertext: z.string().check(z.minLength(1)) }), ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
                displayProjectionV1: z.optional(z.nullable(SessionDisplayProjectionV1Schema)),
                agentState: z.null(), dataEncryptionKey: z.nullable(z.string()), encryptionMode: z.enum(['plain', 'e2ee']),
                usageTimingV1: z.optional(UsageSessionTimingV1Schema),
                organizationPlacement: z.optional(SessionOrganizationPlacementV1Schema), initialAccess: z.optional(SessionInitialAccessMaterializedV1Schema),
                teamCredentialBindings: z.optional(SessionTeamCredentialBindingIntentsV1Schema) }).parse(JSON.parse(String(init.body)));
            const current = records.get(sessionId);
            if (current?.metadataLayoutVersion === 1) return Response.json({ created: false, session: current });
            if (current) throw new Error('Create/load fixture requires an existing current owner tuple, not a candidate migration');
            const seed = readSessions()[sessionId];
            const record = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: seed?.seq ?? 0, createdAt: seed?.createdAt ?? 1, updatedAt: seed?.updatedAt ?? 1,
                active: false, activeAt: seed?.activeAt ?? 1, archivedAt: null, encryptionMode: body.encryptionMode, metadataLayoutVersion: 1,
                metadata: body.sharedMetadata.ciphertext, metadataVersion: seed?.metadataVersion ?? 0, ownerMetadata: body.ownerMetadata,
                displayProjectionV1: body.displayProjectionV1 ?? undefined,
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
                responsibleAccountId: null, responsibleAccount: null, share: null, dataEncryptionKey: body.dataEncryptionKey,
                agentState: null, agentStateVersion: seed?.agentStateVersion ?? 0, pendingCount: 0, pendingVersion: 0 });
            records.set(sessionId, record);
            return Response.json({ created: true, session: record });
        },
        rejectNextPatch(sessionId: string) { rejectPatchFor = sessionId; },
        handle(input: URL | RequestInfo, init?: RequestInit): Response | null {
            const path = new URL(String(input)).pathname;
            const turns = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(path);
            if (turns) {
                const id = decodeURIComponent(turns[1]!);
                const session = readSessions()[id];
                const stored = records.get(id);
                if (!session && !stored) return Response.json({ error: 'Session not found' }, { status: 404 });
                return Response.json(SessionTurnsProjectionV1Schema.parse(session?.sessionTurns ?? {
                    v: 1, sessionId: id, updatedAt: session?.updatedAt ?? stored!.updatedAt, turns: [],
                }));
            }
            if (path === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({
                snapshot: { schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0,
                    pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] },
            }));
            if (path === '/v2/sessions/lookup-by-tags' || path === '/v2/sessions/read-batch') return null;
            const detail = /^\/v2\/sessions\/([^/]+)$/.exec(path);
            const listing = path === '/v2/sessions' || path === '/v2/sessions/active';
            if (!detail && !listing) return null;
            for (const session of Object.values(readSessions())) {
                if (records.has(session.id)) continue;
                if (!session.access) throw new Error('Session HTTP fixture requires canonical access');
                records.set(session.id, SessionCurrentProjectionRecordV1Schema.parse({
                    id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
                    active: session.active, activeAt: session.activeAt, archivedAt: session.archivedAt ?? null, encryptionMode: 'plain', metadataLayoutVersion: 0,
                    metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion,
                    effectiveAccess: { v: 1, level: session.access.level, sources: [{ kind: 'owner' }], capabilities: session.access.capabilities },
                    responsibleAccountId: null, responsibleAccount: null, share: null, dataEncryptionKey: null,
                    agentState: session.agentState ? JSON.stringify(session.agentState) : null,
                    agentStateVersion: session.agentStateVersion ?? 0, pendingCount: 0, pendingVersion: 0,
                }));
            }
            if (listing) return Response.json({ sessions: [...records.values()], hasNext: false, nextCursor: null });
            const id = decodeURIComponent(detail![1]!);
            const current = records.get(id);
            if (!current) return Response.json({ error: 'Session not found' }, { status: 404 });
            if (init?.method !== 'PATCH') return Response.json({ session: current });
            writes.push(id);
            if (rejectPatchFor === id) {
                rejectPatchFor = null;
                return Response.json({ error: 'Failed to update session' }, { status: 500 });
            }
            const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
            if (patch.mode === 'shared_editor') {
                if (current.effectiveAccess?.level !== 'edit') return Response.json({ error: 'forbidden' }, { status: 403 });
                if (current.metadataLayoutVersion !== 1 || patch.sharedMetadata.expectedVersion !== current.metadataVersion) {
                    return Response.json({ code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
                        sharedMetadata: { version: current.metadataVersion } }, { status: 409 });
                }
                const committed = SessionCurrentProjectionRecordV1Schema.parse({ ...current,
                    metadata: patch.sharedMetadata.ciphertext, metadataVersion: current.metadataVersion + 1,
                    displayProjectionV1: patch.displayProjectionV1 ?? undefined });
                records.set(id, committed);
                return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                    sharedMetadata: { version: committed.metadataVersion } }));
            }
            if (patch.mode !== 'owner_migration' && patch.mode !== 'owner') throw new Error('Expected owner metadata mutation');
            if (patch.mode === 'owner_migration') {
                if (current.metadataLayoutVersion !== 0 || patch.source.metadata.version !== current.metadataVersion
                    || patch.source.metadata.ciphertext !== current.metadata || patch.source.agentState.version !== current.agentStateVersion
                    || patch.source.agentState.ciphertext !== current.agentState) {
                    // The real PATCH route reports a stale source through HTTP;
                    // let the real metadata owner classify that response.
                    return Response.json(current.metadataLayoutVersion === 1
                        ? SessionMetadataVersionConflictV1Schema.parse({ code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
                            sharedMetadata: { version: current.metadataVersion }, agentState: { version: current.agentStateVersion } })
                        : { error: 'Session metadata privacy upgrade required', code: 'metadata_privacy_upgrade_required' }, { status: 409 });
                }
            } else if (current.metadataLayoutVersion !== 1 || patch.sharedMetadata.expectedVersion !== current.metadataVersion
                || patch.agentState.expectedVersion !== current.agentStateVersion
                || JSON.stringify(patch.expectedOwnerMetadata) !== JSON.stringify(current.ownerMetadata)) {
                return Response.json({ code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
                    sharedMetadata: { version: current.metadataVersion }, agentState: { version: current.agentStateVersion } }, { status: 409 });
            }
            const target = patch.mode === 'owner_migration' ? patch.target : patch;
            const committed = SessionCurrentProjectionRecordV1Schema.parse({ ...current, metadataLayoutVersion: 1,
                metadata: target.sharedMetadata.ciphertext, metadataVersion: current.metadataVersion + 1,
                displayProjectionV1: target.displayProjectionV1 ?? undefined,
                ownerMetadata: target.ownerMetadata, agentState: target.agentState.ciphertext, agentStateVersion: (current.agentStateVersion ?? 0) + 1 });
            records.set(id, committed);
            return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                sharedMetadata: { version: committed.metadataVersion }, agentState: { version: committed.agentStateVersion } }));
        },
    };
}

import { describe, expect, it } from 'vitest';

import { applySessionRoleV1ToMetadata, type SessionRoleV1 } from '@happier-dev/protocol';

import { updateSessionMetadataWithRetry } from './updateSessionMetadataWithRetry';

type Metadata = {
    path: string;
    host: string;
    readStateV1?: { v: 1; sessionSeq: number; pendingActivityAt: number; updatedAt: number };
    tools?: string[];
};

describe('updateSessionMetadataWithRetry', () => {
    it('sets and clears only the role across a concurrent writer, preserving provenance and unrelated keys', async () => {
        const origin = { v: 1, kind: 'agent', creatorSessionId: 'planner' };
        let server = { version: 1, metadata: { path: '/repo', host: 'h', sessionOriginV1: origin, futureKey: 1 } as Record<string, unknown> };
        let local = { metadataVersion: 1, metadata: server.metadata };
        let raced = false;
        const write = (assignment: SessionRoleV1 | null) => updateSessionMetadataWithRetry<Record<string, unknown>>({
            sessionId: 's1', getSession: () => local, refreshSessions: async () => {},
            encryptMetadata: async (metadata) => JSON.stringify(metadata),
            decryptMetadata: async (_version, encrypted) => JSON.parse(encrypted),
            emitUpdateMetadata: async (payload) => {
                if (!raced) {
                    // Another device renames the session between our read and write.
                    raced = true;
                    server = { version: 2, metadata: { ...server.metadata, summary: { text: 'Renamed', updatedAt: 2 } } };
                }
                if (payload.expectedVersion !== server.version) {
                    return { result: 'version-mismatch' as const, version: server.version, metadata: JSON.stringify(server.metadata) };
                }
                server = { version: server.version + 1, metadata: JSON.parse(payload.metadata) };
                return { result: 'success' as const, version: server.version, metadata: payload.metadata };
            },
            applySessionMetadata: (next) => { local = next; },
            updater: (metadata) => applySessionRoleV1ToMetadata(metadata, assignment),
        });
        const delegate: SessionRoleV1 = { v: 1, role: 'delegate', instructions: 'Delegate rules.', assignmentId: 'a-1', assignedAt: 1 };
        await write(delegate);
        expect(server.metadata).toEqual({ path: '/repo', host: 'h', sessionOriginV1: origin, futureKey: 1,
            summary: { text: 'Renamed', updatedAt: 2 }, sessionRoleV1: delegate });
        await write(null);
        expect(server.metadata).toEqual({ path: '/repo', host: 'h', sessionOriginV1: origin, futureKey: 1,
            summary: { text: 'Renamed', updatedAt: 2 } });
    });

    it('does not write metadata after its account scope retires during encryption', async () => {
        let current = true;
        const writes: string[] = [];
        const snapshot = { metadataVersion: 1, metadata: { path: '/repo', host: 'host' } };
        await updateSessionMetadataWithRetry({
            sessionId: 's1', getSession: () => snapshot, refreshSessions: async () => {},
            encryptMetadata: async (metadata) => { current = false; return JSON.stringify(metadata); },
            decryptMetadata: async () => snapshot.metadata,
            emitUpdateMetadata: async (payload) => { writes.push(payload.metadata); return { result: 'success' as const }; },
            applySessionMetadata: () => {}, updater: (metadata) => ({ ...metadata, tools: ['new'] }),
            shouldContinue: () => current,
        });
        expect(writes).toEqual([]);
    });

    it('refreshes sessions when metadata is missing before attempting the update', async () => {
        const sessionId = 's1';

        const sessions: Record<string, { metadataVersion: number; metadata: Metadata } | undefined> = {};

        const decryptMetadata = async (_version: number, encrypted: string): Promise<Metadata | null> => JSON.parse(encrypted);
        const encryptMetadata = async (metadata: Metadata): Promise<string> => JSON.stringify(metadata);

        const applySessionMetadata = (next: { metadataVersion: number; metadata: Metadata }) => {
            sessions[sessionId] = next;
        };

        const refreshSessionsCalls: string[] = [];
        const refreshSessions = async () => {
            refreshSessionsCalls.push('refresh');
            sessions[sessionId] = { metadataVersion: 1, metadata: { path: '/tmp', host: 'h' } };
        };

        const emitUpdateMetadata = async (payload: { sid: string; expectedVersion: number; metadata: string }) => {
            return {
                result: 'success' as const,
                version: payload.expectedVersion + 1,
                metadata: payload.metadata,
            };
        };

        await updateSessionMetadataWithRetry({
            sessionId,
            getSession: () => sessions[sessionId] ?? null,
            refreshSessions,
            encryptMetadata,
            decryptMetadata,
            emitUpdateMetadata,
            applySessionMetadata,
            updater: (base) => ({
                ...base,
                tools: ['a'],
            }),
            maxAttempts: 2,
        });

        expect(refreshSessionsCalls.length).toBe(1);
        expect(sessions[sessionId]?.metadataVersion).toBe(2);
        expect(sessions[sessionId]?.metadata.tools).toEqual(['a']);
    });

    it('retries multiple version-mismatches and applies the latest server metadata before succeeding', async () => {
        const sessionId = 's1';

        const sessions: Record<string, { metadataVersion: number; metadata: Metadata }> = {
            [sessionId]: { metadataVersion: 1, metadata: { path: '/tmp', host: 'h' } },
        };

        const decryptMetadata = async (_version: number, encrypted: string): Promise<Metadata | null> => JSON.parse(encrypted);
        const encryptMetadata = async (metadata: Metadata): Promise<string> => JSON.stringify(metadata);

        const applySessionMetadata = (next: { metadataVersion: number; metadata: Metadata }) => {
            sessions[sessionId] = next;
        };

        const calls: Array<{ expectedVersion: number; metadata: Metadata }> = [];

        const emitUpdateMetadata = async (payload: { sid: string; expectedVersion: number; metadata: string }) => {
            const parsed = JSON.parse(payload.metadata) as Metadata;
            calls.push({ expectedVersion: payload.expectedVersion, metadata: parsed });

            if (payload.expectedVersion === 1) {
                return {
                    result: 'version-mismatch' as const,
                    version: 2,
                    metadata: JSON.stringify({ path: '/tmp', host: 'h', tools: ['a'] }),
                };
            }

            if (payload.expectedVersion === 2) {
                return {
                    result: 'version-mismatch' as const,
                    version: 3,
                    metadata: JSON.stringify({ path: '/tmp', host: 'h', tools: ['a', 'b'] }),
                };
            }

            return {
                result: 'success' as const,
                version: payload.expectedVersion + 1,
                metadata: payload.metadata,
            };
        };

        const refreshSessions = async () => {
            // Should not be required when the server provides version+metadata on mismatch.
            throw new Error('refreshSessions should not be called');
        };

        await updateSessionMetadataWithRetry({
            sessionId,
            getSession: () => sessions[sessionId] ?? null,
            refreshSessions,
            encryptMetadata,
            decryptMetadata,
            emitUpdateMetadata,
            applySessionMetadata,
            updater: (base) => ({
                ...base,
                readStateV1: { v: 1 as const, sessionSeq: 5, pendingActivityAt: 10, updatedAt: 123 },
            }),
            maxAttempts: 5,
        });

        expect(calls.map((c) => c.expectedVersion)).toEqual([1, 2, 3]);
        expect(sessions[sessionId]?.metadataVersion).toBe(4);
        expect(sessions[sessionId]?.metadata.readStateV1?.sessionSeq).toBe(5);
        expect(sessions[sessionId]?.metadata.tools?.length).toBe(2);
    });
});

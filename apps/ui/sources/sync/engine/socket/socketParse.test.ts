import { describe, expect, it, vi } from 'vitest';
import { parseEphemeralUpdate, parseUpdateContainer } from './socketParse';

describe('socketParse', () => {
    it.each(['new-session', 'update-session'])('rejects malformed explicit viewers before %s ingestion can use legacy tracking', (type) => {
        const viewer = {
            readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: null },
            relevance: { relevant: true, reasons: ['owned_by_me'] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: null },
            notification: { level: 'important', source: 'owner' },
        };
        const body = type === 'update-session' ? { t: type, id: 'private', viewer } : {
            t: type, id: 'private', seq: 0, metadata: 'e30=', metadataVersion: 1,
            agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
            encryptionMode: 'plain', active: true, activeAt: 1, createdAt: 1, updatedAt: 1,
            viewer,
        };
        const envelope = { id: 'private-update', seq: 0, createdAt: 1, body };
        expect(parseUpdateContainer(envelope)).not.toBeNull();
        expect(parseUpdateContainer({ ...envelope, body: { ...body, viewer: { ...viewer, readState: { ...viewer.readState, lastViewedSessionSeq: '0' } } } })).toBeNull();
    });

    it('parses a full update container (new-message)', () => {
        const res = parseUpdateContainer({
            id: 'u1',
            seq: 123,
            createdAt: 1000,
            body: {
                t: 'new-message',
                sid: 's1',
                message: {
                    id: 'm1',
                    seq: 1,
                    content: { t: 'encrypted', c: 'abc' },
                    localId: null,
                    createdAt: 1000,
                    updatedAt: 1000,
                },
            },
        });

        expect(res).not.toBeNull();
        expect(res!.body.t).toBe('new-message');
        expect((res!.body as any).sid).toBe('s1');
    });

    it('round-trips the content-free Automation source-status invalidation through the protocol container parser', () => {
        const res = parseUpdateContainer({
            id: 'u-automation-source-status',
            seq: 124,
            createdAt: 1_001,
            body: {
                t: 'automation-source-status-updated',
            },
        });

        expect(res).toEqual({
            id: 'u-automation-source-status',
            seq: 124,
            createdAt: 1_001,
            body: { t: 'automation-source-status-updated' },
        });
        expect(parseUpdateContainer({
            id: 'u-automation-source-status-private',
            seq: 125,
            createdAt: 1_002,
            body: {
                t: 'automation-source-status-updated',
                automationId: 'must-not-cross-the-socket-boundary',
            },
        })).toBeNull();
    });

    it('returns null for a non-container non-sharing update body', () => {
        const res = parseUpdateContainer({
            t: 'new-message',
            sid: 's1',
            message: { id: 'm1' },
        });
        expect(res).toBeNull();
    });

    it('accepts legacy sharing update bodies without a container', () => {
        const res = parseUpdateContainer({
            t: 'session-shared',
            sessionId: 's1',
        });

        expect(res).not.toBeNull();
        expect(res!.body.t).toBe('session-shared');
        expect((res!.body as any).sessionId).toBe('s1');
        expect(res!.seq).toBe(0);
    });

    it('accepts legacy sharing update body nested under body', () => {
        const res = parseUpdateContainer({
            body: {
                t: 'session-share-updated',
                sessionId: 's1',
                shareId: 'sh1',
            },
        });

        expect(res).not.toBeNull();
        expect(res!.body.t).toBe('session-share-updated');
        expect((res!.body as any).sessionId).toBe('s1');
        expect((res!.body as any).shareId).toBe('sh1');
        expect(res!.seq).toBe(0);
    });

    it('returns null for malformed legacy sharing payloads', () => {
        const res = parseUpdateContainer({
            t: 'session-shared',
            // missing sessionId
        });

        expect(res).toBeNull();
    });

    it('parses ephemeral activity updates', () => {
        const res = parseEphemeralUpdate({
            type: 'activity',
            id: 's1',
            active: true,
            activeAt: 1000,
            thinking: true,
        });

        expect(res).not.toBeNull();
        expect(res!.type).toBe('activity');
        expect((res as any).id).toBe('s1');
    });

    it('parses transcript stream segment ephemerals', () => {
        const res = parseEphemeralUpdate({
            type: 'transcript-stream-segment',
            sessionId: 's1',
            message: {
                localId: 'segment-1',
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            agentId: 'codex',
                            data: { type: 'message', message: 'Hello' },
                        },
                        meta: {
                            happierStreamSegmentV1: {
                                v: 1,
                                segmentKind: 'assistant',
                                segmentLocalId: 'segment-1',
                                segmentState: 'streaming',
                                startedAtMs: 1_000,
                                updatedAtMs: 1_010,
                            },
                        },
                    },
                },
                createdAt: 1_000,
                updatedAt: 1_010,
            },
        });

        expect(res).not.toBeNull();
        expect(res?.type).toBe('transcript-stream-segment');
        expect((res as any)?.message?.localId).toBe('segment-1');
    });

    it('parses transcript stream segment snapshots with a live-stream tick anchor', () => {
        const res = parseEphemeralUpdate({
            type: 'transcript-stream-segment',
            sessionId: 's1',
            message: {
                localId: 'segment-1',
                messageRole: 'agent',
                tick: 25,
                content: { t: 'encrypted', c: 'cipher' },
                createdAt: 1_000,
                updatedAt: 1_010,
            },
        });

        expect(res).not.toBeNull();
        expect(res?.type).toBe('transcript-stream-segment');
        expect((res as any)?.message?.tick).toBe(25);
    });

    it('parses transcript stream segment delta ephemerals with chaining fields', () => {
        const res = parseEphemeralUpdate({
            type: 'transcript-stream-segment-delta',
            sessionId: 's1',
            message: {
                localId: 'segment-1',
                messageRole: 'agent',
                tick: 2,
                baseLength: 5,
                content: { t: 'encrypted', c: 'cipher-of-delta' },
                createdAt: 1_000,
                updatedAt: 1_040,
            },
        });

        expect(res).not.toBeNull();
        expect(res?.type).toBe('transcript-stream-segment-delta');
        expect((res as any)?.message?.tick).toBe(2);
        expect((res as any)?.message?.baseLength).toBe(5);
    });

    it('rejects transcript stream segment deltas without chaining fields', () => {
        const res = parseEphemeralUpdate({
            type: 'transcript-stream-segment-delta',
            sessionId: 's1',
            message: {
                localId: 'segment-1',
                messageRole: 'agent',
                content: { t: 'encrypted', c: 'cipher' },
                createdAt: 1_000,
                updatedAt: 1_040,
            },
        });

        expect(res).toBeNull();
    });

    it('parses content-free qualified external-session invalidations', () => {
        const res = parseEphemeralUpdate({
            v: 1,
            type: 'external-session-transcript-invalidated',
            binding: {
                v: 1,
                machineId: 'm1',
                sessionId: 's1',
                link: { generation: 'link-1', remoteSessionId: 'remote-1' },
                source: {
                    qualifiedIdentity: {
                        v: 1,
                        agent: { pluginId: 'happier.claude', localId: 'claude' },
                        source: { kind: 'claudeConfig', contractVersion: 1 },
                    },
                    generation: 'source-1',
                },
                sourceCustody: { kind: 'development', registeredRootId: 'contribution-1' },
                cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
            },
        });

        expect(res).not.toBeNull();
        expect(res?.type).toBe('external-session-transcript-invalidated');
        if (res?.type !== 'external-session-transcript-invalidated') throw new Error('Expected a qualified invalidation');
        expect(res.binding.sessionId).toBe('s1');
        expect(res.binding).not.toHaveProperty('items');
    });

    it('rejects transcript-bearing direct-session deltas', () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = parseEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId: 's1',
            items: [{ id: 'secret', createdAtMs: 1, raw: { text: 'plaintext' } }],
            fromCursor: 'tail-0',
            nextCursor: 'tail-1',
            truncated: false,
        });

        expect(res).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        consoleErrorSpy.mockRestore();
    });

    it('rejects stale legacy direct-session transcript ephemeral names', () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = parseEphemeralUpdate({
            type: 'direct-session-transcript-updated',
            sessionId: 's1',
            items: [],
        });

        expect(res).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        consoleErrorSpy.mockRestore();
    });

    it('returns null for invalid ephemeral payloads', () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = parseEphemeralUpdate({
            type: 'activity',
            active: true,
            // missing required id
        });

        expect(res).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        consoleErrorSpy.mockRestore();
    });
});

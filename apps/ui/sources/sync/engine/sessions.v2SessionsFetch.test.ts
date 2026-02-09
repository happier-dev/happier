import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/tokenStorage';
import { HappyError } from '@/utils/errors';

import { fetchAndApplySessions, type SessionListEncryption } from './sessionsSnapshot';

vi.mock('../serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

type SessionRow = {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: string | null;
    share: {
        accessLevel: 'view' | 'edit' | 'admin';
        canApprovePermissions: boolean;
    } | null;
};

function buildSessionRow(overrides: Partial<SessionRow> & Pick<SessionRow, 'id'>): SessionRow {
    return {
        id: overrides.id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: `metadata-${overrides.id}`,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: null,
        share: null,
        ...overrides,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createEncryptionHarness(): {
    encryption: SessionListEncryption;
    decryptEncryptionKey: ReturnType<typeof vi.fn>;
    initializeSessions: ReturnType<typeof vi.fn>;
    decryptMetadata: ReturnType<typeof vi.fn>;
    decryptAgentState: ReturnType<typeof vi.fn>;
} {
    const decryptEncryptionKey = vi.fn(async (value: string) => new Uint8Array([value.length]));
    const initializeSessions = vi.fn(async () => {});
    const decryptMetadata = vi.fn(async (_version: number, value: string) => ({ decrypted: value }));
    const decryptAgentState = vi.fn(async () => null);
    const encryption: SessionListEncryption = {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption: () => ({
            decryptMetadata,
            decryptAgentState,
        }),
    };
    return { encryption, decryptEncryptionKey, initializeSessions, decryptMetadata, decryptAgentState };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('fetchAndApplySessions (/v2/sessions snapshot)', () => {
    it('pages through /v2/sessions and applies decrypted sessions with share and key cache mapping', async () => {
        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const parsed = new URL(typeof input === 'string' ? input : String(input));
            expect(parsed.pathname).toBe('/v2/sessions');

            const cursor = parsed.searchParams.get('cursor');
            if (!cursor) {
                return jsonResponse({
                    sessions: [
                        buildSessionRow({ id: 's2', seq: 2, dataEncryptionKey: 'k2' }),
                        buildSessionRow({
                            id: 's1',
                            seq: 1,
                            dataEncryptionKey: null,
                            share: { accessLevel: 'view', canApprovePermissions: true },
                        }),
                    ],
                    nextCursor: 'cursor_v1_s1',
                    hasNext: true,
                });
            }

            expect(cursor).toBe('cursor_v1_s1');
            return jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's0', seq: 0, active: false, activeAt: 0, dataEncryptionKey: 'k0' }),
                ],
                nextCursor: null,
                hasNext: false,
            });
        });
        vi.stubGlobal('fetch', fetchSpy);

        const { encryption, decryptEncryptionKey, initializeSessions, decryptMetadata, decryptAgentState } =
            createEncryptionHarness();
        const credentials: AuthCredentials = { token: 't', secret: 's' };
        const appliedSessions: Array<Record<string, unknown>> = [];
        const sessionDataKeys = new Map<string, Uint8Array>();

        await fetchAndApplySessions({
            credentials,
            encryption,
            sessionDataKeys,
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(decryptEncryptionKey).toHaveBeenCalledTimes(2);
        expect(initializeSessions).toHaveBeenCalledTimes(1);
        expect(decryptMetadata).toHaveBeenCalledTimes(3);
        expect(decryptAgentState).toHaveBeenCalledTimes(3);

        expect(appliedSessions).toHaveLength(3);
        expect(appliedSessions.map((session) => session.id)).toEqual(['s2', 's1', 's0']);

        const sharedSession = appliedSessions.find((session) => session.id === 's1');
        expect(sharedSession?.accessLevel).toBe('view');
        expect(sharedSession?.canApprovePermissions).toBe(true);

        expect(sessionDataKeys.has('s2')).toBe(true);
        expect(sessionDataKeys.has('s0')).toBe(true);
        expect(sessionDataKeys.has('s1')).toBe(false);
    });

    it('throws HappyError for non-retryable 4xx responses', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
        const { encryption } = createEncryptionHarness();

        await expect(
            fetchAndApplySessions({
                credentials: { token: 't', secret: 's' },
                encryption,
                sessionDataKeys: new Map<string, Uint8Array>(),
                applySessions: () => {},
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
            }),
        ).rejects.toBeInstanceOf(HappyError);
    });

    it('throws when /v2/sessions response shape is invalid', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sessions: 'bad-shape', hasNext: false })));
        const { encryption } = createEncryptionHarness();

        await expect(
            fetchAndApplySessions({
                credentials: { token: 't', secret: 's' },
                encryption,
                sessionDataKeys: new Map<string, Uint8Array>(),
                applySessions: () => {},
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
            }),
        ).rejects.toThrow('Invalid /v2/sessions response');
    });

    it('uses injected request transport when provided', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [buildSessionRow({ id: 's1', seq: 1 })],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption } = createEncryptionHarness();
        const sessionDataKeys = new Map<string, Uint8Array>();
        const appliedSessions: Array<Record<string, unknown>> = [];

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            request: (path, init) => requestSpy(path, init),
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(appliedSessions.map((session) => session.id)).toEqual(['s1']);
    });
});

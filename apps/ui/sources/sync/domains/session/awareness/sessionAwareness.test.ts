import { describe, expect, it } from 'vitest';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '../listing/sessionListRenderable';
import { projectUiSessionAwareness } from './sessionAwareness';

describe('UI Session awareness acquisition adapter', () => {
    it('uses the same presentation title for detail and list awareness', () => {
        const session = createSessionFixture({ encryptionMode: 'plain', metadata: {
            path: '/work', host: 'host', name: 'Original name', summary: { text: 'Current summary', updatedAt: 100 },
        } });
        const detail = projectUiSessionAwareness(session, 1_000);
        const row = projectUiSessionAwareness(buildSessionListRenderableFromSession(session, undefined, []), 1_000);
        expect(detail.title).toBe('Current summary');
        expect(row.title).toBe(detail.title);
    });

    it('projects the same status facts without reading a title for summary consumers', () => {
        let titleReads = 0;
        const session = createSessionListRenderableSessionFixture({ active: true, activeAt: 1_000,
            hasPendingPermissionRequests: true, pendingRequestObservedAt: 1_000,
            metadata: { path: '/work', host: 'host', get name() { titleReads += 1; return 'Visible title'; } },
        });
        const full = projectUiSessionAwareness(session, 1_000);
        expect(full.title).toBe('Visible title');
        titleReads = 0;
        const status = projectUiSessionAwareness(session, 1_000, { includeTitle: false });
        expect(status.operational).toEqual(full.operational);
        expect(status.runtime).toEqual(full.runtime);
        expect(status.encryption).toEqual(full.encryption);
        expect(status).not.toHaveProperty('title');
        expect(titleReads).toBe(0);
    });

    it('preserves public step origin across locked detail and list projections', () => {
        const session = createSessionFixture({ encryptionMode: 'e2ee', metadata: null,
            origin: { kind: 'run_step', runId: 'workflow-run' }, workDepth: 3 });
        const row = buildSessionListRenderableFromSession(session, undefined, []);
        expect(projectUiSessionAwareness(session, 1_000).origin).toEqual({ kind: 'run_step', runId: 'workflow-run' });
        expect(projectUiSessionAwareness(row, 1_000).origin).toEqual({ kind: 'run_step', runId: 'workflow-run' });
        expect(buildSessionListRenderableFromSession(session, row, [])).toBe(row);
        expect(projectUiSessionAwareness(row, 1_000)).not.toHaveProperty('lineage');
    });

    it('projects readable metadata in detail and list and omits it when locked', () => {
        const session = createSessionFixture({ encryptionMode: 'plain', metadata: {
            path: '/work', host: 'host', name: 'Private workspace',
            forkV1: { v: 1, parentSessionId: 'parent', createdAtMs: 100, parentCutoffSeqInclusive: 1, strategy: 'replay' },
            sessionWorkStateV1: { v: 1, backendId: 'codex', updatedAt: 100,
                items: [{ id: 'private', kind: 'task', origin: 'happier', status: 'in_progress', title: 'Private task', updatedAt: 100 }],
            },
        } });
        const expected = { relation: 'fork', sourceSessionId: 'parent' };
        expect(projectUiSessionAwareness(session, 1_000).lineage).toEqual(expected);
        const row = buildSessionListRenderableFromSession(session, undefined, []);
        expect(projectUiSessionAwareness(row, 1_000).lineage).toEqual(expected);
        const locked = projectUiSessionAwareness({ ...row, encryptionMode: 'e2ee', metadataUnavailable: true }, 1_000);
        expect(locked).not.toHaveProperty('title');
        expect(locked).not.toHaveProperty('currentWork');
        expect(locked).not.toHaveProperty('workspace');
        expect(locked).not.toHaveProperty('lineage');
    });

    it('retains canonical paused work in list awareness and preserves unchanged row identity', () => {
        const session = createSessionFixture({ encryptionMode: 'plain', metadata: {
            path: '/work', host: 'host', sessionWorkStateV1: { v: 1, backendId: 'codex', updatedAt: 100,
                items: [{ id: 'paused', kind: 'task', origin: 'happier', status: 'paused', title: 'Review migration', updatedAt: 100 }],
            },
        } });
        const row = buildSessionListRenderableFromSession(session, undefined, []);
        const detail = projectUiSessionAwareness(session, 1_000);
        expect(detail.currentWork?.title).toBe('Review migration');
        expect(projectUiSessionAwareness(row, 1_000).currentWork).toEqual(detail.currentWork);
        expect(buildSessionListRenderableFromSession(session, row, [])).toBe(row);
    });

    it('preserves plain mode and operational state through the list projection', () => {
        const session = createSessionFixture({
            encryptionMode: 'plain', active: true, presence: 'online', activeAt: 1_000,
            latestTurnStatus: 'failed', pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0, pendingCount: 2,
        });
        const detail = projectUiSessionAwareness(session, 1_001);
        const row = projectUiSessionAwareness(buildSessionListRenderableFromSession(session, undefined, []), 1_001);
        expect(row.encryption).toBe('plain');
        expect(row.operational).toEqual(detail.operational);
        expect(detail.operational.primary).toBe('failed');
    });

    it('distinguishes missing pending evidence from an observed empty projection', () => {
        const base = createSessionFixture({
            encryptionMode: 'plain', latestTurnStatus: null,
            pendingPermissionRequestCount: undefined,
            pendingUserActionRequestCount: undefined,
            agentState: null,
        });

        expect(projectUiSessionAwareness(base, 1_000).availability).toBe('partial');
        expect(projectUiSessionAwareness(
            buildSessionListRenderableFromSession(base),
            1_000,
        ).availability).toBe('partial');
        expect(projectUiSessionAwareness({
            ...base,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }, 1_000).availability).toBe('complete');
    });

    it('preserves an omitted lifecycle projection as unobserved through the list adapter', () => {
        const session = createSessionFixture({
            encryptionMode: 'plain',
            metadata: { path: '/work', host: 'host' },
            active: false,
            // `presence` is 'online' or the last-seen timestamp; any number is offline.
            presence: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            agentState: {},
            latestTurnStatus: undefined,
            latestTurnStatusObservedAt: undefined,
        });

        expect(projectUiSessionAwareness(
            buildSessionListRenderableFromSession(session),
            1_000,
        ).availability).toBe('partial');
    });

    it('treats a positive ready-event sequence as observed lifecycle evidence for list awareness', () => {
        const session = createSessionFixture({
            encryptionMode: 'plain',
            metadata: { path: '/work', host: 'host' },
            active: false,
            // `presence` is 'online' or the last-seen timestamp; any number is offline.
            presence: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            agentState: {},
            archivedAt: undefined,
            latestTurnStatus: undefined,
            latestTurnStatusObservedAt: undefined,
            latestReadyEventSeq: 4,
        });

        expect(projectUiSessionAwareness(
            buildSessionListRenderableFromSession(session),
            1_000,
        )).toMatchObject({
            lifecycle: 'unknown',
            operational: { primary: 'ready' },
            availability: 'complete',
        });
    });

    it('does not promote active state into observed runtime reachability', () => {
        const session = createSessionFixture({
            encryptionMode: 'plain', active: true, latestTurnStatus: 'in_progress',
        });
        delete (session as { presence?: unknown }).presence;

        expect(projectUiSessionAwareness(session, 1_000)).toMatchObject({
            runtime: 'unknown', freshness: 'unknown',
            operational: { primary: 'working' },
        });
    });

    it('uses settled content availability for hydrated and list awareness', () => {
        const session = createSessionFixture({
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_access_pending',
            metadata: { name: 'Retained private title', path: '/private', host: 'host' },
        });

        const detail = projectUiSessionAwareness(session, 1_000);
        const list = projectUiSessionAwareness(
            buildSessionListRenderableFromSession(session, undefined, []),
            1_000,
        );

        expect(detail).toMatchObject({ encryption: 'access_pending', availability: 'locked' });
        expect(list).toMatchObject({ encryption: 'access_pending', availability: 'locked' });
        expect(detail.title).toBeUndefined();
        expect(detail.workspace).toBeUndefined();
        expect(list.title).toBeUndefined();
        expect(list.workspace).toBeUndefined();
    });

    it('keeps absent availability unknown and hides retained private metadata', () => {
        const session = createSessionFixture({ encryptionMode: 'e2ee', encryptedContentAvailability: undefined,
            metadata: { name: 'Private title', path: '/private', host: 'host' },
        });
        for (const source of [session, buildSessionListRenderableFromSession(session, undefined, [])]) {
            const projection = projectUiSessionAwareness(source, 1_000);
            expect(projection.encryption).toBe('unknown');
            expect(projection.title).toBeUndefined();
            expect(projection.workspace).toBeUndefined();
        }
    });

    it('maps each settled encrypted-content outcome without inventing another crypto decision', () => {
        const cases = [
            ['ready', 'ready'],
            ['encrypted_access_pending', 'access_pending'],
            ['recipient_encryption_setup_required', 'setup_required'],
            ['encrypted_access_needs_repair', 'repair_needed'],
            ['encrypted_content_unavailable', 'content_unavailable'],
        ] as const;

        for (const [encryptedContentAvailability, encryption] of cases) {
            expect(projectUiSessionAwareness(createSessionFixture({
                encryptionMode: 'e2ee',
                encryptedContentAvailability,
                metadata: { name: 'Private title', path: '/private', host: 'host' },
            }), 1_000).encryption).toBe(encryption);
        }
    });

    it('keeps a plain Session with unavailable Account owner metadata locked in list and detail awareness', () => {
        const session = createSessionFixture({
            encryptionMode: 'plain',
            encryptedContentAvailability: 'encrypted_content_unavailable',
            metadata: null,
            ownerMetadataView: null,
            agentState: null,
        });
        for (const source of [session, buildSessionListRenderableFromSession(session, undefined, [])]) {
            const projection = projectUiSessionAwareness(source, 1_000);
            expect(projection.encryption).toBe('content_unavailable');
            expect(projection.title).toBeUndefined();
            expect(projection.workspace).toBeUndefined();
        }
    });

});

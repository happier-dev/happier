import { describe, expect, it, vi } from 'vitest';
import { SessionWorkflowActivityHeadlineV1Schema } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowActivityHeadlineV1';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '../listing/sessionListRenderable';
import { createSessionListPresentationSource } from '../listing/sessionListRenderableSessionProjection';
import { projectUiSessionAwareness } from './sessionAwareness';
import { SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { readSessionWorkStateV1FromMetadata } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';

describe('UI Session awareness acquisition adapter', () => {
    it('reads startup progress from the admitted list source without reviving an older Agent state', () => {
        const session = createSessionFixture({ encryptionMode: 'plain', active: true, presence: 'online',
            activeAt: 1_000, agentStateVersion: 4, agentState: { workStatus: 'waiting_for_startup_lock' } });
        const row = buildSessionListRenderableFromSession(session, undefined, []);
        const source = createSessionListPresentationSource(row, { baseSession: session });
        expect(projectUiSessionAwareness(row, 1_001, { presentationSource: source }).workStatus)
            .toBe('waiting_for_startup_lock');
        const newerRow = { ...row, agentStateVersion: 5 };
        const newerSource = createSessionListPresentationSource(newerRow, { baseSession: session });
        expect(projectUiSessionAwareness(newerRow, 1_001, { presentationSource: newerSource }))
            .not.toHaveProperty('workStatus');
    });
    it('keeps canonical current work in the compact row without retaining work history', () => {
        const task = { id: 'task', kind: 'task' as const, origin: 'happier' as const,
            status: 'blocked' as const, statusReason: 'blocked' as const, title: 'Current task', updatedAt: 100 };
        const goal = { id: 'goal', kind: 'goal' as const, origin: 'happier' as const,
            status: 'active' as const, title: 'Active goal', updatedAt: 100 };
        const history = { id: 'history', kind: 'task' as const, origin: 'happier' as const,
            status: 'complete' as const, title: 'Private completed history', updatedAt: 100 };
        const session = createSessionFixture({ encryptionMode: 'plain', metadata: {
            path: '/work', host: 'host', sessionWorkStateV1: { v: 1, backendId: 'codex', updatedAt: 100,
                primaryItemId: task.id, items: [goal, task, history] },
        } });
        const row = buildSessionListRenderableFromSession(session, undefined, []);
        expect(row).toHaveProperty('workDisplay', { v: 1, primaryItem: {
            id: task.id, kind: task.kind, title: task.title, status: task.status, statusReason: task.statusReason,
        }, hasActiveGoal: true });
        expect(row).not.toHaveProperty('workState');
        expect(JSON.stringify(row)).not.toContain(history.title);
        expect(projectUiSessionAwareness(row, 1_000).currentWork)
            .toEqual(projectUiSessionAwareness(session, 1_000).currentWork);
        const changedHistory = createSessionFixture({ ...session, metadata: { ...session.metadata!,
            sessionWorkStateV1: { v: 1, backendId: 'codex', updatedAt: 200,
                primaryItemId: task.id, items: [goal, task, { ...history, title: 'Changed private history', updatedAt: 200 }] },
        } });
        expect(buildSessionListRenderableFromSession(changedHistory, row, [])).toBe(row);
        expect(readSessionWorkStateV1FromMetadata(session.metadata)?.items).toHaveLength(3);
    });

    it('carries issue-bound recovery once through the keyed row and preserves unchanged row identity', () => {
        const recovery = SessionUsageLimitRecoveryV1Schema.parse({ v: 1, status: 'waiting',
            issueFingerprint: 'usage-limit:codex:turn-a:1000:5000', armedAtMs: 1_000,
            resetAtMs: 5_000, nextCheckAtMs: 5_000, attemptCount: 0, maxAttempts: 3,
            lastProbeError: null, selectedAuth: { kind: 'native' },
        });
        const session = createSessionFixture({ encryptionMode: 'plain', active: true, presence: 'online', activeAt: 1_000,
            latestTurnStatus: 'failed', metadata: { path: '/work', host: 'local', sessionUsageLimitRecoveryV1: recovery },
            lastRuntimeIssue: { v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit', code: 'usage_limit',
                agentId: 'codex', agentTurnId: 'turn-a', occurredAt: 1_000,
                usageLimit: { v: 1, resetAtMs: 5_000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } },
        });
        const row = buildSessionListRenderableFromSession(session, undefined, []);
        expect(row.metadata?.sessionUsageLimitRecoveryV1).toEqual(recovery);
        expect(buildSessionListRenderableFromSession(session, row, [])).toBe(row);
        const parse = vi.spyOn(SessionUsageLimitRecoveryV1Schema, 'safeParse');
        try {
            for (let index = 0; index < 20; index += 1) {
                expect(projectUiSessionAwareness(row, 1_001).operational.primary).toBe('usage_limited');
            }
            expect(parse).not.toHaveBeenCalled();
        } finally { parse.mockRestore(); }
    });
    it('retains a usage-limited failed turn through detail and list without automatic recovery data', () => {
        const session = createSessionFixture({ encryptionMode: 'plain', active: true, presence: 'online', activeAt: 1_000,
            latestTurnStatus: 'failed', latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: { v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit', code: 'usage_limit', occurredAt: 1_000 },
        });
        for (const source of [session, buildSessionListRenderableFromSession(session, undefined, [])]) {
            expect(projectUiSessionAwareness(source, 1_001).operational.primary).toBe('usage_limited');
        }
    });
    it('does not parse absent workflow headlines while projecting ordinary Sessions', () => {
        const session = createSessionFixture({ encryptionMode: 'plain', metadata: { path: '/work', host: 'host' } });
        const parse = vi.spyOn(SessionWorkflowActivityHeadlineV1Schema, 'safeParse');
        try {
            for (let index = 0; index < 20; index += 1) {
                expect(projectUiSessionAwareness(session, 1_000).encryption).toBe('plain');
            }
            expect(parse).not.toHaveBeenCalled();
        } finally { parse.mockRestore(); }
    });
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

    it('projects a hydrated native permission despite unstamped zero counters in both detail and list awareness', () => {
        const session = createSessionFixture({ encryptionMode: 'plain', active: true, presence: 'online', activeAt: 13_000,
            latestTurnStatus: 'in_progress', updatedAt: 13_000, pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0, pendingRequestObservedAt: null,
            agentState: { requests: { 'exec-native': { tool: 'Bash', kind: 'permission',
                arguments: { command: 'sleep 300' }, createdAt: 12_345, turnId: 'native-turn' } } },
        });
        for (const source of [session, buildSessionListRenderableFromSession(session, undefined, [])]) {
            expect(projectUiSessionAwareness(source, 13_001).operational.primary).toBe('permission_required');
        }
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

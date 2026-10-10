import { describe, expect, it, vi } from 'vitest';
import type { BoardItemRefV1 } from '@happier-dev/protocol';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params && 'count' in params ? `${key}:${String(params.count)}` : key),
    });
});

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';

import {
    buildBoardCards,
    createBoardCardProjection,
    countSessionsByMachine,
    describeBoardColumnLine,
    reconcileBoardCards,
    type BoardCardFacts,
} from './boardCards';
import type { BoardMember } from './boardMembership';
import { readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';

const NOW = 1_000_000;

function member(ref: BoardItemRefV1, available = true): BoardMember {
    return { key: JSON.stringify([ref.kind, ref.qualifiedId.serverId, ref.qualifiedId.id]), ref, picked: true, sourced: false, available };
}

const permissionSession = createSessionListRenderableSessionFixture({
    id: 's-need',
    active: true,
    activeAt: NOW,
    hasPendingPermissionRequests: true,
    pendingRequestObservedAt: NOW,
    metadata: { path: '/repo', host: 'mbp', homeDir: '/u', machineId: 'm1' },
});
const workingSession = createSessionListRenderableSessionFixture({
    id: 's-work',
    active: true,
    activeAt: NOW,
    thinking: true,
    thinkingAt: NOW,
    metadata: { path: '/repo', host: 'mbp', homeDir: '/u', machineId: 'm1' },
});

describe('board cards', () => {
    it('keeps the enrolled Machine asleep and reprojects observed Start through the shared status owner', () => {
        const ref = { kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'guest' } } as const;
        const managed: ManagedMachineV1 = { id: 'managed', homeId: 'home-a', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: true,
            observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained', daemon: 'disconnected' } };
        const guest = createMachineFixture({ id: 'guest', active: false, activeAt: 0 });
        const members = [member(ref)];
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => guest, managedMachine: () => managed,
            machineSessionCounts: new Map(), accountScopedHome: () => true };
        const project = createBoardCardProjection();
        expect(project(members, facts)[0]?.status).toMatchObject({ bucket: 'idle', word: 'managedPower.asleep' });
        const starting = { ...managed, submittedNativeEffect: { intent: 'start' as const, intentRevision: 2, requestId: 'start', controller: managed.controller } };
        expect(project(members, { ...facts, managedMachine: () => starting })[0]?.status).toMatchObject({ bucket: 'working', word: 'managedWake.starting' });
    });
    it('keeps unreadable Session explanations in the body with a short neutral state word', () => {
        const row = createSessionListRenderableSessionFixture({ ...permissionSession, metadata: null,
            encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_content_unavailable' });
        const [card] = buildBoardCards([member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: row.id } })], {
            nowMs: NOW, session: () => row, workflowRun: () => null, machine: () => null,
            workflow: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true,
        });
        expect(card?.status).toMatchObject({ bucket: 'idle', tone: 'neutral', word: 'boards.card.unavailable' });
        expect(card?.body).toMatchObject({ kind: 'session', statusDetail: 'session.access.unavailable' });
    });
    it('reprojects unchanged Session sources when the canonical status freshness deadline passes', () => {
        const members = [member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: permissionSession.id } })];
        const facts: BoardCardFacts = { nowMs: NOW, session: () => permissionSession, workflowRun: () => null,
            machine: () => null, workflow: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true };
        const project = createBoardCardProjection();
        const before = project(members, facts);
        expect(before[0]?.status.bucket).toBe('needs_you');
        const refreshAt = readSessionStatusNextRefreshAtMs(permissionSession, NOW);
        expect(refreshAt).not.toBeNull();
        const expired = { ...facts, nowMs: refreshAt! };
        expect(project(members, expired)[0]?.status).toEqual(buildBoardCards(members, expired)[0]?.status);
        expect(project(members, expired)[0]?.status.bucket).not.toBe('needs_you');
    });
    it('projects FIN lean authored-step and loop progress without opening full runs', () => {
        const ref = { kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'r1' } } as const;
        const facts: BoardCardFacts = {
            nowMs: NOW, session: () => null, machine: () => null, machineSessionCounts: new Map(),
            workflow: () => null, accountScopedHome: () => true,
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
                stepProgress: { completed: 3, total: 5, currentLoop: { completed: 2, total: 8 } },
            }), null),
        };
        expect(buildBoardCards([member(ref)], facts)[0]?.body).toMatchObject({
            kind: 'workflow_run', progress: { completed: 3, total: 5, currentLoop: { completed: 2, total: 8 } },
        });
        const missing = buildBoardCards([member(ref)], { ...facts,
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ stepProgress: null }), null) });
        expect(missing[0]?.body).toMatchObject({ progress: null });
    });

    it('projects library trigger summaries and distinguishes manual from unavailable scheduled next-run facts', () => {
        const ref = { kind: 'workflow', qualifiedId: { serverId: 'home-a', id: 'wf1' } } as const;
        const facts: BoardCardFacts = {
            nowMs: NOW, session: () => null, machine: () => null, machineSessionCounts: new Map(),
            workflowRun: () => null, accountScopedHome: () => true,
            workflow: () => ({ title: 'Nightly', triggers: [{ kind: 'schedule', schedule: {
                kind: 'interval', everyMs: 3_600_000, scheduleExpr: null, timezone: null,
            } }], summary: { needsYouCount: 2, lastRun: { state: 'succeeded', createdAt: '2026-10-01T00:00:00Z' } } }),
        };
        expect(buildBoardCards([member(ref)], facts)[0]?.body).toMatchObject({
            triggerSummary: 'workflows.triggers.summary.everyHours:1', nextRun: { kind: 'unavailable' }, needsYouCount: 2,
        });
        const notRead = buildBoardCards([member(ref)], { ...facts, workflow: () => ({ title: 'Manual', triggers: [], summary: null }) })[0];
        expect(notRead?.body)
            .toMatchObject({ triggerSummary: 'workflows.triggers.summary.manual', nextRun: { kind: 'unscheduled' }, needsYouCount: null });
        expect(notRead?.status.word).toBe('boards.card.notLoaded');
    });

    it('counts running and needs-you sessions per machine from the loaded rows, through the shared status owner', () => {
        const machineKey = (serverId: string, id: string) => JSON.stringify(['machine', serverId, id]);
        // The same machine id on two Homes is two machines: each counts only its own Home's rows.
        const counts = countSessionsByMachine([
            ['home-a', [permissionSession, workingSession]],
            ['home-b', [{ ...workingSession, id: 's-work-b' }]],
        ], NOW);
        expect(counts.get(machineKey('home-a', 'm1'))).toEqual({ running: 1, needsYou: 1 });
        expect(counts.get(machineKey('home-b', 'm1'))).toEqual({ running: 1, needsYou: 0 });
    });

    it('gives every kind one status vocabulary and groups all kinds By status, Finished rather than Done', () => {
        const facts: BoardCardFacts = {
            nowMs: NOW,
            session: (ref) => (ref.qualifiedId.id === 's-need' ? permissionSession : null),
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'r1', state: 'succeeded' }), null),
            machine: (ref) => (ref.qualifiedId.id === 'm1'
                ? createMachineFixture({ id: 'm1', active: true, activeAt: NOW })
                : createMachineFixture({ id: 'm2', active: false, activeAt: 1 })),
            machineSessionCounts: new Map([[JSON.stringify(['machine', 'home-a', 'm1']), { running: 1, needsYou: 1 }]]),
            accountScopedHome: () => true,
            workflow: () => ({ title: 'Nightly release check', summary: { needsYouCount: 0, lastRun: null } }),
        };
        const cards = buildBoardCards([
            member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: 's-need' } }),
            member({ kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'r1' } }),
            member({ kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'm1' } }),
            member({ kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'm2' } }),
            member({ kind: 'workflow', qualifiedId: { serverId: 'home-a', id: 'wf1' } }),
        ], facts);

        expect(cards.map((card) => [card.ref.kind, card.status.bucket])).toEqual([
            ['session', 'needs_you'],
            ['workflow_run', 'finished'],
            ['machine', 'needs_you'],
            ['machine', 'offline'],
            ['workflow', 'idle'],
        ]);
    });

    it('shows an item from a Home that is not mounted as unavailable, not as missing work', () => {
        const [card] = buildBoardCards([member({ kind: 'session', qualifiedId: { serverId: 'home-off', id: 's9' } }, false)], {
            nowMs: NOW,
            session: () => null,
            workflowRun: () => null,
            machine: () => null,
            machineSessionCounts: new Map(),
            workflow: () => null,
            accountScopedHome: () => true,
        });
        expect(card!.availability).toBe('home_unavailable');
        expect(card!.status.bucket).toBe('offline');
    });

    it('never reads another Home\'s workflow or run from the focused Home\'s same-id item', () => {
        const run = (serverId: string) => member({ kind: 'workflow_run', qualifiedId: { serverId, id: 'r1' } });
        const workflow = (serverId: string) => member({ kind: 'workflow', qualifiedId: { serverId, id: 'wf1' } });
        const cards = buildBoardCards([run('home-a'), run('home-b'), workflow('home-a'), workflow('home-b')], {
            nowMs: NOW,
            session: () => null,
            // The Account-scoped stores hold the focused Home's (home-a) r1 and wf1, keyed by bare id.
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'r1', state: 'running' }), null),
            machine: () => null,
            machineSessionCounts: new Map(),
            workflow: () => ({ title: 'Nightly release check', summary: { needsYouCount: 0, lastRun: null } }),
            accountScopedHome: (serverId) => serverId === 'home-a',
        });
        expect(cards.map((card) => [card.ref.qualifiedId.serverId, card.ref.kind, card.availability])).toEqual([
            ['home-a', 'workflow_run', 'ready'],
            ['home-b', 'workflow_run', 'home_unavailable'],
            ['home-a', 'workflow', 'ready'],
            ['home-b', 'workflow', 'home_unavailable'],
        ]);
    });

    it('on a populated board, a store update on one item gives a new card to that item only', () => {
        // 40 cards mixing kinds (INT §7.3); one Session then asks for a permission.
        const rows = new Map(Array.from({ length: 20 }, (_, index) => [`s${index}`, createSessionListRenderableSessionFixture({
            id: `s${index}`, active: true, activeAt: NOW, metadata: { path: '/repo', host: 'mbp', homeDir: '/u', machineId: 'm1' },
        })] as const));
        const members = [
            ...Array.from({ length: 20 }, (_, index) => member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: `s${index}` } })),
            ...Array.from({ length: 10 }, (_, index) => member({ kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: `r${index}` } })),
            ...Array.from({ length: 10 }, (_, index) => member({ kind: 'machine', qualifiedId: { serverId: 'home-a', id: `m${index}` } })),
        ];
        const facts = (sessionRows: ReadonlyMap<string, ReturnType<typeof createSessionListRenderableSessionFixture>>): BoardCardFacts => ({
            nowMs: NOW,
            session: (ref) => sessionRows.get(ref.qualifiedId.id) ?? null,
            workflowRun: (ref) => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: ref.qualifiedId.id, state: 'running' }), null),
            machine: (ref) => createMachineFixture({ id: ref.qualifiedId.id, active: true, activeAt: NOW }),
            machineSessionCounts: new Map(),
            workflow: () => null,
            accountScopedHome: () => true,
        });
        const before = buildBoardCards(members, facts(rows));
        expect(before).toHaveLength(40);
        const updated = new Map(rows);
        updated.set('s7', { ...rows.get('s7')!, hasPendingPermissionRequests: true, pendingRequestObservedAt: NOW });
        const after = reconcileBoardCards(before, buildBoardCards(members, facts(updated)));

        const changed = after.filter((card, index) => card !== before[index]);
        expect(changed.map((card) => card.ref.qualifiedId.id)).toEqual(['s7']);
        expect(changed[0]!.status.bucket).toBe('needs_you');
        // Nothing changed at all: the previous list itself is kept.
        expect(reconcileBoardCards(after, buildBoardCards(members, facts(updated)))).toBe(after);
    });

    it('says in the column what a board holds right now: who needs you, then how many items (lab boards-B1)', () => {
        const status = (bucket: 'needs_you' | 'working') => ({ bucket, tone: bucket === 'needs_you' ? 'attention' as const : 'neutral' as const, word: bucket });
        const cards = [status('needs_you'), status('needs_you'), status('working')].map((value, index) => ({
            key: `k${index}`,
            ref: { kind: 'session' as const, qualifiedId: { serverId: 'home-a', id: `s${index}` } },
            picked: true,
            availability: 'ready' as const,
            title: `s${index}`,
            status: value,
            body: { kind: 'none' as const },
        }));
        expect(describeBoardColumnLine(cards)).toEqual({ needYou: 2, text: 'boards.meta.needYou:2 · boards.meta.items:3' });
        expect(describeBoardColumnLine(cards.slice(2))).toEqual({ needYou: 0, text: 'boards.meta.items:1' });
    });
});

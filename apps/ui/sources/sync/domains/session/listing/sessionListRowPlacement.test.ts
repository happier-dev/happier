import { afterEach, describe, expect, it } from 'vitest';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { QUIET_SESSION_PERSONAL_ATTENTION_V1 } from '@happier-dev/protocol/sessions/personal/attention';

import { createSessionListRenderableSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import {
    planSyncActionsFromChanges,
    plannedChangesAffectSessionListQuery,
    plannedSessionListRowMembershipFacets,
} from '@/sync/runtime/orchestration/changesPlanner';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import { createSessionListQueryHomeController } from './sessionListQueryController';
import { subscribeSessionListQueryHomeInvalidation } from './sessionListQueryInvalidation';
import { placeSessionListRows } from './sessionListRowPlacement';
import type { SessionListRenderableSession } from './sessionListRenderable';

const HOME = 'home-a';
const base = { v: 1, storage: 'active', scope: 'my_work', attention: 'any', audiences: [], tagIds: [] } as const;
const MY_WORK: SessionListQueryV1 = { ...base, includeInactive: true };
const HIDE_INACTIVE: SessionListQueryV1 = { ...base, includeInactive: false };
const ATTENTION: SessionListQueryV1 = { ...base, includeInactive: true, attention: 'needs_my_attention' };

type RowFacts = Readonly<{ activity: number; relevant: boolean; attention?: boolean; active?: boolean; owned?: boolean; pinned?: boolean }>;

function row(id: string, facts: RowFacts): SessionListRenderableSession {
    return createSessionListRenderableSessionFixture({
        id, createdAt: 1, meaningfulActivityAt: facts.activity, active: facts.active ?? false,
        viewer: createSessionViewerFixture({
            relevance: { relevant: facts.relevant, reasons: facts.relevant ? [facts.owned === false ? 'followed_by_me' : 'owned_by_me', ...(facts.pinned ? ['pinned_by_me' as const] : [])] : [] },
            attention: facts.attention
                ? { needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full' }
                : QUIET_SESSION_PERSONAL_ATTENTION_V1,
        }),
    });
}

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

describe('in-place list placement of batch-read rows', () => {
    it('places N message and Agent-state writes, loaded or not, with zero list queries and the server order', async () => {
        const reads: string[] = [];
        const queries = new Map<ReturnType<typeof createSessionListQueryHomeController>, SessionListQueryV1>();
        const make = (name: string, query: SessionListQueryV1, ids: string[], hasNext = true) => {
            const controller = createSessionListQueryHomeController({ serverId: HOME, fetchPage: async () => {
                reads.push(name);
                return { sessionIds: ids, nextCursor: hasNext ? 'next' : null, hasNext, attentionNextCursor: null, attentionHasNext: false, current: true, source: 'v2' as const };
            } });
            disposers.push(() => controller.dispose());
            disposers.push(subscribeSessionListQueryHomeInvalidation(() => new Map([[HOME, controller]])));
            // A paged corpus serves full pages (rows = limit); a short page with `hasNext`
            // would make the controller fill the page from the next cursor.
            queries.set(controller, hasNext ? { ...query, limit: ids.length } : query);
            return controller;
        };
        let rows: Record<string, SessionListRenderableSession> = {
            'loaded-1': row('loaded-1', { activity: 200, relevant: true, active: true }),
            'loaded-2': row('loaded-2', { activity: 100, relevant: true }),
        };
        storage.setState({
            sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId, [HOME]: rows },
            ordinarySessionListMembershipByServerId: { ...storage.getState().ordinarySessionListMembershipByServerId, [HOME]: ['loaded-1', 'loaded-2'] },
        });
        const myWork = make('myWork', MY_WORK, ['loaded-1', 'loaded-2']);
        const hideInactive = make('hideInactive', HIDE_INACTIVE, ['loaded-1']);
        // The attention corpus is fully read (no unread page can hold a member).
        const attention = make('attention', ATTENTION, [], false);
        for (const [controller, query] of queries) {
            await controller.update({ query, selected: true, online: true, supported: true });
            expect(controller.getSnapshot().phase).toBe('ready');
        }
        reads.length = 0;

        // The final facts the batch owner reads back for each written Session.
        const finalFacts: Record<string, RowFacts> = {
            'loaded-1': { activity: 210, relevant: true, active: true },
            'loaded-2': { activity: 220, relevant: true, attention: true },
            'outside-hot': { activity: 300, relevant: true, active: true },
            'outside-cold': { activity: 50, relevant: true },
            'outside-team': { activity: 400, relevant: false, active: true },
        };
        const isLoaded = (id: string) => (storage.getState().ordinarySessionListMembershipByServerId[HOME] ?? []).includes(id);
        const ids = Object.keys(finalFacts);
        for (let index = 1; index <= 10; index++) {
            const changes = ids.flatMap((id, offset) => [
                { cursor: index * 100 + offset * 2, kind: 'session' as const, entityId: id, changedAt: index,
                    hint: { lastMessageSeq: index, lastMessageId: `m-${id}-${index}` } },
                { cursor: index * 100 + offset * 2 + 1, kind: 'session' as const, entityId: id, changedAt: index,
                    hint: { agentStateVersion: index } },
            ]);
            // Focused-Home catch-up: plan, publish the list decision, then batch-read the rows.
            const plan = planSyncActionsFromChanges(changes, { isSessionListMember: isLoaded });
            publishHomeAccountChange(HOME, changes.map(change => change.entityId), {
                feedPageConsumed: true, changeKinds: changes.map(change => change.kind),
                sessionListQueryAffects: plannedChangesAffectSessionListQuery(plan),
                sessionListRowFacets: plannedSessionListRowMembershipFacets(plan),
            });
            if (plannedChangesAffectSessionListQuery(plan) === true) continue;
            rows = { ...rows, ...Object.fromEntries(plan.sessionRowRefreshIds.map(id => [id, row(id, finalFacts[id]!)])) };
            storage.setState({ sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId, [HOME]: rows } });
            placeSessionListRows({ serverId: HOME, sessionIds: plan.sessionRowRefreshIds, ordinaryHasMorePages: true });
            await Promise.resolve();
        }

        expect(reads).toEqual([]);
        const ids_ = (controller: typeof myWork) => controller.getSnapshot().addresses.map(address => address.sessionId);
        // Server order (activity descending); an older unloaded member stays with paging.
        expect(ids_(myWork)).toEqual(['outside-hot', 'loaded-2', 'loaded-1']);
        expect(ids_(hideInactive)).toEqual(['outside-hot', 'loaded-2', 'loaded-1']);
        expect(ids_(attention)).toEqual(['loaded-2']);
        expect(storage.getState().ordinarySessionListMembershipByServerId[HOME]).toEqual(
            expect.arrayContaining(['loaded-1', 'loaded-2', 'outside-hot']));
        expect(storage.getState().ordinarySessionListMembershipByServerId[HOME]).not.toContain('outside-cold');
        expect(storage.getState().ordinarySessionListMembershipByServerId[HOME]).not.toContain('outside-team');
    });

    it('admits an old unloaded Session that newly needs attention into a paged includeAttention corpus', async () => {
        // Activity's corpus: page 1 carries every attention row ahead of the activity window.
        const ACTIVITY: SessionListQueryV1 = { ...MY_WORK, includeAttention: true, limit: 2 };
        let reads = 0;
        const controller = createSessionListQueryHomeController({ serverId: HOME, fetchPage: async () => {
            reads++;
            return { sessionIds: ['loaded-1', 'loaded-2'], nextCursor: 'next', hasNext: true,
                attentionNextCursor: null, attentionHasNext: false, current: true, source: 'v2' as const };
        } });
        disposers.push(() => controller.dispose());
        disposers.push(subscribeSessionListQueryHomeInvalidation(() => new Map([[HOME, controller]])));
        const rows: Record<string, SessionListRenderableSession> = {
            'loaded-1': row('loaded-1', { activity: 200, relevant: true }),
            'loaded-2': row('loaded-2', { activity: 100, relevant: true }),
            'old-asks': row('old-asks', { activity: 10, relevant: true, attention: true }),
            'old-quiet': row('old-quiet', { activity: 5, relevant: true }),
        };
        storage.setState({ sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId, [HOME]: rows } });
        await controller.update({ query: ACTIVITY, selected: true, online: true, supported: true });
        expect(controller.getSnapshot().phase).toBe('ready');
        reads = 0;

        placeSessionListRows({ serverId: HOME, sessionIds: ['old-asks', 'old-quiet'], ordinaryHasMorePages: true });
        await Promise.resolve();

        expect(reads).toBe(0);
        // The attention row joins; the quiet older row stays with its unread activity page.
        expect(controller.getSnapshot().addresses.map(address => address.sessionId)).toEqual(['loaded-1', 'loaded-2', 'old-asks']);
    });

    it('admits an old pinned Session that becomes active into a paged hide-inactive corpus', async () => {
        // Every active-storage first page carries the viewer's pinned members ahead of the window.
        const query: SessionListQueryV1 = { ...HIDE_INACTIVE, limit: 2 };
        let reads = 0;
        const controller = createSessionListQueryHomeController({ serverId: HOME, fetchPage: async () => {
            reads++;
            return { sessionIds: ['loaded-1', 'loaded-2'], nextCursor: 'next', hasNext: true,
                attentionNextCursor: null, attentionHasNext: false, current: true, source: 'v2' as const };
        } });
        disposers.push(() => controller.dispose());
        disposers.push(subscribeSessionListQueryHomeInvalidation(() => new Map([[HOME, controller]])));
        storage.setState({ sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId, [HOME]: {
            'loaded-1': row('loaded-1', { activity: 200, relevant: true, active: true }),
            'loaded-2': row('loaded-2', { activity: 100, relevant: true, active: true }),
            'old-pinned': row('old-pinned', { activity: 10, relevant: true, active: true, pinned: true }),
            'old-active': row('old-active', { activity: 5, relevant: true, active: true }),
        } } });
        await controller.update({ query, selected: true, online: true, supported: true });
        expect(controller.getSnapshot().phase).toBe('ready');
        reads = 0;

        placeSessionListRows({ serverId: HOME, sessionIds: ['old-pinned', 'old-active'], ordinaryHasMorePages: true });
        await Promise.resolve();

        expect(reads).toBe(0);
        expect(controller.getSnapshot().addresses.map(address => address.sessionId)).toEqual(['loaded-1', 'loaded-2', 'old-pinned']);
    });

    it('places streamed writes into a smart Space corpus without re-reading it, and re-reads only when manual membership decides', async () => {
        // A Space with a manually associated tag: the Home answers `tagged OR my_work filter` under the outer lens.
        const SPACE: SessionListQueryV1 = { ...base, scope: 'all_accessible', includeInactive: true, includeAttention: true, limit: 2,
            membership: { mode: 'filter_or_manual', tagIds: ['tag-space'], filter: { scope: 'my_work', attention: 'any', audiences: [], tagIds: [] } } };
        let reads = 0;
        const controller = createSessionListQueryHomeController({ serverId: HOME, fetchPage: async () => {
            reads++;
            return { sessionIds: ['streaming', 'tagged-foreign'], nextCursor: 'next', hasNext: true,
                attentionNextCursor: null, attentionHasNext: false, current: true, source: 'v2' as const };
        } });
        disposers.push(() => controller.dispose());
        disposers.push(subscribeSessionListQueryHomeInvalidation(() => new Map([[HOME, controller]])));
        let rows: Record<string, SessionListRenderableSession> = {
            streaming: row('streaming', { activity: 200, relevant: true, active: true }),
            // In the Space only through its manual tag: the row write cannot decide it.
            'tagged-foreign': row('tagged-foreign', { activity: 100, relevant: false }),
        };
        storage.setState({ sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId, [HOME]: rows } });
        await controller.update({ query: SPACE, selected: true, online: true, supported: true });
        expect(controller.getSnapshot().phase).toBe('ready');
        reads = 0;

        const write = (ids: readonly string[], facts: Record<string, RowFacts>, index: number) => {
            const changes = ids.flatMap((id, offset) => [
                { cursor: index * 100 + offset * 2, kind: 'session' as const, entityId: id, changedAt: index,
                    hint: { updatedMessageSeq: 3, updatedMessageId: `m-${id}` } },
                { cursor: index * 100 + offset * 2 + 1, kind: 'session' as const, entityId: id, changedAt: index,
                    hint: { meaningfulActivityAt: facts[id]!.activity } },
            ]);
            const plan = planSyncActionsFromChanges(changes, { isSessionListMember: () => true });
            publishHomeAccountChange(HOME, changes.map(change => change.entityId), {
                feedPageConsumed: true, changeKinds: changes.map(change => change.kind),
                sessionListQueryAffects: plannedChangesAffectSessionListQuery(plan),
                sessionListRowFacets: plannedSessionListRowMembershipFacets(plan),
            });
            rows = { ...rows, ...Object.fromEntries(plan.sessionRowRefreshIds.map(id => [id, row(id, facts[id]!)])) };
            storage.setState({ sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId, [HOME]: rows } });
            placeSessionListRows({ serverId: HOME, sessionIds: plan.sessionRowRefreshIds, ordinaryHasMorePages: true });
        };
        // Ten durable writes of the streaming Session, plus a newer relevant Session that was not loaded.
        for (let index = 1; index <= 10; index++) {
            write(['streaming', 'outside-hot'], {
                streaming: { activity: 200 + index, relevant: true, active: true },
                'outside-hot': { activity: 300 + index, relevant: true, active: true },
            }, index);
            await Promise.resolve();
        }
        expect(reads).toBe(0);
        expect(controller.getSnapshot().addresses.map(address => address.sessionId)).toEqual(['outside-hot', 'streaming', 'tagged-foreign']);

        // A write to a row the filter rejects: only the Home knows its manual membership.
        write(['tagged-foreign'], { 'tagged-foreign': { activity: 400, relevant: false } }, 11);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(reads).toBe(1);
    });

    it('still re-reads a list for a structural or unknown change', async () => {
        let reads = 0;
        const controller = createSessionListQueryHomeController({ serverId: HOME, fetchPage: async () => {
            reads++;
            return { sessionIds: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false, current: true, source: 'v2' as const };
        } });
        disposers.push(() => controller.dispose());
        disposers.push(subscribeSessionListQueryHomeInvalidation(() => new Map([[HOME, controller]])));
        await controller.update({ query: MY_WORK, selected: true, online: true, supported: true });
        reads = 0;
        const plan = planSyncActionsFromChanges([{ cursor: 1, kind: 'session', entityId: 's', changedAt: 1,
            hint: { someFutureMembershipFact: 1 } }], { isSessionListMember: () => false });
        publishHomeAccountChange(HOME, ['s'], { feedPageConsumed: true, changeKinds: ['session'],
            sessionListQueryAffects: plannedChangesAffectSessionListQuery(plan) });
        await Promise.resolve();
        expect(plannedChangesAffectSessionListQuery(plan)).toBe(true);
        expect(reads).toBe(1);
    });
});

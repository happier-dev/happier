import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { PluginContributesV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { buildWorkBoardItemKeyV1, createWorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPluginUiClientExecutableRegistrationIndex } from '@/components/plugins/reactNative/clientExecutableContributions';
import { readBoardTaskItems, subscribeBoardTaskItems, type BoardTaskItems, type BoardTaskSource } from './boardTaskItems';
import { projectBoardMembership, type BoardMembershipSources } from './boardMembership';
import { buildBoardCards } from './boardCards';
import { createWorkItemsAccountFixture } from '@/dev/testkit/fixtures/workItemsPlugin';

describe('Board public work-item reader', () => {
    it('refreshes only the watched source and releases demand when the visit ends', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const controller = new AbortController();
        const reads = [0, 0];
        let firstUnavailable = false;
        const titles = ['First task', 'Second task'];
        const wakes: (() => void)[] = [];
        const stopped: number[] = [];
        const scopes: ReturnType<typeof index.createScope>[] = [];
        const sources: BoardTaskSource[] = [];
        const refs = [0, 1].map(number => ({ kind: 'task' as const, pluginId: `com.acme.tasks${number}`,
            qualifiedId: { serverId: 'home', id: `task${number}` } }));
        for (const number of [0, 1]) {
            const pluginId = refs[number]!.pluginId;
            const client = { artifactId: 'tasks', exportName: 'activate' };
            const plugin = definePlugin({ id: pluginId, version: '1.0.0', workItems: { 'work-items': { client, platforms: ['web'] } } });
            const contributes = PluginContributesV2Schema.parse(plugin.manifest.contributes);
            const executionOrigin = { serverIdentityId: 'srv_server1', materializationRef: { pluginId, machineId: 'machine', materializationId: 'materialization' } };
            const account = createWorkItemsAccountFixture('home', controller.signal);
            const scope = index.createScope({ pluginId, contributes, target: { ...client, platform: 'web' }, executionOrigin,
                occurrenceId: 'current', pluginVersion: '1.0.0', authority: { serverId: 'home', machineId: 'machine' },
                accountLifetime: account.accountLifetime,
                lifecycle: { signal: controller.signal, isCurrent: () => !controller.signal.aborted } });
            scope.api.workItems.register('work-items', {
                resolve: async ({ itemIds }) => {
                    reads[number]!++;
                    if (number === 0 && firstUnavailable) throw new Error('Source unavailable');
                    return Object.fromEntries(itemIds.map(id => [id, { title: titles[number]!, category: 'started' as const, linkedSessions: [] }]));
                },
                watch: (_selection, wake) => { wakes[number] = wake; return () => { stopped.push(number); }; },
            });
            scope.commit();
            scopes.push(scope);
            const source = { id: `${pluginId}/work-items`, pluginId, pluginVersion: '1.0.0', occurrenceId: 'current',
                definition: contributes.workItems[0]!, executionOrigin };
            sources.push(source);
        }
        let latest: BoardTaskItems | undefined;
        const subscription = subscribeBoardTaskItems({ serverId: 'home', refs, sessions: [], sources,
            platform: 'web', reader: index, signal: controller.signal }, result => { latest = result; });
        try {
            await vi.waitFor(() => expect(latest?.complete).toBe(true));
            expect(reads).toEqual([1, 1]);
            titles[0] = 'First changed'; wakes[0]!();
            await vi.waitFor(() => expect(latest?.items.get(buildWorkBoardItemKeyV1(refs[0]!))?.title).toBe('First changed'));
            expect(reads).toEqual([2, 1]);
            titles[1] = 'Second changed'; wakes[1]!();
            await vi.waitFor(() => expect(latest?.items.get(buildWorkBoardItemKeyV1(refs[1]!))?.title).toBe('Second changed'));
            expect(latest?.items.get(buildWorkBoardItemKeyV1(refs[0]!))?.title).toBe('First changed');
            expect(reads).toEqual([2, 2]);
            firstUnavailable = true;
            wakes[0]!();
            await vi.waitFor(() => expect(latest).toMatchObject({ complete: false, settled: true }));
            expect(latest?.items.get(buildWorkBoardItemKeyV1(refs[1]!))?.title).toBe('Second changed');
            expect(reads).toEqual([3, 2]);
            firstUnavailable = false;
            wakes[0]!();
            await vi.waitFor(() => expect(latest?.complete).toBe(true));
            subscription.stop(); controller.abort();
            wakes[0]!(); wakes[1]!();
            await Promise.resolve();
            expect(reads).toEqual([4, 2]);
            expect(stopped.sort()).toEqual([0, 1]);
        } finally {
            subscription.stop(); controller.abort();
            await Promise.all(scopes.map(scope => scope.unwind()));
        }
    });
    it('retains proven tasks through partial discovery and recovery, including unavailable explicit picks', async () => {
        const pluginId = 'com.acme.tasks';
        const client = { artifactId: 'tasks', exportName: 'activate' };
        const target = { ...client, platform: 'web' as const };
        const plugin = definePlugin({ id: pluginId, version: '1.0.0', workItems: { 'work-items': { client, platforms: ['web'] } } });
        const contributes = PluginContributesV2Schema.parse(plugin.manifest.contributes);
        const executionOrigin = { serverIdentityId: 'srv_server1', materializationRef: { pluginId, machineId: 'machine', materializationId: 'materialization' } };
        const controller = new AbortController();
        const index = createPluginUiClientExecutableRegistrationIndex();
        const account = createWorkItemsAccountFixture('home', controller.signal);
        const scope = index.createScope({ pluginId, contributes, target, executionOrigin, occurrenceId: 'current', pluginVersion: '1.0.0',
            accountLifetime: account.accountLifetime,
            authority: { serverId: 'home', machineId: 'machine' },
            lifecycle: { signal: controller.signal, isCurrent: () => !controller.signal.aborted } });
        const item = { title: 'Fix payments', category: 'started' as const, linkedSessions: [{ serverId: 'home', sessionId: 'worker' }] };
        let complete = false;
        scope.api.workItems.register('work-items', {
            findLinked: async () => ({ itemIds: ['known', 'outside'], complete }),
            resolve: async ({ itemIds }) => Object.fromEntries(itemIds.map(id => [id, id === 'known' || id === 'picked'
                ? item : id === 'outside' ? { ...item, linkedSessions: [] } : null])),
        });
        scope.commit();
        const source = { id: `${pluginId}/work-items`, pluginId, pluginVersion: '1.0.0', occurrenceId: 'current',
            definition: contributes.workItems[0]!, executionOrigin };
        const missing = { kind: 'task', qualifiedId: { serverId: 'home', id: 'missing' }, pluginId } as const;
        const foreign = { ...missing, pluginId: 'com.missing.plugin' };
        const picked = { ...missing, qualifiedId: { serverId: 'home', id: 'picked' } };
        const input = { serverId: 'home', refs: [missing, foreign, picked], sessions: [{ serverId: 'home', sessionId: 'worker' }],
            sources: [source], platform: 'web' as const, reader: index, signal: controller.signal };
        const result = await readBoardTaskItems(input);
        expect(result.complete).toBe(false);
        expect(result.settled).toBe(true);
        const known = { kind: 'task', qualifiedId: { serverId: 'home', id: 'known' }, pluginId } as const;
        expect(result.refs).toContainEqual(known);
        expect(result.linkedRefs).toEqual([known]);
        expect(result.refs).not.toContainEqual({ ...known, qualifiedId: { serverId: 'home', id: 'outside' } });
        expect(result.items.get(buildWorkBoardItemKeyV1(known))).toEqual(item);
        expect(result.items.get(buildWorkBoardItemKeyV1(missing))).toBeNull();
        expect(result.items.get(buildWorkBoardItemKeyV1(foreign))).toBeNull();
        const session = { kind: 'session', qualifiedId: { serverId: 'home', id: 'worker' } } as const;
        const board = { ...createWorkBoardV1({ id: 'external-board', name: 'External work' }), source: {
            picked: input.refs, filter: normalizeSessionListFilterV1({ scope: 'all_accessible', show: 'both',
                homeServerIds: ['home'], underSessionId: 'coordinator' }),
        } };
        const sources: BoardMembershipSources = { isHomeMounted: () => true, sections: {}, filtered: [session, ...result.linkedRefs],
            taskItemsComplete: result.complete, taskItemsSettled: result.settled,
            linkedSessionsForTask: ref => result.items.get(buildWorkBoardItemKeyV1(ref))?.linkedSessions.map(link =>
                ({ kind: 'session' as const, qualifiedId: { serverId: link.serverId, id: link.sessionId } })) ?? null };
        const membership = projectBoardMembership(board, sources);
        expect(membership).toMatchObject({ complete: false, settled: true, taskItemsComplete: false });
        expect(membership.members.some(member => member.ref.kind === 'session')).toBe(false);
        const now = Date.now();
        const row = createSessionListRenderableSessionFixture({ id: 'worker', active: true, activeAt: now,
            hasPendingPermissionRequests: true, pendingRequestObservedAt: now });
        const cards = buildBoardCards(membership.members, { nowMs: now, session: () => row,
            task: ref => result.items.get(buildWorkBoardItemKeyV1(ref)) ?? null,
            workflowRun: () => null, workflow: () => null, machine: () => null, machineSessionCounts: new Map(),
            accountScopedHome: () => true, missingEntityReason: () => 'unavailable' });
        expect(cards.find(card => card.key === buildWorkBoardItemKeyV1(known)))
            .toMatchObject({ availability: 'ready', title: item.title, status: { bucket: 'needs_you' } });
        expect(cards.find(card => card.key === buildWorkBoardItemKeyV1(missing)))
            .toMatchObject({ availability: 'content_unavailable' });
        expect(cards.find(card => card.key === buildWorkBoardItemKeyV1(foreign)))
            .toMatchObject({ availability: 'content_unavailable' });
        expect(projectBoardMembership({ ...board, source: { ...board.source, picked: [...board.source.picked, session] } }, sources)
            .members.find(member => member.ref.kind === 'session')?.picked).toBe(true);
        complete = true;
        const recovered = await readBoardTaskItems(input);
        expect(recovered.complete).toBe(true);
        expect(recovered.linkedRefs).toEqual([known]);
        expect(recovered.items.get(buildWorkBoardItemKeyV1(known))).toEqual(item);
        await scope.unwind();
        const retired = await readBoardTaskItems({ ...input, refs: [known], sessions: [] });
        expect(retired.refs).toContainEqual(known);
        expect(retired.items.get(buildWorkBoardItemKeyV1(known))).toBeNull();
    });
});

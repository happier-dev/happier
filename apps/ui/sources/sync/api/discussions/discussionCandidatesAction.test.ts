import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createDiscussionActionAdapter } from './discussionActions';
import { createActionExecutorBoundaryFixture, createPlainSessionCurrentProjectionRecordFixture, createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit';

const scope = { serverId: 'home-a', accountId: 'alice' };
const profile = (id: string) => ({ id, name: id, firstName: id, lastName: null, username: id,
    avatar: null, bio: null, badges: [], status: 'none', publicKey: null });

describe('registered Discussion candidate Action', () => {
    it('searches the captured Account directory through the real executor and preserves its continuation', async () => {
        const requests: string[] = [];
        const action = createDiscussionActionAdapter({ scope, availability: 'available', encryption: null,
            request: async path => {
                requests.push(path);
                return Response.json({ users: [profile('alice'), profile('bob')], nextCursor: 'people-next' });
            } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ discussionAction: action }));
        const result = await executor.execute(ActionIdSchema.parse('discussion.candidates.list'),
            { source: 'people', query: 'bo', cursor: 'people-before' },
            { surface: 'ui', authority: 'present_user', serverId: scope.serverId, runtimeAccountId: scope.accountId });
        expect(result).toMatchObject({ ok: true, result: { v: 1, serverId: scope.serverId,
            source: 'people', candidates: [{ kind: 'account', participant: { kind: 'account', accountId: 'bob' } }],
            nextCursor: 'people-next' } });
        expect(requests).toEqual(['/v1/user/search?query=bo&purpose=collaboration&cursor=people-before']);
    });

    it('uses the existing accessible Session query and excludes already-bound participants without opening history', async () => {
        const requests: Readonly<{ path: string; body: unknown }>[] = [];
        const roster = { discussionId: 'discussion', ownerAccountId: 'alice', access: 'owner', grants: [],
            participants: [{ participant: { kind: 'session', sessionId: 'joined' }, answerPolicy: 'when_addressed', createdAt: 1 }] };
        const action = createDiscussionActionAdapter({ scope, availability: 'available', encryption: null,
            request: async (path, init) => {
                requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
                if (path.endsWith('/participants')) return Response.json(roster);
                return Response.json({ sessions: ['joined', 'available', 'read-only'].map(id => {
                    const row = createPlainSessionCurrentProjectionRecordFixture({ id });
                    return { ...row, effectiveAccess: { ...row.effectiveAccess,
                        capabilities: { ...row.effectiveAccess.capabilities, submitAgentInput: id !== 'read-only' } },
                        viewer: createSessionOwnerViewerFixture(createSessionFixture({ id })) };
                }), nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
            } });
        const result = await createActionExecutor(createActionExecutorBoundaryFixture({ discussionAction: action })).execute(ActionIdSchema.parse('discussion.candidates.list'),
            { source: 'sessions', discussionId: 'discussion' },
            { surface: 'ui', authority: 'present_user', serverId: scope.serverId, runtimeAccountId: scope.accountId });
        expect(result).toMatchObject({ ok: true, result: { source: 'sessions', candidates: [{ kind: 'session',
            selection: { kind: 'session', session: { serverId: scope.serverId, sessionId: 'available' } } }], nextCursor: null } });
        expect(requests).toEqual([{ path: '/v1/discussions/discussion/participants', body: undefined },
            { path: '/v2/sessions/query', body: { v: 1, storage: 'active', includeInactive: true,
                scope: 'all_accessible', attention: 'any', audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, includeAttention: false } }]);
    });

    it('refuses denied and foreign-Home reads before offering directory data and preserves cancellation', async () => {
        const requests: string[] = [];
        const action = createDiscussionActionAdapter({ scope, availability: 'available', encryption: null,
            request: async path => { requests.push(path); return Response.json({ error: 'discussion_read_denied' }, { status: 403 }); } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ discussionAction: action }));
        const actionId = ActionIdSchema.parse('discussion.candidates.list');
        const input = { source: 'people', query: 'bob', discussionId: 'private' };
        expect(await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', serverId: 'home-b' }))
            .toMatchObject({ ok: false, errorCode: 'discussion_not_found' });
        expect(requests).toEqual([]);
        expect(await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', serverId: scope.serverId }))
            .toMatchObject({ ok: false, errorCode: 'discussion_read_denied' });
        expect(requests).toEqual(['/v1/discussions/private/participants']);
        const controller = new AbortController();
        controller.abort();
        expect(await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', serverId: scope.serverId, signal: controller.signal }))
            .toMatchObject({ ok: false });
        expect(requests).toHaveLength(1);
    });

    it('projects supplied ordinary model selections without discovering, probing or starting anything', async () => {
        const requests: string[] = [];
        const action = createDiscussionActionAdapter({ scope, availability: 'available', encryption: null,
            request: async path => { requests.push(path); throw new Error('Unexpected network read'); } });
        const option = { label: 'Chosen model', selection: { kind: 'model', launch: {
            executionTarget: { serverId: scope.serverId, machineId: 'machine' }, directory: { kind: 'path', path: '/work' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        } } };
        expect(await createActionExecutor(createActionExecutorBoundaryFixture({ discussionAction: action })).execute(ActionIdSchema.parse('discussion.candidates.list'),
            { source: 'models', options: [option, option] },
            { surface: 'ui', authority: 'present_user', serverId: scope.serverId, runtimeAccountId: scope.accountId }))
            .toMatchObject({ ok: true, result: { source: 'models', candidates: [{ kind: 'model', label: option.label,
                selection: option.selection, availability: null, repair: null }], nextCursor: null } });
        expect(requests).toEqual([]);
    });
});

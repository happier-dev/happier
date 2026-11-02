import { describe, expect, it } from 'vitest';
import { SessionListActionInputV1Schema } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

const project = { serverId: 'home-a', projectKey: 'anchor' };
describe('session.list Project selection', () => {
    it('admits a qualified Project on the existing Action and rejects an unqualified identity', () => {
        expect(SessionListActionInputV1Schema.safeParse({ project }).success).toBe(true);
        expect(SessionListActionInputV1Schema.safeParse({ project: { projectKey: 'anchor' } }).success).toBe(false);
    });
    it('admits the canonical Home behind a saved local profile and still refuses another Home', async () => {
        // Session-list transport is the boundary; Action admission and projection remain real.
        const executor = createActionExecutor({ sessionList: async args => ({ sessions: [], nextCursor: null,
            hasNext: false, project: args.project }) });
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            serverId: 'local-profile', serverIdentityId: project.serverId };
        expect(await executor.execute('session.list', { project }, context))
            .toMatchObject({ ok: true, result: { project, sessions: [] } });
        expect(await executor.execute('session.list', { project: { ...project, serverId: 'foreign-home' } }, context))
            .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    });
    it('refuses a host that ignored the selection and a different Home', async () => {
        const ignored = createActionExecutor({ sessionList: async () => ({ sessions: [], nextCursor: null, hasNext: false }) } as ActionExecutorDeps);
        expect(await ignored.execute('session.list', { project }, { surface: 'ui', authority: 'present_user', serverId: 'home-a' }))
            .toMatchObject({ ok: false, errorCode: 'session_list_project_filter_unsupported' });
        expect(await ignored.execute('session.list', { project }, { surface: 'ui', authority: 'present_user', serverId: 'home-b' }))
            .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
        const admitted = createActionExecutor({ sessionList: async args => ({ sessions: [], nextCursor: null, hasNext: false,
            project: args.project }) } as ActionExecutorDeps);
        expect(await admitted.execute('session.list', { project }, { surface: 'ui', authority: 'present_user', serverId: 'home-a' }))
            .toMatchObject({ ok: true, result: { project, sessions: [] } });
    });
});

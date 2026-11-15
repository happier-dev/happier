import { describe, expect, it, vi } from 'vitest';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { applyProjectAccountRowsFixture, createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { storage } from '@/sync/domains/state/storage';
import { buildProjectPaneScopeId } from './projectPaneScope';
import { buildProjectTerminalKey, resolveProjectTerminalScope } from './projectTerminalScope';
import { DaemonTerminalEnsureRequestSchema } from '@happier-dev/protocol/daemon/terminal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { useProjectTerminalScope } from './projectTerminalScope';

describe('admitted Project terminal scope', () => {
    it('uses an exact current Account checkout and refuses path guesses or another Home', async () => {
        const serverId = 'srv_project_scope';
        const ref = { id: 'accepted', serverId, machineId: 'machine', rootPath: '/accepted', projectKey: 'project', createdAtMs: 1 };
        const checkout = { ...ref, id: 'worktree', rootPath: '/accepted-worktree' };
        const home = await serveActionHomes({ homes: [{ key: 'project', serverUrl: 'https://project-terminals.test', accountId: 'bob', serverIdentityId: serverId }],
            route: request => request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
                ? Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: [ref, checkout] }))
                : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            await vi.waitFor(() => expect(storage.getState().projectAccountRows).toMatchObject({ scope: { serverId, accountId: 'bob' }, status: 'ready', workspaceRefs: [ref, checkout] }));
            const scopeId = buildProjectPaneScopeId(ref.id, serverId, 'destination');
            const workspace = { serverId, workspaceId: checkout.id, machineId: checkout.machineId, rootPath: checkout.rootPath };
            expect(resolveProjectTerminalScope(scopeId, workspace)).toMatchObject({ workspace, scope: { serverId, accountId: 'bob' } });
            expect(resolveProjectTerminalScope(scopeId, { ...workspace, rootPath: '/guessed' })).toBeNull();
            expect(resolveProjectTerminalScope(scopeId, { ...workspace, machineId: 'guessed' })).toBeNull();
            expect(resolveProjectTerminalScope(buildProjectPaneScopeId(ref.id, 'another-home'), workspace)).toBeNull();
            const captured = resolveProjectTerminalScope(scopeId, workspace);
            let renders = 0;
            const hook = await renderHook(() => { renders++; return useProjectTerminalScope(scopeId, workspace); });
            const held = hook.getCurrent();
            const before = renders;
            await act(async () => applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref, checkout,
                { ...ref, id: 'unrelated', rootPath: '/unrelated' }] }));
            expect(hook.getCurrent()).toBe(held);
            expect(renders).toBe(before);
            const longRoot = { ...workspace, rootPath: `/${'folder/'.repeat(1000)}` };
            expect(DaemonTerminalEnsureRequestSchema.safeParse({ terminalKey: buildProjectTerminalKey(captured!.scope, longRoot, 'member'),
                workspace: longRoot, cwd: longRoot.rootPath }).success).toBe(true);
            await act(async () => storage.getState().activateProfileScope({ serverId, accountId: 'cara' }));
            expect(captured?.lifetime.isCurrent()).toBe(false);
            expect(resolveProjectTerminalScope(scopeId, workspace)).toBeNull();
            expect(hook.getCurrent()).toBeNull();
            await hook.unmount();
        } finally { await home.dispose(); }
    });
});

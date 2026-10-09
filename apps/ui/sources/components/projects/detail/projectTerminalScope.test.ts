import { describe, expect, it } from 'vitest';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { storage } from '@/sync/domains/state/storage';
import { buildProjectPaneScopeId } from './projectPaneScope';
import { buildProjectTerminalKey, resolveProjectTerminalScope } from './projectTerminalScope';
import { DaemonTerminalEnsureRequestSchema } from '@happier-dev/protocol/daemon/terminal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

describe('admitted Project terminal scope', () => {
    it('uses an exact current Account checkout and refuses path guesses or another Home', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'project', serverUrl: 'https://project-terminals.test', accountId: 'bob' }], route: () => undefined });
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const serverId = home.homes.project!.id;
            const ref = { id: 'accepted', serverId, machineId: 'machine', rootPath: '/accepted', projectKey: 'project', createdAtMs: 1 };
            const checkout = { ...ref, id: 'worktree', rootPath: '/accepted-worktree' };
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref, checkout] });
            expect(storage.getState().projectAccountRows).toMatchObject({ scope: { serverId, accountId: 'bob' }, status: 'ready', workspaceRefs: [ref, checkout] });
            const scopeId = buildProjectPaneScopeId(ref.id, serverId, 'destination');
            const workspace = { serverId, workspaceId: checkout.id, machineId: checkout.machineId, rootPath: checkout.rootPath };
            expect(resolveProjectTerminalScope(scopeId, workspace)).toMatchObject({ workspace, scope: { serverId, accountId: 'bob' } });
            expect(resolveProjectTerminalScope(scopeId, { ...workspace, rootPath: '/guessed' })).toBeNull();
            expect(resolveProjectTerminalScope(scopeId, { ...workspace, machineId: 'guessed' })).toBeNull();
            expect(resolveProjectTerminalScope(buildProjectPaneScopeId(ref.id, 'another-home'), workspace)).toBeNull();
            const captured = resolveProjectTerminalScope(scopeId, workspace);
            const longRoot = { ...workspace, rootPath: `/${'folder/'.repeat(1000)}` };
            expect(DaemonTerminalEnsureRequestSchema.safeParse({ terminalKey: buildProjectTerminalKey(captured!.scope, longRoot, 'member'),
                workspace: longRoot, cwd: longRoot.rootPath }).success).toBe(true);
            storage.getState().activateProfileScope({ serverId, accountId: 'cara' });
            expect(captured?.lifetime.isCurrent()).toBe(false);
            expect(resolveProjectTerminalScope(scopeId, workspace)).toBeNull();
        } finally { home.dispose(); }
    });
});

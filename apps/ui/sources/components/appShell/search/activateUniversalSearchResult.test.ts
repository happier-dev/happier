import { installFileFindAccountBoundaryMocks } from '@/components/appShell/panes/fileFindSeedTestHelpers';
import { describe, expect, it, vi } from 'vitest';

import { activateUniversalSearchResult } from './activateUniversalSearchResult';
import type { UniversalSearchTarget } from './universalSearchResult';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { createFileFindSeedHandoff } from '@/components/appShell/panes/fileFindSeedHandoff';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

installFileFindAccountBoundaryMocks();

async function expectSavedWorkspaceResourceOpensInProject(
    target: UniversalSearchTarget,
    initialResource: Readonly<{ kind: 'file'; path: string }> | Readonly<{ kind: 'commit'; sha: string }>,
): Promise<void> {
    const openProject = vi.fn(() => true);
    const outcome = await activateUniversalSearchResult(target, {
        navigateToSession: vi.fn(),
        push: vi.fn(),
        openProject,
    });

    expect(outcome).toEqual({ ok: true });
    expect(openProject).toHaveBeenCalledWith('wr_1', {
        activeRootPath: '/repo',
        initialResource,
    });
}

describe('activateUniversalSearchResult', () => {
    it('discards destination Find memory when navigation fails or the project disappeared', async () => {
        const handoff = createFileFindSeedHandoff();
        const scope = { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' };
        const find = { query: 'needle', options: { matchCase: false, regex: false }, target: { kind: 'file' as const, path: 'src/a.ts' } };
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected real Account lifetime');
        for (const host of ['session', 'project'] as const) {
            const destination = { host, id: 'destination-a', accountId: 'account-a', path: 'src/a.ts', scope };
            const outcome = await activateUniversalSearchResult({ kind: 'workspaceFile', path: destination.path, scope,
                workspaceRefId: host === 'project' ? destination.id : null,
                sessionId: host === 'session' ? destination.id : null, serverId: scope.serverId, accountId: destination.accountId, find }, {
                navigateToSession: async () => { throw new Error('Destination navigation failed'); },
                openProject: () => false, push: () => {}, stageFileFindSeed: () => handoff.stage(destination, find, authority),
            });
            expect(outcome).toEqual({ ok: false, reason: host === 'session' ? 'failed' : 'unavailable' });
            expect(handoff.take(destination)).toBeNull();
        }
    });
    it('hands the exact session file target to pane memory while serializing only its anchor', async () => {
        const anchor = { kind: 'fileLine' as const, startLine: 12 };
        const find = { query: 'secret query', options: { matchCase: true, regex: false }, target: { kind: 'file' as const, path: 'src/index.ts', anchor } };
        const navigateToSession = vi.fn();
        const stageFileFindSeed = vi.fn(() => () => {});
        const target = { kind: 'workspaceFile' as const, path: 'src/index.ts', anchor, find,
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' }, workspaceRefId: null,
            sessionId: 'session-a', serverId: 'home-a', accountId: 'account-a' };
        expect(await activateUniversalSearchResult(target, { navigateToSession, push: vi.fn(), openProject: () => true, stageFileFindSeed })).toEqual({ ok: true });
        expect(stageFileFindSeed).toHaveBeenCalledWith(target, find);
        const query = navigateToSession.mock.calls[0][1].query;
        expect(parseSessionPaneUrlState(query)?.details).toEqual({ kind: 'file', path: target.path, anchor });
        expect(JSON.stringify(query)).not.toContain(find.query);
    });

    it('keeps project file anchors and Find seeds on the canonical opener', async () => {
        const anchor = { kind: 'range' as const, filePath: 'src/index.ts', startLine: 12, endLine: 14 };
        const find = { query: 'needle', options: { matchCase: false, regex: false }, target: { kind: 'file' as const, path: 'src/index.ts', anchor } };
        const openProject = vi.fn(() => true);
        await activateUniversalSearchResult({ kind: 'workspaceFile', path: 'src/index.ts', anchor, anchorSource: 'diff', find,
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' }, workspaceRefId: 'wr_1',
            sessionId: null, serverId: 'home-a', accountId: 'account-a' }, { navigateToSession: vi.fn(), push: vi.fn(), openProject });
        expect(openProject).toHaveBeenCalledWith('wr_1', { activeRootPath: '/repo', initialResource: { kind: 'file', path: 'src/index.ts', anchor, anchorSource: 'diff', find } });
    });
    it('opens project results through the canonical project-opening owner', async () => {
        const push = vi.fn();
        const openProject = vi.fn(() => true);

        const outcome = await activateUniversalSearchResult({
            kind: 'project',
            workspaceRefId: 'wr_1',
            serverId: 'home-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            rootPath: '/repo',
        }, {
            navigateToSession: vi.fn(),
            push,
            openProject,
        });

        expect(outcome).toEqual({ ok: true });
        expect(openProject).toHaveBeenCalledWith('wr_1');
        expect(push).not.toHaveBeenCalled();
    });

    it('reports a project that the canonical opener can no longer resolve as unavailable', async () => {
        const outcome = await activateUniversalSearchResult({
            kind: 'project',
            workspaceRefId: 'retired',
            serverId: 'home-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            rootPath: '/gone',
        }, {
            navigateToSession: vi.fn(),
            push: vi.fn(),
            openProject: () => false,
        });

        expect(outcome).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('opens a saved workspace file through the canonical project opener without a Session', async () => {
        await expectSavedWorkspaceResourceOpensInProject({
            kind: 'workspaceFile',
            path: 'src/index.ts',
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
            workspaceRefId: 'wr_1',
            sessionId: null,
            serverId: 'home-a',
            accountId: 'account-a',
        }, { kind: 'file', path: 'src/index.ts' });
    });

    it('opens a saved workspace commit through the canonical project opener without a Session', async () => {
        await expectSavedWorkspaceResourceOpensInProject({
            kind: 'workspaceCommit',
            sha: 'abc123',
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
            workspaceRefId: 'wr_1',
            sessionId: null,
            serverId: 'home-a',
            accountId: 'account-a',
        }, { kind: 'commit', sha: 'abc123' });
    });
});

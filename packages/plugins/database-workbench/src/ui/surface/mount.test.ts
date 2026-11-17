import { expect, it } from 'vitest';
import { createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { readWorkbenchLaunchInput } from './mount.js';

it('opens Session and Project rail mounts on the same admitted checkout as Services', () => {
    const project = { kind: 'project' as const, projectKey: 'project', checkout: {
        id: 'workspace', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 0, label: null,
    } };
    for (const target of [
        { ...project, installationId: 'installation' },
        { kind: 'session' as const, sessionId: 'session', project, installationId: 'installation' },
    ]) {
        const surface = createSurfaceContextFixture({ accountScope: { accountId: 'account', serverId: 'home' }, target });
        expect(readWorkbenchLaunchInput({ surface })).toEqual({ scope: {
            kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
            workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/repo' },
        } });
    }
});

it('opens a Services checkout without requiring an explicit page launch', () => {
    const surface = createSurfaceContextFixture({
        accountScope: { accountId: 'account', serverId: 'home' },
        target: { kind: 'services', installationId: 'installation', project: {
            kind: 'project', projectKey: 'project', checkout: {
                id: 'workspace', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 0, label: null,
            },
        } },
    });
    expect(readWorkbenchLaunchInput({ surface })).toEqual({ scope: {
        kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
        workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/repo' },
    } });
    expect(readWorkbenchLaunchInput({ surface: { ...surface, target: { kind: 'services' } } })).toBeNull();
    expect(readWorkbenchLaunchInput({ surface, launchInput: {} })).toBeNull();
});

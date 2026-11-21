import { describe, expect, it } from 'vitest';
import {
    buildUniversalSearchScopeChoices,
    buildUniversalSearchScopeKeyFromSeed,
    resolveUniversalSearchRouteInitialScope,
} from './universalSearchScope';

describe('Universal Search local scope', () => {
    it('retains managed workspace identity without joining an unrelated Machine Session', () => {
        const workspace = { id: 'managed-a', v: 2 as const, kind: 'managed' as const, serverId: 'home',
            managedId: 'guest-a', controller: { machineId: 'controller', installationId: 'installation' }, rootPath: '/repo', createdAtMs: 1 };
        const choices = buildUniversalSearchScopeChoices({ accountIdByServerId: new Map([['home', 'account']]),
            profiles: [{ id: 'home', name: 'Home' }] as never,
            workspaces: [workspace, { ...workspace, id: 'managed-b', managedId: 'guest-b' }],
            sessions: [{ id: 'unrelated', serverId: 'home' }], readMachineTarget: () => null,
        });
        expect(choices[1]?.scope).toMatchObject({ accountId: 'account', serverId: 'home', machineId: 'controller',
            rootPath: '/repo', sessionId: null, workspace: { kind: 'managed', workspaceId: 'managed-a', managedId: 'guest-a',
                controller: workspace.controller, rootPath: '/repo' } });
        expect(choices[1]?.key).not.toBe(choices[2]?.key);
    });
    it('adds an all-machines scope within each credential-bound Home', () => {
        const choices = buildUniversalSearchScopeChoices({ accountIdByServerId: new Map([['home', 'account']]),
            profiles: [{ id: 'home', name: 'Home' }] as never, workspaces: [], sessions: [], readMachineTarget: () => null,
            includeAllMachines: true, allMachinesLabel: 'All machines',
        });
        expect(choices.find(choice => choice.scope.machineScope === 'all')?.scope)
            .toEqual({ accountId: 'account', serverId: 'home', sessionId: null, machineId: null, rootPath: null, machineScope: 'all' });
        expect(choices[0].key).not.toBe(choices[1].key);
    });
    it('keeps an invocation-seeded Home independent from focused Home changes', () => {
        const seed = { accountId: 'account', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null } as const;
        const key = buildUniversalSearchScopeKeyFromSeed(seed);
        expect(key).toBe(buildUniversalSearchScopeKeyFromSeed({ accountId: 'account', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }));
        expect(key).not.toBe(buildUniversalSearchScopeKeyFromSeed({ accountId: 'account', serverId: 'home-a', sessionId: null, machineId: null, rootPath: null }));
    });

    it('projects exact Home and workspace alternatives from their Account-bound targets', () => {
        const readMachineTarget = (target: { accountId: string; serverId: string; sessionId: string }) => target.sessionId === 'session-b'
            && target.accountId === 'account-b' && target.serverId === 'home-b'
            ? { machineId: 'machine-b', basePath: '/repo/b' }
            : null;
        const choices = buildUniversalSearchScopeChoices({
            accountIdByServerId: new Map([
                ['home-a', 'account-a'],
                ['home-b', 'account-b'],
            ]),
            profiles: [
                { id: 'home-a', name: 'Home A' },
                { id: 'home-b', name: 'Home B' },
            ] as never,
            workspaces: [{ id: 'workspace-b', serverId: 'home-b', machineId: 'machine-b', rootPath: '/repo/b', createdAtMs: 1 }] as never,
            sessions: [{ id: 'session-b', serverId: 'home-b' }] as never,
            readMachineTarget,
        });

        expect(choices.map((choice) => choice.scope)).toEqual([
            { accountId: 'account-a', serverId: 'home-a', machineId: null, rootPath: null, sessionId: null },
            { accountId: 'account-b', serverId: 'home-b', machineId: null, rootPath: null, sessionId: null },
            { accountId: 'account-b', serverId: 'home-b', machineId: 'machine-b', rootPath: '/repo/b', sessionId: 'session-b' },
        ]);
    });

    it('names a workspace scope by its project name, never its absolute path', () => {
        const choices = buildUniversalSearchScopeChoices({
            accountIdByServerId: new Map([['home-a', 'account-a']]),
            profiles: [{ id: 'home-a', name: 'Home A' }] as never,
            workspaces: [
                { id: 'unnamed', serverId: 'home-a', machineId: 'machine-a', rootPath: '/home/leeroy/code/happier', createdAtMs: 1 },
                { id: 'named', serverId: 'home-a', machineId: 'machine-a', rootPath: '/home/leeroy/code/site', label: 'Marketing site', createdAtMs: 1 },
            ] as never,
            sessions: [],
            readMachineTarget: () => null,
        });

        expect(choices.slice(1).map((choice) => choice.label)).toEqual(['happier', 'Marketing site']);
    });

    it('omits Home and workspace alternatives whose exact credential Account cannot be resolved', () => {
        const choices = buildUniversalSearchScopeChoices({
            accountIdByServerId: new Map([['home-a', 'account-a']]),
            profiles: [
                { id: 'home-a', name: 'Home A' },
                { id: 'home-b', name: 'Home B' },
            ] as never,
            workspaces: [
                { id: 'workspace-a', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo/a', createdAtMs: 1 },
                { id: 'workspace-b', serverId: 'home-b', machineId: 'machine-b', rootPath: '/repo/b', createdAtMs: 1 },
            ] as never,
            sessions: [],
            readMachineTarget: () => null,
        });

        expect(choices.map((choice) => choice.scope.serverId)).toEqual(['home-a', 'home-a']);
        expect(choices.every((choice) => choice.scope.accountId === 'account-a')).toBe(true);
    });

    it('changes the resolver identity for an exact workspace transition so stale dynamic work is fenced', () => {
        const before = buildUniversalSearchScopeKeyFromSeed({ accountId: 'account-b', serverId: 'home-b', machineId: 'machine-b', rootPath: '/repo/one', sessionId: 's1' });
        const after = buildUniversalSearchScopeKeyFromSeed({ accountId: 'account-b', serverId: 'home-b', machineId: 'machine-b', rootPath: '/repo/two', sessionId: 's1' });
        expect(after).not.toBe(before);
    });

    it('uses portable server identity for Home and workspace choices while accepting stored local profile ids', () => {
        const choices = buildUniversalSearchScopeChoices({
            accountIdByServerId: new Map([['srv-home-a', 'account-a']]),
            profiles: [{
                id: 'local-profile-a',
                serverIdentityId: 'srv-home-a',
                name: 'Home A',
            }] as never,
            workspaces: [{
                id: 'workspace-a',
                serverId: 'local-profile-a',
                machineId: 'machine-a',
                rootPath: '/repo/a',
                createdAtMs: 1,
            }] as never,
            sessions: [{ id: 'session-a', serverId: 'local-profile-a' }] as never,
            readMachineTarget: () => ({ machineId: 'machine-a', basePath: '/repo/a' }),
        });

        expect(choices.map((choice) => choice.scope)).toEqual([
            { accountId: 'account-a', serverId: 'srv-home-a', machineId: null, rootPath: null, sessionId: null },
            { accountId: 'account-a', serverId: 'srv-home-a', machineId: 'machine-a', rootPath: '/repo/a', sessionId: 'session-a' },
        ]);
    });

    it('leaves an unscoped direct route ambient while preserving partial and explicit-empty scopes', () => {
        expect(resolveUniversalSearchRouteInitialScope({})).toBeUndefined();
        expect(resolveUniversalSearchRouteInitialScope({ serverId: 'home-b' })).toEqual({
            accountId: null,
            serverId: 'home-b',
            sessionId: null,
            machineId: null,
            rootPath: null,
        });
        expect(resolveUniversalSearchRouteInitialScope({
            accountId: '',
            serverId: '',
            sessionId: '',
            machineId: '',
            rootPath: '',
        })).toEqual({
            accountId: null,
            serverId: null,
            sessionId: null,
            machineId: null,
            rootPath: null,
        });
        expect(resolveUniversalSearchRouteInitialScope({ serverId: ['home-a', 'home-b'] })).toEqual({
            accountId: null,
            serverId: null,
            sessionId: null,
            machineId: null,
            rootPath: null,
        });
    });

    it('does not reinterpret a malformed managed route as a controller filesystem scope', () => {
        expect(resolveUniversalSearchRouteInitialScope({ accountId: 'account', serverId: 'home', sessionId: 'session',
            machineId: 'controller', rootPath: '/repo', workspace: '{invalid' })).toMatchObject({
            machineId: null, rootPath: null, sessionId: null,
        });
    });
});

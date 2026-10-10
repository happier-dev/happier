import { describe, expect, it } from 'vitest';

import type { WorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';

import { isUniversalSearchTargetCurrent } from './isUniversalSearchTargetCurrent';
import type { UniversalSearchTarget } from './universalSearchResult';

describe('isUniversalSearchTargetCurrent', () => {
    it('rejects duplicate saved checkout candidates before project or file activation', () => {
        const scope = { serverId: 'home', machineId: 'machine', rootPath: '/repo' };
        const ref = { id: 'workspace', ...scope, createdAtMs: 1 };
        const base = { accountScope: { serverId: 'home', accountId: 'account', current: true },
            workspaces: [ref, { ...ref }], settingsPages: new Map(),
            resolveSessionWorkspaceTarget: () => null, isWorkspaceScopeReachable: () => true };
        expect(isUniversalSearchTargetCurrent({ ...base, target: { kind: 'project', ...scope,
            workspaceRefId: 'workspace', accountId: 'account' } })).toBe(false);
        expect(isUniversalSearchTargetCurrent({ ...base, target: { kind: 'workspaceFile', scope, path: 'README.md',
            workspaceRefId: 'workspace', serverId: 'home', accountId: 'account', sessionId: null } })).toBe(false);
    });
    it('keeps an exact scoped transcript target current when its session is not hydrated', () => {
        expect(isUniversalSearchTargetCurrent({
            target: { kind: 'session', serverId: 'home-b', accountId: 'account-b', sessionId: 'archived-unloaded', seq: 42 },
            accountScope: { serverId: 'home-b', accountId: 'account-b', current: true },
            workspaces: [],
            settingsPages: new Map(),
            resolveSessionWorkspaceTarget: () => null,
            isWorkspaceScopeReachable: () => true,
        })).toBe(true);
    });

    it('rejects the same unloaded result after its producing Home scope retires', () => {
        expect(isUniversalSearchTargetCurrent({
            target: { kind: 'session', serverId: 'home-b', accountId: 'account-b', sessionId: 'archived-unloaded' },
            accountScope: { serverId: 'home-a', accountId: 'account-a', current: true },
            workspaces: [],
            settingsPages: new Map(),
            resolveSessionWorkspaceTarget: () => null,
            isWorkspaceScopeReachable: () => true,
        })).toBe(false);
    });

    it.each(['workspaceFile', 'workspaceCommit'] as const)(
        're-resolves an ordinary session before activating a %s target',
        (kind) => {
            const target: UniversalSearchTarget = kind === 'workspaceFile'
                ? {
                    kind,
                    scope: { serverId: 'server-a', machineId: 'machine-a', rootPath: 'C:\\Repo\\' },
                    path: 'C:\\Repo\\src\\index.ts',
                    workspaceRefId: null,
                    sessionId: 'session-a',
                    serverId: 'server-a',
                    accountId: 'account-a',
                }
                : {
                    kind,
                    scope: { serverId: 'server-a', machineId: 'machine-a', rootPath: 'C:\\Repo\\' },
                    sha: 'abc123',
                    workspaceRefId: null,
                    sessionId: 'session-a',
                    serverId: 'server-a',
                    accountId: 'account-a',
                };
            const originalScope: WorkspaceTargetForSession = {
                serverId: 'server-a',
                machineId: 'machine-a',
                rootPath: 'c:/repo',
                workspaceCacheKey: 'server-a:machine-a:c:/repo',
            };
            let currentScope: WorkspaceTargetForSession | null = originalScope;
            let reachable = true;
            const isCurrent = () => isUniversalSearchTargetCurrent({
                target,
                accountScope: { serverId: 'server-a', accountId: 'account-a', current: true },
                workspaces: [],
                settingsPages: new Map(),
                resolveSessionWorkspaceTarget: () => currentScope,
                isWorkspaceScopeReachable: () => reachable,
            });

            expect(isCurrent()).toBe(true);

            for (const staleScope of [
                { ...originalScope, serverId: 'server-b' },
                { ...originalScope, machineId: 'machine-b' },
                { ...originalScope, rootPath: 'c:/other-repo' },
            ]) {
                currentScope = staleScope;
                expect(isCurrent()).toBe(false);
            }

            currentScope = null;
            expect(isCurrent()).toBe(false);

            currentScope = originalScope;
            reachable = false;
            expect(isCurrent()).toBe(false);
        },
    );

    it('keeps a settings search result current while its page is offered, including one row on it', () => {
        const settingsPages = new Map([
            ['settings', { id: 'settings', route: '/settings' } as never],
            ['appearance', { id: 'appearance', route: '/settings/appearance' } as never],
            ['session', { id: 'session', route: '/settings/session' } as never],
        ]);
        const check = (route: string) => isUniversalSearchTargetCurrent({
            target: { kind: 'settingsPage', route },
            accountScope: null,
            workspaces: [],
            settingsPages,
            resolveSessionWorkspaceTarget: () => null,
            isWorkspaceScopeReachable: () => true,
        });
        expect(check('/settings/appearance')).toBe(true);
        expect(check('/settings/appearance?setting=appearance.density')).toBe(true);
        // A row on a sub-page opens that sub-page, under its catalog page.
        expect(check('/settings/session/runtime?setting=session.runtime.tmux')).toBe(true);
        // A page that is no longer offered is not reached through the Overview's route.
        expect(check('/settings/pets?setting=pets.enabled')).toBe(false);
    });

    it('keeps project currentness owned by workspace refs', () => {
        expect(isUniversalSearchTargetCurrent({
            target: {
                kind: 'project',
                workspaceRefId: 'workspace-a',
                serverId: 'server-a',
                accountId: 'account-a',
                machineId: 'machine-a',
                rootPath: 'C:\\Repo\\',
            },
            accountScope: { serverId: 'server-a', accountId: 'account-a', current: true },
            workspaces: [{
                id: 'workspace-a',
                serverId: 'server-a',
                machineId: 'machine-a',
                rootPath: 'c:/repo',
                label: null,
                createdAtMs: 1,
                lastOpenedAtMs: null,
            }],
            settingsPages: new Map(),
            resolveSessionWorkspaceTarget: () => {
                throw new Error('project currentness must not resolve a session target');
            },
            isWorkspaceScopeReachable: () => true,
        })).toBe(true);
    });

    it('rejects a saved project when its Account lifetime or machine reachability retires', () => {
        const target: UniversalSearchTarget = {
            kind: 'project',
            workspaceRefId: 'workspace-a',
            serverId: 'server-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            rootPath: '/repo',
        };
        const workspaces = [{
            id: 'workspace-a',
            serverId: 'server-a',
            machineId: 'machine-a',
            rootPath: '/repo',
            label: null,
            createdAtMs: 1,
            lastOpenedAtMs: null,
        }];
        const isCurrent = (accountScope: { serverId: string; accountId: string; current: boolean } | null, reachable: boolean) => (
            isUniversalSearchTargetCurrent({
                target,
                accountScope,
                workspaces,
                settingsPages: new Map(),
                resolveSessionWorkspaceTarget: () => null,
                isWorkspaceScopeReachable: () => reachable,
            })
        );

        expect(isCurrent(null, true)).toBe(false);
        expect(isCurrent({ serverId: 'server-b', accountId: 'account-a', current: true }, true)).toBe(false);
        expect(isCurrent({ serverId: 'server-a', accountId: 'account-b', current: true }, true)).toBe(false);
        expect(isCurrent({ serverId: 'server-a', accountId: 'account-a', current: false }, true)).toBe(false);
        expect(isCurrent({ serverId: 'server-a', accountId: 'account-a', current: true }, false)).toBe(false);
    });

    it('keeps a saved workspace file current without requiring a Session', () => {
        expect(isUniversalSearchTargetCurrent({
            target: {
                kind: 'workspaceFile',
                scope: { serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' },
                path: 'README.md',
                workspaceRefId: 'workspace-a',
                sessionId: null,
                serverId: 'server-a',
                accountId: 'account-a',
            },
            accountScope: { serverId: 'server-a', accountId: 'account-a', current: true },
            workspaces: [{
                id: 'workspace-a',
                serverId: 'server-a',
                machineId: 'machine-a',
                rootPath: '/repo',
                label: null,
                createdAtMs: 1,
                lastOpenedAtMs: null,
            }],
            settingsPages: new Map(),
            resolveSessionWorkspaceTarget: () => {
                throw new Error('saved workspace currentness must not require a Session');
            },
            isWorkspaceScopeReachable: () => true,
        })).toBe(true);
    });

    it('rejects a saved workspace target when its exact machine binding is no longer reachable', () => {
        expect(isUniversalSearchTargetCurrent({
            target: {
                kind: 'workspaceCommit',
                scope: { serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' },
                sha: 'abc123',
                workspaceRefId: 'workspace-a',
                sessionId: null,
                serverId: 'server-a',
                accountId: 'account-a',
            },
            accountScope: { serverId: 'server-a', accountId: 'account-a', current: true },
            workspaces: [{
                id: 'workspace-a',
                serverId: 'server-a',
                machineId: 'machine-a',
                rootPath: '/repo',
                label: null,
                createdAtMs: 1,
                lastOpenedAtMs: null,
            }],
            settingsPages: new Map(),
            resolveSessionWorkspaceTarget: () => null,
            isWorkspaceScopeReachable: () => false,
        })).toBe(false);
    });
});

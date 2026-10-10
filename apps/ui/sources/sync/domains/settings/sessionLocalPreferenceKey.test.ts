import { describe, expect, it } from 'vitest';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { buildRealmQualifiedMobileSurfaceStorageKey, resolveProjectMobileSurfaceStorageKey } from './mobileSurfacePersistence';
import {
    buildRealmQualifiedSessionLocalPreferenceKey,
    resolveSessionLocalPreferenceRealm,
} from './sessionLocalPreferenceKey';

const scope: ServerAccountScope = { serverId: 'https://home.one', accountId: 'account-1' };

describe('sessionLocalPreferenceKey', () => {
    it('binds Project page preference lookup to the selected registered Home and the applied Account realm', () => {
        const first = { id: 'project', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
        const other = { ...first, serverId: 'https://home.two' };
        const input = { workspaceRefs: [first, other], workspaceRefId: first.id, activeScope: scope, activeServerId: scope.serverId };
        expect(resolveProjectMobileSurfaceStorageKey({ ...input, targetServerId: first.serverId })).toBe(
            buildRealmQualifiedMobileSurfaceStorageKey('project', scope, first.id));
        expect(resolveProjectMobileSurfaceStorageKey(input)).toBeNull();
        expect(resolveProjectMobileSurfaceStorageKey({ ...input, targetServerId: other.serverId })).toBeNull();
        expect(resolveProjectMobileSurfaceStorageKey({ ...input, workspaceRefs: [first, first], targetServerId: first.serverId })).toBeNull();
    });
    it('keeps the mobile surface key bytes it was extracted from', () => {
        expect(buildRealmQualifiedMobileSurfaceStorageKey('session', scope, 'session-1')).toBe(
            buildRealmQualifiedSessionLocalPreferenceKey({
                prefix: 'mobile-surface-selection:v2',
                kind: 'session',
                scope,
                ownerId: 'session-1',
            }),
        );
        expect(buildRealmQualifiedMobileSurfaceStorageKey('session', scope, 'session-1')).toBe(
            'mobile-surface-selection:v2:session:16:https://home.one9:account-1:9:session-1',
        );
    });

    it('separates the same Session id across Homes, Accounts and preference families', () => {
        const key = (input: Readonly<{ prefix: string; scope: ServerAccountScope }>) => (
            buildRealmQualifiedSessionLocalPreferenceKey({
                prefix: input.prefix,
                kind: 'session',
                scope: input.scope,
                ownerId: 'session-1',
            })
        );
        const base = key({ prefix: 'session-companion:v1', scope });
        const otherHome = key({ prefix: 'session-companion:v1', scope: { ...scope, serverId: 'https://home.two' } });
        const otherAccount = key({ prefix: 'session-companion:v1', scope: { ...scope, accountId: 'account-2' } });
        const otherFamily = key({ prefix: 'mobile-surface-selection:v2', scope });

        expect(new Set([base, otherHome, otherAccount, otherFamily]).size).toBe(4);
    });

    it('length-prefixes the owner id so adjacent identities cannot collide', () => {
        const first = buildRealmQualifiedSessionLocalPreferenceKey({
            prefix: 'session-companion:v1', kind: 'session', scope, ownerId: 'a:b',
        });
        const second = buildRealmQualifiedSessionLocalPreferenceKey({
            prefix: 'session-companion:v1', kind: 'session', scope, ownerId: 'a',
        });

        expect(first).not.toBe(second);
        expect(first?.startsWith(second!.slice(0, second!.lastIndexOf(':1:')))).toBe(true);
    });

    it('refuses a key when the owner id is blank', () => {
        expect(buildRealmQualifiedSessionLocalPreferenceKey({
            prefix: 'session-companion:v1', kind: 'session', scope, ownerId: '   ',
        })).toBeNull();
    });

    it('refuses to resolve a realm the active Account and Home cannot prove', () => {
        expect(resolveSessionLocalPreferenceRealm({
            activeScope: scope,
            activeServerId: 'https://home.one',
            targetServerId: 'https://home.two',
        })).toBeNull();
        expect(resolveSessionLocalPreferenceRealm({
            activeScope: null,
            activeServerId: 'https://home.one',
            targetServerId: 'https://home.one',
        })).toBeNull();
        expect(resolveSessionLocalPreferenceRealm({
            activeScope: scope,
            activeServerId: 'https://home.one',
            targetServerId: null,
        })).toBeNull();
        expect(resolveSessionLocalPreferenceRealm({
            activeScope: scope,
            activeServerId: 'https://home.one',
            targetServerId: 'https://home.one',
        })).toEqual(scope);
    });
});

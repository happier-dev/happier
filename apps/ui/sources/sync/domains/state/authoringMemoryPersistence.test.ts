import { beforeEach, describe, expect, it } from 'vitest';

import {
    accountSettingsScopeKeySuffix,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import { getPersistenceStorage } from './persistenceStorage';
import { loadAuthoringMemoryProjection, saveAuthoringMemoryProjection } from './authoringMemoryPersistence';

function persistedKey(scope: AccountSettingsScope): string {
    return `authoring-memory:v1:${accountSettingsScopeKeySuffix(scope)}`;
}

const scope = { serverId: 'home-a', accountId: 'account-a' };
function values(profile: string | null = 'profile-a') {
    return {
        recentMachinePaths: [{ machineId: 'machine-a', path: '/projects/one' }],
        lastUsedProfile: profile,
        lastEngineSelectionsByScopeV1: {
            'home-a:backend:future.agent': { futureCarrier: { opaque: [1, null, false] }, updatedAt: 3 },
        },
    };
}

describe('authoring-memory local projection', () => {
    beforeEach(() => getPersistenceStorage().clearAll());

    it('reloads the persisted snapshot with opaque selections after the caller discards or changes its in-memory values', () => {
        const initial = values();
        saveAuthoringMemoryProjection(scope, initial);
        const expected = values();
        initial.recentMachinePaths[0]!.path = '/changed-in-memory';
        initial.lastUsedProfile = 'changed-in-memory';
        expect(loadAuthoringMemoryProjection(scope)).toEqual(expected);
        expect(loadAuthoringMemoryProjection(scope)).toEqual(expected);
    });

    it('separates the same Account on another Home, another Account on the same Home, and delimiter-shaped scope identities', () => {
        const scopes = [
            scope,
            { serverId: 'home-b', accountId: scope.accountId },
            { serverId: scope.serverId, accountId: 'account-b' },
            { serverId: 'home:account', accountId: 'other' },
            { serverId: 'home', accountId: 'account:other' },
        ];
        expect(loadAuthoringMemoryProjection(scope)).toBeNull();
        for (const [index, current] of scopes.entries()) saveAuthoringMemoryProjection(current, values(`profile-${index}`));
        for (const [index, current] of scopes.entries()) expect(loadAuthoringMemoryProjection(current)).toEqual(values(`profile-${index}`));
    });

    it.each([
        '{',
        JSON.stringify({ ...values(), recentMachinePaths: [{ machineId: 'machine-a', path: '/valid' }, { machineId: 3, path: '/invalid' }] }),
        JSON.stringify({ ...values(), lastUsedProfile: { invalid: true } }),
        JSON.stringify({ recentMachinePaths: [], lastUsedProfile: null }),
    ])('ignores a malformed projection as a whole without exposing otherwise valid fields', (raw) => {
        getPersistenceStorage().set(persistedKey(scope), raw);
        expect(loadAuthoringMemoryProjection(scope)).toBeNull();
    });

    it('loads known persisted fields and opaque engine data while dropping additive projection fields', () => {
        getPersistenceStorage().set(persistedKey(scope), JSON.stringify({
            ...values(), futureProjectionField: { extra: true },
            recentMachinePaths: [{ ...values().recentMachinePaths[0], futurePathField: true }],
        }));
        expect(loadAuthoringMemoryProjection(scope)).toEqual(values());
    });
});

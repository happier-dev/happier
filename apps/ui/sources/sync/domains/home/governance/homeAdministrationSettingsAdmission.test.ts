import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import type { HomeGovernanceProjectionV1 } from '@happier-dev/protocol/home/governance';
import { describe, expect, it } from 'vitest';

import {
    resolveHomeAdministrationSettingsAdmission,
    type HomeAdministrationHomeObservation,
} from './homeAdministrationSettingsAdmission';

function projection(overrides?: Partial<HomeGovernanceProjectionV1>): HomeGovernanceProjectionV1 {
    return homeGovernanceProjectionFixture({
        viewer: { accountId: 'viewer', homeRole: 'owner', status: 'active' },
        activeOwnerCount: 1,
        ...overrides,
    });
}

function observation(
    overrides?: Partial<HomeAdministrationHomeObservation>,
): HomeAdministrationHomeObservation {
    return {
        scope: 'bound',
        projection: projection(),
        error: null,
        stale: false,
        ...overrides,
    };
}

describe('resolveHomeAdministrationSettingsAdmission', () => {
    it('admits an ownerless Home from its typed setup-required refusal without a projection', () => {
        expect(resolveHomeAdministrationSettingsAdmission({
            serverIds: ['home-a'],
            observationsByServerId: {
                'home-a': {
                    scope: 'bound',
                    projection: null,
                    stale: false,
                    error: {
                        kind: 'forbidden',
                        retryable: false,
                        code: 'home_governance_setup_required',
                    },
                },
            },
        })).toMatchObject({
            admitted: true,
            homes: [{ serverId: 'home-a', state: 'admitted', reason: 'owner_setup_required' }],
        });
    });

    it('admits the Homes whose own projection grants administration and reports why', () => {
        const admission = resolveHomeAdministrationSettingsAdmission({
            serverIds: ['home-a', 'home-b'],
            observationsByServerId: {
                'home-a': observation(),
                'home-b': observation({
                    projection: projection({
                        capabilities: { ...projection().capabilities, viewAdministration: false },
                        setupState: 'setup_required',
                    }),
                }),
            },
        });

        expect(admission.admitted).toBe(true);
        expect(admission.admittedServerIds).toEqual(['home-a', 'home-b']);
        expect(admission.homes).toEqual([
            { serverId: 'home-a', state: 'admitted', reason: 'capability' },
            { serverId: 'home-b', state: 'admitted', reason: 'owner_setup_required' },
        ]);
    });

    it('denies a Home whose viewer has no administration authority without hiding capable siblings', () => {
        const admission = resolveHomeAdministrationSettingsAdmission({
            serverIds: ['home-a', 'home-b'],
            observationsByServerId: {
                'home-a': observation({
                    projection: projection({
                        viewer: { accountId: 'viewer', homeRole: 'member', status: 'active' },
                        capabilities: { ...projection().capabilities, viewAdministration: false },
                    }),
                }),
                'home-b': observation(),
            },
        });

        expect(admission.admitted).toBe(true);
        expect(admission.admittedServerIds).toEqual(['home-b']);
        expect(admission.homes[0]).toEqual({ serverId: 'home-a', state: 'denied' });
    });

    it('keeps a Home that has not answered unresolved rather than admitting or denying it', () => {
        const admission = resolveHomeAdministrationSettingsAdmission({
            serverIds: ['home-a'],
            observationsByServerId: {
                'home-a': observation({ projection: null }),
            },
        });

        expect(admission.admitted).toBe(false);
        expect(admission.unresolvedServerIds).toEqual(['home-a']);
        expect(admission.homes[0]).toEqual({ serverId: 'home-a', state: 'unresolved', reason: 'loading' });
    });

    it('separates a Home this device is signed out of from one it never saved', () => {
        const admission = resolveHomeAdministrationSettingsAdmission({
            serverIds: ['home-a', 'home-b'],
            observationsByServerId: {
                'home-a': observation({ scope: 'signed_out', projection: null }),
                'home-b': observation({ scope: 'unknown_home', projection: null }),
            },
        });

        expect(admission.homes).toEqual([
            { serverId: 'home-a', state: 'unresolved', reason: 'signed_out' },
            { serverId: 'home-b', state: 'unresolved', reason: 'unknown_home' },
        ]);
    });

    it('treats an unreachable Home as unresolved but a settled refusal as denied', () => {
        const admission = resolveHomeAdministrationSettingsAdmission({
            serverIds: ['offline', 'refused', 'older'],
            observationsByServerId: {
                offline: observation({
                    projection: null,
                    error: { kind: 'unreachable', retryable: true },
                }),
                refused: observation({
                    projection: null,
                    error: { kind: 'forbidden', retryable: false },
                }),
                older: observation({
                    projection: null,
                    error: { kind: 'unsupported', retryable: false },
                }),
            },
        });

        expect(admission.homes).toEqual([
            { serverId: 'offline', state: 'unresolved', reason: 'unreachable' },
            { serverId: 'refused', state: 'denied' },
            { serverId: 'older', state: 'denied' },
        ]);
    });

    it('keeps deciding from a retained projection when the Home went stale', () => {
        const admission = resolveHomeAdministrationSettingsAdmission({
            serverIds: ['home-a'],
            observationsByServerId: {
                'home-a': observation({
                    stale: true,
                    error: { kind: 'unreachable', retryable: true },
                }),
            },
        });

        // Losing the connection does not remove an administrator's authority, so
        // the destination stays offered and the screen explains the staleness.
        expect(admission.homes[0]).toEqual({ serverId: 'home-a', state: 'admitted', reason: 'capability' });
    });

    it('stops offering a Home that refused after it had already answered', () => {
        // A retained projection survives an offline Home, but not the Home
        // saying this account may not administer it. Offering the destination
        // from a withdrawn authority would be a false promise.
        for (const kind of ['forbidden', 'unauthorized', 'unsupported'] as const) {
            const admission = resolveHomeAdministrationSettingsAdmission({
                serverIds: ['home-a'],
                observationsByServerId: {
                    'home-a': observation({ stale: true, error: { kind, retryable: false } }),
                },
            });
            expect(admission.homes[0]).toEqual({ serverId: 'home-a', state: 'denied' });
            expect(admission.admitted).toBe(false);
        }
    });

    it('keeps offering a Home whose answer was merely malformed or unclassified', () => {
        for (const kind of ['invalid', 'unknown'] as const) {
            const admission = resolveHomeAdministrationSettingsAdmission({
                serverIds: ['home-a'],
                observationsByServerId: {
                    'home-a': observation({ stale: true, error: { kind, retryable: false } }),
                },
            });
            expect(admission.homes[0]).toEqual({
                serverId: 'home-a',
                state: 'admitted',
                reason: 'capability',
            });
        }
    });

    it('never admits a Home whose observation is missing entirely', () => {
        const admission = resolveHomeAdministrationSettingsAdmission({
            serverIds: ['home-a'],
            observationsByServerId: {},
        });

        expect(admission.admitted).toBe(false);
        expect(admission.homes[0]).toEqual({ serverId: 'home-a', state: 'unresolved', reason: 'loading' });
    });

    it('deduplicates and drops blank Home ids so one Home cannot be counted twice', () => {
        const admission = resolveHomeAdministrationSettingsAdmission({
            serverIds: ['home-a', ' home-a ', '   '],
            observationsByServerId: { 'home-a': observation() },
        });

        expect(admission.homes).toHaveLength(1);
        expect(admission.admittedServerIds).toEqual(['home-a']);
    });
});

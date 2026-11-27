import { beforeEach, describe, expect, it } from 'vitest';

import { createMachineFixture, createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { publishMachineActivity } from '@/sync/domains/machines/machineActivity';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';

import {
    resolveConnectedServiceRecoveryCreditMachineTarget,
} from './useConnectedServiceRecoveryCreditMachineTarget';

// Released V3 account-surface scalar id and its canonical qualified binding key.
const CODEX_LEGACY_SERVICE_ID = 'openai-codex';
const CODEX_SERVICE_KEY = 'happier.agent.codex/openai-codex';
const EXTERNAL_SERVICE_KEY = 'acme.novel.accounts/work-cloud';
const NOVEL_SERVICE_ID = 'reviewer-service';

function machine(id: string, active = true): Machine {
    const row = createMachineFixture({
        id,
        active,
        activeAt: Date.now(),
        presenceProtocolVersion: 1,
        metadata: createMachineMetadataFixture({ host: id }),
    });
    publishMachineActivity(row, { active: row.active, activeAt: row.activeAt }, []);
    return row;
}

function session(params: Readonly<{
    id: string;
    machineId: string;
    serviceId: string;
    binding: unknown;
    /** Canonical current writers emit `2`; released sessions still carry `1`. */
    bindingsVersion?: 1 | 2;
}>): Session {
    return {
        id: params.id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            agentId: 'codex',
            flavor: 'codex',
            host: params.machineId,
            machineId: params.machineId,
            path: '/repo',
            connectedServices: {
                v: params.bindingsVersion ?? 1,
                bindingsByServiceId: {
                    [params.serviceId]: params.binding,
                },
            },
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

describe('connected-service machine targeting', () => {
    beforeEach(() => clearMachineRequestReachabilityForTest());

    it('does not offer a request-unreachable, replaced, or locked profile owner for recovery credit', () => {
        for (const owner of [machine('owner'), { ...machine('owner'), replacedByMachineId: 'replacement' },
            { ...machine('owner'), metadata: null, availability: { kind: 'locked', reason: 'decryption_failed' } as const }]) {
            clearMachineRequestReachabilityForTest();
            if (owner.metadata && !('replacedByMachineId' in owner)) {
                recordMachineRequestFailed({ serverId: 'home-a', accountId: 'recovery-account', machineId: owner.id });
            }
            expect(resolveConnectedServiceRecoveryCreditMachineTarget({
                accountScope: { serverId: 'home-a', accountId: 'recovery-account' },
                serviceId: CODEX_LEGACY_SERVICE_ID,
                profileId: 'work',
                sessions: [session({ id: 'bound', machineId: owner.id, serviceId: CODEX_SERVICE_KEY,
                    binding: { source: 'connected', selection: 'profile', profileId: 'work' } })],
                machines: [owner, machine('unbound')],
                connectedServicesV2: [],
            })).toBeNull();
        }
    });

    it('keeps the same Machine id reachable on a different Home', () => {
        const owner = machine('owner');
        recordMachineRequestFailed({ serverId: 'home-b', accountId: 'recovery-account', machineId: owner.id });
        expect(resolveConnectedServiceRecoveryCreditMachineTarget({
            accountScope: { serverId: 'home-a', accountId: 'recovery-account' }, serviceId: CODEX_LEGACY_SERVICE_ID, profileId: 'work',
            sessions: [session({ id: 'bound', machineId: owner.id, serviceId: CODEX_SERVICE_KEY,
                binding: { source: 'connected', selection: 'profile', profileId: 'work' } })],
            machines: [owner], connectedServicesV2: [],
        })).toBe(owner.id);
    });
    it.each([
        [CODEX_LEGACY_SERVICE_ID, CODEX_SERVICE_KEY, 1],
        [EXTERNAL_SERVICE_KEY, EXTERNAL_SERVICE_KEY, 2],
    ] as const)('resolves the session-bound profile owner for %s', (serviceId, serviceKey, bindingsVersion) => {
        expect(resolveConnectedServiceRecoveryCreditMachineTarget({
            accountScope: { serverId: 'home-a', accountId: 'recovery-account' },
            serviceId,
            profileId: 'work',
            sessions: [
                session({
                    id: 'unrelated',
                    machineId: 'machine-arbitrary',
                    serviceId: serviceKey,
                    bindingsVersion,
                    binding: { source: 'connected', selection: 'profile', profileId: 'personal' },
                }),
                session({
                    id: 'owner',
                    machineId: 'machine-owner',
                    serviceId: serviceKey,
                    bindingsVersion,
                    binding: { source: 'connected', selection: 'profile', profileId: 'work' },
                }),
            ],
            machines: [machine('machine-arbitrary'), machine('machine-owner')],
            connectedServicesV2: [],
        })).toBe('machine-owner');
    });

    it('resolves a group-bound owner through the released V2 group facts after qualified resolution', () => {
        expect(resolveConnectedServiceRecoveryCreditMachineTarget({
            accountScope: { serverId: 'home-a', accountId: 'recovery-account' },
            serviceId: CODEX_LEGACY_SERVICE_ID,
            profileId: 'oncall',
            sessions: [
                session({
                    id: 'pool-owner',
                    machineId: 'machine-pool',
                    serviceId: CODEX_SERVICE_KEY,
                    binding: {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'pool-1',
                    },
                }),
            ],
            machines: [machine('machine-pool')],
            connectedServicesV2: [{
                serviceId: CODEX_LEGACY_SERVICE_ID,
                profiles: [
                    { profileId: 'work', status: 'connected', kind: null, providerEmail: null, providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null },
                    { profileId: 'oncall', status: 'connected', kind: null, providerEmail: null, providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null },
                ],
                groups: [{
                    groupId: 'pool-1',
                    displayName: 'Codex pool',
                    activeProfileId: 'oncall',
                    generation: 1,
                    memberProfileIds: ['work', 'oncall'],
                }],
            }],
        })).toBe('machine-pool');
    });

    it('fails closed for a service without a canonical qualified binding key', () => {
        expect(resolveConnectedServiceRecoveryCreditMachineTarget({
            accountScope: { serverId: 'home-a', accountId: 'recovery-account' },
            serviceId: NOVEL_SERVICE_ID,
            profileId: 'work',
            sessions: [
                session({
                    id: 'owner',
                    machineId: 'machine-owner',
                    serviceId: NOVEL_SERVICE_ID,
                    binding: { source: 'connected', selection: 'profile', profileId: 'work' },
                }),
            ],
            machines: [machine('machine-owner')],
            connectedServicesV2: [],
        })).toBeNull();
    });

    it('does not treat a Team resource selection as a personal profile binding', () => {
        expect(resolveConnectedServiceRecoveryCreditMachineTarget({
            accountScope: { serverId: 'home-a', accountId: 'recovery-account' },
            serviceId: CODEX_LEGACY_SERVICE_ID,
            profileId: 'work',
            sessions: [
                session({
                    id: 'team-bound',
                    machineId: 'machine-team',
                    serviceId: CODEX_SERVICE_KEY,
                    bindingsVersion: 2,
                    binding: {
                        source: 'team_resource',
                        resourceId: 'pool-resource',
                        deliveryMode: 'direct',
                        // Same spelling as the personal profile id above: the
                        // disclosed member is a Team account ref, so matching on
                        // it would credit another Account's resource.
                        disclosedMember: {
                            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                            accountId: 'work',
                        },
                    },
                }),
            ],
            machines: [machine('machine-team')],
            connectedServicesV2: [],
        })).toBeNull();
    });

    it('reports no bound session when no active session carries the qualified binding', () => {
        expect(resolveConnectedServiceRecoveryCreditMachineTarget({
            accountScope: { serverId: 'home-a', accountId: 'recovery-account' },
            serviceId: CODEX_LEGACY_SERVICE_ID,
            profileId: 'work',
            sessions: [
                session({
                    id: 'unrelated',
                    machineId: 'machine-arbitrary',
                    serviceId: CODEX_SERVICE_KEY,
                    binding: { source: 'connected', selection: 'profile', profileId: 'personal' },
                }),
            ],
            machines: [machine('machine-arbitrary')],
            connectedServicesV2: [],
        })).toBeNull();
    });
});

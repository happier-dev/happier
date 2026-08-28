import { describe, expect, it } from 'vitest';

import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { Machine, Session } from '@/sync/domains/state/storageTypes';

import {
    resolveConnectedServiceRecoveryCreditMachineTarget,
} from './useConnectedServiceRecoveryCreditMachineTarget';

// Released V3 account-surface scalar id and its canonical qualified binding key.
const CODEX_LEGACY_SERVICE_ID = 'openai-codex';
const CODEX_SERVICE_KEY = 'happier.agent.codex/openai-codex';
// Novel external plugin service: no bundled enum member, no generated legacy
// mapping, and therefore no canonical binding key. Cast is a test-harness
// fixture for an out-of-enum runtime value the released V3 surface can carry.
const NOVEL_SERVICE_ID = 'acme.review/reviewer-service' as ConnectedServiceId;

function machine(id: string, active = true): Machine {
    return {
        id,
        active,
        activeAt: active ? Date.now() : null,
        revokedAt: null,
        metadata: {
            host: id,
            platform: 'darwin',
            happyCliVersion: '0.0.0',
            happyHomeDir: '/tmp/happier',
            homeDir: '/Users/test',
        },
    } as Machine;
}

function session(params: Readonly<{
    id: string;
    machineId: string;
    serviceId: string;
    binding: unknown;
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
                v: 1,
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
    it('resolves recovery-credit targets from the session-bound profile owner keyed by the canonical qualified key', () => {
        expect(resolveConnectedServiceRecoveryCreditMachineTarget({
            serviceId: CODEX_LEGACY_SERVICE_ID,
            profileId: 'work',
            sessions: [
                session({
                    id: 'unrelated',
                    machineId: 'machine-arbitrary',
                    serviceId: CODEX_SERVICE_KEY,
                    binding: { source: 'connected', selection: 'profile', profileId: 'personal' },
                }),
                session({
                    id: 'owner',
                    machineId: 'machine-owner',
                    serviceId: CODEX_SERVICE_KEY,
                    binding: { source: 'connected', selection: 'profile', profileId: 'work' },
                }),
            ],
            machines: [machine('machine-arbitrary'), machine('machine-owner')],
            connectedServicesV2: [],
        })).toBe('machine-owner');
    });

    it('resolves a group-bound owner through the released V2 group facts after qualified resolution', () => {
        expect(resolveConnectedServiceRecoveryCreditMachineTarget({
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

    it('reports no bound session when no active session carries the qualified binding', () => {
        expect(resolveConnectedServiceRecoveryCreditMachineTarget({
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

import { describe, expect, it } from 'vitest';

import type { Machine, Session } from '@/sync/domains/state/storageTypes';

import {
    resolveConnectedServiceRecoveryCreditMachineTarget,
} from './useConnectedServiceRecoveryCreditMachineTarget';

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
    it('resolves recovery-credit targets from the session-bound profile owner', () => {
        expect(resolveConnectedServiceRecoveryCreditMachineTarget({
            serviceId: 'openai-codex',
            profileId: 'work',
            sessions: [
                session({
                    id: 'unrelated',
                    machineId: 'machine-arbitrary',
                    serviceId: 'openai-codex',
                    binding: { source: 'connected', selection: 'profile', profileId: 'personal' },
                }),
                session({
                    id: 'owner',
                    machineId: 'machine-owner',
                    serviceId: 'openai-codex',
                    binding: { source: 'connected', selection: 'profile', profileId: 'work' },
                }),
            ],
            machines: [machine('machine-arbitrary'), machine('machine-owner')],
            connectedServicesV2: [],
        })).toBe('machine-owner');
    });
});

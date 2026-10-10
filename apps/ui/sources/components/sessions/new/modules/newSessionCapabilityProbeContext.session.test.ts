import { describe, expect, it } from 'vitest';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol';
import { resolveNewSessionModelCapabilityProbeContext } from './newSessionCapabilityProbeContext';

describe('existing session model probe context', () => {
    it('carries qualified launch bindings and partitions generic target probes without a native-observation expiry', () => {
        const connectedServices = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        } });
        const params = {
            backendTarget: { kind: 'backend' as const, backendId: 'codex' },
            runtimeCarrierAgentId: 'codex', settings: settingsDefaults,
            connectedServices, connectedServicesCacheIdentity: 'revision-1',
        };
        const first = resolveNewSessionModelCapabilityProbeContext(params);
        expect(first?.capabilityParams).toMatchObject({ connectedServices });
        expect(first?.modelSuccessCacheMaxAgeMs).toBeUndefined();
        expect(resolveNewSessionModelCapabilityProbeContext({ ...params, connectedServices: ConnectedServiceBindingsV2Schema.parse(connectedServices) })).toBe(first);
        const accountChanged = resolveNewSessionModelCapabilityProbeContext({ ...params,
            connectedServices: ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'personal' },
            } }),
        });
        const groupChanged = resolveNewSessionModelCapabilityProbeContext({ ...params,
            connectedServices: ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'team' },
            } }),
        });
        const revisionChanged = resolveNewSessionModelCapabilityProbeContext({ ...params, connectedServicesCacheIdentity: 'revision-2' });
        expect(accountChanged?.cacheKeySuffixParts).not.toEqual(first?.cacheKeySuffixParts);
        expect(groupChanged?.cacheKeySuffixParts).not.toEqual(first?.cacheKeySuffixParts);
        expect(revisionChanged?.cacheKeySuffixParts).not.toEqual(first?.cacheKeySuffixParts);
    });
    it('carries the opaque session runtime and partitions observations independently of account defaults', () => {
        const runtimeDescriptorV1 = { v: 1 as const, agentId: 'codex', agent: { backendMode: 'acp' } };
        const params = {
            backendTarget: { kind: 'backend' as const, backendId: 'codex' },
            runtimeCarrierAgentId: 'codex',
            settings: settingsDefaults,
            selectedProfileId: 'session-profile',
            runtimeDescriptorV1,
        };
        const first = resolveNewSessionModelCapabilityProbeContext(params);
        expect(first?.capabilityParams).toMatchObject({ runtimeDescriptorV1, profileId: 'session-profile' });
        expect(resolveNewSessionModelCapabilityProbeContext({ ...params, runtimeDescriptorV1: { ...runtimeDescriptorV1 } })).toBe(first);
        const second = resolveNewSessionModelCapabilityProbeContext({
            ...params, runtimeDescriptorV1: { ...runtimeDescriptorV1, agent: { backendMode: 'appServer' } },
        });
        expect(second?.cacheKeySuffixParts).not.toEqual(first?.cacheKeySuffixParts);
    });
});

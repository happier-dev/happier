import { describe, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountGroupV4Schema, QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol';
import type { ApiClient } from '@/api/api';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';

describe('spawn pool model eligibility', () => {
    it.each(['requested-model', 'observational-probe'] as const)('refuses unavailable %s admission before credential reads', async (operation) => {
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const healthyId = '7e9ced1f-60ac-4618-bcf0-31adc1c2e4aa';
        const activeId = operation === 'observational-probe' ? '92fe29be-575b-4551-8e90-edaacc3ec7a4' : 'primary';
        const memberIds = operation === 'observational-probe'
            ? [healthyId, '97bd5614-8970-4068-87f2-1447de69d604', '705530f2-81e8-4ba2-bc7b-7929a4b95b5a', activeId]
            : ['primary', 'backup'];
        const group = QualifiedConnectedAccountGroupV4Schema.parse({
            v: 1, ref: { service, groupId: 'pool' }, incarnation: 'pool-row', displayName: 'Pool',
            policy: { autoSwitch: true }, activeConnectedAccountId: activeId, generation: 7,
            runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 1,
            members: memberIds.map((connectedAccountId, priority) => ({
                v: 1, connectedAccountId, priority, enabled: true,
                state: operation === 'requested-model' ? { modelUnavailableUntilMsByModelId: { 'requested-model': 50_000 } } : {},
                createdAt: 1, updatedAt: 1,
            })),
        });
        const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service,
            accounts: memberIds.map((accountId) => ({
                ref: { service, accountId }, status: operation === 'observational-probe' && accountId !== healthyId ? 'needs_reauth' : 'connected', authenticationModeId: 'oauth',
                revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                configurationReady: true, configurationRevision: null, scopes: [],
            })),
        });
        const readCredential = vi.fn(async () => { throw new Error('credential-network-unavailable'); });
        // This incomplete API represents only network methods reached before materialization.
        const api = {
            getAccountEncryptionMode: async () => 'plain',
            getConnectedServiceCredentialPlain: readCredential,
        } as unknown as ApiClient;
        const request = {
            agentId: 'codex' as const, connectedServicesBindingsRaw: {
                v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'pool' } },
            },
            materializationKey: 'model-eligibility-run', activeServerDir: '/unused-server', baseDir: '/unused-materialization',
            credentials: { token: 'boundary-token', encryption: null }, api, nowMs: () => 1_000,
            qualifiedConnectedAccountApi: { readGroup: async () => group, listAccounts: async () => accounts },
            resolveQualifiedPurposeBindingSnapshot: (bindings: Parameters<typeof resolveQualifiedPurposeBindingSnapshotForAgentSpawn>[0]['bindings']) =>
                resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'codex', bindings, contributions: getResolvedContributionRegistry() }),
        };
        if (operation === 'requested-model') {
            await expect(resolveConnectedServiceAuthForSpawn({ ...request, modelId: 'requested-model' }))
                .rejects.toMatchObject({ code: 'connected_service_run_model_unavailable', modelId: 'requested-model' });
        } else {
            await expect(resolveConnectedServiceAuthForSpawn({ ...request, probePurpose: 'probe',
                authGroupSwitchCoordinator: null, credentialRefreshService: null }))
                .rejects.toMatchObject({ code: 'connected_service_auth_group_switch_unavailable_auth_expired', reason: 'auth_expired',
                    activeProfileId: activeId, selectedProfileId: healthyId });
        }
        expect(readCredential).not.toHaveBeenCalled();
    });
});

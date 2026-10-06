import { describe, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountGroupV4Schema, QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol';
import type { ApiClient } from '@/api/api';
import { resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';

describe('spawn pool model eligibility', () => {
    it('refuses an exhausted requested model before credential reads while preserving another model', async () => {
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const group = QualifiedConnectedAccountGroupV4Schema.parse({
            v: 1, ref: { service, groupId: 'pool' }, incarnation: 'pool-row', displayName: 'Pool',
            policy: { autoSwitch: true }, activeConnectedAccountId: 'primary', generation: 7,
            runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 1,
            members: ['primary', 'backup'].map((connectedAccountId, priority) => ({
                v: 1, connectedAccountId, priority, enabled: true,
                state: { modelUnavailableUntilMsByModelId: { 'requested-model': 50_000 } },
                createdAt: 1, updatedAt: 1,
            })),
        });
        const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service,
            accounts: ['primary', 'backup'].map((accountId) => ({
                ref: { service, accountId }, status: 'connected', authenticationModeId: 'oauth',
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
        };
        await expect(resolveConnectedServiceAuthForSpawn({ ...request, modelId: 'requested-model' }))
            .rejects.toMatchObject({ code: 'connected_service_run_model_unavailable', modelId: 'requested-model' });
        expect(readCredential).not.toHaveBeenCalled();
        await expect(resolveConnectedServiceAuthForSpawn({ ...request, modelId: 'other-model' })).rejects.toThrow();
        expect(readCredential).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'primary' }));
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));

import {
    describeProviderConnections,
    describeProviderConnectionModels,
    describeProviderModels,
    describeProviderBindingStatus,
    mutateProviderConnection,
    mutateProviderModelSettings,
    loadProviderModel,
    probeProviderConnection,
    probeProviderDraft,
    previewLegacyProfileMigration,
    confirmLegacyProfileMigration,
    confirmLegacyProfileMigrationConflict,
} from './client';
import { createCustomProviderDraft, buildCustomProviderTemplate } from '@/providers/authoring/state';
import { createProviderErrorV1 } from '@happier-dev/protocol';

function createReviewedMapping() {
    const template = buildCustomProviderTemplate({
        ...createCustomProviderDraft('anthropic'),
        name: 'Legacy gateway',
        baseUrl: 'https://gateway.example.test',
        requiresApiKey: false,
    });
    return {
        connection: {
            v: 1 as const,
            id: 'pc_migrated',
            source: { kind: 'custom' as const, template },
            role: 'named' as const,
            displayName: 'Legacy gateway',
            displayNameMode: 'custom' as const,
            revision: 0,
            createdAt: 1,
            updatedAt: 1,
        },
        credentialMoves: [],
        routingEnvironmentVariableNames: ['ANTHROPIC_BASE_URL'],
        manualModelIds: ['model-a'],
    };
}

describe('provider settings RPC client', () => {
    beforeEach(() => machineRpcWithServerScope.mockReset());

    it('routes strict identity-only describe requests to the selected machine/server', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            status: 'success', connections: [], available: [], availableTruncated: false,
            discoveryCandidates: [], diagnostics: [], diagnosticsTruncated: false,
        });
        await expect(describeProviderConnections({ machineId: 'machine-a', serverId: 'server-a' }))
            .resolves.toMatchObject({ status: 'success' });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a', serverId: 'server-a',
            method: 'daemon.providers.connections.describe', payload: { machineId: 'machine-a' },
        }));
    });

    it('rejects malformed or secret-bearing responses at the UI boundary', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            status: 'success', connections: [], available: [], availableTruncated: false,
            discoveryCandidates: [], diagnostics: [], diagnosticsTruncated: false, rawSecret: 'nope',
        });
        await expect(describeProviderConnections({ machineId: 'machine-a', serverId: 'server-a' }))
            .rejects.toMatchObject({
                v: 1,
                code: 'provider_rpc_response_invalid',
                machineId: 'machine-a',
                retryable: true,
                action: 'retry',
            });
    });

    it('classifies failed machine transport separately from a typed Provider endpoint failure', async () => {
        machineRpcWithServerScope.mockRejectedValueOnce(new Error('selected machine disconnected'));
        await expect(describeProviderConnections({ machineId: 'machine-a', serverId: 'server-a' }))
            .rejects.toEqual(createProviderErrorV1('provider_machine_unavailable', {
                machineId: 'machine-a',
            }));

        const endpointFailure = createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: 'pc_a', machineId: 'machine-a',
        });
        machineRpcWithServerScope.mockRejectedValueOnce(endpointFailure);
        await expect(describeProviderConnections({
            machineId: 'machine-a', serverId: 'server-a', connectionId: 'pc_a',
        })).rejects.toEqual(endpointFailure);
    });

    it.each([
        {
            name: 'connection describe', kind: 'read', invoke: () => describeProviderConnections({
                machineId: 'machine-a', serverId: 'server-a',
            }),
        },
        {
            name: 'connection mutation', kind: 'mutation', invoke: () => mutateProviderConnection({
                serverId: 'server-a',
                request: { action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' },
            }),
        },
        {
            name: 'probe', kind: 'read', invoke: () => probeProviderConnection({
                machineId: 'machine-a', serverId: 'server-a', connectionId: 'pc_a',
            }),
        },
        {
            name: 'model projection', kind: 'read', invoke: () => describeProviderModels({
                machineId: 'machine-a', serverId: 'server-a', agentTargetKey: 'backend:codex',
            }),
        },
        {
            name: 'connection models', kind: 'read', invoke: () => describeProviderConnectionModels({
                machineId: 'machine-a', serverId: 'server-a', connectionId: 'pc_a',
            }),
        },
        {
            name: 'model load', kind: 'mutation', invoke: () => loadProviderModel({
                machineId: 'machine-a', serverId: 'server-a', connectionId: 'pc_a', modelId: 'model-a',
            }),
        },
        {
            name: 'model settings mutation', kind: 'mutation', invoke: () => mutateProviderModelSettings({
                serverId: 'server-a',
                request: {
                    action: 'manualRemove', machineId: 'machine-a', connectionId: 'pc_a',
                    expectedConnectionRevision: 2, modelId: 'model-a',
                },
            }),
        },
        {
            name: 'binding status', kind: 'read', invoke: () => describeProviderBindingStatus({
                serverId: 'server-a',
                request: {
                    machineId: 'machine-a', agentTargetKey: 'backend:codex',
                    selection: {
                        v: 1, updatedAt: 1,
                        ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_a', modelId: 'model-a' },
                    },
                    launchBinding: {
                        v: 1, connectionId: 'pc_a', contributionKey: null, connectionRevision: 1,
                        protocol: 'openai-responses', materialization: 'engineConfig',
                        compatibilityFingerprint: 'compatibility:v1:a',
                        bindingSecurityFingerprint: 'binding-security:v1:a',
                        displaySnapshot: {
                            providerName: 'Gateway', connectionName: 'Work', connectionRole: 'named',
                            connectionDisplayNameMode: 'custom',
                        },
                    },
                },
            }),
        },
        {
            name: 'migration preview', kind: 'read', invoke: () => previewLegacyProfileMigration({
                serverId: 'server-a',
                request: {
                    machineId: 'machine-a', sourceProfileId: 'legacy-a', reviewedMapping: createReviewedMapping(),
                },
            }),
        },
        {
            name: 'migration confirm', kind: 'mutation', invoke: () => confirmLegacyProfileMigration({
                serverId: 'server-a',
                request: {
                    machineId: 'machine-a', sourceProfileId: 'legacy-a', reviewedMapping: createReviewedMapping(),
                    expectedSourceFingerprint: `legacy-profile-migration-source:v1:${'a'.repeat(43)}`,
                },
            }),
        },
        {
            name: 'migration conflict confirm', kind: 'mutation', invoke: () => confirmLegacyProfileMigrationConflict({
                serverId: 'server-a',
                request: {
                    machineId: 'machine-a', sourceProfileId: 'legacy-a',
                    expectedCandidateFingerprint: `legacy-profile-migration-conflict:v1:${'b'.repeat(43)}`,
                    decision: { kind: 'keep_existing', existingConnectionId: 'pc_a' },
                },
            }),
        },
    ] satisfies ReadonlyArray<Readonly<{
        name: string;
        kind: 'read' | 'mutation';
        invoke: () => Promise<unknown>;
    }>>)('classifies a schema-invalid $name response by replay safety', async ({ kind, invoke }) => {
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'unexpected' });

        await expect(invoke()).rejects.toMatchObject(kind === 'read'
            ? { code: 'provider_rpc_response_invalid', retryable: true, action: 'retry' }
            : { code: 'provider_rpc_mutation_outcome_unknown', retryable: false, action: 'review_current_state' });
    });

    it('treats an untyped mutation transport rejection as unknown outcome while preserving typed failures', async () => {
        machineRpcWithServerScope.mockRejectedValueOnce(new Error('acknowledgement lost after dispatch'));
        await expect(mutateProviderConnection({
            serverId: 'server-a',
            request: { action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' },
        })).rejects.toMatchObject({
            code: 'provider_rpc_mutation_outcome_unknown',
            connectionId: 'pc_a',
            machineId: 'machine-a',
            retryable: false,
            action: 'review_current_state',
        });

        const typedFailure = createProviderErrorV1('provider_connection_changed', {
            connectionId: 'pc_a', machineId: 'machine-a',
        });
        machineRpcWithServerScope.mockRejectedValueOnce(typedFailure);
        await expect(mutateProviderConnection({
            serverId: 'server-a',
            request: { action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' },
        })).rejects.toEqual(typedFailure);
    });

    it.each([
        {
            action: 'createContribution' as const,
            machineId: 'machine-a',
            connectionId: 'pc_create',
            contributionKey: 'acme.gateway/main',
            displayName: null,
            savedSecretId: null,
            enable: false,
            authoringReview: {
                candidateId: null,
                fingerprint: 'authoring-review:v1:reviewed',
                revision: 0,
            },
        },
        {
            action: 'update' as const,
            machineId: 'machine-a',
            connectionId: 'pc_update',
            expectedRevision: 2,
            displayName: 'Updated',
        },
        {
            action: 'delete' as const,
            machineId: 'machine-a',
            connectionId: 'pc_delete',
        },
    ])('classifies a schema-invalid $action result as an unknown mutation outcome', async (request) => {
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'success', action: request.action });

        await expect(mutateProviderConnection({ serverId: 'server-a', request }))
            .rejects.toMatchObject({
                code: 'provider_rpc_mutation_outcome_unknown',
                connectionId: request.connectionId,
                action: 'review_current_state',
            });
    });

    it.each([
        {
            name: 'one Provider connection',
            changes: [
                {
                    ref: { scope: 'agent' as const, agentTargetKey: 'backend:codex', providerConnectionId: 'pc_a', modelId: 'model-a' },
                    hidden: true,
                },
                {
                    ref: { scope: 'allAgents' as const, providerConnectionId: 'pc_a', modelId: 'model-b' },
                    hidden: false,
                },
            ],
            expectedConnectionId: 'pc_a',
        },
        {
            name: 'native and Provider models',
            changes: [
                {
                    ref: { scope: 'agent' as const, agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'native-a' },
                    hidden: true,
                },
                {
                    ref: { scope: 'agent' as const, agentTargetKey: 'backend:codex', providerConnectionId: 'pc_a', modelId: 'model-a' },
                    hidden: true,
                },
            ],
            expectedConnectionId: undefined,
        },
        {
            name: 'multiple Provider connections',
            changes: [
                {
                    ref: { scope: 'allAgents' as const, providerConnectionId: 'pc_a', modelId: 'model-a' },
                    hidden: true,
                },
                {
                    ref: { scope: 'allAgents' as const, providerConnectionId: 'pc_b', modelId: 'model-b' },
                    hidden: true,
                },
            ],
            expectedConnectionId: undefined,
        },
    ])('attributes an unknown $name bulk outcome only when every ref has the same connection', async ({ changes, expectedConnectionId }) => {
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'success', action: 'bulkVisibility', extra: true });

        const failure = await mutateProviderModelSettings({
            serverId: 'server-a',
            request: { action: 'bulkVisibility', machineId: 'machine-a', changes },
        }).catch((caught: unknown) => caught);

        expect(failure).toEqual(createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
            machineId: 'machine-a',
            ...(expectedConnectionId ? { connectionId: expectedConnectionId } : {}),
        }));
    });

    it('sends only the strict mutation intent', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            status: 'success', action: 'delete', deletedConnectionId: 'pc_a',
        });
        await expect(mutateProviderConnection({
            serverId: 'server-a',
            request: { action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' },
        })).resolves.toMatchObject({ status: 'success', action: 'delete' });
    });

    it('probes a configured connection through the selected machine', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            status: 'success', models: [], requestFingerprint: `probe-request:v1:${'a'.repeat(43)}`,
        });
        await probeProviderConnection({ machineId: 'machine-a', serverId: 'server-a', connectionId: 'pc_a' });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.providers.probe',
            payload: { machineId: 'machine-a', connectionId: 'pc_a' },
        }));
    });

    it('probes a draft using only a SavedSecret identity and action nonce', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'not_supported' });
        const template = buildCustomProviderTemplate({
            ...createCustomProviderDraft('openai-chat'),
            name: 'Gateway',
            baseUrl: 'https://gateway.example.test/v1',
        });
        await probeProviderDraft({
            machineId: 'machine-a', serverId: 'server-a', draftConnectionId: 'pc_draft',
            template, savedSecretId: 'secret-id', actionNonce: 'nonce_1234567890123456',
        });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.providers.probe',
            payload: expect.objectContaining({ savedSecretId: 'secret-id', actionNonce: 'nonce_1234567890123456' }),
        }));
    });

    it('requests the canonical machine-and-agent model projection', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            status: 'success', agentTargetKey: 'backend:codex', groups: [],
        });
        await describeProviderModels({ machineId: 'machine-a', serverId: 'server-a', agentTargetKey: 'backend:codex' });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.providers.model.projection',
            payload: { machineId: 'machine-a', agentTargetKey: 'backend:codex' },
        }));
    });

    it('requests a connection catalog without reconstructing it in the UI', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            status: 'success', connectionId: 'pc_a', connectionRevision: 2,
            manualModelPolicy: 'allowed', modelLoadAction: 'descriptor_absent', models: [],
        });
        await describeProviderConnectionModels({
            machineId: 'machine-a', serverId: 'server-a', connectionId: 'pc_a',
        });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.providers.models',
            payload: { machineId: 'machine-a', connectionId: 'pc_a' },
        }));
    });

    it('loads one exact model through the identity-only management RPC', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'loaded', source: 'requested' });
        await loadProviderModel({
            machineId: 'machine-a', serverId: 'server-a', connectionId: 'pc_a', modelId: 'model-a',
        });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a', serverId: 'server-a', method: 'daemon.providers.model.load',
            payload: { action: 'load', machineId: 'machine-a', connectionId: 'pc_a', modelId: 'model-a' },
        }));
    });

    it('sends strict model-setting mutation intents without UI-side merge data', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'success', action: 'manualRemove' });
        await mutateProviderModelSettings({
            serverId: 'server-a',
            request: {
                action: 'manualRemove', machineId: 'machine-a', connectionId: 'pc_a',
                expectedConnectionRevision: 2, modelId: 'model-a',
            },
        });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.providers.model.settings.mutate',
        }));
    });

    it('checks one exact non-secret launch binding through the owning machine', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'current' });
        await describeProviderBindingStatus({
            serverId: 'server-a',
            request: {
                machineId: 'machine-a', agentTargetKey: 'backend:codex',
                selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_a', modelId: 'm' } },
                launchBinding: {
                    v: 1, connectionId: 'pc_a', contributionKey: null, connectionRevision: 1,
                    protocol: 'openai-responses', materialization: 'engineConfig',
                    compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a',
                    displaySnapshot: {
                        providerName: 'Gateway', connectionName: 'Work', connectionRole: 'named', connectionDisplayNameMode: 'custom',
                    },
                },
            },
        });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a', method: 'daemon.providers.binding.status',
        }));
    });

    it('previews and confirms a reviewed legacy profile mapping without sending raw settings', async () => {
        const template = buildCustomProviderTemplate({
            ...createCustomProviderDraft('anthropic'),
            name: 'Legacy gateway',
            baseUrl: 'https://gateway.example.test',
            requiresApiKey: false,
        });
        const reviewedMapping = {
            connection: {
                v: 1 as const,
                id: 'pc_migrated',
                source: { kind: 'custom' as const, template },
                role: 'named' as const,
                displayName: 'Legacy gateway',
                displayNameMode: 'custom' as const,
                revision: 0,
                createdAt: 1,
                updatedAt: 1,
            },
            credentialMoves: [],
            routingEnvironmentVariableNames: ['ANTHROPIC_BASE_URL'],
            manualModelIds: ['model-a'],
        };
        const sourceFingerprint = `legacy-profile-migration-source:v1:${'a'.repeat(43)}`;
        machineRpcWithServerScope
            .mockResolvedValueOnce({ status: 'success', sourceProfileId: 'legacy-a', sourceFingerprint })
            .mockResolvedValueOnce({
                status: 'success', sourceProfileId: 'legacy-a', connectionId: 'pc_migrated', settingsVersion: 8,
            });

        await expect(previewLegacyProfileMigration({
            serverId: 'server-a',
            request: { machineId: 'machine-a', sourceProfileId: 'legacy-a', reviewedMapping },
        })).resolves.toMatchObject({ status: 'success', sourceFingerprint });
        await expect(confirmLegacyProfileMigration({
            serverId: 'server-a',
            request: {
                machineId: 'machine-a', sourceProfileId: 'legacy-a', reviewedMapping,
                expectedSourceFingerprint: sourceFingerprint,
            },
        })).resolves.toMatchObject({ status: 'success', settingsVersion: 8 });

        expect(machineRpcWithServerScope).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-a', serverId: 'server-a',
            method: 'daemon.providers.profileMigration.preview',
            payload: expect.not.objectContaining({ settings: expect.anything() }),
        }));
        expect(machineRpcWithServerScope).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-a', serverId: 'server-a',
            method: 'daemon.providers.profileMigration.confirm',
            payload: expect.objectContaining({ expectedSourceFingerprint: sourceFingerprint }),
        }));
    });

    it('confirms an exact redacted legacy-profile conflict decision through the typed RPC', async () => {
        const fingerprint = `legacy-profile-migration-conflict:v1:${'b'.repeat(43)}`;
        machineRpcWithServerScope.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'deepseek', connectionId: 'pc_existing', settingsVersion: 9,
        });

        await expect(confirmLegacyProfileMigrationConflict({
            serverId: 'server-a',
            request: {
                machineId: 'machine-a',
                sourceProfileId: 'deepseek',
                expectedCandidateFingerprint: fingerprint,
                decision: { kind: 'keep_existing', existingConnectionId: 'pc_existing' },
            },
        })).resolves.toMatchObject({ status: 'success', settingsVersion: 9 });

        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a',
            serverId: 'server-a',
            method: 'daemon.providers.profileMigration.conflict.confirm',
            payload: expect.not.objectContaining({ settings: expect.anything(), secretId: expect.anything() }),
        }));
    });
});

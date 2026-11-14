import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_PROVIDER_BINDING_ADAPTER_V1, PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST } from '@happier-dev/plugins-claude';
import { AgentProviderRequirementsV1Schema } from '@happier-dev/protocol';
import { projectRunnerDaemonPluginServicesFailure, createRunnerDaemonPluginServicesPreparationError } from './runnerDaemonPluginServicesHost';

import {
    ProviderRuntimeBindingBasisV1Schema,
    ProviderCredentialTransportV1Schema,
    type AgentProviderRequirementsV1,
} from '@happier-dev/protocol';
import type {
    AgentProviderBindingAdapter,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
    materializeRunnerManagedProviderAgentBinding,
} from './materializeRunnerManagedProviderAgentBinding';

type AgentProviderBindingMaterialization = Awaited<
    ReturnType<AgentProviderBindingAdapter['materialize']>
>;

const transport = ProviderCredentialTransportV1Schema.parse({
    id: 'bearer',
    protocols: ['openai-responses'],
    uses: ['runtime'],
    destination: {
        kind: 'httpHeader',
        name: 'Authorization',
        format: 'bearer',
    },
});

const binding = {
    v: 1 as const,
    agentTargetKey: 'codex',
    selection: {
        connectionId: 'provider-connection',
        model: { id: 'model-1', name: 'Model 1' },
    },
    contributionKey: 'provider.plugin/gateway',
    endpoint: {
        endpointTemplateId: 'responses',
        normalizedUrl: 'http://127.0.0.1:4312/v1',
        protocol: 'openai-responses' as const,
        publicHeaders: {},
    },
    runtimeCredentialTransport: transport,
    compatibilityFingerprint: 'compatibility-1',
};

const support = {
    acceptsProtocols: ['openai-responses' as const],
    required: { streaming: true },
    credentialSupport: {
        supportsNoAuth: false,
        apiKeyTransports: [{
            protocol: 'openai-responses' as const,
            destination: {
                kind: 'httpHeader' as const,
                names: 'anyValidated' as const,
                formats: ['bearer' as const],
            },
        }],
    },
    authIsolation: {
        suppressConnectedServiceIds: [],
        ownedEnvKeys: ['PROVIDER_API_KEY'],
    },
    materialization: 'spawnEnv' as const,
    applyPolicy: 'restart_session' as const,
    supportsFreeformModelIds: true,
} satisfies AgentProviderRequirementsV1;

function input(materialize: AgentProviderBindingAdapter['materialize']) {
    return {
        capturedAgentBinding: {
            pluginId: 'agent.plugin',
            adapter: {
                v: 1 as const,
                adapterVersion: 1,
                prepare: () => ({
                    v: 1 as const,
                    materialization: 'spawnEnv' as const,
                }),
                materialize,
            },
            support,
            isCurrent: () => true,
        },
        runtimeBindingBasis: ProviderRuntimeBindingBasisV1Schema.parse({
            v: 1, agentTargetKey: binding.agentTargetKey, connectionId: binding.selection.connectionId,
            contributionKey: binding.contributionKey, endpoint: binding.endpoint,
            runtimeCredentialTransport: transport, prepared: { v: 1, materialization: 'spawnEnv' },
            adapterVersion: 1, agentSupport: support, deployment: { kind: 'external' },
            credentialAuthorization: {
                connectionSecurityFingerprint: 'security', grantFingerprint: 'grant',
                selectedSecretBindingId: null, selectedSecretRecordFingerprint: null,
            },
        }),
        model: binding.selection.model, endpointUrl: binding.endpoint.normalizedUrl,
        compatibilityFingerprint: binding.compatibilityFingerprint,
        credential: {
            kind: 'apiKey' as const,
            transport,
            value: 'placeholder-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
    };
}

describe('runner managed Provider Agent binding materialization', () => {
    it('carries a real Claude preparation refusal through the daemon failure envelope', async () => {
        const base = input(async () => { throw new Error('Unused fixture adapter'); });
        const support = AgentProviderRequirementsV1Schema.parse(CLAUDE_PLUGIN_MANIFEST.contributes.agents[0]?.providerRequirements);
        const claudeTransport = ProviderCredentialTransportV1Schema.parse({ ...transport, protocols: ['anthropic'] });
        const error = await materializeRunnerManagedProviderAgentBinding({
            ...base,
            capturedAgentBinding: { pluginId: 'happier.agent.claude', adapter: CLAUDE_PROVIDER_BINDING_ADAPTER_V1,
                support, isCurrent: () => true },
            runtimeBindingBasis: { ...base.runtimeBindingBasis, runtimeCredentialTransport: claudeTransport,
                endpoint: { ...base.runtimeBindingBasis.endpoint, protocol: 'anthropic' }, roleModels: {} },
            credential: { ...base.credential, transport: claudeTransport },
            isCapturedAgentRegistrationCurrent: () => true, isManagedProviderCurrent: () => true, cleanup() {},
        }).catch((error: unknown) => error);
        const response = projectRunnerDaemonPluginServicesFailure(
            createRunnerDaemonPluginServicesPreparationError(error, 'managed_provider'));
        expect(response).toMatchObject({
            cause: { stage: 'managed_provider', code: 'claude_provider_binding_preparation_invalid' },
            failureCause: { errorCode: 'claude_provider_binding_preparation_invalid' },
        });
        expect(JSON.stringify(response)).not.toContain(base.credential.value);
    });
    it('rejects a G to H replacement before materialization without resolving or invoking H', async () => {
        const materialize = vi.fn(async () => ({
            v: 1,
            kind: 'spawnEnv',
            env: [],
        } satisfies AgentProviderBindingMaterialization));
        const cleanup = vi.fn(async () => undefined);

        await expect(materializeRunnerManagedProviderAgentBinding({
            ...input(materialize),
            isCapturedAgentRegistrationCurrent: () => false,
            isManagedProviderCurrent: () => true,
            cleanup,
        })).rejects.toMatchObject({
            code:
                'plugin_services_managed_provider_materialization_authority_changed',
        });
        expect(materialize).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('discards adapter output when exact G changes during settlement and cleans P once', async () => {
        let agentCurrent = true;
        const materialize = vi.fn(async () => {
            agentCurrent = false;
            return {
                v: 1,
                kind: 'spawnEnv',
                env: [{
                    name: 'PROVIDER_API_KEY',
                    value: 'placeholder-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    source: 'provider',
                }],
            } satisfies AgentProviderBindingMaterialization;
        });
        const cleanup = vi.fn(async () => undefined);

        await expect(materializeRunnerManagedProviderAgentBinding({
            ...input(materialize),
            isCapturedAgentRegistrationCurrent: () => agentCurrent,
            isManagedProviderCurrent: () => true,
            cleanup,
        })).rejects.toMatchObject({
            code:
                'plugin_services_managed_provider_materialization_authority_changed',
        });
        expect(materialize).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('cleans exact P once when the captured G adapter rejects', async () => {
        const materialize = vi.fn(async () => {
            throw new Error('adapter rejected');
        });
        const cleanup = vi.fn(async () => undefined);

        await expect(materializeRunnerManagedProviderAgentBinding({
            ...input(materialize),
            isCapturedAgentRegistrationCurrent: () => true,
            isManagedProviderCurrent: () => true,
            cleanup,
        })).rejects.toThrow(/materialization failed/i);
        expect(materialize).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('cleans exact P when a currentness read throws', async () => {
        const materialize = vi.fn(async () => ({
            v: 1,
            kind: 'spawnEnv',
            env: [],
        } satisfies AgentProviderBindingMaterialization));
        const cleanup = vi.fn(async () => undefined);

        await expect(materializeRunnerManagedProviderAgentBinding({
            ...input(materialize),
            isCapturedAgentRegistrationCurrent: () => true,
            isManagedProviderCurrent: () => {
                throw new Error('policy read failed');
            },
            cleanup,
        })).rejects.toMatchObject({
            code:
                'plugin_services_managed_provider_materialization_authority_changed',
        });
        expect(materialize).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledOnce();
    });
});

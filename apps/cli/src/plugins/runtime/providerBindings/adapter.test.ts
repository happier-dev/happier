import { describe, expect, it, vi } from 'vitest';
import {
    ProviderConnectionIdSchema,
    ProviderCredentialTransportV1Schema,
    type AgentProviderRequirementsV1,
} from '@happier-dev/protocol';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '../reload/controller';
import {
    materializeLeasedAgentProviderBinding,
    prepareLeasedAgentProviderBinding,
    readLeasedAgentProviderBindingAdapter,
    readLeasedAgentProviderRequirements,
} from './adapter';

type AgentRuntimeRegistrationOptions =
    NonNullable<Parameters<PluginApi['agents']['register']>[2]>;

const apiKeyTransport = ProviderCredentialTransportV1Schema.parse({
    id: 'bearer',
    protocols: ['openai-responses'],
    uses: ['runtime'],
    destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
});

const staticSupport: AgentProviderRequirementsV1 = {
    acceptsProtocols: ['openai-responses'],
    required: { streaming: true, toolRoundTrips: true },
    credentialSupport: {
        supportsNoAuth: true,
        apiKeyTransports: [{
            protocol: 'openai-responses',
            destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] },
        }],
    },
    authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['GATEWAY_KEY'] },
    materialization: 'engineConfig',
    applyPolicy: 'restart_session',
    supportsFreeformModelIds: true,
};

function leaseWithAdapter(
    adapter: NonNullable<AgentRuntimeRegistrationOptions['providerBinding']> | null,
    support: AgentProviderRequirementsV1 | null = staticSupport,
) {
    const create = vi.fn(async () => ({
        sessions: {
            open: async () => { throw new Error('not invoked'); },
        },
    }));
    const registry = {
        contributes: {
            agentDefinitionsById: new Map([['codex', {
                definition: support === null ? { id: 'codex', kindVersion: 1 } : {
                    id: 'codex',
                    kindVersion: 1,
                    providerRequirements: support,
                },
            }]]),
        },
        agentRuntimesByAgentId: adapter === null ? new Map() : new Map([['codex', {
            pluginId: 'happier.agent.codex',
            pluginVersion: '1.0.0',
            agentId: 'codex',
            generation: '7',
            providerBinding: adapter,
            isCurrent: () => true,
            createRuntime: create,
        }]]),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    return {
        create,
        lease: {
            registry,
            source: 'active' as const,
            release: async () => undefined,
        } satisfies PluginRuntimeRegistryLease,
    };
}

const prepareInput = {
    v: 1 as const,
    agentTargetKey: 'codex',
    connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
};

const binding = {
    v: 1 as const,
    agentTargetKey: 'codex',
    selection: {
        connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
        model: { id: 'model-1', name: 'Model 1' },
    },
    contributionKey: 'acme.gateway/main',
    endpoint: {
        endpointTemplateId: 'responses',
        normalizedUrl: 'https://gateway.example/v1',
        protocol: 'openai-responses' as const,
        publicHeaders: {},
    },
    runtimeCredentialTransport: apiKeyTransport,
    compatibilityFingerprint: 'provider-fingerprint:v1:compatibility:abc',
};

describe('leased provider-binding adapter ABI', () => {
    it('fails closed when static support and the executable adapter disagree', () => {
        const adapter = Object.freeze({
            v: 1 as const,
            adapterVersion: 1,
            prepare: () => ({ v: 1 as const, materialization: 'engineConfig' as const }),
            materialize: async () => ({ v: 1 as const, kind: 'engineConfig' as const, env: [], engineConfig: {} }),
        });
        expect(() => readLeasedAgentProviderBindingAdapter({
            lease: leaseWithAdapter(adapter, null).lease,
            agentId: 'codex',
        })).toThrow(/static provider support/i);
        expect(() => readLeasedAgentProviderBindingAdapter({
            lease: leaseWithAdapter(null, staticSupport).lease,
            agentId: 'codex',
        })).toThrow(/executable provider-binding adapter/i);
        expect(readLeasedAgentProviderBindingAdapter({
            lease: leaseWithAdapter(null, null).lease,
            agentId: 'codex',
        })).toBeNull();
    });

    it('reads static provider support without requiring executable adapter activation', () => {
        const { lease } = leaseWithAdapter(null, staticSupport);
        expect(readLeasedAgentProviderRequirements({ lease, agentId: 'codex' }))
            .toMatchObject({ authIsolation: { ownedEnvKeys: ['GATEWAY_KEY'] } });
    });

    it('reads and prepares the registration-level adapter without creating a runtime', () => {
        const adapter = Object.freeze({
            v: 1 as const,
            adapterVersion: 1,
            prepare: vi.fn(() => ({ v: 1 as const, materialization: 'engineConfig' as const, adapterBindingKey: 'gateway' })),
            materialize: vi.fn(async () => ({ v: 1 as const, kind: 'engineConfig' as const, env: [], engineConfig: {} })),
        });
        const { lease, create } = leaseWithAdapter(adapter);

        expect(readLeasedAgentProviderBindingAdapter({ lease, agentId: 'codex' })?.adapter).toBe(adapter);
        expect(prepareLeasedAgentProviderBinding({
            lease,
            agentId: 'codex',
            input: prepareInput,
        })).toEqual({ v: 1, materialization: 'engineConfig', adapterBindingKey: 'gateway' });
        expect(create).not.toHaveBeenCalled();
    });

    it('rejects async preparation, wrong static materialization, and malformed prepared output', () => {
        const { lease } = leaseWithAdapter(Object.freeze({
            v: 1 as const,
            adapterVersion: 1,
            prepare: (() => Promise.resolve({ v: 1, materialization: 'spawnEnv' })) as never,
            materialize: async () => ({ v: 1 as const, kind: 'spawnEnv' as const, env: [] }),
        }));
        expect(() => prepareLeasedAgentProviderBinding({
            lease, agentId: 'codex', input: prepareInput,
        })).toThrow(/synchronous/i);

        const wrong = leaseWithAdapter(Object.freeze({
            v: 1 as const,
            adapterVersion: 1,
            prepare: () => ({ v: 1 as const, materialization: 'configFile' as const }),
            materialize: async () => ({ v: 1 as const, kind: 'configFile' as const, env: [], files: [] }),
        })).lease;
        expect(() => prepareLeasedAgentProviderBinding({
            lease: wrong, agentId: 'codex', input: prepareInput,
        })).toThrow(/materialization/i);
    });

    it('validates the exact credential transport, owned env keys, output kind, and secret-free config', async () => {
        const adapter = Object.freeze({
            v: 1 as const,
            adapterVersion: 1,
            prepare: () => ({ v: 1 as const, materialization: 'engineConfig' as const }),
            materialize: vi.fn(async () => ({
                v: 1 as const,
                kind: 'engineConfig' as const,
                env: [{ name: 'GATEWAY_KEY', value: 'raw-secret', source: 'provider' as const }],
                engineConfig: {
                    key: 'env:GATEWAY_KEY',
                    benignEscapes: { quote: '"not the credential"', path: 'C:\\safe', unicode: 'café' },
                },
            })),
        });
        const { lease } = leaseWithAdapter(adapter);
        const prepared = prepareLeasedAgentProviderBinding({
            lease, agentId: 'codex', input: prepareInput,
        });
        await expect(materializeLeasedAgentProviderBinding({
            lease,
            agentId: 'codex',
            binding,
            prepared,
            credential: { kind: 'apiKey', transport: apiKeyTransport, value: 'raw-secret' },
        })).resolves.toMatchObject({ kind: 'engineConfig' });

        await expect(materializeLeasedAgentProviderBinding({
            lease,
            agentId: 'codex',
            binding: { ...binding, runtimeCredentialTransport: null },
            prepared,
            credential: { kind: 'apiKey', transport: apiKeyTransport, value: 'raw-secret' },
        })).rejects.toThrow(/credential transport/i);

        await expect(materializeLeasedAgentProviderBinding({
            lease,
            agentId: 'codex',
            binding,
            prepared,
            credential: { kind: 'apiKey', transport: apiKeyTransport, value: 42 } as never,
        })).rejects.toThrow(/credential value/i);
        expect(adapter.materialize).toHaveBeenCalledTimes(1);

        const leaking = leaseWithAdapter(Object.freeze({
            ...adapter,
            materialize: async () => ({
                v: 1 as const,
                kind: 'engineConfig' as const,
                env: [{ name: 'GATEWAY_KEY', value: 'raw-secret', source: 'provider' as const }],
                engineConfig: { key: 'raw-secret' },
            }),
        })).lease;
        await expect(materializeLeasedAgentProviderBinding({
            lease: leaking,
            agentId: 'codex',
            binding,
            prepared,
            credential: { kind: 'apiKey', transport: apiKeyTransport, value: 'raw-secret' },
        })).rejects.toThrow(/credential/i);

        for (const escapedCredential of ['raw-"secret\nvalue', 'raw\\secret', 'raw-🔐-secret']) {
            const escapedLeak = leaseWithAdapter(Object.freeze({
                ...adapter,
                materialize: async () => ({
                    v: 1 as const,
                    kind: 'engineConfig' as const,
                    env: [{ name: 'GATEWAY_KEY', value: escapedCredential, source: 'provider' as const }],
                    engineConfig: { nested: { key: escapedCredential } },
                }),
            })).lease;
            await expect(materializeLeasedAgentProviderBinding({
                lease: escapedLeak,
                agentId: 'codex',
                binding,
                prepared,
                credential: { kind: 'apiKey', transport: apiKeyTransport, value: escapedCredential },
            })).rejects.toThrow(/credential/i);
        }
    });

    it('rejects credentials embedded in a config-file path as well as file contents', async () => {
        const support = { ...staticSupport, materialization: 'configFile' as const };
        const adapter = Object.freeze({
            v: 1 as const,
            adapterVersion: 1,
            prepare: () => ({ v: 1 as const, materialization: 'configFile' as const }),
            materialize: async () => ({
                v: 1 as const,
                kind: 'configFile' as const,
                env: [{ name: 'GATEWAY_KEY', value: 'raw-secret', source: 'provider' as const }],
                files: [{ relativePath: 'config/raw-secret.json', utf8: '{}' }],
            }),
        });
        const { lease } = leaseWithAdapter(adapter, support);
        const prepared = prepareLeasedAgentProviderBinding({ lease, agentId: 'codex', input: prepareInput });

        await expect(materializeLeasedAgentProviderBinding({
            lease,
            agentId: 'codex',
            binding,
            prepared,
            credential: { kind: 'apiKey', transport: apiKeyTransport, value: 'raw-secret' },
        })).rejects.toThrow(/credential/i);
    });
});

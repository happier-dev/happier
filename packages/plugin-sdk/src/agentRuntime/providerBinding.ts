import type { JsonValue } from '../identity.js';

type AgentProviderWireProtocol =
    | 'anthropic'
    | 'openai-chat'
    | 'openai-responses'
    | 'ollama-native';

type AgentProviderBindingModel = Readonly<{
    id: string;
    name: string;
    capabilities?: Readonly<{
        reasoningControls?: 'supported' | 'unsupported' | 'unknown';
    }>;
}>;

export type AgentProviderCredentialTransport = Readonly<{
    id: string;
    protocols: readonly AgentProviderWireProtocol[];
    uses: readonly ('probe' | 'runtime' | 'management')[];
    destination:
        | Readonly<{
            kind: 'httpHeader';
            name: string;
            format: 'raw' | 'bearer' | Readonly<{ template: string }>;
        }>
        | Readonly<{
            kind: 'queryParam';
            name: string;
            format: 'raw' | 'bearer' | Readonly<{ template: string }>;
        }>;
}>;

type AgentProviderBindingEnvironmentEntry = Readonly<{
    name: string;
    value: string | null;
    source: 'provider';
}>;

type AgentProviderBindingMaterializationBase = Readonly<{
    v: 1;
    env: readonly AgentProviderBindingEnvironmentEntry[];
    additionalRedactionValues?: readonly string[];
}>;

export type AgentProviderBindingMaterialization =
    | (AgentProviderBindingMaterializationBase & Readonly<{ kind: 'spawnEnv' }>)
    | (AgentProviderBindingMaterializationBase & Readonly<{
        kind: 'engineConfig';
        engineConfig: Readonly<Record<string, JsonValue>>;
    }>)
    | (AgentProviderBindingMaterializationBase & Readonly<{
        kind: 'configFile';
        files: readonly Readonly<{ relativePath: string; utf8: string }>[];
    }>);

export type AgentProviderBindingPrepareInput = Readonly<{
    v: 1;
    agentTargetKey: string;
    connectionId: string;
    reservedBindingCandidate?: Readonly<{
        contributionKey: string;
        endpointTemplateId: string;
        protocol: AgentProviderWireProtocol;
        normalizedUrl: string;
    }>;
}>;

export type AgentProviderBindingPrepared = Readonly<{
    v: 1;
    materialization: 'spawnEnv' | 'engineConfig' | 'configFile';
    adapterBindingKey?: string;
}>;

export type AgentProviderBindingCredential =
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'apiKey';
        transport: AgentProviderCredentialTransport;
        value: string;
    }>;

export type AgentProviderBindingResolvedFacts = Readonly<{
    v: 1;
    agentTargetKey: string;
    selection: Readonly<{
        connectionId: string;
        model: AgentProviderBindingModel;
    }>;
    contributionKey: string | null;
    endpoint: Readonly<{
        endpointTemplateId: string;
        normalizedUrl: string;
        protocol: AgentProviderWireProtocol;
        publicHeaders: Readonly<Record<string, string>>;
    }>;
    runtimeCredentialTransport: AgentProviderCredentialTransport | null;
    compatibilityFingerprint: string;
}>;

export type AgentProviderBindingMaterializeInput = Readonly<{
    v: 1;
    binding: AgentProviderBindingResolvedFacts;
    prepared: AgentProviderBindingPrepared;
    credential: AgentProviderBindingCredential;
}>;

export type AgentProviderBindingAdapter = Readonly<{
    v: 1;
    adapterVersion: number;
    prepare(input: AgentProviderBindingPrepareInput): AgentProviderBindingPrepared;
    materialize(
        input: AgentProviderBindingMaterializeInput,
    ): AgentProviderBindingMaterialization | Promise<AgentProviderBindingMaterialization>;
}>;

export type AgentRuntimeRegistrationOptions = Readonly<{
    providerBinding?: AgentProviderBindingAdapter;
}>;

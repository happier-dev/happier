import type {
    AgentProviderBindingMaterializationV1,
    ProviderConnectionId,
    ProviderCredentialTransportV1,
    ProviderWireProtocol,
} from '@happier-dev/protocol';

export type AgentProviderBindingPrepareInputV1 = Readonly<{
    v: 1;
    agentTargetKey: string;
    connectionId: ProviderConnectionId;
    reservedBindingCandidate?: Readonly<{
        contributionKey: string;
        endpointTemplateId: string;
        protocol: ProviderWireProtocol;
        normalizedUrl: string;
    }>;
}>;

export type AgentProviderBindingPreparedV1 = Readonly<{
    v: 1;
    materialization: 'spawnEnv' | 'engineConfig' | 'configFile';
    adapterBindingKey?: string;
}>;

export type AgentProviderBindingCredentialV1 =
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'apiKey';
        transport: ProviderCredentialTransportV1;
        value: string;
    }>;

export type AgentProviderBindingResolvedFactsV1 = Readonly<{
    v: 1;
    agentTargetKey: string;
    selection: Readonly<{
        connectionId: ProviderConnectionId;
        modelId: string;
    }>;
    contributionKey: string | null;
    endpoint: Readonly<{
        endpointTemplateId: string;
        normalizedUrl: string;
        protocol: ProviderWireProtocol;
        publicHeaders: Readonly<Record<string, string>>;
    }>;
    runtimeCredentialTransport: ProviderCredentialTransportV1 | null;
    compatibilityFingerprint: string;
}>;

export type AgentProviderBindingMaterializeInputV1 = Readonly<{
    v: 1;
    binding: AgentProviderBindingResolvedFactsV1;
    prepared: AgentProviderBindingPreparedV1;
    credential: AgentProviderBindingCredentialV1;
}>;

export type AgentProviderBindingAdapterV1 = Readonly<{
    v: 1;
    adapterVersion: number;
    prepare(input: AgentProviderBindingPrepareInputV1): AgentProviderBindingPreparedV1;
    materialize(
        input: AgentProviderBindingMaterializeInputV1,
    ): AgentProviderBindingMaterializationV1 | Promise<AgentProviderBindingMaterializationV1>;
}>;

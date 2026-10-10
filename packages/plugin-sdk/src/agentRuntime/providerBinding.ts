import type {
    ProviderConnectionV1,
    ProviderWireProtocol,
} from '@happier-dev/protocol';

import type { JsonValue } from '../identity.js';

declare const canonicalProviderModelSettings: NonNullable<ProviderConnectionV1['modelSettings']>[string];

export type AgentProviderBindingModel = Readonly<{
    id: string;
    name: string;
    capabilities?: Readonly<{
        reasoningControls?: 'supported' | 'unsupported' | 'unknown';
    }>;
}>;

export type AgentProviderCredentialTransport = Readonly<{
    id: string;
    protocols: readonly ProviderWireProtocol[];
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

export type AgentProviderBindingEnvironmentEntry = Readonly<{
    name: string;
    value: string | null;
    source: 'provider';
}>;

export type AgentProviderBindingMaterialization = Readonly<{
    v: 1;
    env: readonly AgentProviderBindingEnvironmentEntry[];
    additionalRedactionValues?: readonly string[];
}> & (
    | Readonly<{ kind: 'spawnEnv' }>
    | Readonly<{
        kind: 'engineConfig';
        engineConfig: Readonly<Record<string, JsonValue>>;
    }>
    | Readonly<{
        kind: 'configFile';
        files: readonly Readonly<{ relativePath: string; utf8: string }>[];
    }>
);

export type AgentProviderBindingSourceKey = Readonly<
    | { bindingKey: string; connectionId?: never }
    | { connectionId: string; bindingKey?: never }
>;

export type AgentProviderBindingPrepareInput = Readonly<{
    v: 1;
    agentTargetKey: string;
    model?: AgentProviderBindingModel;
    claudeHelperModels?: Readonly<{ fast?: string; default?: string; strongest?: string }>;
    reservedBindingCandidate?: Readonly<{
        contributionKey: string;
        endpointTemplateId: string;
        protocol: ProviderWireProtocol;
        normalizedUrl: string;
    }>;
}> & AgentProviderBindingSourceKey;

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
        model: AgentProviderBindingModel;
    }> & AgentProviderBindingSourceKey;
    contributionKey: string | null;
    endpoint: Readonly<{
        endpointTemplateId: string;
        normalizedUrl: string;
        protocol: ProviderWireProtocol;
        publicHeaders: Readonly<Record<string, string>>;
    }>;
    runtimeCredentialTransport: AgentProviderCredentialTransport | null;
    /** Settings of the selected model from the canonical Provider connection. */
    modelSettings?: typeof canonicalProviderModelSettings extends infer TSettings
        ? { [TKey in keyof TSettings]: TSettings[TKey] }
        : never;
    /** Managed-gateway Claude alias configuration; omitted for external connections. */
    claudeHelperModels?: Readonly<{ fast?: string; default?: string; strongest?: string }>;
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
    /** Consumes managed connection Claude alias pins; other Agents leave them independent. */
    supportsClaudeHelperModels?: true;
    /** Consumes connection-owned selected-model generation settings. */
    supportsModelSettings?: true;
    prepare(input: AgentProviderBindingPrepareInput): AgentProviderBindingPrepared;
    materialize(
        input: AgentProviderBindingMaterializeInput,
    ): AgentProviderBindingMaterialization | Promise<AgentProviderBindingMaterialization>;
}>;

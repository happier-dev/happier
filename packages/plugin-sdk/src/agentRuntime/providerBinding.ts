import type { AgentProviderBindingResolvedFactsV1, AgentProviderBindingPrepareInputV1, AgentProviderBindingPreparedV1 } from '@happier-dev/protocol/providers/materialization/v1';
import type {
    AgentProviderRequirementsV1,
    ProviderModelDescriptorV1,
    ProviderWireProtocol,
} from '@happier-dev/protocol';

import type { JsonValue } from '../identity.js';

export type AgentProviderBindingModel = ProviderModelDescriptorV1;

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
    additionalCredentials?: readonly Readonly<{
        slotId: string;
        destination: AgentProviderCredentialTransport['destination'];
    }>[];
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
        /** Project the Agent's declared native home through the host state-sharing owner. */
        nativeHome?: true;
        files: readonly Readonly<{
            relativePath: string;
            utf8: string;
            /** Preserve copied native preferences while replacing the supplied top-level keys. */
            merge?: 'jsonObject';
        }>[];
    }>
);

export type AgentProviderBindingSourceKey = Readonly<
    | { bindingKey: string; connectionId?: never }
    | { connectionId: string; bindingKey?: never }
>;

export type AgentProviderBindingPrepareInput = Readonly<Omit<
    AgentProviderBindingPrepareInputV1, 'bindingKey' | 'connectionId' | 'reservedBindingCandidate'
> & {
    reservedBindingCandidate?: Readonly<NonNullable<AgentProviderBindingPrepareInputV1['reservedBindingCandidate']>>;
}> & AgentProviderBindingSourceKey;

export type AgentProviderBindingPrepared = Readonly<AgentProviderBindingPreparedV1>;

export type AgentProviderBindingCredential =
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'apiKey';
        transport: AgentProviderCredentialTransport;
        value: string;
        additionalCredentials?: readonly Readonly<{ slotId: string; value: string }>[];
    }>;

/** Protocol owns the closed DTO; SDK identities remain unbranded and transports immutable. */
export type AgentProviderBindingResolvedFacts = Readonly<Omit<
    AgentProviderBindingResolvedFactsV1, 'selection' | 'endpoint' | 'runtimeCredentialTransport'
> & {
    selection: Readonly<Pick<AgentProviderBindingResolvedFactsV1['selection'], 'model'>> & AgentProviderBindingSourceKey;
    endpoint: Readonly<Omit<AgentProviderBindingResolvedFactsV1['endpoint'], 'publicHeaders'> & {
        publicHeaders: Readonly<AgentProviderBindingResolvedFactsV1['endpoint']['publicHeaders']>;
    }>;
    runtimeCredentialTransport: AgentProviderCredentialTransport | null;
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
    /** Model roles consumed by this adapter, projected from its plugin declaration. */
    modelRoles?: AgentProviderRequirementsV1['modelRoles'];
    /** Consumes connection-owned selected-model generation settings. */
    supportsModelSettings?: true;
    prepare(input: AgentProviderBindingPrepareInput): AgentProviderBindingPrepared;
    materialize(
        input: AgentProviderBindingMaterializeInput,
    ): AgentProviderBindingMaterialization | Promise<AgentProviderBindingMaterialization>;
}>;

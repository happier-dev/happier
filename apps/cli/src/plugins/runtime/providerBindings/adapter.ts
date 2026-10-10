import { z } from 'zod';
import { AgentProviderBindingMaterializationV1Schema } from '@happier-dev/protocol/providers/materialization/v1';
import { AgentProviderRequirementsV1Schema } from '@happier-dev/protocol/providers/compatibility/v1';
import { ProviderAdapterBindingKeyV1Schema } from '@happier-dev/protocol/providers/sessions/adapterBindingKeyV1';
import { ProviderCredentialTransportV1Schema } from '@happier-dev/protocol/providers/credentials/v1';
import { ProviderWireProtocolSchema } from '@happier-dev/protocol/providers/capabilities/v1';
import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderContributionKeySchema, ProviderLocalIdSchema } from '@happier-dev/protocol/providers/ids';
import { ProviderEndpointUrlSyntaxSchema } from '@happier-dev/protocol/providers/endpoint-url';
import { ProviderClaudeHelperModelsV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';
import type { AgentProviderBindingMaterializationV1, AgentProviderRequirementsV1 } from '@happier-dev/protocol';
import type {
    AgentProviderBindingAdapter,
    AgentProviderBindingCredential,
    AgentProviderBindingPrepared,
    AgentProviderBindingResolvedFacts,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { isAgentRuntimeGenerationCurrent } from '../lifecycle/contributions/agentGenerationCurrentness';
import type { PluginRuntimeRegistryLease } from '../reload/controller';

const MaterializationKindSchema = z.enum(['spawnEnv', 'engineConfig', 'configFile']);

const ProviderBindingKeySchema = z.string().trim().min(1).max(512);

const PrepareInputBaseSchema = z.object({
    v: z.literal(1),
    agentTargetKey: ProviderAgentTargetKeySchema,
    model: ProviderModelDescriptorV1Schema.optional(),
    claudeHelperModels: ProviderClaudeHelperModelsV1Schema.optional(),
    reservedBindingCandidate: z.object({
        contributionKey: ProviderContributionKeySchema,
        endpointTemplateId: ProviderLocalIdSchema,
        protocol: ProviderWireProtocolSchema,
        normalizedUrl: ProviderEndpointUrlSyntaxSchema,
    }).strict().optional(),
}).strict();

const PrepareInputSchema = z.union([
    PrepareInputBaseSchema.extend({ bindingKey: ProviderBindingKeySchema }),
    PrepareInputBaseSchema.extend({ connectionId: ProviderConnectionIdSchema }),
]);

const PreparedSchema = z.object({
    v: z.literal(1),
    materialization: MaterializationKindSchema,
    adapterBindingKey: ProviderAdapterBindingKeyV1Schema.optional(),
}).strict();

const ResolvedSelectionBaseSchema = z.object({
    model: ProviderModelDescriptorV1Schema,
}).strict();

const ResolvedSelectionSchema = z.union([
    ResolvedSelectionBaseSchema.extend({ bindingKey: ProviderBindingKeySchema }),
    ResolvedSelectionBaseSchema.extend({ connectionId: ProviderConnectionIdSchema }),
]);

const ResolvedFactsSchema = z.object({
    v: z.literal(1),
    agentTargetKey: ProviderAgentTargetKeySchema,
    selection: ResolvedSelectionSchema,
    contributionKey: ProviderContributionKeySchema.nullable(),
    endpoint: z.object({
        endpointTemplateId: ProviderLocalIdSchema,
        normalizedUrl: ProviderEndpointUrlSyntaxSchema,
        protocol: ProviderWireProtocolSchema,
        publicHeaders: z.record(z.string(), z.string()),
    }).strict(),
    runtimeCredentialTransport: ProviderCredentialTransportV1Schema.nullable(),
    claudeHelperModels: ProviderClaudeHelperModelsV1Schema.optional(),
    compatibilityFingerprint: z.string().min(1).max(512),
}).strict();

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
    if (typeof value !== 'object' || value === null || seen.has(value)) return value;
    seen.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if ('value' in descriptor) deepFreeze(descriptor.value, seen);
    }
    return Object.freeze(value);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return typeof value === 'object' && value !== null && typeof (value as Readonly<{ then?: unknown }>).then === 'function';
}

function normalizedEnvName(value: string): string {
    return value.toUpperCase();
}

function assertExactOwnedEnvKeys(
    materialization: AgentProviderBindingMaterializationV1,
    authIsolation: AgentProviderRequirementsV1['authIsolation'],
): void {
    const required = authIsolation.ownedEnvKeys.map(normalizedEnvName);
    const optional = (authIsolation.optionalOwnedEnvKeys ?? []).map(normalizedEnvName);
    const declared = new Set([...required, ...optional]);
    const actual = materialization.env.map((entry) => normalizedEnvName(entry.name));
    const emitted = new Set(actual);
    if (declared.size !== required.length + optional.length
        || emitted.size !== actual.length
        || required.some((key) => !emitted.has(key))
        || actual.some((key) => !declared.has(key))) {
        throw new Error('Agent provider binding materialization must cover required owned environment keys and only declared optional keys');
    }
}

function transportsEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(ProviderCredentialTransportV1Schema.parse(left))
        === JSON.stringify(ProviderCredentialTransportV1Schema.parse(right));
}

function renderCredential(value: string, transport: z.infer<typeof ProviderCredentialTransportV1Schema>): string {
    const format = transport.destination.format;
    if (format === 'raw') return value;
    if (format === 'bearer') return `Bearer ${value}`;
    return format.template.replace('{secret}', value);
}

function containsSensitiveString(
    value: unknown,
    sensitiveValues: ReadonlySet<string>,
    seen = new Set<object>(),
): boolean {
    const containsSecret = (candidate: string): boolean => {
        for (const secret of sensitiveValues) {
            if (candidate.includes(secret)) return true;
        }
        return false;
    };
    if (typeof value === 'string') {
        return containsSecret(value);
    }
    if (typeof value !== 'object' || value === null || seen.has(value)) return false;
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!(Array.isArray(value) && key === 'length') && containsSecret(key)) return true;
        if ('value' in descriptor && containsSensitiveString(descriptor.value, sensitiveValues, seen)) return true;
    }
    return false;
}

function assertCredentialMatchesBinding(
    binding: AgentProviderBindingResolvedFacts,
    credential: AgentProviderBindingCredential,
): void {
    if (credential.kind === 'none') {
        if (binding.runtimeCredentialTransport !== null) {
            throw new Error('Agent provider binding credential transport requires an API key');
        }
        return;
    }
    if (!binding.runtimeCredentialTransport
        || !transportsEqual(binding.runtimeCredentialTransport, credential.transport)
        || !credential.transport.protocols.includes(binding.endpoint.protocol)
        || !credential.transport.uses.includes('runtime')) {
        throw new Error('Agent provider binding credential transport does not match the resolved runtime transport');
    }
    if (typeof credential.value !== 'string' || credential.value.length === 0) {
        throw new Error('Agent provider binding credential value must be a non-empty string');
    }
}

function assertSecretFreeConfigAndFiles(
    materialization: AgentProviderBindingMaterializationV1,
    credential: AgentProviderBindingCredential,
): void {
    if (credential.kind !== 'apiKey' || materialization.kind === 'spawnEnv') return;
    const rendered = renderCredential(credential.value, ProviderCredentialTransportV1Schema.parse(credential.transport));
    const sensitiveValues = new Set([credential.value, rendered]);
    const content = materialization.kind === 'engineConfig'
        ? materialization.engineConfig
        : materialization.files;
    if (containsSensitiveString(content, sensitiveValues)) {
        throw new Error('Agent provider binding config/files may not contain the credential value');
    }
}

export function readLeasedAgentProviderRequirements(params: Readonly<{
    lease: PluginRuntimeRegistryLease;
    agentId: string;
}>): AgentProviderRequirementsV1 | null {
    const definition = params.lease.registry.contributes.agentDefinitionsById.get(params.agentId)?.definition;
    const rawSupport = definition?.providerRequirements;
    return rawSupport === undefined
        ? null
        : deepFreeze(AgentProviderRequirementsV1Schema.parse(rawSupport));
}

export type CapturedAgentProviderBindingAdapter = Readonly<{
    pluginId: string;
    adapter: AgentProviderBindingAdapter;
    support: AgentProviderRequirementsV1;
    /**
     * Currentness of the exact Agent runtime registration this adapter was
     * captured from. A capture outlives the generation that produced it, so
     * every use is re-checked against this handle rather than against whatever
     * registration currently answers to the Agent id.
     */
    isCurrent: () => boolean;
}>;

export function readLeasedAgentProviderBindingAdapter(params: Readonly<{
    lease: PluginRuntimeRegistryLease;
    agentId: string;
}>): CapturedAgentProviderBindingAdapter | null {
    const owner = params.lease.registry.agentRuntimesByAgentId.get(params.agentId);
    const adapter = owner?.providerBinding;
    const support = readLeasedAgentProviderRequirements(params);
    if (support === null && adapter === undefined) return null;
    if (support === null) {
        throw new Error(`Agent '${params.agentId}' registered a provider-binding adapter without static provider support`);
    }
    if (!owner || !adapter) {
        throw new Error(`Agent '${params.agentId}' declares static provider support without an executable provider-binding adapter`);
    }
    const isCurrent = () => isAgentRuntimeGenerationCurrent(owner);
    if (!isCurrent()) {
        throw new Error(`Agent '${params.agentId}' provider-binding adapter belongs to a retired generation`);
    }
    return Object.freeze({ pluginId: owner.pluginId, adapter, support, isCurrent });
}

export function prepareLeasedAgentProviderBinding(params: Readonly<{
    lease: PluginRuntimeRegistryLease;
    agentId: string;
    input: Parameters<AgentProviderBindingAdapter['prepare']>[0];
}>): AgentProviderBindingPrepared {
    const resolved = readLeasedAgentProviderBindingAdapter(params);
    if (!resolved) throw new Error(`Agent '${params.agentId}' has no provider-binding adapter`);
    const input = deepFreeze(PrepareInputSchema.parse(params.input));
    const rawPrepared = resolved.adapter.prepare(input);
    if (isThenable(rawPrepared)) throw new Error('Agent provider binding preparation must be synchronous');
    const prepared = deepFreeze(PreparedSchema.parse(rawPrepared));
    if (prepared.materialization !== resolved.support.materialization) {
        throw new Error('Agent provider binding prepared materialization does not match static agent support');
    }
    return prepared;
}

export async function materializeLeasedAgentProviderBinding(params: Readonly<{
    lease: PluginRuntimeRegistryLease;
    agentId: string;
    binding: AgentProviderBindingResolvedFacts;
    prepared: AgentProviderBindingPrepared;
    credential: AgentProviderBindingCredential;
}>): Promise<AgentProviderBindingMaterializationV1> {
    const resolved = readLeasedAgentProviderBindingAdapter(params);
    if (!resolved) throw new Error(`Agent '${params.agentId}' has no provider-binding adapter`);
    return await materializeCapturedAgentProviderBinding({
        resolved,
        binding: params.binding,
        prepared: params.prepared,
        credential: params.credential,
    });
}

export async function materializeCapturedAgentProviderBinding(params: Readonly<{
    resolved: NonNullable<ReturnType<
        typeof readLeasedAgentProviderBindingAdapter
    >>;
    binding: AgentProviderBindingResolvedFacts;
    prepared: AgentProviderBindingPrepared;
    credential: AgentProviderBindingCredential;
}>): Promise<AgentProviderBindingMaterializationV1> {
    const resolved = params.resolved;
    const binding = deepFreeze(ResolvedFactsSchema.parse(params.binding));
    const prepared = deepFreeze(PreparedSchema.parse(params.prepared));
    const credential = deepFreeze(params.credential.kind === 'none'
        ? { kind: 'none' as const }
        : {
            kind: 'apiKey' as const,
            transport: ProviderCredentialTransportV1Schema.parse(params.credential.transport),
            value: params.credential.value,
        });
    if (prepared.materialization !== resolved.support.materialization) {
        throw new Error('Agent provider binding materialization does not match static agent support');
    }
    assertCredentialMatchesBinding(binding, credential);
    if (!resolved.isCurrent()) {
        throw new Error('Agent provider binding generation retired before materialization');
    }
    let raw: unknown;
    try {
        raw = await resolved.adapter.materialize(deepFreeze({ v: 1 as const, binding, prepared, credential }));
    } catch {
        throw new Error('Agent provider binding materialization failed');
    }
    if (!resolved.isCurrent()) {
        // The generation retired while materialization was in flight: drop the
        // settled result rather than publishing a dead generation's credential.
        throw new Error('Agent provider binding generation retired while materializing');
    }
    const materialization = deepFreeze(AgentProviderBindingMaterializationV1Schema.parse(raw));
    if (materialization.kind !== prepared.materialization
        || materialization.kind !== resolved.support.materialization) {
        throw new Error('Agent provider binding adapter returned the wrong materialization kind');
    }
    assertExactOwnedEnvKeys(materialization, resolved.support.authIsolation);
    assertSecretFreeConfigAndFiles(materialization, credential);
    return materialization;
}

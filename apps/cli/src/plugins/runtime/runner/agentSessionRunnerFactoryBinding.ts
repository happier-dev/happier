import type { AgentSessionRunnerFactoryLocatorV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { z } from 'zod';

const MAX_PLUGIN_ID_LENGTH = 256;
const MAX_AGENT_LOCAL_ID_LENGTH = 256;
const MAX_AGENT_ROUTING_ID_LENGTH =
    MAX_PLUGIN_ID_LENGTH + 1 + MAX_AGENT_LOCAL_ID_LENGTH;
// Contribution authority carries the literal `/agents/` namespace. Local ids
// permit `/`, which the canonical formatter percent-encodes, so reserve the
// encoding worst case instead of incorrectly applying the routing-id bound.
const MAX_AGENT_CONTRIBUTION_QUALIFIED_ID_LENGTH =
    MAX_PLUGIN_ID_LENGTH + '/agents/'.length + (MAX_AGENT_LOCAL_ID_LENGTH * 3);

export const AgentSessionRunnerFactoryBindingV1Schema = z.object({
    v: z.literal(1),
    pluginId: z.string().trim().min(1).max(256),
    pluginVersion: z.string().trim().min(1).max(256),
    // Canonical host routing id; 513 = 256 + '/' + 256.
    agentId: z.string().trim().min(1).max(MAX_AGENT_ROUTING_ID_LENGTH),
    localAgentId: z.string().trim().min(1).max(256),
    immutableGenerationId: z.string().trim().min(1).max(512),
    locator: z.object({
        module: z.string().regex(/^\.[/][A-Za-z0-9._/-]+$/u),
        export: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u),
        runtimeApiVersion: z.literal(1),
        externalSessionsExport:
            z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u).optional(),
    }).strict(),
    normalizedModulePath: z.string().trim().min(1).max(16_384),
    loadMode: z.enum(['immutable-js', 'source-ts']),
}).strict();

/**
 * One runner Agent binding. `agentId` is the canonical host routing id
 * (`resolveContributedAgentRoutingId`); `qualifiedAgentId` is the
 * always-qualified contribution key (`resolveAgentContributionQualifiedId`)
 * used for activation and managed-service authority. They are intentionally
 * validated against their distinct canonical spellings.
 */
export const HostDeclarativeAcpRunnerBindingV1Schema = z.object({
    kind: z.literal('host_declarative_acp_v1'),
    v: z.literal(1),
    pluginId: z.string().trim().min(1).max(256),
    pluginVersion: z.string().trim().min(1).max(256),
    agentId: z.string().trim().min(1).max(MAX_AGENT_ROUTING_ID_LENGTH),
    qualifiedAgentId: z.string().trim().min(1).max(MAX_AGENT_CONTRIBUTION_QUALIFIED_ID_LENGTH),
    localAgentId: z.string().trim().min(1).max(256),
    immutableGenerationId: z.string().trim().min(1).max(512),
}).strict();

export const AgentSessionRunnerBindingV1Schema = z.union([
    AgentSessionRunnerFactoryBindingV1Schema,
    HostDeclarativeAcpRunnerBindingV1Schema,
]);

export type AgentSessionRunnerFactoryBindingV1 = Readonly<{
    v: 1;
    pluginId: string;
    pluginVersion: string;
    agentId: string;
    localAgentId: string;
    immutableGenerationId: string;
    locator: AgentSessionRunnerFactoryLocatorV1;
    normalizedModulePath: string;
    loadMode: 'immutable-js' | 'source-ts';
}>;

export type HostDeclarativeAcpRunnerBindingV1 = Readonly<{
    kind: 'host_declarative_acp_v1';
    v: 1;
    pluginId: string;
    pluginVersion: string;
    /** Canonical host routing id; see the schema doc for the qualified split. */
    agentId: string;
    /** Always-qualified activation/service authority contribution key. */
    qualifiedAgentId: string;
    localAgentId: string;
    immutableGenerationId: string;
}>;

export type AgentSessionRunnerBindingV1 =
    | AgentSessionRunnerFactoryBindingV1
    | HostDeclarativeAcpRunnerBindingV1;

export function createAgentSessionRunnerFactoryBinding(
    input: AgentSessionRunnerFactoryBindingV1,
): AgentSessionRunnerFactoryBindingV1 {
    return Object.freeze(AgentSessionRunnerFactoryBindingV1Schema.parse({
        ...input,
        locator: Object.freeze({ ...input.locator }),
    }));
}

export function verifyAgentSessionRunnerFactoryBindingV1(
    value: unknown,
): AgentSessionRunnerFactoryBindingV1 {
    return createAgentSessionRunnerFactoryBinding(
        AgentSessionRunnerFactoryBindingV1Schema.parse(value),
    );
}

export function createHostDeclarativeAcpRunnerBinding(
    input: HostDeclarativeAcpRunnerBindingV1,
): HostDeclarativeAcpRunnerBindingV1 {
    return Object.freeze(
        HostDeclarativeAcpRunnerBindingV1Schema.parse(input),
    );
}

export function verifyHostDeclarativeAcpRunnerBindingV1(
    value: unknown,
): HostDeclarativeAcpRunnerBindingV1 {
    return createHostDeclarativeAcpRunnerBinding(
        HostDeclarativeAcpRunnerBindingV1Schema.parse(value),
    );
}

export function verifyAgentSessionRunnerBindingV1(
    value: unknown,
): AgentSessionRunnerBindingV1 {
    const binding = AgentSessionRunnerBindingV1Schema.parse(value);
    return 'kind' in binding
        ? verifyHostDeclarativeAcpRunnerBindingV1(binding)
        : verifyAgentSessionRunnerFactoryBindingV1(binding);
}

import { maxCodeUnits } from '@happier-dev/protocol/strings/maxCodeUnits';
import { MAX_AGENT_ROUTING_ID_BYTES } from '@happier-dev/protocol/agents/agentIdV1';
import type { PluginSourceCustodyV1 } from '@happier-dev/protocol';
import { MAX_PLUGIN_IDENTIFIER_BYTES } from '@happier-dev/protocol/plugins/plugin-id';
import type { AgentSessionRunnerFactoryLocatorV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { z } from 'zod/mini';
import { MachinePluginSourceCustodySchema, type MachinePluginSourceCustody } from '../sourceAuthority';

// Contribution authority carries the literal `/agents/` namespace. Local ids
// permit `/`, which the canonical formatter percent-encodes, so reserve the
// encoding worst case instead of incorrectly applying the routing-id bound.
const MAX_AGENT_CONTRIBUTION_QUALIFIED_ID_LENGTH =
    MAX_PLUGIN_IDENTIFIER_BYTES
    + '/agents/'.length
    + (MAX_PLUGIN_IDENTIFIER_BYTES * 3);

export const AgentSessionRunnerFactoryBindingV1Schema = z.strictObject({
    v: z.literal(1),
    pluginId: z.string().check(z.trim(), z.minLength(1), maxCodeUnits(MAX_PLUGIN_IDENTIFIER_BYTES)),
    pluginVersion: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    // Canonical host routing id; qualified for an installed Agent.
    agentId: z.string().check(z.trim(), z.minLength(1), maxCodeUnits(MAX_AGENT_ROUTING_ID_BYTES)),
    localAgentId: z.string().check(z.trim(), z.minLength(1), maxCodeUnits(MAX_PLUGIN_IDENTIFIER_BYTES)),
    sourceCustody: MachinePluginSourceCustodySchema,
    locator: z.strictObject({
        module: z.string().check(z.regex(/^\.[/][A-Za-z0-9._/-]+$/u)),
        export: z.string().check(z.regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u)),
        runtimeApiVersion: z.literal(1),
        externalSessionsExport:
            z.optional(z.string().check(z.regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u))),
    }),
    normalizedModulePath: z.string().check(z.trim(), z.minLength(1), z.maxLength(16_384)),
    loadMode: z.enum(['immutable-js', 'source-ts']),
});

/**
 * One runner Agent binding. `agentId` is the canonical host routing id
 * (`resolveContributedAgentRoutingId`); `qualifiedAgentId` is the
 * always-qualified contribution key (`resolveAgentContributionQualifiedId`)
 * used for activation and managed-service authority. They are intentionally
 * validated against their distinct canonical spellings.
 */
export const HostDeclarativeAcpRunnerBindingV1Schema = z.strictObject({
    kind: z.literal('host_declarative_acp_v1'),
    v: z.literal(1),
    pluginId: z.string().check(z.trim(), z.minLength(1), maxCodeUnits(MAX_PLUGIN_IDENTIFIER_BYTES)),
    pluginVersion: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    agentId: z.string().check(z.trim(), z.minLength(1), maxCodeUnits(MAX_AGENT_ROUTING_ID_BYTES)),
    qualifiedAgentId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_AGENT_CONTRIBUTION_QUALIFIED_ID_LENGTH)),
    localAgentId: z.string().check(z.trim(), z.minLength(1), maxCodeUnits(MAX_PLUGIN_IDENTIFIER_BYTES)),
    sourceCustody: MachinePluginSourceCustodySchema,
});

export const AgentSessionRunnerBindingV1Schema = z.union([
    AgentSessionRunnerFactoryBindingV1Schema,
    HostDeclarativeAcpRunnerBindingV1Schema,
]);

// An execution-only Agent registers its factory in activate(api). Its retained
// binding identifies that registration in the admitted source, with no leaf locator.
export const ActivatedExecutionRunFactoryBindingV1Schema = z.extend(
    z.pick(AgentSessionRunnerFactoryBindingV1Schema, {
        v: true, pluginId: true, pluginVersion: true, agentId: true, localAgentId: true, sourceCustody: true,
    }),
    { kind: z.literal('activated_execution_run_factory_v1') },
);

export const AgentExecutionRunRunnerBindingV1Schema = z.union([
    AgentSessionRunnerBindingV1Schema,
    ActivatedExecutionRunFactoryBindingV1Schema,
]);

export type ActivatedExecutionRunFactoryBindingV1 = Readonly<z.infer<typeof ActivatedExecutionRunFactoryBindingV1Schema>>;
export type AgentExecutionRunRunnerBindingV1 = AgentSessionRunnerBindingV1 | ActivatedExecutionRunFactoryBindingV1;

export function isActivatedExecutionRunFactoryBinding(binding: AgentExecutionRunRunnerBindingV1): binding is ActivatedExecutionRunFactoryBindingV1 {
    return 'kind' in binding && binding.kind === 'activated_execution_run_factory_v1';
}

export function verifyAgentExecutionRunRunnerBindingV1(value: unknown): AgentExecutionRunRunnerBindingV1 {
    return Object.freeze(AgentExecutionRunRunnerBindingV1Schema.parse(value));
}

export type AgentSessionRunnerFactoryBindingV1 = Readonly<{
    v: 1;
    pluginId: string;
    pluginVersion: string;
    agentId: string;
    localAgentId: string;
    sourceCustody: MachinePluginSourceCustody;
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
    sourceCustody: MachinePluginSourceCustody;
}>;

export type AgentSessionRunnerBindingV1 =
    | AgentSessionRunnerFactoryBindingV1
    | HostDeclarativeAcpRunnerBindingV1;

export function createAgentSessionRunnerFactoryBinding(
    input: Omit<AgentSessionRunnerFactoryBindingV1, 'sourceCustody'> & Readonly<{ sourceCustody: PluginSourceCustodyV1 }>,
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
    input: Omit<HostDeclarativeAcpRunnerBindingV1, 'sourceCustody'> & Readonly<{ sourceCustody: PluginSourceCustodyV1 }>,
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

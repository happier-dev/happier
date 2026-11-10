import { z } from '../zodRuntimePolicy.js';

import { resolveSessionCapabilitiesV1, projectMcpServerMaterializationV1, type ResolvedMcpServerV1 } from '../reach/resolveSessionCapabilitiesV1.js';
import { SessionMcpSelectionV1Schema } from '../mcp/servers/sessionSelectionV1.js';
import { SessionCapabilitySelectionAuthoringV1Schema, type SessionCapabilitySelectionV1 } from '../reach/sessionCapabilitySelectionV1.js';
import {
  McpServerCatalogEntryV1Schema,
  McpServersSettingsV1Schema,
  type McpServerCatalogEntryV1,
  type McpServersSettingsV1,
} from '../mcp/servers/settingsV1.js';
import { listValueRefSecretIdsV1, resolveValueRefPlaintextV1, type ValueRefV1 } from '../valueRefs/valueRefV1.js';

const RunnerReviewedMcpServerV1Schema = z.strictObject({
  serverId: z.string().check(z.minLength(1)),
  serverRevision: z.number(),
  bindingId: z.nullable(z.string().check(z.minLength(1))),
  bindingRevision: z.nullable(z.number()),
  savedSecretRevisions: z.array(z.strictObject({
    secretId: z.string().check(z.minLength(1)),
    revision: z.number(),
  })).check(z.maxLength(256)),
  config: McpServerCatalogEntryV1Schema,
}).check(z.superRefine((value, context) => {
  const refs = [
    ...Object.values(value.config.env),
    ...Object.values(value.config.remote?.headers ?? {}),
  ];
  if (refs.some((ref) => listValueRefSecretIdsV1(ref).length > 0)) {
    context.addIssue({ code: 'custom', path: ['config'], message: 'Reviewed MCP material must resolve Saved Secret values before handoff' });
  }
}));

export const RunnerMcpMaterialV1Schema = z.strictObject({
  v: z.literal(1),
  strictMode: z.boolean(),
  capabilitySelection: SessionCapabilitySelectionAuthoringV1Schema,
  servers: z.array(RunnerReviewedMcpServerV1Schema).check(z.maxLength(256)),
}).check(z.superRefine((value, context) => {
  const serverIds = new Set<string>();
  const serverNames = new Set<string>();
  for (const [index, server] of value.servers.entries()) {
    if (server.config.id !== server.serverId || server.config.updatedAt !== server.serverRevision) {
      context.addIssue({ code: 'custom', path: ['servers', index], message: 'Reviewed MCP server identity or revision mismatch' });
    }
    if ((server.bindingId === null) !== (server.bindingRevision === null)) {
      context.addIssue({ code: 'custom', path: ['servers', index], message: 'Reviewed MCP binding identity and revision must be paired' });
    }
    if (serverIds.has(server.serverId) || serverNames.has(server.config.name)) {
      context.addIssue({ code: 'custom', path: ['servers', index], message: 'Reviewed MCP servers must have unique identities and names' });
    }
    const secretIds = new Set<string>();
    for (const [secretIndex, secret] of server.savedSecretRevisions.entries()) {
      if (secretIds.has(secret.secretId)) {
        context.addIssue({ code: 'custom', path: ['servers', index, 'savedSecretRevisions', secretIndex], message: 'Reviewed MCP secret identities must be unique' });
      }
      secretIds.add(secret.secretId);
    }
    serverIds.add(server.serverId);
    serverNames.add(server.config.name);
  }
}));
export type RunnerMcpMaterialV1 = z.infer<typeof RunnerMcpMaterialV1Schema>;
export const EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1 = 'ephemeral-runner-unmaterialized';

export type RunnerMcpMaterializationFailureV1 = Readonly<{
  ok: false;
  reason: 'server_unavailable' | 'binding_unavailable' | 'machine_scoped' | 'saved_secret_unavailable' | 'endpoint_environment' | 'agent_unsupported';
  serverId: string;
  valuePath: string | null;
}>;

function resolvePortableValueRef(input: Readonly<{
  serverId: string;
  path: string;
  ref: ValueRefV1;
  resolveSavedSecret: (secretId: string) => Readonly<{ value: string; revision: number }> | null;
}>): { ok: true; value: ValueRefV1; savedSecretRevisions: readonly Readonly<{ secretId: string; revision: number }>[] } | RunnerMcpMaterializationFailureV1 {
  if (input.ref.t === 'savedSecret') {
    const resolved = input.resolveSavedSecret(input.ref.secretId);
    return resolved === null
      ? { ok: false, reason: 'saved_secret_unavailable', serverId: input.serverId, valuePath: input.path }
      : {
          ok: true,
          value: { t: 'literal', v: resolved.value },
          savedSecretRevisions: [{ secretId: input.ref.secretId, revision: resolved.revision }],
        };
  }
  // Portable preparation has no Session identity to assert. Retain the
  // symbolic reference for the ordinary runtime materializer to resolve/omit.
  if (input.ref.t === 'sessionAttested') {
    return { ok: true, value: input.ref, savedSecretRevisions: [] };
  }
  if (input.ref.t === 'template') {
    // Unobserved Machine variables stay unavailable; the shared renderer decides
    // whether the template actually needs them.
    const vars = Object.fromEntries(Object.entries(input.ref.vars)
      .filter(([, value]) => value.t !== 'literal' || !value.v.includes('${')));
    const revisions = new Map<string, number>();
    let secretUnavailable = false;
    const value = resolveValueRefPlaintextV1({ ...input.ref, vars }, secretId => {
      const resolved = input.resolveSavedSecret(secretId);
      if (!resolved) { secretUnavailable = true; return null; }
      revisions.set(secretId, resolved.revision);
      return resolved.value;
    });
    return value === null ? { ok: false, reason: secretUnavailable ? 'saved_secret_unavailable' : 'endpoint_environment',
      serverId: input.serverId, valuePath: input.path } : { ok: true, value: { t: 'literal', v: value },
      savedSecretRevisions: [...revisions].map(([secretId, revision]) => ({ secretId, revision })),
    };
  }
  // Environment expansion is Machine-owned in the ordinary runtime. A creator
  // cannot truthfully freeze an endpoint value it has never observed.
  if (input.ref.v.includes('${')) {
    return { ok: false, reason: 'endpoint_environment', serverId: input.serverId, valuePath: input.path };
  }
  return { ok: true, value: input.ref, savedSecretRevisions: [] };
}

function materializeConfig(input: Readonly<{
  serverId: string;
  config: McpServerCatalogEntryV1;
  resolveSavedSecret: (secretId: string) => Readonly<{ value: string; revision: number }> | null;
}>): { ok: true; config: McpServerCatalogEntryV1; savedSecretRevisions: ReadonlyArray<Readonly<{ secretId: string; revision: number }>> } | RunnerMcpMaterializationFailureV1 {
  const env: Record<string, ValueRefV1> = {};
  const savedSecretRevisions = new Map<string, number>();
  for (const [key, ref] of Object.entries(input.config.env)) {
    const resolved = resolvePortableValueRef({ serverId: input.serverId, path: `env:${key}`, ref, resolveSavedSecret: input.resolveSavedSecret });
    if (!resolved.ok) return resolved;
    env[key] = resolved.value;
    for (const reference of resolved.savedSecretRevisions) savedSecretRevisions.set(reference.secretId, reference.revision);
  }
  if (input.config.transport === 'stdio') return {
    ok: true,
    config: { ...input.config, env },
    savedSecretRevisions: [...savedSecretRevisions].map(([secretId, revision]) => ({ secretId, revision })),
  };
  const headers: Record<string, ValueRefV1> = {};
  for (const [key, ref] of Object.entries(input.config.remote?.headers ?? {})) {
    const resolved = resolvePortableValueRef({ serverId: input.serverId, path: `header:${key}`, ref, resolveSavedSecret: input.resolveSavedSecret });
    if (!resolved.ok) return resolved;
    headers[key] = resolved.value;
    for (const reference of resolved.savedSecretRevisions) savedSecretRevisions.set(reference.secretId, reference.revision);
  }
  return {
    ok: true,
    config: { ...input.config, env, remote: { ...input.config.remote!, headers } },
    savedSecretRevisions: [...savedSecretRevisions].map(([secretId, revision]) => ({ secretId, revision })),
  };
}

/**
 * Canonical portable selection for both creator-side resource admission and
 * materialization. Machine placement and forced-selection refusals stay owned
 * here rather than being reconstructed by the creator.
 */
export function resolveRunnerMcpSelectionV1(input: Readonly<{
  settings: McpServersSettingsV1;
  agentId: string;
  agentAcceptsUserMcp: boolean;
  capabilitySelection?: SessionCapabilitySelectionV1 | null;
}>): Readonly<{ ok: true; settings: McpServersSettingsV1; capabilitySelection: SessionCapabilitySelectionV1;
  selectedServers: readonly ResolvedMcpServerV1[] }> | RunnerMcpMaterializationFailureV1 {
  const settings = McpServersSettingsV1Schema.parse(input.settings);
  const capabilitySelection = SessionCapabilitySelectionAuthoringV1Schema.parse(input.capabilitySelection ?? {});
  const selection = SessionMcpSelectionV1Schema.parse(capabilitySelection.mcp ?? {});
  const resolved = projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({
    context: { machineId: EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1, directory: null, machinePlatform: null, projectKey: null, agentId: input.agentId },
    mcp: settings, skills: null, selection: capabilitySelection, agentAcceptsUserMcp: input.agentAcceptsUserMcp,
  }), '/');
  const selectedServers = Object.values(resolved.serversByName).filter(server => server.enabled);
  const forced = new Set(selection.forceIncludeServerIds.filter((id) => !selection.forceExcludeServerIds.includes(id)));
  const selectedIds = new Set(selectedServers.map((item) => item.serverId));
  for (const serverId of forced) {
    if (selectedIds.has(serverId)) continue;
    const server = settings.servers.find((candidate) => candidate.id === serverId);
    const hasMachineScopedBinding = settings.bindings.some((binding) => (
      binding.serverId === serverId && binding.target.t !== 'allMachines'
    ));
    return {
      ok: false,
      reason: !server ? 'server_unavailable' : !input.agentAcceptsUserMcp ? 'agent_unsupported'
        : hasMachineScopedBinding ? 'machine_scoped' : 'binding_unavailable',
      serverId,
      valuePath: null,
    };
  }
  return { ok: true, settings, capabilitySelection, selectedServers };
}

/** Materializes exactly the portable selection admitted by the same selection owner. */
export function resolveRunnerMcpMaterialV1(input: Readonly<{
  settings: McpServersSettingsV1;
  agentId: string;
  agentAcceptsUserMcp: boolean;
  capabilitySelection?: SessionCapabilitySelectionV1 | null;
  resolveSavedSecret: (secretId: string) => Readonly<{ value: string; revision: number }> | null;
}>): { ok: true; material: RunnerMcpMaterialV1 } | RunnerMcpMaterializationFailureV1 {
  const selected = resolveRunnerMcpSelectionV1(input);
  if (!selected.ok) return selected;
  const { settings, capabilitySelection } = selected;
  const servers: RunnerMcpMaterialV1['servers'][number][] = [];
  for (const item of selected.selectedServers) {
    const materialized = materializeConfig({ serverId: item.serverId, config: item.config, resolveSavedSecret: input.resolveSavedSecret });
    if (!materialized.ok) return materialized;
    const server = settings.servers.find((candidate) => candidate.id === item.serverId)!;
    const binding = item.bindingId === null ? null : settings.bindings.find((candidate) => candidate.id === item.bindingId) ?? null;
    servers.push({
      serverId: item.serverId,
      serverRevision: server.updatedAt,
      bindingId: item.bindingId,
      bindingRevision: binding?.updatedAt ?? null,
      savedSecretRevisions: [...materialized.savedSecretRevisions],
      config: materialized.config,
    });
  }
  return { ok: true, material: RunnerMcpMaterialV1Schema.parse({ v: 1, strictMode: settings.strictMode, capabilitySelection, servers }) };
}

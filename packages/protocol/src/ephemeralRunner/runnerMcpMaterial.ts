import { z } from 'zod';

import { resolveManagedSessionMcpSelectionV1 } from '../mcp/servers/resolveManagedSessionMcpSelectionV1.js';
import type { ResolvedMcpServerV1 } from '../mcp/servers/resolveEffectiveServersV1.js';
import { SessionMcpSelectionV1Schema, type SessionMcpSelectionV1 } from '../mcp/servers/sessionSelectionV1.js';
import {
  McpServerCatalogEntryV1Schema,
  McpServersSettingsV1Schema,
  type McpServerCatalogEntryV1,
  type McpServersSettingsV1,
  type McpValueRefV1,
} from '../mcp/servers/settingsV1.js';

const RunnerReviewedMcpServerV1Schema = z.object({
  serverId: z.string().min(1),
  serverRevision: z.number(),
  bindingId: z.string().min(1).nullable(),
  bindingRevision: z.number().nullable(),
  savedSecretRevisions: z.array(z.object({
    secretId: z.string().min(1),
    revision: z.number(),
  }).strict()).max(256),
  config: McpServerCatalogEntryV1Schema,
}).strict().superRefine((value, context) => {
  const refs = [
    ...Object.values(value.config.env),
    ...Object.values(value.config.remote?.headers ?? {}),
  ];
  if (refs.some((ref) => ref.t !== 'literal')) {
    context.addIssue({ code: 'custom', path: ['config'], message: 'Reviewed MCP material must contain only resolved literal values' });
  }
});

export const RunnerMcpMaterialV1Schema = z.object({
  v: z.literal(1),
  strictMode: z.boolean(),
  selection: SessionMcpSelectionV1Schema,
  servers: z.array(RunnerReviewedMcpServerV1Schema).max(256),
}).strict().superRefine((value, context) => {
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
});
export type RunnerMcpMaterialV1 = z.infer<typeof RunnerMcpMaterialV1Schema>;

export type RunnerMcpMaterializationFailureV1 = Readonly<{
  ok: false;
  reason: 'server_unavailable' | 'binding_unavailable' | 'machine_scoped' | 'saved_secret_unavailable' | 'endpoint_environment';
  serverId: string;
  valuePath: string | null;
}>;

function resolvePortableValueRef(input: Readonly<{
  serverId: string;
  path: string;
  ref: McpValueRefV1;
  resolveSavedSecret: (secretId: string) => Readonly<{ value: string; revision: number }> | null;
}>): { ok: true; value: McpValueRefV1; savedSecretRevision: Readonly<{ secretId: string; revision: number }> | null } | RunnerMcpMaterializationFailureV1 {
  if (input.ref.t === 'savedSecret') {
    const resolved = input.resolveSavedSecret(input.ref.secretId);
    return resolved === null
      ? { ok: false, reason: 'saved_secret_unavailable', serverId: input.serverId, valuePath: input.path }
      : {
          ok: true,
          value: { t: 'literal', v: resolved.value },
          savedSecretRevision: { secretId: input.ref.secretId, revision: resolved.revision },
        };
  }
  // Environment expansion is Machine-owned in the ordinary runtime. A creator
  // cannot truthfully freeze an endpoint value it has never observed.
  if (input.ref.v.includes('${')) {
    return { ok: false, reason: 'endpoint_environment', serverId: input.serverId, valuePath: input.path };
  }
  return { ok: true, value: input.ref, savedSecretRevision: null };
}

function materializeConfig(input: Readonly<{
  serverId: string;
  config: McpServerCatalogEntryV1;
  resolveSavedSecret: (secretId: string) => Readonly<{ value: string; revision: number }> | null;
}>): { ok: true; config: McpServerCatalogEntryV1; savedSecretRevisions: ReadonlyArray<Readonly<{ secretId: string; revision: number }>> } | RunnerMcpMaterializationFailureV1 {
  const env: Record<string, McpValueRefV1> = {};
  const savedSecretRevisions = new Map<string, number>();
  for (const [key, ref] of Object.entries(input.config.env)) {
    const resolved = resolvePortableValueRef({ serverId: input.serverId, path: `env:${key}`, ref, resolveSavedSecret: input.resolveSavedSecret });
    if (!resolved.ok) return resolved;
    env[key] = resolved.value;
    if (resolved.savedSecretRevision) savedSecretRevisions.set(resolved.savedSecretRevision.secretId, resolved.savedSecretRevision.revision);
  }
  if (input.config.transport === 'stdio') return {
    ok: true,
    config: { ...input.config, env },
    savedSecretRevisions: [...savedSecretRevisions].map(([secretId, revision]) => ({ secretId, revision })),
  };
  const headers: Record<string, McpValueRefV1> = {};
  for (const [key, ref] of Object.entries(input.config.remote?.headers ?? {})) {
    const resolved = resolvePortableValueRef({ serverId: input.serverId, path: `header:${key}`, ref, resolveSavedSecret: input.resolveSavedSecret });
    if (!resolved.ok) return resolved;
    headers[key] = resolved.value;
    if (resolved.savedSecretRevision) savedSecretRevisions.set(resolved.savedSecretRevision.secretId, resolved.savedSecretRevision.revision);
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
  selection?: SessionMcpSelectionV1 | null;
}>): Readonly<{ ok: true; settings: McpServersSettingsV1; selection: SessionMcpSelectionV1;
  selectedServers: readonly ResolvedMcpServerV1[] }> | RunnerMcpMaterializationFailureV1 {
  const settings = McpServersSettingsV1Schema.parse(input.settings);
  const selection = SessionMcpSelectionV1Schema.parse(input.selection ?? {});
  const resolved = resolveManagedSessionMcpSelectionV1(settings, {
    machineId: 'ephemeral-runner-unmaterialized',
    directory: '/',
    selection,
  });
  const forced = new Set(selection.forceIncludeServerIds.filter((id) => !selection.forceExcludeServerIds.includes(id)));
  const selectedIds = new Set(Object.values(resolved.selectedServersByName).map((item) => item.serverId));
  for (const serverId of forced) {
    if (selectedIds.has(serverId)) continue;
    const server = settings.servers.find((candidate) => candidate.id === serverId);
    const hasMachineScopedBinding = settings.bindings.some((binding) => (
      binding.serverId === serverId && binding.target.t !== 'allMachines'
    ));
    return {
      ok: false,
      reason: !server ? 'server_unavailable' : hasMachineScopedBinding ? 'machine_scoped' : 'binding_unavailable',
      serverId,
      valuePath: null,
    };
  }
  return { ok: true, settings, selection, selectedServers: Object.values(resolved.selectedServersByName) };
}

/** Materializes exactly the portable selection admitted by the same selection owner. */
export function resolveRunnerMcpMaterialV1(input: Readonly<{
  settings: McpServersSettingsV1;
  selection?: SessionMcpSelectionV1 | null;
  resolveSavedSecret: (secretId: string) => Readonly<{ value: string; revision: number }> | null;
}>): { ok: true; material: RunnerMcpMaterialV1 } | RunnerMcpMaterializationFailureV1 {
  const selected = resolveRunnerMcpSelectionV1(input);
  if (!selected.ok) return selected;
  const { settings, selection } = selected;
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
  return { ok: true, material: RunnerMcpMaterialV1Schema.parse({ v: 1, strictMode: settings.strictMode, selection, servers }) };
}

import { getActionContextualDefaults } from '@happier-dev/protocol/actions/actionSpecs';
import { bindContextualActionToolInput as bindActionInput, type SessionBoundActionToolContext } from '@happier-dev/protocol/actions/actionToolContext';
import type { ActionContextualDefaults } from '@happier-dev/protocol';
import {
  isManagedWorkspaceRefV2,
  WorkspaceAddressV1Schema,
  type WorkspaceAddressV1,
  type WorkspaceRefV1,
} from '@happier-dev/protocol/workspaces/workspaceRefV1';
import {
  resolveSessionProjectKeyV1,
  workspaceAddressFromRefV1,
} from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { z } from 'zod/mini';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

export type { SessionBoundActionToolContext } from '@happier-dev/protocol/actions/actionToolContext';

/**
 * Derive the canonical `WorkspaceAddressV1` for a bound session from its known
 * workspace ref, active workspace-ref census, or explicit session metadata +
 * location coordinates without introducing a second workspace address format.
 */
export function resolveSessionDefaultWorkspaceAddress(params: Readonly<{
  serverId?: string | null;
  serverIdentityId?: string | null;
  metadata?: unknown;
  machineId?: string | null;
  rootPath?: string | null;
  workspaceRef?: WorkspaceRefV1 | null;
  workspaceRefs?: readonly WorkspaceRefV1[] | null;
}>): WorkspaceAddressV1 | null {
  if (params.workspaceRef && !isManagedWorkspaceRefV2(params.workspaceRef)) {
    return workspaceAddressFromRefV1(params.workspaceRef);
  }
  const metadata = params.metadata && typeof params.metadata === 'object' && !Array.isArray(params.metadata)
    ? params.metadata as Readonly<Record<string, unknown>>
    : null;
  const serverId = [params.serverIdentityId, params.serverId]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim() ?? '';
  const machineId = [params.machineId, metadata?.machineId]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim() ?? '';
  const rootPath = [params.rootPath, metadata?.path]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim() ?? '';

  if (serverId && params.workspaceRefs && params.workspaceRefs.length > 0) {
    const mergedMetadata = {
      ...(metadata ?? {}),
      ...(machineId ? { machineId } : {}),
      ...(rootPath ? { path: rootPath } : {}),
    };
    const homeCandidates = new Set(
      [params.serverIdentityId, params.serverId]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim()),
    );
    for (const homeId of homeCandidates) {
      const resolved = resolveSessionProjectKeyV1(mergedMetadata, homeId, params.workspaceRefs);
      if (resolved.kind === 'resolved' && resolved.ref && !isManagedWorkspaceRefV2(resolved.ref)) {
        return workspaceAddressFromRefV1(resolved.ref);
      }
    }
  }

  const workspaceId = typeof metadata?.workspaceId === 'string' ? metadata.workspaceId.trim() : '';
  if (!serverId || !workspaceId || !machineId || !rootPath) return null;
  const parsed = WorkspaceAddressV1Schema.safeParse({ serverId, workspaceId, machineId, rootPath });
  return parsed.success ? parsed.data : null;
}

export function normalizeActionExecuteInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;

  const trimmed = input.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return input;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return input;
  }
}

export function resolveActionToolContextualDefaults(params: Readonly<{
  actionId: string;
  input?: unknown;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): ActionContextualDefaults | null {
  const builtIn = getActionContextualDefaults(params.actionId, params.input);
  if (builtIn) return builtIn;

  const projected = params.pluginToolCatalog?.find((tool) => tool.actionId === params.actionId);
  if (projected?.contextualDefaults) return projected.contextualDefaults;

  const identity = parseQualifiedPluginActionId(params.actionId);
  return identity
    ? params.registry?.actionsById?.get(buildQualifiedPluginContributionKey(identity))?.definition.contextualDefaults ?? null
    : null;
}

export function bindContextualActionToolInput(params: Readonly<{
  actionId: string;
  input: unknown;
  contextualDefaults?: ActionContextualDefaults | null;
  context: SessionBoundActionToolContext;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): unknown {
  return bindActionInput({ ...params, contextualDefaults: params.contextualDefaults ?? resolveActionToolContextualDefaults(params) });
}

export function projectSessionBoundActionToolInputSchema(params: Readonly<{
  actionId: string;
  inputSchema: unknown;
  context: SessionBoundActionToolContext;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  contextualDefaults?: ActionContextualDefaults | null;
}>): unknown {
  const optionalFields = new Set(Object.keys(bindContextualActionToolInput({ ...params, input: {} }) as Record<string, unknown>));
  if (optionalFields.size === 0) return params.inputSchema;

  // Each declared union arm owns its scope and refinements. Project only the
  // host-supplied fields in those existing arms, rather than flattening them.
  if (params.inputSchema instanceof z.core.$ZodUnion) {
    const options = params.inputSchema._zod.def.options.map((inputSchema: unknown) => (
      projectSessionBoundActionToolInputSchema({ ...params, inputSchema })
    ));
    return options.every((option): option is z.core.$ZodType => option instanceof z.core.$ZodType)
      ? z.core.clone(params.inputSchema, { ...params.inputSchema._zod.def, options })
      : params.inputSchema;
  }

  // Browser automation combines the strict request with its action-kind refinement. Project
  // both sides so host defaults are accepted without dropping either validation contract.
  if (params.inputSchema instanceof z.core.$ZodIntersection) {
    const left = projectSessionBoundActionToolInputSchema({ ...params, inputSchema: params.inputSchema._zod.def.left });
    const right = projectSessionBoundActionToolInputSchema({ ...params, inputSchema: params.inputSchema._zod.def.right });
    return left instanceof z.core.$ZodType && right instanceof z.core.$ZodType
      ? z.core.clone(params.inputSchema, { ...params.inputSchema._zod.def, left, right }) : params.inputSchema;
  }

  // Keep preprocessing and its canonical parser together while projecting
  // host-supplied operands, just as for intersections and union arms above.
  if (params.inputSchema instanceof z.core.$ZodPipe) {
    const input = projectSessionBoundActionToolInputSchema({ ...params, inputSchema: params.inputSchema._zod.def.in });
    const output = projectSessionBoundActionToolInputSchema({ ...params, inputSchema: params.inputSchema._zod.def.out });
    return input instanceof z.core.$ZodType && output instanceof z.core.$ZodType
      ? z.core.clone(params.inputSchema, { ...params.inputSchema._zod.def, in: input, out: output }) : params.inputSchema;
  }

  if (params.inputSchema instanceof z.core.$ZodObject) {
    const shape = params.inputSchema._zod.def.shape;
    const optionalShape = Object.fromEntries(
      [...optionalFields]
        .filter((field) => Object.prototype.hasOwnProperty.call(shape, field))
        .map((field) => [field, z.optional(shape[field]!)]),
    );
    return Object.keys(optionalShape).length === 0
      ? params.inputSchema
      // Preserve the original Classic/Mini constructor, checks and strictness.
      : z.core.clone(params.inputSchema, { ...params.inputSchema._zod.def, shape: { ...shape, ...optionalShape } });
  }

  if (!params.inputSchema || typeof params.inputSchema !== 'object' || Array.isArray(params.inputSchema)) {
    return params.inputSchema;
  }
  const schema = params.inputSchema as Readonly<Record<string, unknown>>;
  if (schema.type !== 'object' || !Array.isArray(schema.required)) return params.inputSchema;
  const required = schema.required.filter((field) => (
    typeof field !== 'string' || !optionalFields.has(field)
  ));
  return required.length === schema.required.length ? params.inputSchema : { ...schema, required };
}

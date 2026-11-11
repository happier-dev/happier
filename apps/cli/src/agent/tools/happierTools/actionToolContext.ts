import { getActionContextualDefaults } from '@happier-dev/protocol/actions/actionSpecs';
import { bindContextualActionToolInput as bindActionInput, type SessionBoundActionToolContext } from '@happier-dev/protocol/actions/actionToolContext';
import type { ActionContextualDefaults } from '@happier-dev/protocol';
import { z } from 'zod/mini';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

export type { SessionBoundActionToolContext } from '@happier-dev/protocol/actions/actionToolContext';

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

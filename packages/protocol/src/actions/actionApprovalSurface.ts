import type { ActionExecutorContext } from './actionExecutor.js';
import type { ActionSurfaces } from './actionSpecs.js';

type NonAgentActionSurfaceKey = Exclude<keyof ActionSurfaces, 'agent'>;
const NON_AGENT_ACTION_SURFACE_KEY_RECORD = {
  ui: true, voice: true, mcp: true, cli: true, rpc: true, api: true, plugin: true,
} satisfies Record<NonAgentActionSurfaceKey, true>;
const NON_AGENT_ACTION_SURFACE_KEYS: ReadonlySet<string> = new Set(Object.keys(NON_AGENT_ACTION_SURFACE_KEY_RECORD));

export type ApprovalSurfaceResolution =
  | Readonly<{ kind: 'agent'; surface: 'agent' }>
  | Readonly<{ kind: 'non_agent'; surface: NonAgentActionSurfaceKey }>
  | Readonly<{ kind: 'ambiguous' }>;

export function resolveApprovalSurface(ctx?: Readonly<{ surface?: ActionExecutorContext['surface'] | null }> | null): ApprovalSurfaceResolution {
  const surface: unknown = ctx?.surface ?? null;
  if (surface === 'agent') return { kind: 'agent', surface };
  if (typeof surface === 'string' && NON_AGENT_ACTION_SURFACE_KEYS.has(surface)) return { kind: 'non_agent', surface: surface as NonAgentActionSurfaceKey };
  return { kind: 'ambiguous' };
}

/** Unknown caller surfaces share the Agent trust boundary and fail closed. */
export function isAgentOrUnresolvedSurface(ctx?: Readonly<{ surface?: ActionExecutorContext['surface'] | null }> | null): boolean {
  const surface = resolveApprovalSurface(ctx);
  return surface.kind === 'agent' || surface.kind === 'ambiguous';
}

/** Agent, external MCP and unresolved surfaces share configurable Agent defaults. */
export function sharesAgentApprovalDefault(surface: ApprovalSurfaceResolution): boolean {
  return surface.kind !== 'non_agent' || surface.surface === 'mcp';
}

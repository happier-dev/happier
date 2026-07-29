import { z } from 'zod';

export const PluginStructuredMessageRendererIdV1Schema = z.enum([
  'actionList',
  'keyValue',
  'markdownSummary',
  'notice',
  'resourceLink',
  'status',
  'summaryCard',
]);
export type PluginStructuredMessageRendererIdV1 = z.infer<typeof PluginStructuredMessageRendererIdV1Schema>;

export const PluginSessionSurfaceRendererIdV1Schema = z.enum([
  'actionPanel',
  'emptyState',
  'fileReference',
  'markdownDetails',
  'previewPlaceholder',
  'resourceSummary',
  'statusTimeline',
  'terminalReference',
]);
export type PluginSessionSurfaceRendererIdV1 = z.infer<typeof PluginSessionSurfaceRendererIdV1Schema>;

export const PluginSessionHeaderActionRendererIdV1Schema = z.enum([
  'badgeButton',
  'iconButton',
  'menuItem',
]);
export type PluginSessionHeaderActionRendererIdV1 = z.infer<typeof PluginSessionHeaderActionRendererIdV1Schema>;

export const PluginUiRendererFamilyV1Schema = z.enum([
  'structuredMessage',
  'sessionSurface',
  'sessionHeaderAction',
  'hostedWeb',
  'reactNative',
]);
export type PluginUiRendererFamilyV1 = z.infer<typeof PluginUiRendererFamilyV1Schema>;

/**
 * Canonical, pure (React-free) source of truth for which `{kind:'host'}` surface
 * placement renderer ids the host can render through a real renderer-id dispatch
 * table (PR-12). Both the CLI projection (`available` gating) and the UI host
 * renderer-id → React component map key off THIS set so projection-availability and
 * the actual render path cannot disagree.
 *
 * Phase 1.4 — ONE renderer registry: the generic `descriptorPanel` AND the 8
 * richer `sessionSurface` renderer ids are unified into this single host-placement
 * set (previously the 8 ids were stranded in a separate enum that the placement
 * path never dispatched, finding #4). The UI `PLUGIN_HOST_RENDERERS` dispatch
 * table is keyed off exactly this set, so there is one dispatch table for native
 * host placements. L5's `KNOWN_HOST_RENDERER_IDS` (surfaceRegistry.ts) treats this
 * as the generic-host renderer universe.
 *
 * Capability-truth: an id only belongs here when the UI has a real descriptor-render
 * component producer for it. `descriptorPanel` renders descriptor-declared display
 * content (title/description/badge) for generic placements such as
 * `workspace.details` and `app.settingsPage`; the session-surface ids render the
 * richer session-pane descriptor surfaces.
 */
export const PLUGIN_HOST_PLACEMENT_RENDERER_IDS = Object.freeze([
  'descriptorPanel',
  ...PluginSessionSurfaceRendererIdV1Schema.options,
] as const);
export type PluginHostPlacementRendererIdV1 = (typeof PLUGIN_HOST_PLACEMENT_RENDERER_IDS)[number];

export const PluginHostPlacementRendererIdV1Schema = z.enum(
  PLUGIN_HOST_PLACEMENT_RENDERER_IDS as unknown as [PluginHostPlacementRendererIdV1, ...PluginHostPlacementRendererIdV1[]],
);

const PLUGIN_HOST_PLACEMENT_RENDERER_ID_SET: ReadonlySet<string> = new Set(
  PLUGIN_HOST_PLACEMENT_RENDERER_IDS,
);

/**
 * Pure predicate: is the given host renderer id one the host can render through the
 * renderer-id dispatch table? Fails closed for unknown/empty/non-string ids.
 */
export function isRenderableHostRendererId(value: unknown): value is PluginHostPlacementRendererIdV1 {
  return typeof value === 'string' && PLUGIN_HOST_PLACEMENT_RENDERER_ID_SET.has(value);
}

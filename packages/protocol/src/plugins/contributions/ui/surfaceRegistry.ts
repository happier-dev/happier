import { z } from 'zod';

import { FEATURE_IDS, type FeatureId } from '../../../features/catalog.js';
import { PluginUiHostApiMethodV1Schema, type PluginUiHostApiMethodV1 } from '../../ui/hostApi.js';
import { PluginUiPredicateOperandV1Schema, type PluginUiPredicateOperandV1 } from './predicates.js';
import {
  PLUGIN_HOST_PLACEMENT_RENDERER_IDS,
  PluginSessionHeaderActionRendererIdV1Schema,
  PluginSessionSurfaceRendererIdV1Schema,
  PluginStructuredMessageRendererIdV1Schema,
} from './renderers.js';
import { PluginSessionHeaderActionDescriptorV1Schema } from './sessionHeaderActions.js';
import { PluginStructuredMessageDescriptorV1Schema } from './structuredMessages.js';
import { PluginSurfacePlacementDescriptorV1Schema } from './surfacePlacements.js';

/**
 * Surface Registry — the 8th canonical plugin-UI primitive (FINALIZATION-PLAN §16).
 *
 * One structural `SurfaceDescriptor` keyed by surface TYPE that feeds every pipeline
 * owner, replacing the historically-scattered surface knowledge:
 *   - the placement enum (`PluginSurfacePlacementKindV1Schema`)
 *   - the second `sessionSurfaces` renderer enum (`PluginSessionSurfaceRendererIdV1Schema`)
 *   - the `surfaceContext` placement enum + `resolveSurfaceContextPlacement` mapper
 *   - the placement->target `superRefine` coupling in `surfacePlacements.ts`
 *
 * This module is ADDITIVE. It introduces the descriptor contract + a populated
 * registry of the real surface types, but migrates no consumer onto it — the
 * existing projection/render keeps working unchanged (Phase 2 consumes this).
 */

// ---------------------------------------------------------------------------
// Surface type ids (modeled off the existing placement / session-surface enums,
// plus the merged `session.headerAction` and the `session.structuredMessage`
// transcript surface).
// ---------------------------------------------------------------------------

export const PluginSurfaceTypeIdV1Schema = z.enum([
  'session.details',
  'session.preview',
  'session.tool',
  'session.side',
  'session.rightSidebarTab',
  'session.headerAction',
  'session.structuredMessage',
  'workspace.details',
  'workspace.main',
  'project.details',
  'project.main',
  'project.rightSidebarTab',
  'app.settingsPage',
  'app.sidePanel',
  'app.bottomPanel',
  'app.rightSidebarTab',
  'browser.panel',
  'services.panel',
]);
export type PluginSurfaceTypeIdV1 = z.infer<typeof PluginSurfaceTypeIdV1Schema>;

export const PluginSurfaceScopeV1Schema = z.enum([
  'session',
  'project',
  'app',
  'workspace',
  'browser',
  'services',
]);
export type PluginSurfaceScopeV1 = z.infer<typeof PluginSurfaceScopeV1Schema>;

export const PluginSurfaceCategoryV1Schema = z.enum([
  'panel',
  'action',
  'message',
  'container',
]);
export type PluginSurfaceCategoryV1 = z.infer<typeof PluginSurfaceCategoryV1Schema>;

/**
 * Runtime modes a surface can be rendered through. Names follow §16's vocabulary;
 * `embeddedWeb` maps to the embedded-web renderer-ref kind and `reactNative`
 * to the RN host. `*Bundle` names are reserved for artifact kinds/families.
 */
export const PluginSurfaceRuntimeModeV1Schema = z.enum([
  'host',
  'declarative',
  'structured',
  'action',
  'hostedWeb',
  'embeddedWeb',
  'reactNative',
]);
export type PluginSurfaceRuntimeModeV1 = z.infer<typeof PluginSurfaceRuntimeModeV1Schema>;

/**
 * The closed set of live runtime hosts. Faithful to the actual
 * `PluginSurfaceHost` mount dispatch (`host` -> native blueprint host;
 * `hostedWeb`/`embeddedWeb` -> sandboxed web/webview host;
 * `reactNative` -> RN host).
 */
export const PluginSurfaceRuntimeHostV1Schema = z.enum([
  'nativeBlueprintHost',
  'sandboxedWebHost',
  'reactNativeHost',
]);
export type PluginSurfaceRuntimeHostV1 = z.infer<typeof PluginSurfaceRuntimeHostV1Schema>;

export const LIVE_SURFACE_RUNTIME_HOSTS: readonly PluginSurfaceRuntimeHostV1[] = Object.freeze(
  PluginSurfaceRuntimeHostV1Schema.options,
);

/**
 * Canonical mode -> live host binding. Single source of truth for "which host
 * serves a mode"; the closure test re-derives `rendererSet` hosts from this.
 */
export const CANONICAL_RUNTIME_MODE_HOST: Readonly<
  Record<PluginSurfaceRuntimeModeV1, PluginSurfaceRuntimeHostV1>
> = Object.freeze({
  host: 'nativeBlueprintHost',
  declarative: 'nativeBlueprintHost',
  structured: 'nativeBlueprintHost',
  action: 'nativeBlueprintHost',
  hostedWeb: 'sandboxedWebHost',
  embeddedWeb: 'sandboxedWebHost',
  reactNative: 'reactNativeHost',
});

function isNativeBlueprintMode(mode: PluginSurfaceRuntimeModeV1): boolean {
  return CANONICAL_RUNTIME_MODE_HOST[mode] === 'nativeBlueprintHost';
}

// ---------------------------------------------------------------------------
// Category-derived default modes + per-surface EXCLUSIONS deny-list (§16).
//
// The default mode-set is derived from the surface category, NOT blanket-all.
// `panel` gets every render mode; `action`/`message`/`container` get only the
// modes that make sense for them. Per-surface `exclusions` carry ONLY true
// within-category exceptions (a deny-list, never an allowlist), so adding a mode
// to a uniform same-category surface is still ZERO files.
// ---------------------------------------------------------------------------

const CATEGORY_DEFAULT_RUNTIME_MODES: Readonly<
  Record<PluginSurfaceCategoryV1, readonly PluginSurfaceRuntimeModeV1[]>
> = Object.freeze({
  panel: Object.freeze(['host', 'hostedWeb', 'embeddedWeb', 'reactNative'] as const),
  action: Object.freeze(['declarative', 'action'] as const),
  message: Object.freeze(['structured'] as const),
  container: Object.freeze(['host', 'declarative'] as const),
});

export function deriveDefaultRuntimeModesForCategory(
  category: PluginSurfaceCategoryV1,
): readonly PluginSurfaceRuntimeModeV1[] {
  return CATEGORY_DEFAULT_RUNTIME_MODES[category];
}

/**
 * `supportedRuntimeModes = categoryDefault - exclusions` (order-preserving).
 * Exclusions not present in the default are no-ops, so the result is always a
 * subset of the category default ("the deny-list never adds").
 */
export function resolveSupportedRuntimeModes(
  category: PluginSurfaceCategoryV1,
  exclusions: readonly PluginSurfaceRuntimeModeV1[] = [],
): readonly PluginSurfaceRuntimeModeV1[] {
  const excluded = new Set<PluginSurfaceRuntimeModeV1>(exclusions);
  return Object.freeze(
    deriveDefaultRuntimeModesForCategory(category).filter((mode) => !excluded.has(mode)),
  );
}

// ---------------------------------------------------------------------------
// Host-API allowlist (closed PluginUiHostApi method set the surface grants).
// ---------------------------------------------------------------------------

const ALL_HOST_API_METHODS: readonly PluginUiHostApiMethodV1[] = Object.freeze(
  PluginUiHostApiMethodV1Schema.options,
);

const CATEGORY_DEFAULT_HOST_API_METHODS: Readonly<
  Record<PluginSurfaceCategoryV1, readonly PluginUiHostApiMethodV1[]>
> = Object.freeze({
  panel: ALL_HOST_API_METHODS,
  container: Object.freeze([
    'getSurfaceContext',
    'requestSessionResource',
    'subscribeResource',
    'unsubscribeResource',
    'openSurface',
    'logDiagnostic',
  ] as const),
  action: Object.freeze([
    'getSurfaceContext',
    'dispatchAction',
    'openSurface',
    'copy',
    'openExternal',
    'logDiagnostic',
  ] as const),
  message: Object.freeze([
    'getSurfaceContext',
    'dispatchAction',
    'copy',
    'openExternal',
    'logDiagnostic',
  ] as const),
});

export function defaultHostApiMethodsForCategory(
  category: PluginSurfaceCategoryV1,
): readonly PluginUiHostApiMethodV1[] {
  return CATEGORY_DEFAULT_HOST_API_METHODS[category];
}

export type PluginSurfaceHostApiShapeV1 = Readonly<{
  methods: readonly PluginUiHostApiMethodV1[];
}>;

// ---------------------------------------------------------------------------
// Anchor — two-level container<-content binding (replaces the placement->target
// `superRefine` coupling). `container` is the UI region; `content` is the
// resource kind bound into it.
// ---------------------------------------------------------------------------

export const PluginSurfaceContainerIdV1Schema = z.enum([
  'sessionDetailPane',
  'sessionPreviewPane',
  'sessionToolPane',
  'sessionSidePane',
  'sessionHeader',
  'transcript',
  'rightSidebar',
  'workspaceDetailPane',
  'workspaceMain',
  'projectDetailPane',
  'projectMain',
  'appSettingsPage',
  'appSidePanel',
  'appBottomPanel',
  'browserPanel',
  'servicesPanel',
]);
export type PluginSurfaceContainerIdV1 = z.infer<typeof PluginSurfaceContainerIdV1Schema>;

export const PluginSurfaceContentBindingV1Schema = z.enum([
  'session',
  'project',
  'app',
  'workspace',
  'browser',
  'services',
]);
export type PluginSurfaceContentBindingV1 = z.infer<typeof PluginSurfaceContentBindingV1Schema>;

export type PluginSurfaceAnchorV1 = Readonly<{
  container: PluginSurfaceContainerIdV1;
  content: PluginSurfaceContentBindingV1;
}>;

// ---------------------------------------------------------------------------
// Renderer set — per-mode binding to a live host. Native-host modes carry the
// allowed host renderer ids (this unifies the previously-split renderer enums:
// the generic `descriptorPanel`, the 8 `sessionSurface` ids, the structured
// message ids, and the header-action ids into ONE registry).
// ---------------------------------------------------------------------------

export type PluginSurfaceRendererBindingV1 = Readonly<{
  host: PluginSurfaceRuntimeHostV1;
  rendererIds?: readonly string[];
}>;
export type PluginSurfaceRendererSetV1 = Readonly<
  Partial<Record<PluginSurfaceRuntimeModeV1, PluginSurfaceRendererBindingV1>>
>;

export const SESSION_SURFACE_HOST_RENDERER_IDS: readonly string[] = Object.freeze([
  ...PluginSessionSurfaceRendererIdV1Schema.options,
]);
export const STRUCTURED_MESSAGE_HOST_RENDERER_IDS: readonly string[] = Object.freeze([
  ...PluginStructuredMessageRendererIdV1Schema.options,
]);
export const SESSION_HEADER_ACTION_RENDERER_IDS: readonly string[] = Object.freeze([
  ...PluginSessionHeaderActionRendererIdV1Schema.options,
]);
export const GENERIC_HOST_RENDERER_IDS: readonly string[] = Object.freeze([
  ...PLUGIN_HOST_PLACEMENT_RENDERER_IDS,
]);

/**
 * The single recognized native-host renderer-id universe. A descriptor may only
 * bind native-host modes to ids in this set; the closure test enforces it. This
 * is the canonical collapse of the previously-separate renderer enums.
 */
export const KNOWN_HOST_RENDERER_IDS: ReadonlySet<string> = new Set<string>([
  ...GENERIC_HOST_RENDERER_IDS,
  ...SESSION_SURFACE_HOST_RENDERER_IDS,
  ...STRUCTURED_MESSAGE_HOST_RENDERER_IDS,
  ...SESSION_HEADER_ACTION_RENDERER_IDS,
]);

// ---------------------------------------------------------------------------
// when-gating — declares the fail-closed gate (server enabled bit +
// dependency closure + context keys). DECLARED here; EVALUATED by the Phase-2
// policy evaluator via `readServerEnabledBit(payload, featureId) === true` and
// `applyFeatureDependencies(...)`.
// ---------------------------------------------------------------------------

export type PluginSurfaceWhenGatingV1 = Readonly<{
  featureId: FeatureId;
  contextKeys: readonly PluginUiPredicateOperandV1[];
  failClosed: true;
}>;

const FEATURE_ID_SET: ReadonlySet<string> = new Set<string>(FEATURE_IDS);

// ---------------------------------------------------------------------------
// SurfaceDescriptor — the contract.
// ---------------------------------------------------------------------------

export type PluginSurfaceDescriptorV1 = Readonly<{
  id: PluginSurfaceTypeIdV1;
  scope: PluginSurfaceScopeV1;
  category: PluginSurfaceCategoryV1;
  anchor: PluginSurfaceAnchorV1;
  exclusions: readonly PluginSurfaceRuntimeModeV1[];
  supportedRuntimeModes: readonly PluginSurfaceRuntimeModeV1[];
  contributionSchema: z.ZodTypeAny;
  hostApiShape: PluginSurfaceHostApiShapeV1;
  rendererSet: PluginSurfaceRendererSetV1;
  whenGating: PluginSurfaceWhenGatingV1;
}>;

type DefineSurfaceDescriptorInput = Readonly<{
  id: PluginSurfaceTypeIdV1;
  scope: PluginSurfaceScopeV1;
  category: PluginSurfaceCategoryV1;
  anchor: PluginSurfaceAnchorV1;
  contributionSchema: z.ZodTypeAny;
  whenGating: Readonly<{
    featureId: FeatureId;
    contextKeys?: readonly PluginUiPredicateOperandV1[];
  }>;
  exclusions?: readonly PluginSurfaceRuntimeModeV1[];
  /** Native-host renderer ids per native mode (host/declarative/structured/action). */
  hostRendererIdsByMode?: Readonly<Partial<Record<PluginSurfaceRuntimeModeV1, readonly string[]>>>;
  hostApiMethods?: readonly PluginUiHostApiMethodV1[];
}>;

/**
 * Build + validate one descriptor. Reject-at-construction guards make illegal
 * descriptors unrepresentable (complements reject-at-projection):
 *  - native-host supported modes MUST declare known renderer ids
 *  - web/RN supported modes MUST NOT declare renderer ids
 *  - `anchor.content` MUST equal `scope` (the unified placement->target coupling)
 *  - `whenGating.featureId` MUST be a real catalog feature id
 */
export function defineSurfaceDescriptor(
  input: DefineSurfaceDescriptorInput,
): PluginSurfaceDescriptorV1 {
  const exclusions = Object.freeze([...(input.exclusions ?? [])]);
  const supportedRuntimeModes = resolveSupportedRuntimeModes(input.category, exclusions);

  if (input.anchor.content !== input.scope) {
    throw new Error(
      `Surface '${input.id}' anchor.content (${input.anchor.content}) must equal scope (${input.scope}).`,
    );
  }
  if (!FEATURE_ID_SET.has(input.whenGating.featureId)) {
    throw new Error(
      `Surface '${input.id}' whenGating.featureId '${input.whenGating.featureId}' is not a catalog feature id.`,
    );
  }

  const rendererSet: Partial<Record<PluginSurfaceRuntimeModeV1, PluginSurfaceRendererBindingV1>> = {};

  for (const mode of supportedRuntimeModes) {
    const host = CANONICAL_RUNTIME_MODE_HOST[mode];
    const declaredRendererIds = input.hostRendererIdsByMode?.[mode];
    if (isNativeBlueprintMode(mode)) {
      if (!declaredRendererIds || declaredRendererIds.length === 0) {
        throw new Error(
          `Surface '${input.id}' native mode '${mode}' must declare at least one host renderer id.`,
        );
      }
      for (const rendererId of declaredRendererIds) {
        if (!KNOWN_HOST_RENDERER_IDS.has(rendererId)) {
          throw new Error(
            `Surface '${input.id}' mode '${mode}' references unknown host renderer id '${rendererId}'.`,
          );
        }
      }
      rendererSet[mode] = Object.freeze({ host, rendererIds: Object.freeze([...declaredRendererIds]) });
    } else {
      if (declaredRendererIds && declaredRendererIds.length > 0) {
        throw new Error(
          `Surface '${input.id}' non-native mode '${mode}' must not declare host renderer ids.`,
        );
      }
      rendererSet[mode] = Object.freeze({ host });
    }
  }

  return Object.freeze({
    id: input.id,
    scope: input.scope,
    category: input.category,
    anchor: Object.freeze({ ...input.anchor }),
    exclusions,
    supportedRuntimeModes,
    contributionSchema: input.contributionSchema,
    hostApiShape: Object.freeze({
      methods: Object.freeze([
        ...(input.hostApiMethods ?? defaultHostApiMethodsForCategory(input.category)),
      ]),
    }),
    rendererSet: Object.freeze(rendererSet),
    whenGating: Object.freeze({
      featureId: input.whenGating.featureId,
      contextKeys: Object.freeze([...(input.whenGating.contextKeys ?? [])]),
      failClosed: true,
    }),
  });
}

// ---------------------------------------------------------------------------
// Mode selection — trivial "pick first-available provided mode" (§16). The
// declared `supportedRuntimeModes` order IS the selection order. Configurable
// preference/fallback ORDER is deferred to P2 (YAGNI until a 2-mode producer
// exists).
// ---------------------------------------------------------------------------

export type SelectRuntimeModeOptionsV1 = Readonly<{
  providedModes: readonly PluginSurfaceRuntimeModeV1[];
  isRuntimeAvailable?: (mode: PluginSurfaceRuntimeModeV1) => boolean;
  isTrustCompatible?: (mode: PluginSurfaceRuntimeModeV1) => boolean;
}>;

export function selectFirstAvailableRuntimeMode(
  descriptor: PluginSurfaceDescriptorV1,
  options: SelectRuntimeModeOptionsV1,
): PluginSurfaceRuntimeModeV1 | null {
  const provided = new Set<PluginSurfaceRuntimeModeV1>(options.providedModes);
  for (const mode of descriptor.supportedRuntimeModes) {
    if (!provided.has(mode)) continue;
    if (options.isRuntimeAvailable && !options.isRuntimeAvailable(mode)) continue;
    if (options.isTrustCompatible && !options.isTrustCompatible(mode)) continue;
    return mode;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reject-at-projection — validate a raw contribution against the descriptor
// `contributionSchema` (and, optionally, its provided modes against
// `supportedRuntimeModes`).
// ---------------------------------------------------------------------------

export type PluginSurfaceProjectionResultV1 =
  | Readonly<{ status: 'projected'; surfaceId: PluginSurfaceTypeIdV1; value: unknown }>
  | Readonly<{
      status: 'rejected';
      surfaceId: string;
      reason: 'unknown_surface' | 'schema_mismatch' | 'mode_unsupported';
      diagnostics: readonly string[];
    }>;

export type ProjectContributionOptionsV1 = Readonly<{
  providedModes?: readonly PluginSurfaceRuntimeModeV1[];
}>;

// ---------------------------------------------------------------------------
// The registry — single id-keyed collection. `createPluginSurfaceRegistry`
// rejects duplicate ids (discharges §13.5.6 id-uniqueness: one id-keyed
// registry, no double-render risk).
// ---------------------------------------------------------------------------

export interface PluginSurfaceRegistryV1 {
  get(id: string): PluginSurfaceDescriptorV1 | undefined;
  has(id: string): boolean;
  ids(): readonly PluginSurfaceTypeIdV1[];
  list(): readonly PluginSurfaceDescriptorV1[];
  projectContribution(
    id: string,
    rawContribution: unknown,
    options?: ProjectContributionOptionsV1,
  ): PluginSurfaceProjectionResultV1;
  selectRuntimeMode(
    id: string,
    options: SelectRuntimeModeOptionsV1,
  ): PluginSurfaceRuntimeModeV1 | null;
}

export function createPluginSurfaceRegistry(
  descriptors: readonly PluginSurfaceDescriptorV1[],
): PluginSurfaceRegistryV1 {
  const byId = new Map<string, PluginSurfaceDescriptorV1>();
  for (const descriptor of descriptors) {
    if (byId.has(descriptor.id)) {
      throw new Error(`Duplicate surface descriptor id '${descriptor.id}' in surface registry.`);
    }
    byId.set(descriptor.id, descriptor);
  }
  const ordered = Object.freeze([...descriptors]);
  const orderedIds = Object.freeze(ordered.map((descriptor) => descriptor.id));

  const registry: PluginSurfaceRegistryV1 = {
    get(id: string): PluginSurfaceDescriptorV1 | undefined {
      return byId.get(id);
    },
    has(id: string): boolean {
      return byId.has(id);
    },
    ids(): readonly PluginSurfaceTypeIdV1[] {
      return orderedIds;
    },
    list(): readonly PluginSurfaceDescriptorV1[] {
      return ordered;
    },
    projectContribution(
      id: string,
      rawContribution: unknown,
      options?: ProjectContributionOptionsV1,
    ): PluginSurfaceProjectionResultV1 {
      const descriptor = byId.get(id);
      if (!descriptor) {
        return {
          status: 'rejected',
          surfaceId: id,
          reason: 'unknown_surface',
          diagnostics: [`No surface descriptor registered for '${id}'.`],
        };
      }
      const parsed = descriptor.contributionSchema.safeParse(rawContribution);
      if (!parsed.success) {
        return {
          status: 'rejected',
          surfaceId: id,
          reason: 'schema_mismatch',
          diagnostics: parsed.error.issues.map(
            (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
          ),
        };
      }
      if (options?.providedModes) {
        const supported = new Set<PluginSurfaceRuntimeModeV1>(descriptor.supportedRuntimeModes);
        const unsupported = options.providedModes.filter((mode) => !supported.has(mode));
        if (unsupported.length > 0) {
          return {
            status: 'rejected',
            surfaceId: id,
            reason: 'mode_unsupported',
            diagnostics: unsupported.map(
              (mode) => `Mode '${mode}' is not in supportedRuntimeModes for surface '${id}'.`,
            ),
          };
        }
      }
      return { status: 'projected', surfaceId: descriptor.id, value: parsed.data };
    },
    selectRuntimeMode(
      id: string,
      options: SelectRuntimeModeOptionsV1,
    ): PluginSurfaceRuntimeModeV1 | null {
      const descriptor = byId.get(id);
      if (!descriptor) return null;
      return selectFirstAvailableRuntimeMode(descriptor, options);
    },
  };

  return Object.freeze(registry);
}

// ---------------------------------------------------------------------------
// Populated descriptors for the ACTUAL known surface types.
// ---------------------------------------------------------------------------

function sessionPaneDescriptor(
  id: Extract<
    PluginSurfaceTypeIdV1,
    'session.details' | 'session.preview' | 'session.tool' | 'session.side'
  >,
  container: Extract<
    PluginSurfaceContainerIdV1,
    'sessionDetailPane' | 'sessionPreviewPane' | 'sessionToolPane' | 'sessionSidePane'
  >,
): PluginSurfaceDescriptorV1 {
  return defineSurfaceDescriptor({
    id,
    scope: 'session',
    category: 'panel',
    anchor: { container, content: 'session' },
    contributionSchema: PluginSurfacePlacementDescriptorV1Schema,
    whenGating: { featureId: 'plugins.ui', contextKeys: ['session.hasBackend'] },
    hostRendererIdsByMode: { host: SESSION_SURFACE_HOST_RENDERER_IDS },
  });
}

function genericPanelDescriptor(
  id: PluginSurfaceTypeIdV1,
  scope: PluginSurfaceScopeV1,
  container: PluginSurfaceContainerIdV1,
  content: PluginSurfaceContentBindingV1,
  contextKeys: readonly PluginUiPredicateOperandV1[] = [],
): PluginSurfaceDescriptorV1 {
  return defineSurfaceDescriptor({
    id,
    scope,
    category: 'panel',
    anchor: { container, content },
    contributionSchema: PluginSurfacePlacementDescriptorV1Schema,
    whenGating: { featureId: 'plugins.ui', contextKeys },
    hostRendererIdsByMode: { host: GENERIC_HOST_RENDERER_IDS },
  });
}

export const SURFACE_DESCRIPTORS: readonly PluginSurfaceDescriptorV1[] = Object.freeze([
  // Session panes (panel).
  sessionPaneDescriptor('session.details', 'sessionDetailPane'),
  sessionPaneDescriptor('session.preview', 'sessionPreviewPane'),
  sessionPaneDescriptor('session.tool', 'sessionToolPane'),
  sessionPaneDescriptor('session.side', 'sessionSidePane'),

  // Session right-sidebar tab (panel; shared `rightSidebar` container, session content).
  genericPanelDescriptor('session.rightSidebarTab', 'session', 'rightSidebar', 'session'),

  // Session header action (action) — the merged `sessionHeaderActions` surface.
  defineSurfaceDescriptor({
    id: 'session.headerAction',
    scope: 'session',
    category: 'action',
    anchor: { container: 'sessionHeader', content: 'session' },
    contributionSchema: PluginSessionHeaderActionDescriptorV1Schema,
    whenGating: { featureId: 'plugins.ui', contextKeys: ['session.hasBackend'] },
    hostRendererIdsByMode: {
      declarative: SESSION_HEADER_ACTION_RENDERER_IDS,
      action: SESSION_HEADER_ACTION_RENDERER_IDS,
    },
  }),

  // Session structured message (message) — transcript renderer concern.
  defineSurfaceDescriptor({
    id: 'session.structuredMessage',
    scope: 'session',
    category: 'message',
    anchor: { container: 'transcript', content: 'session' },
    contributionSchema: PluginStructuredMessageDescriptorV1Schema,
    whenGating: { featureId: 'plugins.ui.structuredMessages', contextKeys: ['message.kind'] },
    hostRendererIdsByMode: { structured: STRUCTURED_MESSAGE_HOST_RENDERER_IDS },
  }),

  // Workspace panels.
  genericPanelDescriptor('workspace.details', 'workspace', 'workspaceDetailPane', 'workspace'),
  genericPanelDescriptor('workspace.main', 'workspace', 'workspaceMain', 'workspace'),

  // Project panels.
  genericPanelDescriptor('project.details', 'project', 'projectDetailPane', 'project'),
  genericPanelDescriptor('project.main', 'project', 'projectMain', 'project'),
  genericPanelDescriptor('project.rightSidebarTab', 'project', 'rightSidebar', 'project'),

  // App surfaces.
  defineSurfaceDescriptor({
    id: 'app.settingsPage',
    scope: 'app',
    category: 'container',
    anchor: { container: 'appSettingsPage', content: 'app' },
    contributionSchema: PluginSurfacePlacementDescriptorV1Schema,
    whenGating: { featureId: 'plugins.ui', contextKeys: [] },
    hostRendererIdsByMode: {
      host: GENERIC_HOST_RENDERER_IDS,
      declarative: GENERIC_HOST_RENDERER_IDS,
    },
  }),
  genericPanelDescriptor('app.sidePanel', 'app', 'appSidePanel', 'app'),
  genericPanelDescriptor('app.bottomPanel', 'app', 'appBottomPanel', 'app'),
  genericPanelDescriptor('app.rightSidebarTab', 'app', 'rightSidebar', 'app'),

  // Browser + services panels.
  genericPanelDescriptor('browser.panel', 'browser', 'browserPanel', 'browser'),
  genericPanelDescriptor('services.panel', 'services', 'servicesPanel', 'services'),
]);

export const PLUGIN_SURFACE_REGISTRY: PluginSurfaceRegistryV1 =
  createPluginSurfaceRegistry(SURFACE_DESCRIPTORS);

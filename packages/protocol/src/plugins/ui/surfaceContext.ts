import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import {
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../contributionIdentity.js';
import { PluginUiChannelV1Schema, PluginUiPlatformV1Schema } from '../contributions/ui/compatibility.js';
import { PluginSessionResourceTargetV1Schema } from '../contributions/ui/resources.js';
import {
  PluginUiDestinationContainerV1Schema,
  type PluginUiDestinationContainerV1,
} from '../contributions/ui/surfaceRegistry.js';
import { PluginUiTargetedContributionsV1Schema } from './targetedContributions.js';
import {
  PluginUiSurfacePlacementV1Schema,
  type PluginUiSurfacePlacementV1,
} from './surfaceContextPlacement.js';

// Preserve the surface-context schema import while keeping request-envelope
// initialization independent from the destination registry. Mounted hosts
// consume the registry-derived context carried by a normalized binding; the
// semantic contribution families supply their own two context values.
export { PluginUiSurfacePlacementV1Schema } from './surfaceContextPlacement.js';
export type { PluginUiSurfacePlacementV1 } from './surfaceContextPlacement.js';

/**
 * The author-visible mounting fact for a plugin UI surface.
 *
 * A destination is stamped from the normalized destination binding; embedded
 * surfaces intentionally carry no invented destination identity or container.
 * This schema is separate from the host-private legacy request context below:
 * the latter remains the controller's coarse dispatch key, while this union is
 * the one public SDK truth rendered to an author.
 */
export const PluginUiMountContextV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('destination'),
    destination: asProtocolZod(PluginContributionIdentityV1Schema),
    container: PluginUiDestinationContainerV1Schema,
  }),
  z.strictObject({
    kind: z.literal('embedded'),
    role: z.string().check(z.trim(), z.minLength(1)),
    presentation: z.enum(['content', 'fill']),
  }),
]));
export type PluginUiMountContextV1 =
  | Readonly<{
    kind: 'destination';
    destination: PluginContributionIdentityV1;
    container: PluginUiDestinationContainerV1;
  }>
  | Readonly<{
    kind: 'embedded';
    role: string;
    presentation: 'content' | 'fill';
  }>;

/**
 * Preserve transport values exactly while rejecting strings that cannot name a
 * current public surface fact. The mounted transport already has JSON-safe
 * values; this is an author-facing payload grammar, not a normalizer.
 */
const PluginUiHostApiSurfaceNonBlankStringV1Schema = lazyZodSchema(() => z.string().check(z.refine((value) => value.trim().length > 0, 'Expected a non-blank string.')));

/** The exact mounted target disclosure carried to an author-facing UI. */
export const PluginUiHostApiSurfaceTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('app') }),
  z.strictObject({
    kind: z.literal('session'),
    sessionId: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    agentId: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  }),
  z.strictObject({
    kind: z.literal('project'),
    projectId: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }),
  z.strictObject({
    kind: z.literal('browser'),
    targetId: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    origin: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  }),
  z.strictObject({ kind: z.literal('services') }),
]));
export type PluginUiHostApiSurfaceTargetV1 = z.infer<
  typeof PluginUiHostApiSurfaceTargetV1Schema
>;

const PluginUiHostApiSurfaceMetricV1Schema = lazyZodSchema(() => z.number().check(z.nonnegative()));

const PluginUiHostApiSurfaceThemeTypographyV1Schema = lazyZodSchema(() => z.strictObject({
  body: z.strictObject({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }),
  /** Reading prose (a detail's body, a story step): a step above `body`, the dense row meta line. */
  reading: z.strictObject({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }),
  label: z.strictObject({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }),
  title: z.strictObject({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }),
  caption: z.strictObject({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }),
  code: z.strictObject({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontFamily: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  }),
}));

/** The complete semantic theme payload, not a style-system object. */
export const PluginUiHostApiSurfaceThemeV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  /** Optional host presentation choices. Unknown ids use the shared renderer's defaults. */
  spinner: z.optional(z.strictObject({
    style: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    speed: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    pause: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  })),
  // Presentation-only V1 addition. The map, gradient and coordinates drop unknown fields;
  // the surrounding identity/authority context remains closed.
  surfaceFinish: z.optional(z.object({
    card: z.optional(z.nullable(surfaceFinishGradientSchema())),
    floating: z.optional(z.nullable(surfaceFinishGradientSchema())),
    composer: z.optional(z.nullable(surfaceFinishGradientSchema())),
    primaryButton: z.optional(z.nullable(surfaceFinishGradientSchema())),
    secondaryButton: z.optional(z.nullable(surfaceFinishGradientSchema())),
  })),
  colors: z.strictObject({
    canvas: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    surface: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    elevatedSurface: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    text: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    secondaryText: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    mutedText: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    border: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    divider: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    focus: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    accent: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    onAccent: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    /** The one accent data marks are drawn in (series, meters); the ramp of its tones tells series apart. Older snapshots omit it. */
    dataAccent: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
    success: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    warning: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    /** "Needs you": the host's one attention ink (its Brand amber), distinct from a caution warning. */
    attention: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    danger: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    info: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    control: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    controlDisabled: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    overlay: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }),
  /** Text on tinted status surfaces; marker/icon colours remain in `colors`. Older snapshots omit it. */
  statusText: z.optional(z.strictObject({
    success: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    warning: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    attention: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    danger: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    info: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    neutral: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  })),
  /** Faint tints behind status words (a composer status item's capsule). Older snapshots omit it. */
  statusTint: z.optional(z.strictObject({
    success: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    warning: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    attention: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    danger: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    info: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    neutral: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  })),
  spacing: z.strictObject({
    xsmall: PluginUiHostApiSurfaceMetricV1Schema,
    small: PluginUiHostApiSurfaceMetricV1Schema,
    medium: PluginUiHostApiSurfaceMetricV1Schema,
    large: PluginUiHostApiSurfaceMetricV1Schema,
    xlarge: PluginUiHostApiSurfaceMetricV1Schema,
  }),
  radii: z.strictObject({
    small: PluginUiHostApiSurfaceMetricV1Schema,
    control: PluginUiHostApiSurfaceMetricV1Schema,
    panel: PluginUiHostApiSurfaceMetricV1Schema,
    pill: PluginUiHostApiSurfaceMetricV1Schema,
  }),
  typography: PluginUiHostApiSurfaceThemeTypographyV1Schema,
}));
export type PluginUiHostApiSurfaceThemeV1 = z.infer<
  typeof PluginUiHostApiSurfaceThemeV1Schema
>;

function surfaceFinishGradientSchema() {
  const point = z.object({ x: z.number(), y: z.number() });
  return z.object({
    colors: z.tuple([PluginUiHostApiSurfaceNonBlankStringV1Schema, PluginUiHostApiSurfaceNonBlankStringV1Schema], PluginUiHostApiSurfaceNonBlankStringV1Schema),
    locations: z.optional(z.tuple([z.number(), z.number()], z.number())),
    start: z.optional(point), end: z.optional(point),
    band: z.optional(z.object({ edge: z.enum(['top', 'bottom']), height: z.number() })),
  });
}

/**
 * The one strict browser-safe rich payload for `context()` and `watchContext`.
 *
 * `PluginUiSurfaceContextV1Schema` below remains the separate host-private
 * request dispatch key. It is not an alternate author payload grammar.
 */
export const PluginUiHostApiSurfaceContextV1Schema = lazyZodSchema(() => z.strictObject({
  mount: PluginUiMountContextV1Schema,
  target: PluginUiHostApiSurfaceTargetV1Schema,
  /** Host page chrome for app pages; absent on other surface placements. */
  page: z.optional(z.strictObject({ columnVisible: z.boolean() })),
  /** The mount's existing approval presenter fact, not an approval or effect authority. */
  pendingApproval: z.optional(z.nullable(z.strictObject({
    artifactId: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    href: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }))),
  /** Presentation-only: the host is establishing its selected Machine capabilities. */
  machineConnectionPending: z.optional(z.boolean()),
  /** Read-only exact-target availability; a positive edge can resume a refused read, never authorize an effect. */
  machineExecutionReady: z.optional(z.boolean()),
  /** Read-only requester-origin admission, independent of any callee or selected Machine. */
  requesterExecutionReady: z.optional(z.boolean()),
  accountEncryptionMode: z.enum(['plain', 'e2ee']),
  platform: PluginUiPlatformV1Schema,
  locale: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  direction: z.enum(['ltr', 'rtl']),
  colorScheme: z.enum(['light', 'dark']),
  contrast: z.enum(['normal', 'high']),
  textScale: z.number().check(z.positive()),
  reducedMotion: z.boolean(),
  screenReaderEnabled: z.boolean(),
  safeAreaInsets: z.strictObject({
    top: PluginUiHostApiSurfaceMetricV1Schema,
    right: PluginUiHostApiSurfaceMetricV1Schema,
    bottom: PluginUiHostApiSurfaceMetricV1Schema,
    left: PluginUiHostApiSurfaceMetricV1Schema,
  }),
  theme: PluginUiHostApiSurfaceThemeV1Schema,
  translations: z.record(z.string(), z.string()),
  targetedContributions: z.optional(PluginUiTargetedContributionsV1Schema),
}));
export type PluginUiHostApiSurfaceContextV1 = z.infer<
  typeof PluginUiHostApiSurfaceContextV1Schema
>;

/** One current hosted render snapshot for context reads and watches. */
export const PluginUiHostApiRenderContextSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  surface: PluginUiHostApiSurfaceContextV1Schema,
  activity: z.strictObject({ active: z.boolean() }),
}));
export type PluginUiHostApiRenderContextSnapshotV1 = z.infer<
  typeof PluginUiHostApiRenderContextSnapshotV1Schema
>;

export const PluginUiSurfaceContextV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.trim(), z.minLength(1)),
  contributionId: z.string().check(z.trim(), z.minLength(1)),
  surfaceId: z.string().check(z.trim(), z.minLength(1)),
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  placement: z._default(PluginUiSurfacePlacementV1Schema, 'unknown'),
  platform: PluginUiPlatformV1Schema,
  channel: PluginUiChannelV1Schema,
  resourceScope: z._default(z.array(PluginSessionResourceTargetV1Schema), []),
  diagnostics: z._default(z.array(z.string().check(z.trim(), z.minLength(1))), []),
}));
export type PluginUiSurfaceContextV1 = z.infer<typeof PluginUiSurfaceContextV1Schema>;

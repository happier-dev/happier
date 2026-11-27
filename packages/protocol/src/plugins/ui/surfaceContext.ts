import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginUiPageNavigationProjectionV1Schema } from './pageNavigation.js';
import { z } from '../../zodRuntimePolicy.js';
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
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import { PluginIdSchema } from '../pluginId.js';
import { PluginUiInstanceKeyV1Schema, PluginUiLaunchInputV1Schema, PluginUiSubPathV1Schema, type PluginUiInstanceKeyV1 } from './semanticCommands.js';
import { ProjectSourceV1Schema } from '../../projects/sources/projectSourceV1.js';
import { DeploymentEnvironmentRefV1Schema } from '../../deployments/deploymentEnvironmentRefV1.js';
import { DeploymentIdentifierV1Schema } from '../../deployments/deploymentIdentifiersV1.js';
import { WorkspaceRefV1WriteSchema } from '../../workspaces/workspaceRefV1.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../../scm/hostingRepositoryIdentity.js';
import { WidgetSurfaceRefV1Schema } from '../../widgets/widgetInstanceV1.js';
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

/** Read-only demanded Review content; never an access, decision or execution grant. */
export const PluginUiReviewContextV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('page'),
    reviewId: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('finding'),
    reviewId: z.string().check(z.trim(), z.minLength(1)),
    commentId: z.string().check(z.trim(), z.minLength(1)),
    namespace: asProtocolZod(PluginIdSchema),
    extension: PluginUiJsonValueV1Schema,
  }),
  z.strictObject({
    kind: z.literal('engineOptions'),
    engineId: z.string().check(z.trim(), z.minLength(1)),
    profileId: z.string().check(z.trim(), z.minLength(1)),
    options: z.record(z.string(), PluginUiJsonValueV1Schema),
  }),
]));
export type PluginUiReviewContextV1 = Readonly<z.infer<typeof PluginUiReviewContextV1Schema>>;

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
    instanceKey: z.optional(PluginUiInstanceKeyV1Schema),
    review: z.optional(PluginUiReviewContextV1Schema),
  }),
  z.strictObject({
    kind: z.literal('embedded'),
    role: z.string().check(z.trim(), z.minLength(1)),
    presentation: z.enum(['content', 'fill']),
    review: z.optional(PluginUiReviewContextV1Schema),
  }),
]));
export type PluginUiMountContextV1 =
  | Readonly<{
    kind: 'destination';
    destination: PluginContributionIdentityV1;
    container: PluginUiDestinationContainerV1;
    instanceKey?: PluginUiInstanceKeyV1;
    review?: PluginUiReviewContextV1;
  }>
  | Readonly<{
    kind: 'embedded';
    role: string;
    presentation: 'content' | 'fill';
    review?: PluginUiReviewContextV1;
  }>;

/**
 * Preserve transport values exactly while rejecting strings that cannot name a
 * current public surface fact. The mounted transport already has JSON-safe
 * values; this is an author-facing payload grammar, not a normalizer.
 */
const PluginUiHostApiSurfaceNonBlankStringV1Schema = lazyZodSchema(() => z.string().check(z.refine((value) => value.trim().length > 0, 'Expected a non-blank string.')));

const PluginUiHostApiProjectTargetV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('project'),
    projectKey: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    installationId: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
    source: z.optional(z.strictObject({
      serverId: PluginUiHostApiSurfaceNonBlankStringV1Schema,
      source: ProjectSourceV1Schema,
    })),
    checkout: z.optional(WorkspaceRefV1WriteSchema),
    repository: z.optional(ScmHostingRepositoryIdentityV1Schema),
    branch: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  }));

/** The exact mounted target disclosure carried to an author-facing UI. */
export const PluginUiHostApiSurfaceTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('app') }),
  z.strictObject({
    kind: z.literal('machine'),
    serverId: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    machineId: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    /** Verified Home identity and current enrolled installation, when the host has those facts. */
    homeId: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
    installationId: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  }),
  z.strictObject({
    ...z.pick(DeploymentEnvironmentRefV1Schema, { serverId: true, projectSourceId: true, environmentId: true }).shape,
    kind: z.literal('deploymentEnvironment'),
    controllerMachineId: DeploymentIdentifierV1Schema,
    machineId: z.optional(DeploymentIdentifierV1Schema),
  }),
  z.strictObject({
    kind: z.literal('session'),
    sessionId: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    project: z.optional(PluginUiHostApiProjectTargetV1Schema),
    installationId: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
    agentId: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
    repository: z.optional(ScmHostingRepositoryIdentityV1Schema),
    branch: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
    headOid: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  }),
  PluginUiHostApiProjectTargetV1Schema,
  z.strictObject({
    kind: z.literal('browser'),
    targetId: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    origin: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  }),
  z.strictObject({ kind: z.literal('services'),
    project: z.optional(PluginUiHostApiProjectTargetV1Schema),
    installationId: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  }),
]));
export type PluginUiHostApiSurfaceTargetV1 = Readonly<z.infer<
  typeof PluginUiHostApiSurfaceTargetV1Schema
>>;

const PluginUiHostApiSurfaceMetricV1Schema = lazyZodSchema(() => z.number().check(z.nonnegative()));

// Mode-resolved output of the host's native declaration compiler. Presentation
// maps are additive; the part envelope stays closed and never carries authority.
const PluginUiThemeSurfaceStyleV1Schema = lazyZodSchema(() => z.record(z.string(), z.union([z.string(), z.number()])));
const PluginUiThemeSurfacesV1Schema = lazyZodSchema(() => z.record(z.string(), z.record(z.string(), z.strictObject({
  base: PluginUiThemeSurfaceStyleV1Schema,
  states: z.record(z.string(), PluginUiThemeSurfaceStyleV1Schema),
}))));

const PluginUiHostApiSurfaceThemeTypographyV1Schema = lazyZodSchema(() => z.strictObject({
  body: z.strictObject({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    fontFamily: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  }),
  /** Reading prose (a detail's body, a story step): a step above `body`, the dense row meta line. */
  reading: z.strictObject({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    fontFamily: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  }),
  label: z.strictObject({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    fontFamily: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  }),
  title: z.strictObject({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    fontFamily: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  }),
  caption: z.strictObject({
    fontSize: PluginUiHostApiSurfaceMetricV1Schema,
    lineHeight: PluginUiHostApiSurfaceMetricV1Schema,
    fontWeight: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    fontFamily: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
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
  /** Completed host sanitizer output. Guests attach it without parsing it again. */
  sanitizedCss: z.optional(z.string()),
  /** Already compiled for this snapshot's appearance; native primitives consume it directly. */
  surfaces: z.optional(PluginUiThemeSurfacesV1Schema),
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
    /** The host's blue, for a colour a person picks for a mark (a label's dot). Older snapshots omit it. */
    blue: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
    /** The host's purple, for the same picked marks. Older snapshots omit it. */
    purple: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
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
  /** Exact physical renderer instance, stable until that renderer retires; never an execution grant. */
  mountId: z.optional(PluginUiHostApiSurfaceNonBlankStringV1Schema),
  mount: PluginUiMountContextV1Schema,
  target: PluginUiHostApiSurfaceTargetV1Schema,
  /** Identity only from this mount's admitted Account lifetime; never an execution grant. */
  accountScope: z.optional(z.readonly(z.strictObject({
    serverId: WidgetSurfaceRefV1Schema.shape.serverId,
    accountId: WidgetSurfaceRefV1Schema.shape.accountId,
  }))),
  /** Host page chrome for app pages; absent on other surface placements. */
  page: z.optional(z.strictObject({ columnVisible: z.boolean(), navigation: z.optional(PluginUiPageNavigationProjectionV1Schema) })),
  /**
   * A companion opened from a page's own navigation item: that page's launch input and current location, as the
   * page has them now, so the companion shows the page's entity. A read of the opener, never navigation or authority;
   * absent on every other mount.
   */
  openedFrom: z.optional(z.strictObject({
    pageKind: asProtocolZod(PluginContributionIdentityV1Schema),
    launchInput: z.optional(PluginUiLaunchInputV1Schema),
    subPath: z.nullable(PluginUiSubPathV1Schema),
    review: z.optional(PluginUiReviewContextV1Schema),
  })),
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
  /**
   * The Agent a new Session starts with by default for this mount's Account: the host's own preferred-target
   * owner and the Agent catalog's label, so a control can name it from first paint. Presentation only; the
   * launch still resolves its Agent at its own owner. `null` when no Agent resolves.
   */
  preferredAgent: z.optional(z.nullable(z.strictObject({
    targetKey: PluginUiHostApiSurfaceNonBlankStringV1Schema,
    label: PluginUiHostApiSurfaceNonBlankStringV1Schema,
  }))),
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

/**
 * The host-stamped context carried only to a contextual dynamic Resource
 * producer. It is deliberately not a generic caller metadata bag: the closed
 * union makes an absent/wrong context fail through the Resource owner.
 */
export const PluginResourceContextV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({
    kind: z.literal('session'),
    sessionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    target: z.optional(PluginUiHostApiSurfaceTargetV1Schema),
  }).check(z.refine(value => value.target === undefined
    || value.target.kind === 'session' && value.target.sessionId === value.sessionId)),
  z.strictObject({
    kind: z.literal('surface'),
    mountInstanceKey: PluginUiInstanceKeyV1Schema,
    launchInput: PluginUiLaunchInputV1Schema,
    review: z.optional(PluginUiReviewContextV1Schema),
    target: z.optional(PluginUiHostApiSurfaceTargetV1Schema),
  }),
]));
export type PluginResourceContextV1 = z.infer<typeof PluginResourceContextV1Schema>;

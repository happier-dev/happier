import { z } from 'zod';

import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
  buildQualifiedPluginContributionKey,
  type PluginContributionIdentityV1,
} from '../../contributionIdentity.js';
import { PluginIdSchema } from '../../pluginId.js';
import {
  PluginUiSurfacePlacementV1Schema,
  type PluginUiSurfacePlacementV1,
} from '../../ui/surfaceContextPlacement.js';
import { PluginUiPlatformV1Schema, type PluginUiPlatformV1 } from './compatibility.js';
import { PluginUiRendererChainBindingV1Schema } from './rendererChainBinding.js';
import { PluginSurfaceTargetV1Schema, type PluginSurfaceTargetV1 } from './surfaceTargets.js';
import { asProtocolZod } from "../../actions/internalProtocolZodAdapter.js";

/**
 * The canonical registry for public plugin-UI destinations. Authored V2 views
 * name a container and target directly; this module admits that pair and
 * produces the sole normalized binding consumed by projection and hosts.
 */
export const PluginUiTargetKindV1Schema = z.enum([
  'app',
  'session',
  'project',
  'browser',
  'services',
]);
export type PluginUiTargetKindV1 = z.infer<typeof PluginUiTargetKindV1Schema>;

export const PluginUiContainerV1Schema = z.enum([
  'appPage',
  'settingsPage',
  'rightSidebarTab',
  'rightPane',
  'detailsTab',
  'detailsPane',
  'bottomPane',
  'browserPanel',
  'servicesPanel',
  'sessionSubagentLaunch',
  'sessionSubagentDetails',
  'sessionInfoSection',
]);
export type PluginUiContainerV1 = z.infer<typeof PluginUiContainerV1Schema>;

/**
 * Author-selectable `ui.views` containers. `settingsPage` remains a real host
 * container, but its declaration is owned exclusively by `ui.settingsPages`.
 * Keeping that distinction structural makes the generated public JSON schema
 * reject the same wrong-owner shape as the canonical parser.
 */
export const PluginUiViewContainerV1Schema = PluginUiContainerV1Schema.exclude([
  'settingsPage',
  'sessionInfoSection',
]);
export type PluginUiViewContainerV1 = z.infer<typeof PluginUiViewContainerV1Schema>;

export const PluginUiInlineSurfaceRoleV1Schema = z.enum([
  'sessionSubagentLaunch',
  'sessionSubagentDetails',
  'sessionInfoSection',
]);
export type PluginUiInlineSurfaceRoleV1 = z.infer<typeof PluginUiInlineSurfaceRoleV1Schema>;
export type PluginUiInlineSurfacePresentationV1 = 'content' | 'fill';

/** Exact host-owned inline roles. This is admission, not a generic author slot. */
export const PLUGIN_UI_INLINE_SURFACE_SLOTS_V1 = Object.freeze({
  sessionSubagentLaunch: Object.freeze({
    container: 'sessionSubagentLaunch' as const,
    targetKind: 'session' as const,
    presentations: Object.freeze(['content'] as const),
  }),
  sessionSubagentDetails: Object.freeze({
    container: 'sessionSubagentDetails' as const,
    targetKind: 'session' as const,
    presentations: Object.freeze(['content', 'fill'] as const),
  }),
  sessionInfoSection: Object.freeze({
    container: 'sessionInfoSection' as const,
    targetKind: 'session' as const,
    presentations: Object.freeze(['content'] as const),
  }),
});

export function resolvePluginUiInlineSurfaceSlotV1(
  role: unknown,
  presentation: unknown,
): Readonly<{
  container: 'sessionSubagentLaunch' | 'sessionSubagentDetails' | 'sessionInfoSection';
  targetKind: 'session';
  presentation: PluginUiInlineSurfacePresentationV1;
}> | null {
  const parsedRole = PluginUiInlineSurfaceRoleV1Schema.safeParse(role);
  if (!parsedRole.success || (presentation !== 'content' && presentation !== 'fill')) return null;
  const slot = PLUGIN_UI_INLINE_SURFACE_SLOTS_V1[parsedRole.data];
  if (!(slot.presentations as readonly string[]).includes(presentation)) return null;
  return Object.freeze({
    container: slot.container,
    targetKind: slot.targetKind,
    presentation,
  });
}

export const PluginUiDestinationInstancePolicyV1Schema = z.enum([
  'singleton',
  'multiple',
]);
export type PluginUiDestinationInstancePolicyV1 =
  z.infer<typeof PluginUiDestinationInstancePolicyV1Schema>;

export type PluginUiDestinationCollisionDomainV1<
  TContainer extends PluginUiContainerV1 = PluginUiContainerV1,
  TTargetKind extends PluginUiTargetKindV1 = PluginUiTargetKindV1,
> = Readonly<{
  container: TContainer;
  targetKind: TTargetKind;
}>;

export const PluginUiRightSidebarScopeV1Schema = z.enum([
  'app',
  'session',
  'project',
]);
export type PluginUiRightSidebarScopeV1 = z.infer<typeof PluginUiRightSidebarScopeV1Schema>;

export type PluginUiDestinationBindingSlotV1<
  TContainer extends PluginUiContainerV1 = PluginUiContainerV1,
  TTargetKind extends PluginUiTargetKindV1 = PluginUiTargetKindV1,
  TInstancePolicy extends PluginUiDestinationInstancePolicyV1 = PluginUiDestinationInstancePolicyV1,
> = Readonly<{
  container: TContainer;
  targetKind: TTargetKind;
  /** The lossy host-API context vocabulary for this admitted host slot. */
  surfaceContextPlacement: PluginUiSurfacePlacementV1;
  platforms: readonly PluginUiPlatformV1[];
  collisionDomain: PluginUiDestinationCollisionDomainV1<TContainer, TTargetKind>;
  /** Present only for an admitted right-sidebar binding. */
  rightSidebarScope?: PluginUiRightSidebarScopeV1;
  /**
   * Every policy this slot can actually fulfill through its canonical launcher
   * and isolated mount. Slots are singleton unless the registry explicitly
   * proves a bounded instance-key path.
   *
   * The literal element type is preserved so the public authoring TYPE derives
   * the admitted policy from this same row. Widening it to the whole
   * vocabulary would leave TypeScript accepting a declaration the canonical
   * parser and the generated authoring schema both reject.
  */
  instancePolicies: readonly TInstancePolicy[];
}>;

const ALL_DESTINATION_PLATFORMS: readonly PluginUiPlatformV1[] = Object.freeze([
  ...PluginUiPlatformV1Schema.options,
]);
const DESKTOP_DESTINATION_PLATFORMS: readonly PluginUiPlatformV1[] = Object.freeze([
  'desktop',
  'web',
]);

/**
 * Form factor is a host-runtime observation, not an authored/plugin wire
 * capability. Keeping it out of the binding schema preserves the existing
 * OS-level declaration contract while letting native tablet hosts apply the
 * same desktop/tablet rows as their multi-pane counterparts.
 */
export type PluginUiDestinationRuntimeFormFactorV1 = 'phone' | 'tablet';

function isNativePluginUiPlatformV1(platform: PluginUiPlatformV1): boolean {
  return platform === 'android' || platform === 'ios';
}

function hasDesktopTabletDestinationPlatformV1(
  platforms: readonly PluginUiPlatformV1[],
): boolean {
  return platforms.includes('desktop') || platforms.includes('web');
}

function isDesktopTabletOnlyDestinationBindingSlotV1(
  binding: Pick<PluginUiDestinationBindingV1, 'container' | 'targetKind'>,
): boolean {
  const slot = resolvePluginUiDestinationBindingSlotV1(binding.container, binding.targetKind);
  return slot !== null
    && slot.platforms.every((platform) => DESKTOP_DESTINATION_PLATFORMS.includes(platform));
}
const SINGLETON_DESTINATION_INSTANCE_POLICIES = Object.freeze([
  'singleton',
] as const) satisfies readonly PluginUiDestinationInstancePolicyV1[];
const INSTANCE_KEYED_DESTINATION_INSTANCE_POLICIES = Object.freeze([
  'singleton',
  'multiple',
] as const) satisfies readonly PluginUiDestinationInstancePolicyV1[];

function surfaceContextPlacementForDestinationBindingSlot(
  container: PluginUiContainerV1,
  targetKind: PluginUiTargetKindV1,
): PluginUiSurfacePlacementV1 {
  if (container === 'rightSidebarTab') return 'rightSidebarSurface';
  switch (targetKind) {
    case 'session':
      return 'sessionPane';
    case 'project':
      return 'projectSurface';
    case 'app':
      return 'appSurface';
    case 'browser':
      return 'browserSurface';
    case 'services':
      return 'servicesSurface';
  }
}

function defineDestinationBindingSlot<
  const TContainer extends PluginUiContainerV1,
  const TTargetKind extends PluginUiTargetKindV1,
  const TInstancePolicies extends readonly PluginUiDestinationInstancePolicyV1[] =
    typeof SINGLETON_DESTINATION_INSTANCE_POLICIES,
>(
  container: TContainer,
  targetKind: TTargetKind,
  platforms: readonly PluginUiPlatformV1[],
  rightSidebarScope?: PluginUiRightSidebarScopeV1,
  instancePolicies: TInstancePolicies = SINGLETON_DESTINATION_INSTANCE_POLICIES as unknown as TInstancePolicies,
): PluginUiDestinationBindingSlotV1<TContainer, TTargetKind, TInstancePolicies[number]> {
  return Object.freeze({
    container,
    targetKind,
    surfaceContextPlacement: surfaceContextPlacementForDestinationBindingSlot(container, targetKind),
    platforms: Object.freeze([...platforms]),
    collisionDomain: Object.freeze({ container, targetKind }),
    ...(rightSidebarScope === undefined ? {} : { rightSidebarScope }),
    instancePolicies: Object.freeze([...instancePolicies]),
  });
}

/**
 * Explicit admitted target/container/platform rows. A missing row is a
 * fail-closed admission result, never an App fallback. Mounted-path proof is
 * owned by the closure test rather than embedded as UI implementation names in
 * these production routing/admission records.
 */
export const PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1 = Object.freeze([
    defineDestinationBindingSlot(
      'appPage',
      'app',
      ALL_DESTINATION_PLATFORMS,
    ),
    defineDestinationBindingSlot(
      'settingsPage',
      'app',
      ALL_DESTINATION_PLATFORMS,
    ),
    defineDestinationBindingSlot(
      'rightSidebarTab',
      'app',
      ALL_DESTINATION_PLATFORMS,
      'app',
    ),
    defineDestinationBindingSlot(
      'rightSidebarTab',
      'session',
      ALL_DESTINATION_PLATFORMS,
      'session',
    ),
    defineDestinationBindingSlot(
      'rightSidebarTab',
      'project',
      DESKTOP_DESTINATION_PLATFORMS,
      'project',
    ),
    defineDestinationBindingSlot(
      'rightPane',
      'session',
      DESKTOP_DESTINATION_PLATFORMS,
      undefined,
      INSTANCE_KEYED_DESTINATION_INSTANCE_POLICIES,
    ),
    defineDestinationBindingSlot(
      'rightPane',
      'project',
      DESKTOP_DESTINATION_PLATFORMS,
      undefined,
      INSTANCE_KEYED_DESTINATION_INSTANCE_POLICIES,
    ),
    defineDestinationBindingSlot(
      'detailsTab',
      'session',
      DESKTOP_DESTINATION_PLATFORMS,
      undefined,
      INSTANCE_KEYED_DESTINATION_INSTANCE_POLICIES,
    ),
    defineDestinationBindingSlot(
      'detailsTab',
      'project',
      DESKTOP_DESTINATION_PLATFORMS,
      undefined,
      INSTANCE_KEYED_DESTINATION_INSTANCE_POLICIES,
    ),
    defineDestinationBindingSlot(
      'detailsPane',
      'session',
      DESKTOP_DESTINATION_PLATFORMS,
      undefined,
      INSTANCE_KEYED_DESTINATION_INSTANCE_POLICIES,
    ),
    defineDestinationBindingSlot(
      'detailsPane',
      'project',
      DESKTOP_DESTINATION_PLATFORMS,
      undefined,
      INSTANCE_KEYED_DESTINATION_INSTANCE_POLICIES,
    ),
    defineDestinationBindingSlot(
      'bottomPane',
      'session',
      DESKTOP_DESTINATION_PLATFORMS,
      undefined,
      INSTANCE_KEYED_DESTINATION_INSTANCE_POLICIES,
    ),
    defineDestinationBindingSlot(
      'bottomPane',
      'project',
      DESKTOP_DESTINATION_PLATFORMS,
      undefined,
      INSTANCE_KEYED_DESTINATION_INSTANCE_POLICIES,
    ),
    defineDestinationBindingSlot(
      'browserPanel',
      'browser',
      ALL_DESTINATION_PLATFORMS,
    ),
    defineDestinationBindingSlot(
      'servicesPanel',
      'services',
      ALL_DESTINATION_PLATFORMS,
    ),
    defineDestinationBindingSlot(
      'sessionSubagentLaunch',
      'session',
      ALL_DESTINATION_PLATFORMS,
    ),
    defineDestinationBindingSlot(
      'sessionSubagentDetails',
      'session',
      ALL_DESTINATION_PLATFORMS,
    ),
    defineDestinationBindingSlot(
      'sessionInfoSection',
      'session',
      ALL_DESTINATION_PLATFORMS,
    ),
  ] as const satisfies readonly PluginUiDestinationBindingSlotV1[]);

const DESTINATION_BINDING_SLOT_BY_KEY: ReadonlyMap<string, PluginUiDestinationBindingSlotV1> = new Map(
  PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1.map((slot) => [
    `${slot.container}\u0000${slot.targetKind}`,
    slot,
  ]),
);

function destinationBindingSlotKey(
  container: PluginUiContainerV1,
  targetKind: PluginUiTargetKindV1,
): string {
  return `${container}\u0000${targetKind}`;
}

export function resolvePluginUiDestinationBindingSlotV1(
  container: unknown,
  targetKind: unknown,
): PluginUiDestinationBindingSlotV1 | null {
  const parsedContainer = PluginUiContainerV1Schema.safeParse(container);
  const parsedTargetKind = PluginUiTargetKindV1Schema.safeParse(targetKind);
  if (!parsedContainer.success || !parsedTargetKind.success) return null;
  return DESTINATION_BINDING_SLOT_BY_KEY.get(
    destinationBindingSlotKey(parsedContainer.data, parsedTargetKind.data),
  ) ?? null;
}

export const PluginUiDestinationBindingInputV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  destinationId: asProtocolZod(PluginContributionLocalIdSchema),
  rendererId: asProtocolZod(PluginContributionLocalIdSchema),
  /** Ordered fallback candidates after the primary renderer. */
  fallbackRendererIds: z.array(asProtocolZod(PluginContributionLocalIdSchema)).optional(),
  /**
   * Projection-time renderer inventory. It is deliberately input-only: the
   * normalized binding carries qualified identities, never a second registry.
   */
  availableRendererIds: z.array(asProtocolZod(PluginContributionLocalIdSchema)).optional(),
  container: PluginUiContainerV1Schema,
  target: PluginSurfaceTargetV1Schema,
  instancePolicy: PluginUiDestinationInstancePolicyV1Schema.default('singleton'),
}).strict();
export type PluginUiDestinationBindingInputV1 =
  z.input<typeof PluginUiDestinationBindingInputV1Schema>;

/**
 * One normalized, qualified UI binding. `target` remains the declaration
 * selector and is not a runtime target or execution authority; its actual
 * public facts are stamped by the incumbent destination/pane owner at open or
 * mount time.
 */
export type PluginUiDestinationBindingV1 = Readonly<{
  destination: PluginContributionIdentityV1;
  /** Authored primary followed by fallbacks, in declaration order. */
  rendererChain: readonly PluginContributionIdentityV1[];
  /** The currently admitted member of {@link rendererChain}. */
  renderer: PluginContributionIdentityV1;
  container: PluginUiContainerV1;
  target: PluginSurfaceTargetV1;
  targetKind: PluginUiTargetKindV1;
  /** Registry-owned host-API context classification; never a legacy surface id. */
  surfaceContextPlacement: PluginUiSurfacePlacementV1;
  instancePolicy: PluginUiDestinationInstancePolicyV1;
  platforms: readonly PluginUiPlatformV1[];
  rightSidebarScope?: PluginUiRightSidebarScopeV1;
}>;

/**
 * Projection only knows the OS-level runtime platform. Native desktop/tablet
 * rows must survive that first gate so the mounted host can apply its actual
 * phone/tablet observation. This is deliberately not final admission.
 */
export function isPluginUiDestinationBindingPotentiallySupportedOnPlatformV1(
  binding: Pick<PluginUiDestinationBindingV1, 'platforms'>,
  platform: PluginUiPlatformV1,
): boolean {
  return binding.platforms.includes(platform)
    || (isNativePluginUiPlatformV1(platform)
      && hasDesktopTabletDestinationPlatformV1(binding.platforms));
}

/**
 * Final destination admission at a mounted host. Phone-sized web hosts and
 * native phones reject desktop/tablet-only rows; web and native tablets use
 * the incumbent multi-pane host path. Explicit native rows remain valid on
 * both phone and tablet form factors.
 */
export function isPluginUiDestinationBindingAdmittedAtRuntimeV1(input: Readonly<{
  binding: Pick<PluginUiDestinationBindingV1, 'container' | 'targetKind' | 'platforms'>;
  platform: PluginUiPlatformV1;
  formFactor: PluginUiDestinationRuntimeFormFactorV1;
}>): boolean {
  // `platforms` on a serialized predecessor binding may be conservative. The
  // registry slot is the canonical authority for whether this is a
  // desktop/tablet-only destination, while the binding still controls the
  // exact platform it advertised.
  if (
    input.platform === 'web'
    && input.formFactor === 'phone'
    && isDesktopTabletOnlyDestinationBindingSlotV1(input.binding)
  ) {
    return false;
  }

  return input.binding.platforms.includes(input.platform)
    || (input.formFactor === 'tablet'
      && isNativePluginUiPlatformV1(input.platform)
      && hasDesktopTabletDestinationPlatformV1(input.binding.platforms));
}

export function normalizePluginUiRendererChainV1(input: Readonly<{
  pluginId: string;
  rendererId: string;
  fallbackRendererIds?: readonly string[];
  availableRendererIds?: readonly string[];
}>): readonly PluginContributionIdentityV1[] | null {
  const binding = PluginUiRendererChainBindingV1Schema.safeParse({
    renderer: input.rendererId,
    fallbackRenderers: input.fallbackRendererIds,
  });
  if (!binding.success) return null;
  const rendererIds = [binding.data.renderer, ...(binding.data.fallbackRenderers ?? [])];
  if (
    input.availableRendererIds
    && rendererIds.some((rendererId) => !input.availableRendererIds!.includes(rendererId))
  ) {
    return null;
  }
  return Object.freeze(rendererIds.map((localId) => Object.freeze(
    PluginContributionIdentityV1Schema.parse({ pluginId: input.pluginId, localId }),
  )));
}

export function normalizePluginUiDestinationBindingV1(
  input: unknown,
): PluginUiDestinationBindingV1 | null {
  const parsed = PluginUiDestinationBindingInputV1Schema.safeParse(input);
  if (!parsed.success) return null;

  const targetKind = PluginUiTargetKindV1Schema.safeParse(parsed.data.target.kind);
  if (!targetKind.success) return null;
  const slot = resolvePluginUiDestinationBindingSlotV1(parsed.data.container, targetKind.data);
  if (!slot) return null;
  if (!slot.instancePolicies.includes(parsed.data.instancePolicy)) return null;

  const destination = PluginContributionIdentityV1Schema.parse({
    pluginId: parsed.data.pluginId,
    localId: parsed.data.destinationId,
  });
  const rendererChain = normalizePluginUiRendererChainV1({
    pluginId: parsed.data.pluginId,
    rendererId: parsed.data.rendererId,
    fallbackRendererIds: parsed.data.fallbackRendererIds,
    availableRendererIds: parsed.data.availableRendererIds,
  });
  if (!rendererChain) return null;
  const renderer = rendererChain[0]!;
  return Object.freeze({
    destination: Object.freeze(destination),
    rendererChain,
    renderer,
    container: slot.container,
    target: Object.freeze({ ...parsed.data.target }),
    targetKind: slot.targetKind,
    surfaceContextPlacement: slot.surfaceContextPlacement,
    instancePolicy: parsed.data.instancePolicy,
    platforms: slot.platforms,
    ...(slot.rightSidebarScope === undefined ? {} : { rightSidebarScope: slot.rightSidebarScope }),
  });
}

/**
 * The daemon-to-UI wire shape for a binding already normalized by this
 * registry. It validates every identity and slot-derived fact instead of letting a UI
 * reader treat an arbitrary `{ container, target }` record as an admitted
 * slot. Platform and method lists may be conservative predecessor subsets, but
 * can never advertise a value outside the current registry slot.
 */
export const PluginUiDestinationBindingV1Schema = z.object({
  destination: asProtocolZod(PluginContributionIdentityV1Schema),
  rendererChain: z.array(asProtocolZod(PluginContributionIdentityV1Schema)).min(1),
  renderer: asProtocolZod(PluginContributionIdentityV1Schema),
  container: PluginUiContainerV1Schema,
  target: PluginSurfaceTargetV1Schema,
  targetKind: PluginUiTargetKindV1Schema,
  surfaceContextPlacement: PluginUiSurfacePlacementV1Schema,
  instancePolicy: PluginUiDestinationInstancePolicyV1Schema,
  platforms: z.array(PluginUiPlatformV1Schema).min(1),
  rightSidebarScope: PluginUiRightSidebarScopeV1Schema.optional(),
}).strict().superRefine((binding, ctx) => {
  const slot = resolvePluginUiDestinationBindingSlotV1(binding.container, binding.targetKind);
  if (!slot) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['container'],
      message: 'Plugin UI binding container and target kind do not identify an admitted slot.',
    });
    return;
  }
  if (binding.target.kind !== binding.targetKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetKind'],
      message: 'Plugin UI binding target kind must match its target selector.',
    });
  }
  if (!slot.instancePolicies.includes(binding.instancePolicy)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['instancePolicy'],
      message: 'Plugin UI binding instance policy must be admitted by its registry slot.',
    });
  }
  if (binding.renderer.pluginId !== binding.destination.pluginId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['renderer', 'pluginId'],
      message: 'Plugin UI binding destination and renderer must have the same plugin owner.',
    });
  }
  if (
    binding.rendererChain.some((renderer) => renderer.pluginId !== binding.destination.pluginId)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rendererChain'],
      message: 'Plugin UI binding renderer chain must have the same plugin owner as its destination.',
    });
  }
  if (
    new Set(binding.rendererChain.map((renderer) => buildQualifiedPluginContributionKey(renderer))).size
    !== binding.rendererChain.length
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rendererChain'],
      message: 'Plugin UI binding renderer chain must not repeat a renderer.',
    });
  }
  if (!binding.rendererChain.some((renderer) => (
    renderer.pluginId === binding.renderer.pluginId
    && renderer.localId === binding.renderer.localId
  ))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['renderer'],
      message: 'Plugin UI binding selected renderer must be a member of its renderer chain.',
    });
  }
  if (binding.surfaceContextPlacement !== slot.surfaceContextPlacement) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['surfaceContextPlacement'],
      message: 'Plugin UI binding surface context placement must be registry-derived.',
    });
  }
  if (binding.rightSidebarScope !== slot.rightSidebarScope) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rightSidebarScope'],
      message: 'Plugin UI binding right-sidebar scope must be registry-derived.',
    });
  }
  if (
    new Set(binding.platforms).size !== binding.platforms.length
    || binding.platforms.some((platform) => !slot.platforms.includes(platform))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['platforms'],
      message: 'Plugin UI binding platforms must be a unique registry-admitted subset.',
    });
  }
});

/**
 * Exact binding selector for a host that already knows its insertion slot and
 * projected renderer. It accepts no legacy placement name and does not infer
 * either identity from an id prefix.
 */
export const PluginUiDestinationBindingSelectorV1Schema = z.object({
  container: PluginUiContainerV1Schema,
  targetKind: PluginUiTargetKindV1Schema,
  pluginId: asProtocolZod(PluginIdSchema),
  rendererId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();
export type PluginUiDestinationBindingSelectorV1 =
  z.infer<typeof PluginUiDestinationBindingSelectorV1Schema>;

export function matchesPluginUiDestinationBindingV1(
  binding: unknown,
  selector: unknown,
): binding is PluginUiDestinationBindingV1 {
  const parsedSelector = PluginUiDestinationBindingSelectorV1Schema.safeParse(selector);
  const parsedBinding = PluginUiDestinationBindingV1Schema.safeParse(binding);
  if (!parsedSelector.success || !parsedBinding.success) {
    return false;
  }
  const normalized = parsedBinding.data;
  return normalized.container === parsedSelector.data.container
    && normalized.targetKind === parsedSelector.data.targetKind
    && normalized.destination.pluginId === parsedSelector.data.pluginId
    && normalized.renderer.pluginId === parsedSelector.data.pluginId
    && normalized.renderer.localId === parsedSelector.data.rendererId;
}

/**
 * Select the first technically eligible renderer from a declaration-owned
 * chain. Projection supplies factual eligibility, but this registry owns the
 * chain's validation and declaration order so neither a destination nor a
 * targeted-Surface consumer can choose a later renderer merely because it
 * observed it first.
 */
export function selectPluginUiRendererChainMemberV1(
  rendererChain: unknown,
  eligibleRendererIds: unknown,
): PluginContributionIdentityV1 | null {
  const parsedRendererChain = z.array(asProtocolZod(PluginContributionIdentityV1Schema)).min(1).safeParse(rendererChain);
  if (!parsedRendererChain.success || !Array.isArray(eligibleRendererIds)) return null;

  const rendererKeys = new Set<string>();
  for (const renderer of parsedRendererChain.data) {
    const key = buildQualifiedPluginContributionKey(renderer);
    if (rendererKeys.has(key)) return null;
    rendererKeys.add(key);
  }

  const eligibleRendererIdSet = new Set<string>();
  for (const rendererId of eligibleRendererIds) {
    const parsedRendererId = PluginContributionLocalIdSchema.safeParse(rendererId);
    if (!parsedRendererId.success || eligibleRendererIdSet.has(parsedRendererId.data)) {
      return null;
    }
    eligibleRendererIdSet.add(parsedRendererId.data);
  }

  const renderer = parsedRendererChain.data.find((candidate) => (
    eligibleRendererIdSet.has(candidate.localId)
  ));
  return renderer ? Object.freeze({ ...renderer }) : null;
}

export function selectPluginUiDestinationBindingRendererV1(
  binding: PluginUiDestinationBindingV1,
  eligibleRendererIds: unknown,
): PluginUiDestinationBindingV1 | null {
  const parsedBinding = PluginUiDestinationBindingV1Schema.safeParse(binding);
  if (!parsedBinding.success) return null;
  const renderer = selectPluginUiRendererChainMemberV1(
    parsedBinding.data.rendererChain,
    eligibleRendererIds,
  );
  if (!renderer) return null;
  return Object.freeze({
    ...binding,
    renderer,
  });
}

/**
 * Settings pages are App-scoped destinations with one fixed host-owned
 * container. Keep that fixed target/container composition at the registry
 * boundary so Settings catalog code cannot invent a second binding normalizer.
 */
export const PluginUiSettingsPageBindingInputV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  pageId: asProtocolZod(PluginContributionLocalIdSchema),
  rendererId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();
export type PluginUiSettingsPageBindingInputV1 =
  z.input<typeof PluginUiSettingsPageBindingInputV1Schema>;

export function normalizePluginUiSettingsPageBindingV1(
  input: unknown,
): PluginUiDestinationBindingV1 | null {
  const parsed = PluginUiSettingsPageBindingInputV1Schema.safeParse(input);
  if (!parsed.success) return null;
  return normalizePluginUiDestinationBindingV1({
    pluginId: parsed.data.pluginId,
    destinationId: parsed.data.pageId,
    rendererId: parsed.data.rendererId,
    container: 'settingsPage',
    target: { kind: 'app' },
  });
}

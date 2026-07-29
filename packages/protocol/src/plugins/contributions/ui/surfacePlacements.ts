import { z } from 'zod';

import {
  ACTION_ID_FAMILIES_V1,
  RuntimeActionIdV1Schema,
  type RuntimeActionIdV1,
} from '../../../actions/actionIds.js';
import {
  RuntimeActionHostEffectClassSchema,
  resolveRuntimeActionHostEffectClass,
} from '../../../actions/actionSpecs.js';
import { PluginUiActionDescriptorV1Schema, PluginUiFallbackRefV1Schema } from './actions.js';
import { PluginUiCompatibilityV1Schema } from './compatibility.js';
import { PluginUiPredicateV1Schema } from './predicates.js';
import {
  PluginBrowserPanelHostActionScopeV1Schema,
  PluginSurfaceTargetV1Schema,
} from './surfaceTargets.js';
import { PluginUiBadgeDescriptorV1Schema, PluginUiDisplayV1Schema } from './tokens.js';

export const PluginSurfacePlacementKindV1Schema = z.enum([
  'session.details',
  'session.preview',
  'session.tool',
  'session.side',
  'session.rightSidebarTab',
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
export type PluginSurfacePlacementKindV1 = z.infer<typeof PluginSurfacePlacementKindV1Schema>;

export const PluginRightSidebarScopeV1Schema = z.enum(['session', 'project', 'app']);
export type PluginRightSidebarScopeV1 = z.infer<typeof PluginRightSidebarScopeV1Schema>;

export const PluginRightSidebarSectionV1Schema = z.enum(['primary', 'secondary', 'plugin']);
export type PluginRightSidebarSectionV1 = z.infer<typeof PluginRightSidebarSectionV1Schema>;

export const PluginRightSidebarMobileProjectionV1Schema = z.object({
  enabled: z.boolean().default(false),
  surface: z.literal('pluginTab').default('pluginTab'),
}).strict();
export type PluginRightSidebarMobileProjectionV1 =
  z.infer<typeof PluginRightSidebarMobileProjectionV1Schema>;

export const PluginRightSidebarLifecycleV1Schema = z.object({
  retention: z.enum(['unmountOnDisable', 'retainWhileAvailable']).default('unmountOnDisable'),
  unmountOnGenerationChange: z.boolean().default(true),
}).strict();
export type PluginRightSidebarLifecycleV1 =
  z.infer<typeof PluginRightSidebarLifecycleV1Schema>;

export const PluginRightSidebarTabMetadataV1Schema = z.object({
  tabId: z.string().trim().min(1).optional(),
  scope: PluginRightSidebarScopeV1Schema,
  section: PluginRightSidebarSectionV1Schema.default('plugin'),
  order: z.number().int().optional(),
  mobile: PluginRightSidebarMobileProjectionV1Schema.optional(),
  lifecycle: PluginRightSidebarLifecycleV1Schema.default({
    retention: 'unmountOnDisable',
    unmountOnGenerationChange: true,
  }),
  disabledPolicy: z.enum(['hide', 'disable']).default('hide'),
  collisionPolicy: z.literal('reject').default('reject'),
}).strict();
export type PluginRightSidebarTabMetadataV1 =
  z.infer<typeof PluginRightSidebarTabMetadataV1Schema>;

export const PluginSurfaceRendererRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('host'),
    rendererId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('hostedWeb'),
    contributionId: z.string().trim().min(1),
    fallback: PluginUiFallbackRefV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('reactNative'),
    contributionId: z.string().trim().min(1),
    fallback: PluginUiFallbackRefV1Schema.optional(),
  }).strict(),
]);
export type PluginSurfaceRendererRefV1 = z.infer<typeof PluginSurfaceRendererRefV1Schema>;

export const PluginSurfaceBrowserHostActionPolicyOwnerV1Schema = z.enum([
  'BRW-2',
  'BRW-6',
  'BRW-10',
  'BRW-11',
  'BRW-14',
  'BRW-15',
  'PMS',
  'LSV',
  'SIM-4',
]);
export type PluginSurfaceBrowserHostActionPolicyOwnerV1 =
  z.infer<typeof PluginSurfaceBrowserHostActionPolicyOwnerV1Schema>;

export const PluginSurfaceBrowserHostActionEffectV1Schema = RuntimeActionHostEffectClassSchema;
export type PluginSurfaceBrowserHostActionEffectV1 =
  z.infer<typeof PluginSurfaceBrowserHostActionEffectV1Schema>;

function createActionIdSet(ids: readonly string[]): ReadonlySet<string> {
  return new Set(ids);
}

const BROWSER_CONTROL_ACTION_IDS = createActionIdSet(ACTION_ID_FAMILIES_V1.browser_control);
const BROWSER_DIAGNOSTICS_ACTION_IDS = createActionIdSet(ACTION_ID_FAMILIES_V1.browser_diagnostics);
const BROWSER_CONTEXT_ACTION_IDS = createActionIdSet(ACTION_ID_FAMILIES_V1.browser_context);
const BROWSER_AUTOMATION_ACTION_IDS = createActionIdSet(ACTION_ID_FAMILIES_V1.browser_automation);
const BROWSER_RECORDING_ACTION_IDS = createActionIdSet(ACTION_ID_FAMILIES_V1.browser_recording);
const LOCAL_SERVICE_ACTION_IDS = createActionIdSet([
  ...ACTION_ID_FAMILIES_V1.local_services_inventory,
  ...ACTION_ID_FAMILIES_V1.local_services_launcher,
  ...ACTION_ID_FAMILIES_V1.local_services_preview,
  ...ACTION_ID_FAMILIES_V1.local_services_public_preview,
  ...ACTION_ID_FAMILIES_V1.local_services_actions,
]);
const PEER_MEDIATION_OBSERVABILITY_ACTION_IDS =
  createActionIdSet(ACTION_ID_FAMILIES_V1.peer_mediation_observability);
const SIMULATOR_ACTION_IDS = createActionIdSet(ACTION_ID_FAMILIES_V1.devices_simulator);

/**
 * Canonical family → policy-owner mapping for plugin surface browser-panel host
 * actions (PR-12). Exported so dispatch-time revalidation in the UI re-derives the
 * expected policy owner from the SAME function the contribution-time `superRefine`
 * uses — UI must not duplicate this family→owner table. Returns `null` when the
 * action id is not a recognized host-action-eligible runtime ActionSpec id.
 */
export function resolveExpectedHostActionPolicyOwner(
  actionId: RuntimeActionIdV1,
): PluginSurfaceBrowserHostActionPolicyOwnerV1 | null {
  if (BROWSER_CONTROL_ACTION_IDS.has(actionId)) return 'BRW-2';
  if (BROWSER_DIAGNOSTICS_ACTION_IDS.has(actionId)) return 'BRW-10';
  if (BROWSER_CONTEXT_ACTION_IDS.has(actionId)) return 'BRW-11';
  if (BROWSER_AUTOMATION_ACTION_IDS.has(actionId)) return 'BRW-14';
  if (BROWSER_RECORDING_ACTION_IDS.has(actionId)) return 'BRW-15';
  if (LOCAL_SERVICE_ACTION_IDS.has(actionId)) return 'LSV';
  if (PEER_MEDIATION_OBSERVABILITY_ACTION_IDS.has(actionId)) return 'PMS';
  if (SIMULATOR_ACTION_IDS.has(actionId)) return 'SIM-4';
  return null;
}

export const PluginSurfaceHostActionDescriptorV1Schema = z.object({
  actionId: RuntimeActionIdV1Schema,
  placement: z.literal('browser.panel'),
  scope: PluginBrowserPanelHostActionScopeV1Schema,
  policyOwner: PluginSurfaceBrowserHostActionPolicyOwnerV1Schema,
  effect: PluginSurfaceBrowserHostActionEffectV1Schema,
  requiredFeatureIds: z.array(z.string().trim().min(1)).default([]),
  requiredPermissionIds: z.array(z.string().trim().min(1)).default([]),
}).strict().superRefine((value, ctx) => {
  const expectedPolicyOwner = resolveExpectedHostActionPolicyOwner(value.actionId);
  if (expectedPolicyOwner === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actionId'],
      message: 'Plugin surface host actions must reference a runtime ActionSpec id.',
    });
  } else if (value.policyOwner !== expectedPolicyOwner) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['policyOwner'],
      message: `Plugin surface host action policy owner must match ${expectedPolicyOwner}.`,
    });
  }

  const expectedEffect = resolveRuntimeActionHostEffectClass(value.actionId);
  if (expectedEffect === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['effect'],
      message: 'Plugin surface host action effect cannot faithfully represent the referenced ActionSpec side effect class.',
    });
  } else if (value.effect !== expectedEffect) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['effect'],
      message: `Plugin surface host action effect must match ${expectedEffect}.`,
    });
  }
});
export type PluginSurfaceHostActionDescriptorV1 =
  z.infer<typeof PluginSurfaceHostActionDescriptorV1Schema>;

const PLUGIN_SURFACE_PLACEMENT_DESCRIPTOR_KEYS = new Set([
  'id',
  'placement',
  'target',
  'renderer',
  'display',
  'visibility',
  'enabled',
  'featureGate',
  'order',
  'badge',
  'actions',
  'hostActions',
  'fallback',
  'compatibility',
  'rightSidebar',
]);

function rejectUnknownPlacementKeys(
  value: Readonly<Record<string, unknown>>,
  ctx: z.RefinementCtx,
): void {
  for (const key of Object.keys(value)) {
    if (PLUGIN_SURFACE_PLACEMENT_DESCRIPTOR_KEYS.has(key)) {
      continue;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unsupported plugin surface placement field: ${key}`,
      path: [key],
    });
  }
}

export const PluginSurfacePlacementDescriptorV1Schema = z.object({
  id: z.string().trim().min(1),
  placement: PluginSurfacePlacementKindV1Schema,
  target: PluginSurfaceTargetV1Schema,
  renderer: PluginSurfaceRendererRefV1Schema,
  display: PluginUiDisplayV1Schema,
  visibility: PluginUiPredicateV1Schema.optional(),
  enabled: PluginUiPredicateV1Schema.optional(),
  featureGate: z.string().trim().min(1).optional(),
  order: z.number().int().optional(),
  badge: PluginUiBadgeDescriptorV1Schema.optional(),
  actions: z.array(PluginUiActionDescriptorV1Schema).default([]),
  hostActions: z.array(PluginSurfaceHostActionDescriptorV1Schema).default([]),
  fallback: PluginUiFallbackRefV1Schema.optional(),
  compatibility: PluginUiCompatibilityV1Schema.optional(),
  rightSidebar: PluginRightSidebarTabMetadataV1Schema.optional(),
}).passthrough().superRefine((value, ctx) => {
  rejectUnknownPlacementKeys(value, ctx);
  const rightSidebarScope = resolveRightSidebarPlacementScope(value.placement);
  if (rightSidebarScope) {
    if (!value.rightSidebar) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rightSidebar'],
        message: `${value.placement} placements require rightSidebar metadata`,
      });
    } else if (value.rightSidebar.scope !== rightSidebarScope) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rightSidebar', 'scope'],
        message: `${value.placement} rightSidebar scope must be ${rightSidebarScope}`,
      });
    }
    if (value.target.kind !== rightSidebarScope) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target'],
        message: `${value.placement} placements require a ${rightSidebarScope} target`,
      });
    }
  } else if (value.rightSidebar !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rightSidebar'],
      message: 'rightSidebar metadata is only supported for right-sidebar tab placements',
    });
  }

  if (value.placement === 'browser.panel' && value.target.kind !== 'browser') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: 'browser.panel placements require a browser target',
    });
  }
  if (value.placement === 'services.panel' && value.target.kind !== 'services') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: 'services.panel placements require a services target',
    });
  }
  if (value.placement !== 'browser.panel' && value.hostActions.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hostActions'],
      message: 'hostActions are only supported for browser.panel placements',
    });
  }
});
export type PluginSurfacePlacementDescriptorV1 =
  z.infer<typeof PluginSurfacePlacementDescriptorV1Schema>;
export type PluginSurfacePlacementDescriptor =
  z.infer<typeof PluginSurfacePlacementDescriptorV1Schema>;
export type PluginSurfacePlacementDescriptorInput =
  z.input<typeof PluginSurfacePlacementDescriptorV1Schema>;

function resolveRightSidebarPlacementScope(
  placement: PluginSurfacePlacementKindV1,
): PluginRightSidebarScopeV1 | null {
  if (placement === 'session.rightSidebarTab') return 'session';
  if (placement === 'project.rightSidebarTab') return 'project';
  if (placement === 'app.rightSidebarTab') return 'app';
  return null;
}

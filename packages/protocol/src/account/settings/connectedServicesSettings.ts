import { z } from 'zod';

import { ConnectedServiceBindingsV1Schema, type ConnectedServiceBindingsV1 } from '../../connect/connectedServiceBindings.js';
import { RELEASED_CONNECTED_SERVICE_IDS } from '../../connect/connectedServiceReaderSupport.js';
import { lazySchema } from '../../lazySchema.js';

const AgentIdSettingsKeySchema = lazySchema(() => z.string().trim().min(1));

function defaultAuthSchema(acceptsService: (serviceId: string) => boolean) {
  return z
  .object({
    v: z.literal(1).default(1),
    bindingsByAgentId: z.record(AgentIdSettingsKeySchema, ConnectedServiceBindingsV1Schema.superRefine((binding, ctx) => {
      for (const serviceId of Object.keys(binding.bindingsByServiceId)) {
        if (!acceptsService(serviceId)) ctx.addIssue({ code: 'custom', message: 'Unsupported service in default auth carrier', path: ['bindingsByServiceId', serviceId] });
      }
    })).default({}),
  })
  .strict();
}

// UI 0.2.15 (88d45f33), UI 0.2.16 (22ac8263), and CLI 0.2.14
// (df8241c8) have a closed service enum here. Keep new services out
// until those readers retire.
const releasedDefaultServiceIds: ReadonlySet<string> = new Set(RELEASED_CONNECTED_SERVICE_IDS);
export const ConnectedServicesDefaultAuthByAgentIdV1Schema = lazySchema(() => defaultAuthSchema((id) => releasedDefaultServiceIds.has(id))
  .catch({
    v: 1,
    bindingsByAgentId: {},
  }));

export const ConnectedServicesAdditionalDefaultAuthByAgentIdV1Schema = lazySchema(() => defaultAuthSchema((id) => !releasedDefaultServiceIds.has(id)));

export type ConnectedServicesDefaultAuthByAgentIdV1 = z.infer<
  typeof ConnectedServicesDefaultAuthByAgentIdV1Schema
>;

export const DEFAULT_CONNECTED_SERVICES_DEFAULT_AUTH_BY_AGENT_ID_V1:
  ConnectedServicesDefaultAuthByAgentIdV1 =
    ConnectedServicesDefaultAuthByAgentIdV1Schema.parse({});

export type ConnectedServicesDefaultAuthSettings = Readonly<{
  connectedServicesDefaultAuthByAgentIdV1?: unknown;
  connectedServicesAdditionalDefaultAuthByAgentIdV1?: unknown;
}>;

/** One effective default owner; the persistence carriers contain disjoint services. */
export function readConnectedServicesDefaultAuthSettings(settings: ConnectedServicesDefaultAuthSettings): ConnectedServicesDefaultAuthByAgentIdV1 {
  const legacy = ConnectedServicesDefaultAuthByAgentIdV1Schema.parse(settings.connectedServicesDefaultAuthByAgentIdV1 ?? {});
  const additional = ConnectedServicesAdditionalDefaultAuthByAgentIdV1Schema.parse(settings.connectedServicesAdditionalDefaultAuthByAgentIdV1 ?? {});
  const bindingsByAgentId: Record<string, ConnectedServiceBindingsV1> = { ...legacy.bindingsByAgentId };
  for (const [agentId, binding] of Object.entries(additional.bindingsByAgentId)) {
    bindingsByAgentId[agentId] = {
      v: 1,
      bindingsByServiceId: { ...bindingsByAgentId[agentId]?.bindingsByServiceId, ...binding.bindingsByServiceId },
    };
  }
  return { v: 1, bindingsByAgentId };
}

/** Write both subsets in one settings patch, never mirror a service binding. */
export function buildConnectedServicesDefaultAuthSettingsPatch(defaults: ConnectedServicesDefaultAuthByAgentIdV1) {
  const legacy: ConnectedServicesDefaultAuthByAgentIdV1 = { v: 1, bindingsByAgentId: {} };
  const additional: ConnectedServicesDefaultAuthByAgentIdV1 = { v: 1, bindingsByAgentId: {} };
  for (const [agentId, binding] of Object.entries(defaults.bindingsByAgentId)) {
    const normalized = ConnectedServiceBindingsV1Schema.parse(binding);
    for (const [serviceId, selection] of Object.entries(normalized.bindingsByServiceId)) {
      const target = releasedDefaultServiceIds.has(serviceId) ? legacy : additional;
      target.bindingsByAgentId[agentId] ??= { v: 1, bindingsByServiceId: {} };
      target.bindingsByAgentId[agentId].bindingsByServiceId[serviceId] = selection;
    }
  }
  return {
    connectedServicesDefaultAuthByAgentIdV1: legacy,
    connectedServicesAdditionalDefaultAuthByAgentIdV1: additional,
  };
}

export const ConnectedServicesProviderConfigSharingModeV1Schema = lazySchema(() => z.enum([
  'linked',
  'copied',
  'isolated',
]));

export type ConnectedServicesProviderConfigSharingModeV1 = z.infer<
  typeof ConnectedServicesProviderConfigSharingModeV1Schema
>;

export const ConnectedServicesProviderStateSharingModeV1Schema = lazySchema(() => z.enum([
  'isolated',
  'shared',
]));

export type ConnectedServicesProviderStateSharingModeV1 = z.infer<
  typeof ConnectedServicesProviderStateSharingModeV1Schema
>;

export const ConnectedServicesProviderStateSharingPolicyV1Schema = lazySchema(() => z
  .object({
    configMode: ConnectedServicesProviderConfigSharingModeV1Schema.default('linked'),
    // Default to shared session state: most users connect multiple accounts for
    // usage/quota and expect their provider sessions to continue across accounts.
    // Turning this off (via `defaults.stateMode` or a per-agent `byAgentId`
    // override) is the opt-out. Providers whose descriptor reports
    // `state.supported: false` ignore `shared` and stay isolated.
    stateMode: ConnectedServicesProviderStateSharingModeV1Schema.default('shared'),
  })
  .strict());

export type ConnectedServicesProviderStateSharingPolicyV1 = z.infer<
  typeof ConnectedServicesProviderStateSharingPolicyV1Schema
>;

const ConnectedServicesProviderStateSharingOverrideV1Schema = lazySchema(() => z
  .object({
    configMode: ConnectedServicesProviderConfigSharingModeV1Schema.optional(),
    stateMode: ConnectedServicesProviderStateSharingModeV1Schema.optional(),
  })
  .strict());

const ConnectedServicesProviderStateSharingRiskAcknowledgementV1Schema = lazySchema(() => z
  .object({
    sharedStatePrivacy: z.boolean().optional(),
    symlinkUnavailable: z.boolean().optional(),
  })
  .strict());

export const ConnectedServicesProviderStateSharingSettingsV1Schema = lazySchema(() => z
  .object({
    v: z.literal(1).default(1),
    defaults: ConnectedServicesProviderStateSharingPolicyV1Schema.default({
      configMode: 'linked',
      stateMode: 'shared',
    }),
    byAgentId: z
      .record(AgentIdSettingsKeySchema, ConnectedServicesProviderStateSharingOverrideV1Schema)
      .default({}),
    acknowledgedRisksByAgentId: z
      .record(AgentIdSettingsKeySchema, ConnectedServicesProviderStateSharingRiskAcknowledgementV1Schema)
      .default({}),
  })
  .strict()
  .catch({
    v: 1,
    defaults: {
      configMode: 'linked',
      stateMode: 'shared',
    },
    byAgentId: {},
    acknowledgedRisksByAgentId: {},
  }));

export type ConnectedServicesProviderStateSharingSettingsV1 = z.infer<
  typeof ConnectedServicesProviderStateSharingSettingsV1Schema
>;

export const DEFAULT_CONNECTED_SERVICES_PROVIDER_STATE_SHARING_SETTINGS_V1:
  ConnectedServicesProviderStateSharingSettingsV1 =
    ConnectedServicesProviderStateSharingSettingsV1Schema.parse({});

export function resolveConnectedServicesProviderStateSharingPolicyV1(
  settingsLike: unknown,
  agentId: string,
): ConnectedServicesProviderStateSharingPolicyV1 {
  const settings = ConnectedServicesProviderStateSharingSettingsV1Schema.parse(settingsLike);
  const override = settings.byAgentId[agentId];
  return {
    configMode: override?.configMode ?? settings.defaults.configMode,
    stateMode: override?.stateMode ?? settings.defaults.stateMode,
  };
}

export type ConnectedServicesDefaultAuthBindingByAgentIdV1 = Record<string, ConnectedServiceBindingsV1>;

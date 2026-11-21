import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import type { HomeReachabilityV1 } from '../home/governance/reachability.js';
import { classifyProviderHostnameSyntax, parseProviderIpAddress } from '../providers/safety/locality.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';

import { AutomationEventPositiveSafeIntegerV1Schema } from './automationColumnBoundsV1.js';
import {
  AutomationEventSourceConfigV1Schema,
  AutomationEventSourceDisplayLabelV1Schema,
  AutomationEventSourceInstanceIdV1Schema,
} from './automationEventJsonBoundsV1.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';
import { embedProtocolJsonSchema } from '../plugins/actions/protocolComposableSchema.js';

/** The existing GitHub push Event can gain managed delivery after its polling trigger commits. */
export const GITHUB_MANAGED_PUSH_EVENT_LOCAL_ID_V1 = 'automation/repository-pushed-v1';

/** A configured HTTPS ingress is a candidate. GitHub delivery establishes readiness. */
export function readManagedGithubWebhookHomeUrlV1(
  home: Pick<HomeReachabilityV1, 'publicAddress' | 'hostAccess'>,
): string | null {
  const { url, inferredFrom } = home.publicAddress;
  if (!url || inferredFrom === 'tailscale_serve'
    || (inferredFrom === 'relay_access' && home.hostAccess?.exposure !== 'public')) return null;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const ip = parseProviderIpAddress(hostname);
    return parsed.protocol === 'https:' && classifyProviderHostnameSyntax(hostname) !== 'loopback'
      && (ip === null || ip.locality === 'public') ? url : null;
  } catch {
    return null;
  }
}

export function readGithubRepositoryIdFromEventSourceV1(sourceInstanceId: string): string | undefined {
  return /^github:repository:([1-9][0-9]*)$/u.exec(sourceInstanceId)?.[1];
}
export const ManagedGithubRepositoryIdV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[1-9][0-9]*$/u)));
export const ManagedGithubRepositoryHookSaveResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('polling'), code: z.string() }),
  z.strictObject({ kind: z.literal('pendingVerification') }),
  z.strictObject({ kind: z.literal('webhook') }),
]));
export type ManagedGithubRepositoryHookSaveResultV1 = z.infer<typeof ManagedGithubRepositoryHookSaveResultV1Schema>;

/** The deployment setup's one finite repository lookup uses the existing repository setup Action. */
export const GITHUB_EVENT_SETUP_ACTIONS_V1 = Object.freeze({
  pluginId: 'happier.scm.forge.github',
  repository: 'automation/setup-repository-event-v1',
  deploymentReview: 'automation/setup-deployment-review-event-v1',
} as const);

/**
 * Builds the exact Action result schema bound to one Automation Event source
 * declaration. Manifest ingestion and plugin authors share this owner so the
 * strict declaration-to-declaration equality check cannot drift.
 */
export function createPluginEventAutomationSetupResultV1JsonSchema(
  sourceContractVersion: number,
  sourceConfigSchema: PluginJsonSchemaV2,
): PluginJsonSchemaV2 {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      v: { type: 'integer', const: 1 },
      sourceInstanceId: { type: 'string', minLength: 1, maxLength: 512 },
      sourceContractVersion: { type: 'integer', const: sourceContractVersion },
      sourceConfig: embedProtocolJsonSchema(sourceConfigSchema, ['properties', 'sourceConfig']),
      displayLabel: { type: 'string', minLength: 1, maxLength: 256 },
      observationOnly: embedProtocolJsonSchema(projectZodProtocolSchema(AutomationObservationOnlyIntentV1Schema).jsonSchema,
        ['properties', 'observationOnly']),
      webhookDelivery: { type: 'string', enum: ['automatic', 'required'] },
    },
    required: ['v', 'sourceInstanceId', 'sourceContractVersion', 'sourceConfig', 'displayLabel'],
  };
}

/** Non-executable authoring intent shared by declarations, setup results and source projections. */
export const AutomationObservationOnlyIntentV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('observationOnly') }));

export const PluginEventAutomationSetupResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  sourceConfig: asProtocolZod(AutomationEventSourceConfigV1Schema),
  displayLabel: AutomationEventSourceDisplayLabelV1Schema,
  observationOnly: z.optional(AutomationObservationOnlyIntentV1Schema),
  webhookDelivery: z.optional(z.enum(['automatic', 'required'])),
}));
export type PluginEventAutomationSetupResultV1 = z.infer<
  typeof PluginEventAutomationSetupResultV1Schema
>;

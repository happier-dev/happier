import type { PreNormalizedActionSpec } from './definition.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginWebhookActionHttpPathsV1, PluginWebhookPluginSurfaceActionHttpPathsV1, PluginWebhookActionInputSchemasV1, PluginWebhookActionOutputSchemasV1, PluginWebhookEndpointEnsureResultV1Schema, PluginWebhookEndpointReadResultV1Schema, isPluginWebhookPluginSurfaceActionIdV1, type PluginWebhookActionIdV1 } from '../../plugins/webhooks/endpointV1.js';


// Observation is applied again on retained receipt reads. Derive from the
// canonical unrefined result objects while accepting an already omitted URL.
const EnsureObservationInputSchema = lazyZodSchema(() => z.partial(PluginWebhookEndpointEnsureResultV1Schema, { publicUrl: true }));
const ReadObservationInputSchema = lazyZodSchema(() => z.partial(PluginWebhookEndpointReadResultV1Schema, { publicUrl: true }));

export const PLUGIN_WEBHOOK_ACTION_TITLES: Readonly<Record<PluginWebhookActionIdV1, string>> = Object.freeze({
  'plugin.webhook.endpoint.ensure': 'Ensure webhook endpoint',
  'plugin.webhook.endpoint.read': 'Read webhook endpoint',
  'plugin.webhook.endpoint.revoke': 'Revoke webhook endpoint',
  'plugin.webhook.endpoint.retarget': 'Retarget webhook endpoint',
  'plugin.webhook.endpoint.checkCorrespondence': 'Check webhook endpoint correspondence',
  'plugin.webhook.endpoint.convergeTarget': 'Converge webhook endpoint target',
  'plugin.webhook.delivery.movePending': 'Move pending webhook deliveries',
  'plugin.webhook.delivery.replay': 'Replay webhook delivery',
  'plugin.webhook.delivery.discard': 'Discard webhook delivery',
  'plugin.webhook.endpoint.credential.configure': 'Configure webhook credential',
  'plugin.webhook.endpoint.credential.rotate': 'Rotate webhook credential',
  'plugin.webhook.endpoint.credential.finishRotation': 'Finish webhook credential rotation',
});

export function createPluginWebhookActionSpec(actionId: PluginWebhookActionIdV1): PreNormalizedActionSpec {
  // A plugin-surface endpoint operation is never offered on a present-user
  // surface: the caller identity it authorizes against is host-stamped plugin
  // provenance, which a `ui`/`cli` invocation cannot supply.
  const isPluginSurface = isPluginWebhookPluginSurfaceActionIdV1(actionId);
  const readOnly = actionId === 'plugin.webhook.endpoint.read'
    || actionId === 'plugin.webhook.endpoint.checkCorrespondence';
  const automationDeliveryControl = actionId === 'plugin.webhook.delivery.replay'
    || actionId === 'plugin.webhook.delivery.discard' || actionId === 'plugin.webhook.delivery.movePending';
  return {
    id: actionId, approval: readOnly || actionId === 'plugin.webhook.endpoint.ensure'
      || automationDeliveryControl
      ? { result: 'required' } : { result: 'none' },
    ...(automationDeliveryControl
      ? { requiredAuthority: 'account_automation' as const, approvalPolicy: { uiConfirmation: 'policy' as const } } : {}),
    ...(actionId === 'plugin.webhook.endpoint.revoke' ? { irreversible: true as const } : {}),
    title: PLUGIN_WEBHOOK_ACTION_TITLES[actionId],
    description: 'Manage one Account-owned webhook endpoint through the canonical Webhook ingress owner.',
    executionPlacement: 'account',
    safety: readOnly ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: !isPluginSurface,
      voice: false,
      agent: automationDeliveryControl,
      mcp: automationDeliveryControl,
      cli: !isPluginSurface,
      rpc: false,
      ...(actionId === 'plugin.webhook.delivery.movePending' ? { api: false } : {}),
    },
    sideEffectClass: readOnly ? 'read' : 'write',
    outputSchema: PluginWebhookActionOutputSchemasV1[actionId],
    ...(actionId === 'plugin.webhook.endpoint.ensure' ? {
      approvalResultCustody: 'live_only' as const,
      projectObservationOutput: (output: unknown) => {
        const result = EnsureObservationInputSchema.parse(output);
        return {
          webhookEndpointId: result.webhookEndpointId,
          revision: result.revision,
          readiness: result.readiness,
        };
      },
    } : {}),
    ...(actionId === 'plugin.webhook.endpoint.read' ? {
      approvalResultCustody: 'live_only' as const,
      projectObservationOutput: (output: unknown) => {
        const result = ReadObservationInputSchema.parse(output);
        return {
          webhookEndpointId: result.webhookEndpointId,
          revision: result.revision,
          contribution: result.contribution,
          targetMaterialization: result.targetMaterialization,
          sourceInstanceId: result.sourceInstanceId,
          routing: result.routing,
          readiness: result.readiness,
          createdAt: result.createdAt,
          ...(result.revokedAt === undefined ? {} : { revokedAt: result.revokedAt }),
        };
      },
    } : {}),
    inputSchema: PluginWebhookActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
    serverTransport: {
      method: 'POST',
      path: isPluginWebhookPluginSurfaceActionIdV1(actionId)
        ? PluginWebhookPluginSurfaceActionHttpPathsV1[actionId]
        : PluginWebhookActionHttpPathsV1[actionId],
    },
  };
}

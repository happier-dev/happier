import { z } from 'zod';

import { PluginHostedWebBridgeMessageKindV1Schema } from '../contributions/ui/hostedWeb.js';
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';

const BridgeIdSchema = z.string().trim().min(1);

const PluginHostedWebBridgeEnvelopeBaseV1Schema = z.object({
  version: z.literal(1),
  pluginId: BridgeIdSchema,
  contributionId: BridgeIdSchema,
  surfaceId: BridgeIdSchema,
  sessionId: BridgeIdSchema.optional(),
  nonce: BridgeIdSchema,
  sequence: z.number().int().nonnegative(),
}).strict();

export const PluginHostedWebBridgeEnvelopeV1Schema =
  PluginHostedWebBridgeEnvelopeBaseV1Schema.extend({
    kind: PluginHostedWebBridgeMessageKindV1Schema,
    payload: PluginUiJsonValueV1Schema,
  }).strict();
export type PluginHostedWebBridgeEnvelopeV1 =
  z.infer<typeof PluginHostedWebBridgeEnvelopeV1Schema>;

export const PluginHostedWebBridgeResponseKindV1Schema = z.enum([
  'ack',
  'result',
  'error',
]);
export type PluginHostedWebBridgeResponseKindV1 =
  z.infer<typeof PluginHostedWebBridgeResponseKindV1Schema>;

export const PluginHostedWebBridgeResponseEnvelopeV1Schema =
  PluginHostedWebBridgeEnvelopeBaseV1Schema.extend({
    requestSequence: z.number().int().nonnegative(),
    kind: PluginHostedWebBridgeResponseKindV1Schema,
    payload: PluginUiJsonValueV1Schema,
  }).strict();
export type PluginHostedWebBridgeResponseEnvelopeV1 =
  z.infer<typeof PluginHostedWebBridgeResponseEnvelopeV1Schema>;

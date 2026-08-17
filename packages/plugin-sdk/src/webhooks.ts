/** @moduleRealm any */
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import {
  PluginWebhookEndpointIdV1Schema as canonicalPluginWebhookEndpointIdV1Schema,
  PluginWebhookEndpointIdV1JsonSchema,
  type PluginWebhookEndpointIdV1,
} from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import {
  PluginWebhookActionInputV1Schema as canonicalPluginWebhookActionInputV1Schema,
  PluginWebhookActionResultV1Schema as canonicalPluginWebhookActionResultV1Schema,
  type PluginWebhookActionInputV1,
  type PluginWebhookActionResultV1,
} from '@happier-dev/protocol/plugins/webhooks/deliveryV1';

export const PluginWebhookActionInputSchema: Readonly<{
  parse(value: unknown): PluginWebhookActionInputV1;
  safeParse(value: unknown):
    | Readonly<{ success: true; data: PluginWebhookActionInputV1 }>
    | Readonly<{ success: false; error: unknown }>;
}> = canonicalPluginWebhookActionInputV1Schema;
export const PluginWebhookActionResultSchema: Readonly<{
  parse(value: unknown): PluginWebhookActionResultV1;
  safeParse(value: unknown):
    | Readonly<{ success: true; data: PluginWebhookActionResultV1 }>
    | Readonly<{ success: false; error: unknown }>;
}> = canonicalPluginWebhookActionResultV1Schema;
export const PluginWebhookEndpointIdV1Schema: Readonly<{
  parse(value: unknown): PluginWebhookEndpointIdV1;
  safeParse(value: unknown):
    | Readonly<{ success: true; data: PluginWebhookEndpointIdV1 }>
    | Readonly<{ success: false; error: unknown }>;
}> = canonicalPluginWebhookEndpointIdV1Schema;
export { PluginWebhookEndpointIdV1JsonSchema };

export {
  PluginWebhookEndpointSetupV1Schema,
} from '@happier-dev/protocol/plugins/webhooks/endpointV1';

export type {
  PluginWebhookContributionV1 as PluginWebhookContribution,
  PluginWebhookVerifierV1 as PluginWebhookVerifier,
} from '@happier-dev/protocol/plugins/contributions/webhooks';

export type {
  PluginWebhookActionInputV1 as PluginWebhookActionInput,
  PluginWebhookActionResultV1 as PluginWebhookActionResult,
  PluginWebhookEndpointIdV1,
};

export type {
  PluginWebhookEndpointSetupV1,
} from '@happier-dev/protocol/plugins/webhooks/endpointV1';

/** Author test fixture for exercising the same JSON input/result contract used by webhook dispatch. */
export type PluginWebhookTestFixture = Readonly<{
  webhookEndpointId: PluginWebhookEndpointIdV1;
  input: PluginWebhookActionInputV1;
  result: PluginWebhookActionResultV1;
}>;

/**
 * Decodes the bounded raw body only after the caller has admitted the complete
 * webhook Action input through `PluginWebhookActionInputSchema`.
 */
export function decodePluginWebhookActionRawBody(
  input: PluginWebhookActionInputV1,
): Uint8Array {
  return decodeBase64(input.request.rawBodyBase64, 'base64');
}

/**
 * Validates an author fixture through the canonical Protocol schemas. This is
 * deliberately test-only vocabulary; webhook endpoints, secrets, queues, and
 * handler registration remain host-owned.
 */
export function definePluginWebhookTestFixture(input: PluginWebhookTestFixture): PluginWebhookTestFixture {
  return Object.freeze({
    webhookEndpointId: PluginWebhookEndpointIdV1Schema.parse(input.webhookEndpointId),
    input: PluginWebhookActionInputSchema.parse(input.input),
    result: PluginWebhookActionResultSchema.parse(input.result),
  });
}

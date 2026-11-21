import { AutomationStoredContentEnvelopeV1Schema } from '../../automations/automationEventV1.js';
import { AutomationTriggerDefinitionBindingV1Schema } from '../../automations/automationTriggerDefinitionStoredContent.js';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '../../rpc/socket.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginWebhookEndpointIdV1Schema, PluginWebhookPublicUrlV1Schema } from './endpointV1.js';

/** Reserved authenticated Home socket. The private operation is not part of the Action interface. */
export const MANAGED_PLUGIN_WEBHOOK_DAEMON_RPC_METHOD_V1 = 'plugin.webhook.managed';

const managedWebhookOperationCoordinatesV1 = {
  endpointId: PluginWebhookEndpointIdV1Schema,
  operationId: z.string().check(z.minLength(1)),
};
export const ManagedPluginWebhookOriginV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal(SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.MANAGED_PLUGIN_WEBHOOK_SERVER_ORIGIN),
  accountId: z.string().check(z.minLength(1)),
  machineId: z.string().check(z.minLength(1)),
}));
export type ManagedPluginWebhookOriginV1 = z.infer<typeof ManagedPluginWebhookOriginV1Schema>;

const githubWebhookOperands = () => ({
  ...managedWebhookOperationCoordinatesV1,
  materializationId: z.string().check(z.minLength(1)),
  binding: AutomationTriggerDefinitionBindingV1Schema,
  storedDefinitionEnvelope: AutomationStoredContentEnvelopeV1Schema,
  repositoryId: z.string().check(z.regex(/^[1-9][0-9]*$/u)),
});
const githubWebhookId = () => z.string().check(z.regex(/^[1-9][0-9]*$/u));
export const ManagedPluginWebhookRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('register'), ...githubWebhookOperands(),
    publicUrl: PluginWebhookPublicUrlV1Schema, signingSecret: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('remove'), ...githubWebhookOperands(), hookId: githubWebhookId() }),
]));
export type ManagedPluginWebhookRequestV1 = z.infer<typeof ManagedPluginWebhookRequestV1Schema>;
export const ManagedPluginWebhookResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('registered'), hookId: githubWebhookId() }),
  z.strictObject({ kind: z.literal('removed') }),
  z.strictObject({ kind: z.literal('unavailable'), code: z.string().check(z.regex(/^[a-z][a-z0-9_]*$/u)) }),
]));
export type ManagedPluginWebhookResultV1 = z.infer<typeof ManagedPluginWebhookResultV1Schema>;

import { z } from 'zod';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { defineProtocolJsonValue, defineProtocolObject, type ProtocolSchemaInput, type ProtocolSchemaOutput } from '../plugins/actions/protocolComposableSchema.js';

/** Selection and policy remain with the canonical dynamic Action executor. */
export const ActionInvokeInputProtocolSchema = defineProtocolObject({
  action: PluginContributionIdentityV1Schema,
  input: defineProtocolJsonValue().optional(),
}, { policy: 'closed' });
export type ActionInvokeInput = ProtocolSchemaOutput<typeof ActionInvokeInputProtocolSchema>;
// Dynamic invocation admits untrusted author input at the existing host boundary;
// the portable parser remains the only owner of its validated JSON output.
export const ActionInvokeInputSchema: z.ZodType<ActionInvokeInput,
  Omit<ProtocolSchemaInput<typeof ActionInvokeInputProtocolSchema>, 'input'> & { input?: unknown }
> = asProtocolZod(ActionInvokeInputProtocolSchema);

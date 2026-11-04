import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ConnectedServiceBindingSelectionV2Schema } from '../../connect/connectedServiceBindings.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { ValueRefV1Schema } from '../../valueRefs/valueRefV1.js';
const key = () => z.string().check(z.minLength(1));
const skip = lazyZodSchema(() => z.strictObject({ action: z.literal('skip') }));
export const BotTemplateSetupSelectionsV1Schema = lazyZodSchema(() => z.strictObject({
  software: z.array(z.strictObject({ key: key(), selection: z.discriminatedUnion('action', [skip,
    z.strictObject({ action: z.literal('install'), inputs: PluginJsonValueV2Schema })]) })),
  accounts: z.array(z.strictObject({ key: key(), selection: z.discriminatedUnion('action', [skip,
    z.strictObject({ action: z.literal('connect'), binding: ConnectedServiceBindingSelectionV2Schema })]) })),
  mcpServers: z.array(z.strictObject({ key: key(), selection: z.discriminatedUnion('action', [skip,
    z.strictObject({ action: z.literal('bind'), inputs: z.record(z.string(), ValueRefV1Schema) })]) })),
}));
export type BotTemplateSetupSelectionsV1 = z.infer<typeof BotTemplateSetupSelectionsV1Schema>;

/** Account references remain visible; MCP operand values stay private to the admitted invocation. */
export const BotTemplateSetupReviewSelectionsV1Schema = lazyZodSchema(() => z.extend(BotTemplateSetupSelectionsV1Schema, {
  mcpServers: z.array(z.strictObject({ key: key(), selection: z.discriminatedUnion('action', [skip,
    z.strictObject({ action: z.literal('bind'), inputKeys: z.array(z.string()) })]) })),
}));
export function projectBotTemplateSetupSelectionsForReviewV1(input: BotTemplateSetupSelectionsV1): z.infer<typeof BotTemplateSetupReviewSelectionsV1Schema> {
  return { ...input, mcpServers: input.mcpServers.map(item => ({ key: item.key, selection: item.selection.action === 'skip'
    ? item.selection : { action: 'bind', inputKeys: Object.keys(item.selection.inputs) } })) };
}

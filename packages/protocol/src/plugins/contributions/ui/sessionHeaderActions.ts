import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { asProtocolZod } from '../../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { PluginIdSchema } from '../../pluginId.js';
import {
  normalizePluginUiSemanticCommandV1,
  PluginUiSemanticActionDeclarationV1Schema,
  type PluginUiResolvedSemanticCommandV1,
} from '../../ui/semanticCommands.js';
import { PluginAvailabilityDescriptorV2Schema, PluginLocalizedStringV2Schema } from '../publicTypes.js';
import { PluginUiIconTokenV1Schema } from './tokens.js';

const PluginContributionLocalIdZodSchema = asProtocolZod(PluginContributionLocalIdSchema);
const PluginIdZodSchema = asProtocolZod(PluginIdSchema);

/** Presentation metadata shared by Session and app-page header actions. */
export const PluginUiHeaderActionPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  id: PluginContributionLocalIdZodSchema,
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  icon: z.optional(PluginUiIconTokenV1Schema),
  order: z.optional(z.number().check(z.int())),
}));

/** A static app-page header action; dynamic status remains host-owned. */
export const PluginUiPageHeaderActionV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginUiHeaderActionPresentationV1Schema, {
  command: PluginUiSemanticActionDeclarationV1Schema,
})));
export type PluginUiPageHeaderActionV1 = z.infer<typeof PluginUiPageHeaderActionV1Schema>;
/** Author input: `command` also admits the bare same-plugin Action local id. */
export type PluginUiPageHeaderActionV1Input = z.input<typeof PluginUiPageHeaderActionV1Schema>;

export const PluginSessionHeaderActionDescriptorV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginUiHeaderActionPresentationV1Schema, {
  command: PluginUiSemanticActionDeclarationV1Schema,
  availability: z.optional(PluginAvailabilityDescriptorV2Schema),
})));
export type PluginSessionHeaderActionDescriptorV1 = z.infer<typeof PluginSessionHeaderActionDescriptorV1Schema>;
export type PluginSessionHeaderActionDescriptor = z.infer<typeof PluginSessionHeaderActionDescriptorV1Schema>;
export type PluginSessionHeaderActionDescriptorInput = z.input<typeof PluginSessionHeaderActionDescriptorV1Schema>;

/** The compiled Session-header descriptor never grants cross-plugin surface navigation. */
export type NormalizedPluginSessionHeaderActionDescriptorV1 = Readonly<
  Omit<PluginSessionHeaderActionDescriptorV1, 'command'> & Readonly<{
    command: PluginUiResolvedSemanticCommandV1;
  }>
>;

/**
 * Normalizes one admitted Session-header descriptor at its own contract seam.
 * Generic semantic commands retain exact qualified cross-plugin destinations
 * for the surfaces that explicitly support them; Session header chrome does
 * not, so an openSurface target must resolve to its declaring plugin here.
 */
export function normalizePluginSessionHeaderActionDescriptorV1(
  input: unknown,
): NormalizedPluginSessionHeaderActionDescriptorV1 | null {
  const parsed = z.strictObject({
    pluginId: PluginIdZodSchema,
    descriptor: PluginSessionHeaderActionDescriptorV1Schema,
  }).safeParse(input);
  if (!parsed.success) return null;
  const command = normalizePluginUiSemanticCommandV1({
    pluginId: parsed.data.pluginId,
    command: parsed.data.descriptor.command,
  });
  if (!command) return null;
  if (command.kind === 'openSurface' && command.destination.pluginId !== parsed.data.pluginId) {
    return null;
  }
  return Object.freeze({ ...parsed.data.descriptor, command });
}

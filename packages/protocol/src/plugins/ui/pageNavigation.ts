import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { PluginUiIconTokenV1Schema } from '../contributions/ui/tokens.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

const value = z.string().check(z.minLength(1));
const identity = asProtocolZod(PluginContributionIdentityV1Schema);
const item = {
  value, title: z.string(), glyph: z.optional(PluginUiIconTokenV1Schema),
  phonePlacement: z.enum(['bar', 'more', 'none']),
  badge: z.optional(z.string()), disabled: z.optional(z.boolean()),
};
/** Presentation facts only; destination admission and panel lifetime stay with their existing owners. */
export const PluginUiPageNavigationItemV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ ...item, kind: z.literal('page') }),
  z.strictObject({ ...item, kind: z.literal('companion'), companion: identity }),
  z.strictObject({ ...item, kind: z.literal('both'), companion: identity }),
]));
export type PluginUiPageNavigationItemV1 = z.infer<typeof PluginUiPageNavigationItemV1Schema>;
export const PluginUiPageNavigationV1Schema = lazyZodSchema(() => z.strictObject({
  pageKind: identity,
  value,
  items: z.array(PluginUiPageNavigationItemV1Schema),
  phonePresented: z.optional(z.boolean()),
}));
export type PluginUiPageNavigationV1 = z.infer<typeof PluginUiPageNavigationV1Schema>;
export const PluginUiSetPageNavigationRequestV1Schema = lazyZodSchema(() => z.strictObject({
  navigation: z.nullable(PluginUiPageNavigationV1Schema),
}));
/** The strip is rendered in-document; only phone bottom chrome is hosted. */
export const PluginUiPageNavigationProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  pageKind: identity,
  tabIds: z.array(value),
  overflowIds: z.optional(z.array(value)),
  items: z.optional(z.array(PluginUiPageNavigationItemV1Schema)),
  presentation: z.enum(['top', 'bottom', 'local']),
  request: z.optional(z.nullable(value)),
}));
export type PluginUiPageNavigationProjectionV1 = z.infer<typeof PluginUiPageNavigationProjectionV1Schema>;

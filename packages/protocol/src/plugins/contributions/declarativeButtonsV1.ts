import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginNoticePageV1Schema } from '../../activity/accountNoticePageV1.js';
import { PluginActionInvocationBindingV1Schema } from '../actions/invocationBindingV1.js';
import { PluginLocalizedStringV2Schema } from './publicTypes.js';

/** A declaration of intent; the host owns navigation and Action admission. */
export const PluginDeclarativeButtonEffectV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open'), page: z.optional(PluginNoticePageV1Schema) }),
  z.strictObject({ kind: z.literal('action'), invocation: PluginActionInvocationBindingV1Schema }),
]));
export type PluginDeclarativeButtonEffectV1 = z.infer<typeof PluginDeclarativeButtonEffectV1Schema>;

export const PluginDeclarativeButtonV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  label: PluginLocalizedStringV2Schema,
  effect: PluginDeclarativeButtonEffectV1Schema,
}));
export type PluginDeclarativeButtonV1 = z.infer<typeof PluginDeclarativeButtonV1Schema>;

export const PluginDeclarativeButtonsV1Schema = lazyZodSchema(() => z.array(PluginDeclarativeButtonV1Schema).check(z.superRefine((buttons, context) => {
  const ids = new Set<string>();
  buttons.forEach((button, index) => {
    if (ids.has(button.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate button id.' });
    ids.add(button.id);
  });
})));

import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { AtmosphereLookOverrideSchema } from '../../account/settings/homeAtmosphere.js';

/** Closed data-only picture declaration; rendering remains with the host atmosphere owner. */
export const PluginAtmospherePictureContributionV1Schema = lazyZodSchema(() => z.strictObject({
    id: asProtocolZod(PluginContributionLocalIdSchema),
    kind: z.enum(['photo', 'painting']),
    title: z.string().check(z.minLength(1)),
    credit: z.strictObject({ author: z.string().check(z.minLength(1)), source: z.string().check(z.minLength(1)), url: z.string().check(z.url()), licence: z.string().check(z.minLength(1)), note: z.optional(z.string()) }),
    src: z.strictObject({ full: z.string().check(z.url()), thumb: z.string().check(z.url()) }),
    horizon: z.strictObject({ src: z.optional(z.number()), at: z.optional(z.number()) }),
    focus: z.strictObject({ x: z.optional(z.number()), y: z.optional(z.number()), zoom: z.optional(z.number()) }),
    hour: z.number(),
    grades: z.strictObject({ light: z.number(), dusk: z.number(), night: z.number() }),
    dark: z.enum(['dusk', 'night']),
    look: z.strictObject({
        effect: AtmosphereLookOverrideSchema.shape.look,
        params: z.optional(z.record(z.string(), z.number())),
        dissolve: z.optional(z.strictObject({ style: AtmosphereLookOverrideSchema.shape.dissolve, from: z.optional(z.number()), to: z.optional(z.number()) })),
        strength: z.optional(z.number()),
    }),
    adjust: z.optional(z.strictObject({ exposure: z.optional(z.number()), contrast: z.optional(z.number()), saturation: z.optional(z.number()), temperature: z.optional(z.number()) })),
    themes: z.optional(z.array(z.enum(['light', 'dark']))),
}));

export type PluginAtmospherePictureContributionV1 = z.infer<typeof PluginAtmospherePictureContributionV1Schema>;

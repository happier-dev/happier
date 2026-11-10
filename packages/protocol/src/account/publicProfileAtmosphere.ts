import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AtmospherePresentationSchema, AtmosphereLookOverrideSchema } from './settings/homeAtmosphere.js';
import { PluginAtmospherePictureContributionV1Schema } from '../plugins/contributions/atmospherePictures.js';
import { readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';

export const PublicProfilePictureCreditUrlV1Schema = lazyZodSchema(() => z.url().check(z.refine(value => /^https:/iu.test(value))));

/** Only the selected picture's portable metadata survives review; no plugin, source URL or device address. */
export const PublicProfilePictureDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
    ...z.omit(PluginAtmospherePictureContributionV1Schema, { id: true, src: true, credit: true, look: true }).shape,
    /** Captured render input: released builtin looks adapt haze; custom looks and own pictures do not. */
    adaptiveHaze: z.boolean(),
    look: z.strictObject({
        effect: z.nonoptional(AtmosphereLookOverrideSchema.shape.look),
        params: z.record(z.string(), z.number()),
        strength: z.nonoptional(PluginAtmospherePictureContributionV1Schema.shape.look.shape.strength),
        dissolve: z.strictObject({
            style: z.nonoptional(AtmosphereLookOverrideSchema.shape.dissolve),
            from: z.number(), to: z.number(),
        }),
    }),
    credit: z.nullable(z.strictObject({
        ...PluginAtmospherePictureContributionV1Schema.shape.credit.shape,
        url: z.optional(PublicProfilePictureCreditUrlV1Schema),
    })),
}));

const PicturePresentationShape = () => ({
    layout: AtmospherePresentationSchema.shape.picture.shape.layout,
    descriptor: PublicProfilePictureDescriptorV1Schema,
});

/** Closed public copy of the active shared atmosphere presentation, never a live library reference. */
export const PublicProfileAtmosphereV1Schema = lazyZodSchema(() => z.discriminatedUnion('source', [
    z.strictObject({ source: z.literal('none') }),
    z.strictObject({ source: z.literal('planet'), planet: AtmospherePresentationSchema.shape.planet }),
    z.strictObject({ source: z.literal('picture'), picture: z.strictObject({
        ...PicturePresentationShape(),
        ref: z.strictObject({ kind: z.literal('publication'), id: z.string().check(z.minLength(1)) }),
    }) }),
]));

/** Client retains normalized selected pixels in approval custody. Preview has no transport effect. */
export const PublicProfilePreparedAtmosphereV1Schema = lazyZodSchema(() => z.discriminatedUnion('source', [
    z.strictObject({ source: z.literal('none') }),
    z.strictObject({ source: z.literal('planet'), planet: AtmospherePresentationSchema.shape.planet }),
    z.strictObject({ source: z.literal('picture'), picture: z.strictObject({
        ...PicturePresentationShape(),
        content: z.strictObject({ mimeType: z.enum(['image/png', 'image/webp']), base64: z.string().check(z.refine(value => {
            const length = readCanonicalPaddedBase64DecodedLength(value);
            return length !== null && length > 0;
        })) }),
    }) }),
]));

export type PublicProfileAtmosphereV1 = z.infer<typeof PublicProfileAtmosphereV1Schema>;
export type PublicProfilePreparedAtmosphereV1 = z.infer<typeof PublicProfilePreparedAtmosphereV1Schema>;
export type PublicProfilePictureDescriptorV1 = z.infer<typeof PublicProfilePictureDescriptorV1Schema>;

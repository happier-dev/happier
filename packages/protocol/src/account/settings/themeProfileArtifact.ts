import { z } from '../../zodRuntimePolicy.js';
import { THEME_PROFILE_ARTIFACT_KIND_V1 as THEME_ARTIFACT_KIND } from '../../artifacts/artifactKindV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ThemeProfileColorSchema, ThemeProfileSeedsSchema, ThemeProfileSourceSchema, ThemeRadiusScaleNameSchema } from './themeProfiles.js';

/** Private Artifact kind, independent of registry/file kind. */
export { THEME_ARTIFACT_KIND };
/** The six authored public roles consumed by a miniature; never the full theme or CSS. */
export const THEME_MINIATURE_OVERRIDE_TOKENS = {
    canvas: 'background.canvas', raised: 'surface.elevated', text: 'text.primary',
    mutedText: 'text.secondary', accent: 'control.button.primary.background', border: 'border.default',
} as const;
const ThemeProfileMiniaturePaletteSchema = lazyZodSchema(() => z.strictObject({ seeds: z.optional(ThemeProfileSeedsSchema),
    overrides: z.partialRecord(z.enum(Object.values(THEME_MINIATURE_OVERRIDE_TOKENS)), ThemeProfileColorSchema), radius: ThemeRadiusScaleNameSchema }));
/** Minimal authored inputs for the header-only miniature; CSS stays in the body. */
export const ThemeProfileArtifactHeaderSchema = lazyZodSchema(() => z.object({
    v: z.literal(1), kind: z.literal(THEME_ARTIFACT_KIND), title: z.string(),
    mode: z.enum(['light', 'dark']), themeSource: ThemeProfileSourceSchema,
    compatibility: z.strictObject({ status: z.enum(['supported', 'partial']), requiresAppVersion: z.optional(z.string()), unsupportedPaths: z.array(z.string()) }),
    palette: ThemeProfileMiniaturePaletteSchema,
    palettes: z.optional(z.partialRecord(z.enum(['light', 'dark']), ThemeProfileMiniaturePaletteSchema)),
}));
export type ThemeProfileArtifactHeader = z.infer<typeof ThemeProfileArtifactHeaderSchema>;

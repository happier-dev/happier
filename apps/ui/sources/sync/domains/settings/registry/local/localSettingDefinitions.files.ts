import { RemoteImageConsentV1Schema } from '../../remoteImageConsent';
import { z } from 'zod/mini';

export const ImageBackgroundSchema = z.enum(['checkerboard', 'light', 'dark']);
export const ImageBackgroundByKindSchema = z.catch(z.object({
    image: z.optional(ImageBackgroundSchema),
    svg: z.optional(ImageBackgroundSchema),
}), {});
export type ImageBackground = z.infer<typeof ImageBackgroundSchema>;
export type ImageBackgroundByKind = z.infer<typeof ImageBackgroundByKindSchema>;

export const FILES_LOCAL_SETTING_DEFINITIONS = {
    filesImageBackgroundByKind: {
        schema: ImageBackgroundByKindSchema,
        default: {},
        description: 'Manual background for image and SVG previews on this device; absent kinds use checkerboard',
        storageScope: 'local',
    },
    remoteImageConsentV1: {
        schema: RemoteImageConsentV1Schema,
        default: [],
        description: 'Workspace Markdown files explicitly allowed to load remote images on this device',
        storageScope: 'local',
    },
} as const;

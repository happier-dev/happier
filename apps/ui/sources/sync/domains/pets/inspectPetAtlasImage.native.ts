import { AlphaType, ColorType, Skia } from '@shopify/react-native-skia';
import { inspectPetAtlasRgbaPixelsV1 } from '@happier-dev/protocol/pets/atlasPixelInspection';
import type { PetAtlasInspectorV1 } from '@happier-dev/protocol/pets/accountPetCreateValidation';

/** Native decoder for the protocol atlas check, through the app's existing Skia image stack. */
export const inspectPetAtlasImage: PetAtlasInspectorV1 = async (bytes) => {
    const data = Skia.Data.fromBytes(new Uint8Array(bytes));
    try {
        const image = Skia.Image.MakeImageFromEncoded(data);
        if (!image) throw new Error('pet_atlas_decode_failed');
        try {
            const width = image.width();
            const height = image.height();
            const pixels = image.readPixels(0, 0, {
                width, height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul,
            });
            if (!(pixels instanceof Uint8Array)) throw new Error('pet_atlas_decode_failed');
            return {
                width,
                height,
                hasAlpha: image.getImageInfo().alphaType !== AlphaType.Opaque,
                ...inspectPetAtlasRgbaPixelsV1({ data: pixels, width, height, channels: 4 }),
            };
        } finally {
            image.dispose();
        }
    } finally {
        data.dispose();
    }
};

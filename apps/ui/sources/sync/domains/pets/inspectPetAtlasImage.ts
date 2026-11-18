import { inspectPetAtlasRgbaPixelsV1 } from '@happier-dev/protocol/pets/atlasPixelInspection';
import type { PetAtlasInspectorV1 } from '@happier-dev/protocol/pets/accountPetCreateValidation';

/**
 * Browser decoder for the protocol atlas check. Decoded canvas pixels are always RGBA,
 * so transparency is enforced by the protocol's transparent-background facts.
 */
export const inspectPetAtlasImage: PetAtlasInspectorV1 = async (bytes, mediaType) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mediaType }), {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
    });
    try {
        const { width, height } = bitmap;
        const canvas = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(width, height)
            : Object.assign(document.createElement('canvas'), { width, height });
        const context = canvas.getContext('2d', { willReadFrequently: true }) as
            CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!context) throw new Error('pet_atlas_canvas_unavailable');
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, width, height);
        return {
            width,
            height,
            hasAlpha: true,
            ...inspectPetAtlasRgbaPixelsV1({ data: new Uint8Array(pixels.data.buffer), width, height, channels: 4 }),
        };
    } finally {
        bitmap.close();
    }
};

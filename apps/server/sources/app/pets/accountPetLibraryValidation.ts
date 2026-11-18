import { inspectPetAtlasRgbaPixelsV1 } from '@happier-dev/protocol/pets/atlasPixelInspection';
import {
    validateAccountPetCreateRequestV1,
    type AccountPetCreateValidationOptionsV1,
    type AccountPetCreateValidationResultV1,
    type PetAtlasInspectionV1,
} from '@happier-dev/protocol/pets/accountPetCreateValidation';
import { loadSharp } from "@/storage/blob/sharpRuntime";

export type PetAtlasInspection = PetAtlasInspectionV1;

export type AccountPetCreateValidationOptions = Partial<AccountPetCreateValidationOptionsV1>;

export type AccountPetCreateValidationResult = AccountPetCreateValidationResultV1;

export async function inspectPetAtlasWithSharp(bytes: Uint8Array): Promise<PetAtlasInspection> {
    const sharp = await loadSharp();
    const image = sharp(Buffer.from(bytes), { failOn: "error" });
    const metadata = await image.metadata();
    const raw = await image
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const inspection = inspectPetAtlasRgbaPixelsV1({
        data: raw.data,
        width: raw.info.width,
        height: raw.info.height,
        channels: raw.info.channels,
    });
    return {
        width: metadata.width ?? 0,
        height: metadata.height ?? 0,
        hasAlpha: Boolean(metadata.hasAlpha),
        ...inspection,
    };
}

/** Plain-Account admission: the protocol owner's package checks with the Home's sharp decoder. */
export async function validateAccountPetCreateRequest(
    rawRequest: unknown,
    options: AccountPetCreateValidationOptions = {},
): Promise<AccountPetCreateValidationResult> {
    return await validateAccountPetCreateRequestV1(rawRequest, {
        ...options,
        inspectAtlas: options.inspectAtlas ?? inspectPetAtlasWithSharp,
    });
}

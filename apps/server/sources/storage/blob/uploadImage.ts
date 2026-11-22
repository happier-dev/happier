import { randomKey } from "@/utils/keys/randomKey";
import { processImage } from "./processImage";
import { writePublicFile } from "./files";
import { db } from "../db";
import type { Tx } from "@/storage/inTx";
import type { ImageRef } from "./files";

export interface PreparedUploadedImage {
    image: ImageRef;
    persist: (client: Pick<Tx, "uploadedFile">) => Promise<void>;
}

export const uploadedPublicImageUrlReuseKeyPrefix = 'image-url:';

/** Prepare file bytes outside the Account transaction; persist its FK only after Account insertion. */
export async function prepareUploadedImage(userId: string, directory: string, prefix: string, url: string, src: Buffer): Promise<PreparedUploadedImage> {

    // Check if image already exists
    const existing = await db.uploadedFile.findFirst({
        where: {
            reuseKey: uploadedPublicImageUrlReuseKeyPrefix + url
        }
    });

    if (existing && existing.thumbhash && existing.width && existing.height) {
        return {
            image: {
                path: existing.path,
                thumbhash: existing.thumbhash,
                width: existing.width,
                height: existing.height,
            },
            persist: async () => {},
        };
    }

    // Publish the re-encoded bytes, not the fetched original: an imported avatar
    // is remote input, and its aspect ratio is preserved while its resolution,
    // trailing bytes, and embedded metadata are bounded by the media owner.
    const processed = await processImage(src, { fit: 'contain' });
    const key = randomKey(prefix);
    let filename = `${key}.${processed.extension}`;
    const path = `public/users/${userId}/${directory}/${filename}`;
    await writePublicFile(path, processed.bytes);
    return {
        image: {
            path,
            thumbhash: processed.thumbhash,
            width: processed.width,
            height: processed.height,
        },
        persist: async (client) => {
            await client.uploadedFile.create({
                data: {
                    accountId: userId,
                    path,
                    reuseKey: uploadedPublicImageUrlReuseKeyPrefix + url,
                    width: processed.width,
                    height: processed.height,
                    thumbhash: processed.thumbhash,
                    storedSizeBytes: BigInt(processed.bytes.byteLength),
                },
            });
        },
    };
}

export async function uploadImage(userId: string, directory: string, prefix: string, url: string, src: Buffer): Promise<ImageRef> {
    const prepared = await prepareUploadedImage(userId, directory, prefix, url, src);
    await prepared.persist(db);
    return prepared.image;
}

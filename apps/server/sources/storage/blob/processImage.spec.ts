import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { processImage, tryProcessImage } from "./processImage";

async function jpeg(width: number, height: number): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } } })
        .jpeg()
        .toBuffer();
}

async function pngWithAlpha(width: number, height: number): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } } })
        .png()
        .toBuffer();
}

describe("processImage publication contract", () => {
    it("returns re-encoded publication bytes whose metadata describes those bytes", async () => {
        // The published dimensions must describe what a client will actually
        // render. Returning the source dimensions alongside resized bytes was the
        // exact mismatch that made the old thumbnail pixels unpublishable.
        const source = await jpeg(1600, 800);

        const result = await processImage(source, { fit: "contain", maxEdge: 512 });

        expect(result.format).toBe("jpeg");
        expect(result.mimeType).toBe("image/jpeg");
        expect(result.extension).toBe("jpg");
        expect(result.width).toBe(512);
        expect(result.height).toBe(256);
        const published = await sharp(result.bytes).metadata();
        expect(published.width).toBe(result.width);
        expect(published.height).toBe(result.height);
        expect(published.format).toBe("jpeg");
        expect(result.thumbhash.length).toBeGreaterThan(0);
    });

    it("preserves the aspect ratio for the avatar caller and never enlarges", async () => {
        const source = await jpeg(200, 100);

        const result = await processImage(source, { fit: "contain", maxEdge: 512 });

        expect(result.width).toBe(200);
        expect(result.height).toBe(100);
    });

    it("fits a square logo by cropping rather than distorting or upscaling", async () => {
        const center = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#00ff00" } }).png().toBuffer();
        const source = await sharp({ create: { width: 1600, height: 800, channels: 3, background: "#ff0000" } })
            .composite([{ input: center, left: 400, top: 0 }]).png().toBuffer();
        const wide = await processImage(source, { fit: "cover", maxEdge: 512 });
        expect(wide.width).toBe(512);
        expect(wide.height).toBe(512);
        // Stretching the whole source would leave red at this point; a centered crop is green.
        const pixel = await sharp(wide.bytes).extract({ left: 32, top: 256, width: 1, height: 1 }).raw().toBuffer();
        expect(pixel[0]).toBeLessThanOrEqual(5);
        expect(pixel[1]).toBeGreaterThanOrEqual(250);
        expect(pixel[2]).toBeLessThanOrEqual(5);

        const small = await processImage(await jpeg(300, 120), { fit: "cover", maxEdge: 512 });
        expect(small.width).toBe(120);
        expect(small.height).toBe(120);
    });

    it("applies EXIF orientation so the published image is not sideways", async () => {
        // A phone photograph is commonly stored unrotated with an orientation
        // tag. Re-encoding drops all source metadata, so the rotation has to be
        // applied to the pixels — otherwise the client confirms an upright
        // preview of its own source bytes and the Home publishes a sideways one.
        // Orientation 6 means "rotate 90° clockwise to display".
        const landscapeStoredAsPortrait = await sharp({
            create: { width: 1600, height: 800, channels: 3, background: { r: 255, g: 0, b: 0 } },
        })
            .withMetadata({ orientation: 6 })
            .jpeg()
            .toBuffer();

        const contained = await processImage(landscapeStoredAsPortrait, { fit: "contain", maxEdge: 512 });

        // Displayed, this image is 800 wide by 1600 tall.
        expect(contained.width).toBe(256);
        expect(contained.height).toBe(512);
        const publishedContain = await sharp(contained.bytes).metadata();
        expect(publishedContain.width).toBe(contained.width);
        expect(publishedContain.height).toBe(contained.height);

        // The square crop must use the *displayed* shorter edge.
        const smallSideways = await sharp({
            create: { width: 300, height: 120, channels: 3, background: { r: 0, g: 255, b: 0 } },
        })
            .withMetadata({ orientation: 6 })
            .jpeg()
            .toBuffer();
        const covered = await processImage(smallSideways, { fit: "cover", maxEdge: 512 });
        expect(covered.width).toBe(120);
        expect(covered.height).toBe(120);
    });

    it("keeps transparency as PNG and publishes opaque input as JPEG", async () => {
        const transparent = await processImage(await pngWithAlpha(300, 300), { fit: "cover", maxEdge: 512 });
        expect(transparent.format).toBe("png");
        expect(transparent.mimeType).toBe("image/png");
        expect(transparent.extension).toBe("png");

        const opaque = await processImage(await jpeg(300, 300), { fit: "cover", maxEdge: 512 });
        expect(opaque.format).toBe("jpeg");
        expect(opaque.extension).toBe("jpg");
    });

    it("validates the declared source MIME from the same decoded metadata", async () => {
        const source = await jpeg(300, 300);

        await expect(tryProcessImage(source, { expectedSourceMimeType: "image/jpeg" }))
            .resolves.toMatchObject({ ok: true });
        await expect(tryProcessImage(source, { expectedSourceMimeType: "image/png" }))
            .resolves.toEqual({ ok: false, reason: "source_mime_mismatch" });
    });

    it.each([
        { channels: 3 as const, alpha: 1, format: "jpeg", mimeType: "image/jpeg", extension: "jpg" },
        { channels: 4 as const, alpha: 0.5, format: "png", mimeType: "image/png", extension: "png" },
    ])("normalizes explicitly admitted $channels-channel WebP pixels into $format publication bytes", async ({ channels, alpha, format, mimeType, extension }) => {
        const source = await sharp({
            create: { width: 3000, height: 1500, channels, background: { r: 255, g: 0, b: 0, alpha } },
        }).withMetadata({ orientation: 6 }).webp({ lossless: true }).toBuffer();

        const result = await processImage(source, {
            allowedSourceMimeTypes: ["image/png", "image/jpeg", "image/webp"],
            expectedSourceMimeType: "image/webp",
            maxEdge: 2560,
        });

        expect(result).toMatchObject({ format, mimeType, extension, width: 1280, height: 2560 });
        const published = await sharp(result.bytes).metadata();
        expect(published).toMatchObject({ format, width: result.width, height: result.height });
        expect(published.orientation).toBeUndefined();
        expect(published.exif).toBeUndefined();
        expect(published.icc).toBeUndefined();
        const pixel = await sharp(result.bytes).extract({ left: 0, top: 0, width: 1, height: 1 })
            .ensureAlpha().raw().toBuffer();
        expect(pixel[0]).toBeGreaterThanOrEqual(250);
        expect(pixel[1]).toBeLessThanOrEqual(5);
        expect(pixel[2]).toBeLessThanOrEqual(5);
        expect(Math.abs(pixel[3] - alpha * 255)).toBeLessThanOrEqual(1);
        expect(result.thumbhash.length).toBeGreaterThan(0);
    });

    it("keeps source admission, declared MIME and decode budget independent for WebP", async () => {
        const webp = await sharp({ create: { width: 64, height: 32, channels: 3, background: "red" } })
            .webp().toBuffer();
        const allowedSourceMimeTypes = ["image/webp"] as const;

        await expect(tryProcessImage(webp, { expectedSourceMimeType: "image/webp" }))
            .resolves.toEqual({ ok: false, reason: "unsupported_format" });
        await expect(tryProcessImage(webp, { allowedSourceMimeTypes, expectedSourceMimeType: "image/png" }))
            .resolves.toEqual({ ok: false, reason: "source_mime_mismatch" });
        await expect(tryProcessImage(await jpeg(64, 32), { allowedSourceMimeTypes }))
            .resolves.toEqual({ ok: false, reason: "unsupported_format" });
        await expect(tryProcessImage(webp, { allowedSourceMimeTypes, maxInputPixels: 64 * 32 - 1 }))
            .resolves.toEqual({ ok: false, reason: "too_many_pixels" });
        const admitted = await processImage(webp, { allowedSourceMimeTypes });
        expect(admitted).toMatchObject({ width: 64, height: 32, format: "jpeg" });
    });

    it("preserves reviewed WebP pixels exactly when a caller requests lossless PNG output", async () => {
        const sourcePixels = Buffer.from(Uint8Array.from({ length: 64 * 32 * 3 }, (_, index) => index * 17 % 256));
        const source = await sharp(sourcePixels, { raw: { width: 64, height: 32, channels: 3 } })
            .webp({ lossless: true }).toBuffer();

        const result = await processImage(source, {
            allowedSourceMimeTypes: ["image/webp"],
            expectedSourceMimeType: "image/webp",
            outputFormat: "png",
            maxEdge: 2560,
        });

        expect(result).toMatchObject({ width: 64, height: 32, format: "png", mimeType: "image/png", extension: "png" });
        const reviewedPixels = await sharp(source).raw().toBuffer();
        const publishedPixels = await sharp(result.bytes).raw().toBuffer();
        expect(publishedPixels.equals(reviewedPixels)).toBe(true);
    });

    it("strips an unrelated trailing payload instead of republishing the input", async () => {
        const source = await jpeg(300, 300);
        const smuggled = Buffer.concat([source, Buffer.from("<?php echo 'payload'; ?>")]);

        const result = await processImage(smuggled, { fit: "cover", maxEdge: 512 });

        expect(result.bytes.includes(Buffer.from("payload"))).toBe(false);
        expect(result.bytes.equals(smuggled)).toBe(false);
        expect(result.bytes.length).toBeLessThan(smuggled.length);
        // The published object is a complete, independently decodable image
        // rather than a truncation of the submitted bytes.
        expect((await sharp(result.bytes).metadata()).width).toBe(300);
    });

    it("enforces the default decode budget and caller overrides while accepting the boundary", async () => {
        // 4096² RGBA pixels occupy the documented 64 MiB default working set.
        const atBudget = await jpeg(4096, 4096);
        await expect(tryProcessImage(atBudget)).resolves.toMatchObject({
            ok: true, image: { width: 512, height: 512 },
        });
        // Uniform PNG compression keeps the submitted bytes small even just above that budget.
        const bomb = await sharp({
            create: { width: 4096, height: 4097, channels: 3, background: { r: 1, g: 2, b: 3 } },
        }).png({ compressionLevel: 9 }).toBuffer();
        await expect(tryProcessImage(bomb)).resolves.toEqual({ ok: false, reason: "too_many_pixels" });
        await expect(tryProcessImage(atBudget, { maxInputPixels: 4_000_000 }))
            .resolves.toEqual({ ok: false, reason: "too_many_pixels" });
    });

    it("rejects an unsupported format and undecodable bytes with typed results", async () => {
        const webp = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } } })
            .webp()
            .toBuffer();

        expect(await tryProcessImage(webp)).toEqual({ ok: false, reason: "unsupported_format" });
        expect(await tryProcessImage(Buffer.from("not an image at all"))).toEqual({
            ok: false,
            reason: "undecodable",
        });
        await expect(processImage(Buffer.from("not an image at all"))).rejects.toThrow();
    });

});

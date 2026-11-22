import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { readPublicFile } from "./files";
import { uploadImage } from "./uploadImage";

describe("Account avatar publication (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-upload-image-",
            initAuth: false,
            initFiles: true,
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function account() {
        return db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
    }

    it("publishes re-encoded bytes with the stored dimensions and a matching extension", async () => {
        const owner = await account();
        const source = await sharp({
            create: { width: 1200, height: 600, channels: 3, background: { r: 3, g: 4, b: 5 } },
        }).jpeg().toBuffer();
        // An imported avatar is remote input; a payload appended to it must not
        // be republished as this Account's public object.
        const smuggled = Buffer.concat([source, Buffer.from("trailing-payload")]);

        const image = await uploadImage(owner.id, "avatars", "github", "https://example.test/a.jpg", smuggled);

        // The aspect ratio is preserved for this caller: an avatar is not cropped.
        expect(image.width).toBe(512);
        expect(image.height).toBe(256);
        expect(image.path.endsWith(".jpg")).toBe(true);

        const published = Buffer.from(await readPublicFile(image.path));
        expect(published.includes(Buffer.from("trailing-payload"))).toBe(false);
        const meta = await sharp(published).metadata();
        // The persisted metadata describes the published bytes, not the source.
        expect(meta.width).toBe(image.width);
        expect(meta.height).toBe(image.height);

        const row = await db.uploadedFile.findFirstOrThrow({ where: { accountId: owner.id } });
        expect(row.width).toBe(image.width);
        expect(row.height).toBe(image.height);
        expect(row.path).toBe(image.path);
        expect(row.storedSizeBytes).toBe(BigInt(published.byteLength));
    });

    it("never enlarges a small avatar to reach the published bound", async () => {
        const owner = await account();
        const source = await sharp({
            create: { width: 96, height: 96, channels: 3, background: { r: 7, g: 7, b: 7 } },
        }).jpeg().toBuffer();

        const image = await uploadImage(owner.id, "avatars", "github", "https://example.test/small.jpg", source);

        expect(image.width).toBe(96);
        expect(image.height).toBe(96);
    });

    it("reuses an already imported origin URL without republishing it", async () => {
        const owner = await account();
        const source = await sharp({
            create: { width: 200, height: 200, channels: 3, background: { r: 1, g: 1, b: 1 } },
        }).jpeg().toBuffer();
        const url = `https://example.test/${crypto.randomUUID()}.jpg`;

        const first = await uploadImage(owner.id, "avatars", "github", url, source);
        const second = await uploadImage(owner.id, "avatars", "github", url, source);

        expect(second.path).toBe(first.path);
        expect(await db.uploadedFile.count({ where: { reuseKey: `image-url:${url}` } })).toBe(1);
    });
});

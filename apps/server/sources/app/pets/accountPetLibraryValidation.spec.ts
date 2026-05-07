import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { validateAccountPetCreateRequest } from "./accountPetLibraryValidation";

function digest(bytes: Uint8Array): string {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const WEBP_BYTES = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46,
    0x18, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x20,
    0x00,
]);

function crc32(bytes: Buffer): number {
    let c = 0xffffffff;
    for (const byte of bytes) {
        c ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
    }
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
    return Buffer.concat([length, typeBytes, data, crc]);
}

function opaqueWhiteAtlasPng(): Uint8Array {
    const width = 1536;
    const height = 1872;
    const bytesPerRow = 1 + width * 4;
    const raw = Buffer.alloc(bytesPerRow * height);
    for (let y = 0; y < height; y += 1) {
        const rowOffset = y * bytesPerRow;
        raw[rowOffset] = 0;
        for (let x = 0; x < width; x += 1) {
            const offset = rowOffset + 1 + x * 4;
            raw[offset] = 255;
            raw[offset + 1] = 255;
            raw[offset + 2] = 255;
            raw[offset + 3] = 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", deflateSync(raw, { level: 9 })),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

function requestFor(bytes: Uint8Array, overrides: Record<string, unknown> = {}) {
    return {
        manifest: {
            id: "blink",
            displayName: "Blink",
            description: "Happier companion pet",
            spritesheetPath: "spritesheet.webp",
        },
        spritesheet: {
            mediaType: "image/webp",
            encoding: "base64",
            data: Buffer.from(bytes).toString("base64"),
            sizeBytes: bytes.byteLength,
            digest: digest(bytes),
            ...overrides,
        },
        origin: { kind: "manualImport" },
    };
}

function requestWithManifest(overrides: Record<string, unknown>) {
    const request = requestFor(WEBP_BYTES);
    return {
        ...request,
        manifest: {
            ...request.manifest,
            ...overrides,
        },
    };
}

describe("validateAccountPetCreateRequest", () => {
    it("accepts canonical WebP bytes that match the declared digest and atlas inspection", async () => {
        const result = await validateAccountPetCreateRequest(requestFor(WEBP_BYTES), {
            maxSpritesheetBytes: 1024,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        expect(result.ok).toBe(true);
    });

    it.each([
        ["random text", Uint8Array.from(Buffer.from("hello"))],
        ["zip", Uint8Array.from([0x50, 0x4b, 0x03, 0x04])],
        ["svg", Uint8Array.from(Buffer.from("<svg></svg>"))],
        ["html", Uint8Array.from(Buffer.from("<!doctype html>"))],
        ["renamed executable", Uint8Array.from([0x4d, 0x5a, 0x90, 0x00])],
    ])("rejects %s payloads before storage", async (_label, bytes) => {
        const result = await validateAccountPetCreateRequest(requestFor(bytes), {
            maxSpritesheetBytes: 1024,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "invalid_request",
        }));
    });

    it("rejects wrong digests", async () => {
        const result = await validateAccountPetCreateRequest(requestFor(WEBP_BYTES, { digest: "sha256:wrong" }), {
            maxSpritesheetBytes: 1024,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "invalid_request",
        }));
    });

    it("rejects manifests that exceed the configured manifest byte limit", async () => {
        const result = await validateAccountPetCreateRequest(requestWithManifest({ description: "x".repeat(256) }), {
            maxManifestBytes: 128,
            maxSpritesheetBytes: 1024,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "invalid_request",
        }));
    });

    it("rejects packages that exceed the configured canonical package byte limit", async () => {
        const result = await validateAccountPetCreateRequest(requestFor(WEBP_BYTES), {
            maxPackageBytes: WEBP_BYTES.byteLength,
            maxSpritesheetBytes: 1024,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "invalid_request",
        }));
    });

    it("rejects client-supplied object keys", async () => {
        const result = await validateAccountPetCreateRequest(requestFor(WEBP_BYTES, { objectKey: "private/accounts/u1/pets/p1/x.webp" }), {
            maxSpritesheetBytes: 1024,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "invalid_request",
        }));
    });

    it("rejects local path metadata from symlink-derived imports", async () => {
        const result = await validateAccountPetCreateRequest({
            ...requestFor(WEBP_BYTES),
            origin: {
                kind: "manualImport",
                packagePath: "/tmp/codex/pets/blink",
                symlinkTarget: "/etc/passwd",
            },
        }, {
            maxSpritesheetBytes: 1024,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "invalid_request",
        }));
    });

    it("rejects spritesheet path traversal in the manifest", async () => {
        const result = await validateAccountPetCreateRequest(requestWithManifest({ spritesheetPath: "../spritesheet.webp" }), {
            maxSpritesheetBytes: 1024,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "invalid_request",
        }));
    });

    it("rejects atlas dimensions that do not match the pet contract", async () => {
        const result = await validateAccountPetCreateRequest(requestFor(WEBP_BYTES), {
            maxSpritesheetBytes: 1024,
            inspectAtlas: async () => ({
                width: 64,
                height: 64,
                hasAlpha: true,
            }),
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "invalid_request",
        }));
    });

    it("rejects opaque atlas backgrounds even when the image has an alpha channel", async () => {
        const bytes = opaqueWhiteAtlasPng();
        const result = await validateAccountPetCreateRequest({
            ...requestFor(bytes),
            manifest: {
                id: "blink",
                displayName: "Blink",
                description: "Happier companion pet",
                spritesheetPath: "spritesheet.png",
            },
            spritesheet: {
                mediaType: "image/png",
                encoding: "base64",
                data: Buffer.from(bytes).toString("base64"),
                sizeBytes: bytes.byteLength,
                digest: digest(bytes),
            },
        }, {
            maxSpritesheetBytes: bytes.byteLength + 1,
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "invalid_request",
        }));
        });
    });

    it("rejects data URI spritesheet payloads before base64 decoding", async () => {
        const request = requestFor(WEBP_BYTES, {
            data: `data:image/webp;base64,${Buffer.from(WEBP_BYTES).toString("base64")}`,
        });

        const result = await validateAccountPetCreateRequest(request, {
            maxSpritesheetBytes: 1024,
            inspectAtlas: async () => ({
                width: 1536,
                height: 1872,
                hasAlpha: true,
            }),
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "invalid_request",
        }));
    });

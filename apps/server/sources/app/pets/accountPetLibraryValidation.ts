import { createHash } from "node:crypto";

import {
    AccountPetCreateRequestV1Schema,
    isCanonicalPetSpritesheetPathV1,
    inspectPetAtlasRgbaPixelsV1,
    PET_ATLAS_V1,
    PET_PACKAGE_LIMITS_V1,
    type AccountPetCreateRequestV1,
    type PetAssetMediaTypeV1,
} from "@happier-dev/protocol";
import { loadSharp } from "../../storage/blob/sharpRuntime";

export type PetAtlasInspection = Readonly<{
    width: number;
    height: number;
    hasAlpha: boolean;
    hasOpaqueBackground?: boolean;
    hasTransparentBackground?: boolean;
    hasVisibleUsedCells?: boolean;
    hasTransparentUnusedCells?: boolean;
}>;

export type AccountPetCreateValidationOptions = Readonly<{
    maxManifestBytes?: number;
    maxSpritesheetBytes?: number;
    maxPackageBytes?: number;
    inspectAtlas?: (bytes: Uint8Array, mediaType: PetAssetMediaTypeV1) => Promise<PetAtlasInspection>;
}>;

export type AccountPetCreateValidationResult =
    | Readonly<{
        ok: true;
        request: AccountPetCreateRequestV1;
        spritesheetBytes: Uint8Array;
    }>
    | Readonly<{
        ok: false;
        errorCode: "invalid_request";
        error: "invalid_request";
    }>;

const INVALID_RESULT: AccountPetCreateValidationResult = {
    ok: false,
    errorCode: "invalid_request",
    error: "invalid_request",
};

const TOP_LEVEL_KEYS = new Set(["manifest", "spritesheet", "origin"]);
const MANIFEST_KEYS = new Set(["id", "displayName", "description", "spritesheetPath"]);
const SPRITESHEET_KEYS = new Set(["mediaType", "encoding", "data", "sizeBytes", "digest"]);
const ORIGIN_KEYS_BY_KIND: Readonly<Record<string, ReadonlySet<string>>> = {
    builtInImport: new Set(["kind", "petId"]),
    detectedCodexHome: new Set(["kind", "homeKind"]),
    manualImport: new Set(["kind"]),
};
const BLOCKED_CLIENT_STORAGE_KEYS = new Set(["objectKey", "storageKey", "path", "packagePath", "filename"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasUnexpectedKeys(value: unknown, allowedKeys: ReadonlySet<string>): boolean {
    if (!isRecord(value)) return true;
    return Object.keys(value).some((key) => !allowedKeys.has(key));
}

function hasBlockedClientStorageKeys(value: unknown): boolean {
    if (!isRecord(value)) return false;
    return Object.keys(value).some((key) => BLOCKED_CLIENT_STORAGE_KEYS.has(key));
}

function hasUnexpectedOriginKeys(value: unknown): boolean {
    if (!isRecord(value) || typeof value.kind !== "string") return true;
    const allowedKeys = ORIGIN_KEYS_BY_KIND[value.kind];
    if (!allowedKeys) return true;
    return hasUnexpectedKeys(value, allowedKeys);
}

function decodeStrictBase64(value: string): Uint8Array | null {
    try {
        const normalized = value.trim();
        const bytes = Buffer.from(normalized, "base64");
        if (bytes.byteLength === 0) return null;
        const canonical = bytes.toString("base64").replace(/=+$/, "");
        const provided = normalized.replace(/=+$/, "");
        if (canonical !== provided) return null;
        return new Uint8Array(bytes);
    } catch {
        return null;
    }
}

function calculateDigest(bytes: Uint8Array): string {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function utf8JsonByteLength(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function hasExpectedMagicBytes(bytes: Uint8Array, mediaType: PetAssetMediaTypeV1): boolean {
    if (mediaType === "image/webp") {
        return bytes.byteLength >= 12
            && bytes[0] === 0x52
            && bytes[1] === 0x49
            && bytes[2] === 0x46
            && bytes[3] === 0x46
            && bytes[8] === 0x57
            && bytes[9] === 0x45
            && bytes[10] === 0x42
            && bytes[11] === 0x50;
    }
    return bytes.byteLength >= 8
        && bytes[0] === 0x89
        && bytes[1] === 0x50
        && bytes[2] === 0x4e
        && bytes[3] === 0x47
        && bytes[4] === 0x0d
        && bytes[5] === 0x0a
        && bytes[6] === 0x1a
        && bytes[7] === 0x0a;
}

export async function inspectPetAtlasWithSharp(bytes: Uint8Array): Promise<PetAtlasInspection> {
    const sharp = loadSharp();
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

function hasExpectedAtlasContract(inspection: PetAtlasInspection): boolean {
    return inspection.width === PET_ATLAS_V1.width
        && inspection.height === PET_ATLAS_V1.height
        && inspection.hasAlpha === true
        && inspection.hasOpaqueBackground !== true
        && inspection.hasTransparentBackground !== false
        && inspection.hasVisibleUsedCells !== false
        && inspection.hasTransparentUnusedCells !== false;
}

export async function validateAccountPetCreateRequest(
    rawRequest: unknown,
    options: AccountPetCreateValidationOptions = {},
): Promise<AccountPetCreateValidationResult> {
    if (
        hasUnexpectedKeys(rawRequest, TOP_LEVEL_KEYS)
        || hasBlockedClientStorageKeys(rawRequest)
        || !isRecord(rawRequest)
        || hasUnexpectedKeys(rawRequest.manifest, MANIFEST_KEYS)
        || hasUnexpectedKeys(rawRequest.spritesheet, SPRITESHEET_KEYS)
        || hasBlockedClientStorageKeys(rawRequest.spritesheet)
        || hasUnexpectedOriginKeys(rawRequest.origin)
        || hasBlockedClientStorageKeys(rawRequest.origin)
    ) {
        return INVALID_RESULT;
    }

    const parsed = AccountPetCreateRequestV1Schema.safeParse(rawRequest);
    if (!parsed.success || !isCanonicalPetSpritesheetPathV1(parsed.data.manifest.spritesheetPath)) {
        return INVALID_RESULT;
    }

    const manifestBytes = utf8JsonByteLength(parsed.data.manifest);
    const maxManifestBytes = options.maxManifestBytes ?? PET_PACKAGE_LIMITS_V1.maxManifestBytes;
    if (manifestBytes > maxManifestBytes) {
        return INVALID_RESULT;
    }

    const spritesheet = parsed.data.spritesheet;
    const maxSpritesheetBytes = options.maxSpritesheetBytes ?? PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes;
    if (spritesheet.sizeBytes > maxSpritesheetBytes) {
        return INVALID_RESULT;
    }

    const maxPackageBytes = options.maxPackageBytes ?? PET_PACKAGE_LIMITS_V1.maxCanonicalPackageBytes;
    if (manifestBytes + spritesheet.sizeBytes > maxPackageBytes) {
        return INVALID_RESULT;
    }

    const bytes = decodeStrictBase64(spritesheet.data);
    if (!bytes || bytes.byteLength !== spritesheet.sizeBytes) {
        return INVALID_RESULT;
    }
    if (!hasExpectedMagicBytes(bytes, spritesheet.mediaType)) {
        return INVALID_RESULT;
    }
    if (spritesheet.digest !== calculateDigest(bytes)) {
        return INVALID_RESULT;
    }

    const inspectAtlas = options.inspectAtlas ?? inspectPetAtlasWithSharp;
    try {
        const inspection = await inspectAtlas(bytes, spritesheet.mediaType);
        if (!hasExpectedAtlasContract(inspection)) {
            return INVALID_RESULT;
        }
    } catch {
        return INVALID_RESULT;
    }

    return {
        ok: true,
        request: parsed.data,
        spritesheetBytes: bytes,
    };
}

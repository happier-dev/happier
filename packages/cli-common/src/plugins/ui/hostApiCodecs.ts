import { PluginUiResourceContentV1Schema } from '@happier-dev/protocol/plugins/ui/resourceContent';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginDiagnosticData } from '../errors.js';

export type ResourceContent = Readonly<{
    contentType: string;
    digest: string;
    bytes: Uint8Array;
}>;

export type PluginUiHostApiDecodeResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; diagnostic: string }>;

function isJsonRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
    return value !== undefined && value !== null && !Array.isArray(value) && typeof value === 'object';
}

/**
 * Realm-neutral decoding for the public Resource result. Physical carriers
 * provide only their byte decoder; the accepted result shape is owned once.
 */
export function decodePluginUiResourceContent(
    value: JsonValue | undefined,
    decodeBytes: (bytesBase64: string) => Uint8Array,
): PluginUiHostApiDecodeResult<ResourceContent> {
    const parsed = PluginUiResourceContentV1Schema.safeParse(value);
    if (!parsed.success) {
        const invalidBytes = parsed.error.issues.some(issue => issue.path[0] === 'bytesBase64');
        return { ok: false, diagnostic: invalidBytes ? 'resource_bytes_invalid' : 'resource_response_invalid' };
    }
    try {
        return {
            ok: true,
            value: Object.freeze({
                contentType: parsed.data.contentType,
                digest: parsed.data.digest,
                bytes: decodeBytes(parsed.data.bytesBase64),
            }),
        };
    } catch {
        return { ok: false, diagnostic: 'resource_bytes_invalid' };
    }
}

/** Canonical current Host API clipboard result; no undeployed bare-string arm. */
export function decodePluginUiClipboardReadResult(
    value: JsonValue | undefined,
): PluginUiHostApiDecodeResult<string> {
    if (!isJsonRecord(value) || typeof value.value !== 'string') {
        return { ok: false, diagnostic: 'clipboard_read_response_invalid' };
    }
    return { ok: true, value: value.value };
}

/** The exact confirmation result accepted by every physical Host API carrier. */
export function decodePluginUiConfirmResult(
    value: JsonValue | undefined,
): PluginUiHostApiDecodeResult<boolean> {
    if (!isJsonRecord(value) || Object.keys(value).length !== 1 || typeof value.confirmed !== 'boolean') {
        return { ok: false, diagnostic: 'confirm_response_invalid' };
    }
    return { ok: true, value: value.confirmed };
}

/** Canonical author diagnostic projection shared by hosted and direct carriers. */
export function encodePluginUiDiagnostic(data: PluginDiagnosticData): JsonValue {
    return {
        code: data.code,
        severity: data.severity,
        ...(data.message === undefined ? {} : { message: data.message }),
        ...(data.details === undefined ? {} : { details: data.details }),
        ...(data.remediation === undefined ? {} : { remediation: data.remediation }),
    };
}

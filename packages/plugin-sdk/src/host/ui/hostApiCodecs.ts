import type { JsonValue } from '../../identity.js';
import type { PluginDiagnosticData } from '../../diagnostics.js';
import type { ResourceContent } from '../../ui/hostApi.js';

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
    if (!isJsonRecord(value)) return { ok: false, diagnostic: 'resource_response_not_object' };
    const keys = Object.keys(value);
    if (
        keys.length !== 3
        || !keys.includes('contentType')
        || !keys.includes('digest')
        || !keys.includes('bytesBase64')
    ) {
        return { ok: false, diagnostic: 'resource_response_fields_invalid' };
    }
    if (
        typeof value.contentType !== 'string'
        || value.contentType.trim() === ''
        || typeof value.digest !== 'string'
        || !/^sha256:[a-f0-9]{64}$/u.test(value.digest)
        || typeof value.bytesBase64 !== 'string'
    ) {
        return { ok: false, diagnostic: 'resource_response_invalid' };
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.bytesBase64)) {
        return { ok: false, diagnostic: 'resource_bytes_invalid' };
    }
    try {
        return {
            ok: true,
            value: Object.freeze({
                contentType: value.contentType,
                digest: value.digest,
                bytes: decodeBytes(value.bytesBase64),
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

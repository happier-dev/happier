import { describe, expect, it } from 'vitest';

import {
    decodePluginUiClipboardReadResult,
    decodePluginUiConfirmResult,
    decodePluginUiResourceContent,
    encodePluginUiDiagnostic,
} from './hostApiCodecs.js';

describe('Plugin UI host API codecs', () => {
    const digest = `sha256:${'a'.repeat(64)}`;

    it('decodes the one exact Resource result shape', () => {
        const result = decodePluginUiResourceContent({
            contentType: 'text/plain',
            digest,
            bytesBase64: 'aGVsbG8=',
        }, () => Uint8Array.from([1, 2, 3]));

        expect(result).toEqual({
            ok: true,
            value: {
                contentType: 'text/plain',
                digest,
                bytes: Uint8Array.from([1, 2, 3]),
            },
        });
    });

    it('rejects noncanonical Resource digests and extra fields', () => {
        expect(decodePluginUiResourceContent({
            contentType: 'text/plain',
            digest: 'sha256:resource',
            bytesBase64: 'aGVsbG8=',
        }, () => new Uint8Array())).toMatchObject({ ok: false });
        expect(decodePluginUiResourceContent({
            contentType: 'text/plain',
            digest,
            bytesBase64: 'aGVsbG8=',
            extra: true,
        }, () => new Uint8Array())).toMatchObject({ ok: false });
        expect(decodePluginUiResourceContent({
            contentType: 'text/plain',
            digest,
            bytesBase64: 'not base64',
        }, () => new Uint8Array())).toEqual({
            ok: false,
            diagnostic: 'resource_bytes_invalid',
        });
    });

    it('accepts only the current object-shaped clipboard result', () => {
        expect(decodePluginUiClipboardReadResult({ value: 'copied' }))
            .toEqual({ ok: true, value: 'copied' });
        expect(decodePluginUiClipboardReadResult('legacy bare string'))
            .toMatchObject({ ok: false });
    });

    it('accepts only the exact confirmation result and projects diagnostics canonically', () => {
        expect(decodePluginUiConfirmResult({ confirmed: true })).toEqual({ ok: true, value: true });
        expect(decodePluginUiConfirmResult({ confirmed: true, extra: 'drift' })).toEqual({
            ok: false,
            diagnostic: 'confirm_response_invalid',
        });
        expect(encodePluginUiDiagnostic({
            code: 'example', severity: 'warning', message: 'Check this', details: { attempt: 1 },
            remediation: { kind: 'retry' },
        })).toEqual({
            code: 'example', severity: 'warning', message: 'Check this', details: { attempt: 1 },
            remediation: { kind: 'retry' },
        });
    });
});

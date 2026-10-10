import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';

import { isApiTokenGrantDraftSendable, readApiTokenGrantOriginInput } from './apiTokenGrantDraft';

afterEach(() => vi.unstubAllGlobals());

describe('grant website input', () => {
    it('refuses a percent-encoded hostname even when the browser URL constructor accepts it', () => {
        const NativeURL = URL;
        const invalidOrigin = 'https://not%20an%20origin';
        // Chrome 154.0.8037.92 returned these fields in both the app and a blank tab.
        // URL is the browser boundary; grant normalization and protocol admission stay real.
        vi.stubGlobal('URL', class extends NativeURL {
            private readonly capturedOrigin: string | null;

            constructor(input: string | URL, base?: string | URL) {
                const captured = ['https://not an origin', invalidOrigin].includes(String(input));
                super(captured ? 'https://example.invalid' : input, base);
                this.capturedOrigin = captured ? invalidOrigin : null;
            }

            override get origin() { return this.capturedOrigin ?? super.origin; }
            override get hostname() { return this.capturedOrigin ? 'not%20an%20origin' : super.hostname; }
        });

        expect(readApiTokenGrantOriginInput('not an origin', [])).toEqual({ ok: false, reason: 'invalid' });
        expect(readApiTokenGrantOriginInput(invalidOrigin, [])).toEqual({ ok: false, reason: 'invalid' });
        expect(isApiTokenGrantDraftSendable({ ...API_TOKEN_FULL_GRANT_V1, origins: [invalidOrigin] })).toBe(false);
        expect(readApiTokenGrantOriginInput('app.example.com/path?next=yes', [])).toEqual({ ok: true, origin: 'https://app.example.com' });
    });

    it('retains canonical websites, loopback development origins and duplicate detection', () => {
        for (const [input, origin] of [
            ['app.example.com/path', 'https://app.example.com'],
            ['localhost:5173/path', 'http://localhost:5173'],
            ['127.0.0.1:5173', 'http://127.0.0.1:5173'],
            ['[::1]:5173/path', 'http://[::1]:5173'],
            ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example'],
            ['https://a%2Eb.example/path', 'https://a.b.example'],
        ] as const) {
            expect(readApiTokenGrantOriginInput(input, [])).toEqual({ ok: true, origin });
            expect(readApiTokenGrantOriginInput(input, [origin])).toEqual({ ok: false, reason: 'duplicate' });
        }
        expect(readApiTokenGrantOriginInput('http://example.com', [])).toEqual({ ok: false, reason: 'invalid' });
        expect(readApiTokenGrantOriginInput('ftp://example.com', [])).toEqual({ ok: false, reason: 'invalid' });
    });
});

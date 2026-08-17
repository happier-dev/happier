import {
    ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.resetModules();
});

async function loadCompatibility() {
    return await import('./accountStoredContentCompatibility');
}

describe('account-stored-content HTTP compatibility headers', () => {
    it('does not claim the plugin-data declaration to a V2-only server', async () => {
        const compatibility = await loadCompatibility();
        compatibility.recordAccountStoredContentServerRequirements({
            serverUrl: 'https://server.example',
            requirements: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: 2,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });

        expect(compatibility.resolveAccountStoredContentCompatibilityHeaders(
            undefined,
            {
                serverUrl: 'https://server.example',
                declaration: PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
            },
        )).toEqual({
            status: 'unavailable',
            reason: 'server-protocol-too-old',
        });
    });

    it('emits the V3 plugin-data declaration only after the server advertises V3 support', async () => {
        const compatibility = await loadCompatibility();
        compatibility.recordAccountStoredContentServerRequirements({
            serverUrl: 'https://server.example',
            requirements: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: 3,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });

        const resolved = compatibility.resolveAccountStoredContentCompatibilityHeaders(
            undefined,
            {
                serverUrl: 'https://server.example',
                declaration: PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
            },
        );
        expect(resolved.status).toBe('available');
        if (resolved.status !== 'available') throw new Error('Expected V3 support');
        expect(resolved.headers.get(ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER)).toBe('3');
    });

    it('advertises the default additive V4 declaration to a V3 base server', async () => {
        const compatibility = await loadCompatibility();
        compatibility.recordAccountStoredContentServerRequirements({
            serverUrl: 'https://server.example',
            requirements: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: 3,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });

        const resolved = compatibility.resolveAccountStoredContentCompatibilityHeaders(
            { [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]: '3' },
            { serverUrl: 'https://server.example' },
        );
        expect(resolved.status).toBe('available');
        if (resolved.status !== 'available') throw new Error('Expected V3 support');
        expect(resolved.declaration).toEqual(
            CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
        );
        expect(resolved.headers.get(ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER)).toBe('4');
    });

    it('keeps an explicit V4 operation declaration strict against a V3 server', async () => {
        const compatibility = await loadCompatibility();
        compatibility.recordAccountStoredContentServerRequirements({
            serverUrl: 'https://server.example',
            requirements: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: 3,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });

        expect(compatibility.resolveAccountStoredContentCompatibilityHeaders(
            undefined,
            {
                serverUrl: 'https://server.example',
                declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
            },
        )).toEqual({
            status: 'unavailable',
            reason: 'server-protocol-too-old',
        });
    });

    it('strips an untrusted raw declaration when no compatible server range is known', async () => {
        const compatibility = await loadCompatibility();

        const headers = compatibility.withCurrentAccountStoredContentCompatibilityHeaders(
            { [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]: '3' },
            { serverUrl: 'https://unknown.example' },
        );

        expect(headers.has(ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER)).toBe(false);
    });
});

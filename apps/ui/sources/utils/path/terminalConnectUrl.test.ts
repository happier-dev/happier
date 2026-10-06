import { describe, expect, it, vi } from 'vitest';
import { encodeTerminalConnectLinkV4Payload } from '@happier-dev/protocol';

import {
    buildTerminalConnectDeepLink,
    buildTerminalConnectWebHref,
    parseTerminalConnectRouteParams,
    parseTerminalConnectUrl,
    resolveTerminalConnectPreAuthTarget,
} from './terminalConnectUrl';

const carrierBoundary = vi.hoisted(() => ({ release: vi.fn(async () => {}) }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default } });
});
vi.mock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
    acquireIrohHomeRuntimeOrigin: async (input: {
        homeServerIdentityId: string;
        endpoint: { endpointId: string };
    }) => {
        if (input.homeServerIdentityId === 'srv_unavailable') {
            throw Object.assign(new Error('carrier unavailable'), { name: 'IrohError', code: 'unavailable' });
        }
        return {
            homeServerIdentityId: input.homeServerIdentityId,
            endpointId: input.endpoint.endpointId,
            leaseId: 'preauth-probe',
            runtimeOrigin: 'http://127.0.0.1:43123',
            status: 'ready',
            release: carrierBoundary.release,
        };
    },
}));

describe('terminal connect preauth target', () => {
    it('admits a remote descriptor endpoint while retaining its canonical loopback custody', async () => {
        expect(await resolveTerminalConnectPreAuthTarget({
            activeServerUrl: 'https://focused.example.test',
            requestedServerUrl: null,
            homeConnectionDescriptor: {
                v: 1,
                homeServerIdentityId: 'srv_remote',
                canonicalServerUrl: 'http://localhost:3010',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://remote.example.test' }],
            },
        })).toEqual({ pendingServerUrl: 'http://localhost:3010', canNavigateToAuth: true });
    });

    it('admits a verified Iroh descriptor and releases its enrollment probe', async () => {
        carrierBoundary.release.mockClear();
        expect(await resolveTerminalConnectPreAuthTarget({
            activeServerUrl: 'https://focused.example.test',
            requestedServerUrl: null,
            homeConnectionDescriptor: {
                v: 1,
                homeServerIdentityId: 'srv_iroh',
                canonicalServerUrl: 'http://localhost:3010',
                revision: 1,
                endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }],
            },
        })).toEqual({ pendingServerUrl: 'http://localhost:3010', canNavigateToAuth: true });
        expect(carrierBoundary.release).toHaveBeenCalledOnce();
    });

    it('retains an unavailable descriptor without authorizing a focused-Home fallback', async () => {
        expect(await resolveTerminalConnectPreAuthTarget({
            activeServerUrl: 'https://focused.example.test',
            requestedServerUrl: 'https://focused.example.test',
            homeConnectionDescriptor: {
                v: 1,
                homeServerIdentityId: 'srv_unavailable',
                canonicalServerUrl: 'http://localhost:3010',
                revision: 1,
                endpoints: [{ kind: 'iroh', endpointId: 'b'.repeat(64) }],
            },
        })).toEqual({ pendingServerUrl: 'http://localhost:3010', canNavigateToAuth: false });
    });

    it('preserves the URL-only loopback policy', async () => {
        expect(await resolveTerminalConnectPreAuthTarget({
            activeServerUrl: 'https://focused.example.test',
            requestedServerUrl: 'http://localhost:3010',
        })).toEqual({ pendingServerUrl: 'https://focused.example.test', canNavigateToAuth: true });
    });
});

it('rebuilds a pending descriptor link as strict opaque V4', () => {
    const link = buildTerminalConnectWebHref({
        publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        serverUrl: 'https://ignored.example.test',
        serverIdentityId: 'srv_home_v4',
        pairing: {
            secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
            createdAtMs: 1_000,
            expiresAtMs: 61_000,
        },
        supportsTokenOnly: true,
        homeConnectionDescriptor: {
            v: 1,
            homeServerIdentityId: 'srv_home_v4',
            canonicalServerUrl: 'https://home.example.test',
            revision: 1,
            endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }],
        },
    });

    expect(link).toMatch(/^\/terminal\/connect#v4=[A-Za-z0-9_-]+$/u);
    expect(parseTerminalConnectUrl(`https://app.example.test${link}`)).toMatchObject({
        wireVersion: 4,
        serverIdentityId: 'srv_home_v4',
    });
});

describe('parseTerminalConnectUrl', () => {
    it('accepts the immutable cli-v0.2.11-preview.2 URL-only V3 link as released compatibility', () => {
        const releasedVector = 'happier://terminal?key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
            + '&server=https%3A%2F%2Fhome.example.test'
            + '&pairingSecret=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
            + '&createdAt=1000&expiresAt=61000';

        expect(parseTerminalConnectUrl(releasedVector)).toEqual({
            publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            serverUrl: 'https://home.example.test',
            pairing: {
                secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
                createdAtMs: 1_000,
                expiresAtMs: 61_000,
            },
            compatibility: {
                provenance: 'cli-v0.2.11-preview.2-url-only-v3',
                admission: 'update_required',
            },
        });
        expect(parseTerminalConnectUrl(releasedVector)).not.toHaveProperty('serverIdentityId');
        expect(parseTerminalConnectUrl(releasedVector)).not.toHaveProperty('homeConnectionDescriptor');
    });

    it('classifies immutable HTTP and no-server V3 outputs without granting authority', () => {
        const tuple = 'key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
            + '&pairingSecret=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
            + '&createdAt=1000&expiresAt=61000';
        expect(parseTerminalConnectUrl(`happier://terminal?${tuple}&server=http%3A%2F%2Flan.example.test`))
            .toMatchObject({
                serverUrl: 'http://lan.example.test',
                compatibility: { admission: 'update_required' },
            });
        expect(parseTerminalConnectUrl(`happier://terminal?${tuple}`)).toMatchObject({
            serverUrl: null,
            compatibility: { admission: 'update_required' },
        });
        for (const input of [
            `happier://terminal?${tuple}&server=http%3A%2F%2Flan.example.test`,
            `happier://terminal?${tuple}`,
        ]) {
            expect(parseTerminalConnectUrl(input)).not.toHaveProperty('serverIdentityId');
            expect(parseTerminalConnectUrl(input)).not.toHaveProperty('homeConnectionDescriptor');
        }
        expect(parseTerminalConnectUrl(`happier://terminal?v4=invalid&${tuple}`)).toBeNull();
    });

    it('parses the strict opaque V4 descriptor link without a URL downgrade path', () => {
        const homeConnectionDescriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_home_v4',
            canonicalServerUrl: 'http://localhost:3010',
            revision: 4,
            endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
        };
        const payload = encodeTerminalConnectLinkV4Payload({
            v: 4,
            publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            pairing: {
                v: 3,
                secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
                createdAtMs: 1_000,
                expiresAtMs: 61_000,
                homeServerIdentityId: homeConnectionDescriptor.homeServerIdentityId,
                supportsTokenOnly: true,
            },
            homeConnectionDescriptor,
        });

        expect(parseTerminalConnectUrl(`happier://terminal?v4=${payload}`)).toEqual({
            wireVersion: 4,
            publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            serverUrl: null,
            serverIdentityId: 'srv_home_v4',
            pairing: {
                secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
                createdAtMs: 1_000,
                expiresAtMs: 61_000,
            },
            supportsTokenOnly: true,
            homeConnectionDescriptor,
        });
        expect(parseTerminalConnectUrl(`happier://terminal?v4=${payload}&key=legacy`)).toBeNull();
    });

    it('parses legacy terminal deeplink format', () => {
        expect(parseTerminalConnectUrl('happier://terminal?abcDEF_123-zzz')).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: null,
        });
    });

    it('parses canonical terminal deeplink format with server URL', () => {
        expect(
            parseTerminalConnectUrl(
                'happier://terminal?key=abcDEF_123-zzz&server=https%3A%2F%2Fstack.example.test',
            ),
        ).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });
    });

    it('parses complete authenticated-pairing context', () => {
        expect(parseTerminalConnectUrl(
            'happier://terminal?key=abc&pairingSecret=secret&createdAt=1000&expiresAt=61000&serverIdentityId=srv_home_expected&supportsTokenOnly=1',
        )).toEqual({
            publicKeyB64Url: 'abc',
            serverUrl: null,
            serverIdentityId: 'srv_home_expected',
            pairing: {
                secretB64Url: 'secret',
                createdAtMs: 1000,
                expiresAtMs: 61000,
            },
            supportsTokenOnly: true,
        });
    });

    it('rejects incomplete authenticated-pairing context', () => {
        expect(parseTerminalConnectUrl('happier://terminal?key=abc&pairingSecret=secret')).toBeNull();
        expect(parseTerminalConnectUrl(
            'happier://terminal?key=abc&serverIdentityId=srv_home_expected',
        )).toBeNull();
        expect(parseTerminalConnectUrl(
            'happier://terminal?key=abc&pairingSecret=secret&createdAt=61000&expiresAt=1000',
        )).toBeNull();
    });

    it('rejects current authenticated pairing with malformed Home identity', () => {
        expect(parseTerminalConnectUrl(
            'happier://terminal?key=abc&pairingSecret=secret&createdAt=1000&expiresAt=61000&serverIdentityId=bad%20identity',
        )).toBeNull();
    });

    it('parses terminal connect web URLs with hash parameters', () => {
        expect(
            parseTerminalConnectUrl(
                'https://web.happier.dev/terminal/connect#server=https%3A%2F%2Fstack.example.test&key=abcDEF_123-zzz',
            ),
        ).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });
    });

    it('reads pairing context from the local Tauri webview without allowing custom server protocols', () => {
        const fragment = '#key=desktop-key&pairingSecret=desktop-secret&createdAt=1000&expiresAt=61000';
        expect(parseTerminalConnectUrl(`tauri://localhost/terminal/connect${fragment}`)).toMatchObject({
            publicKeyB64Url: 'desktop-key',
            serverUrl: null,
            pairing: { secretB64Url: 'desktop-secret', createdAtMs: 1000, expiresAtMs: 61000 },
            compatibility: { admission: 'update_required' },
        });
        expect(parseTerminalConnectUrl(`tauri://other-host/terminal/connect${fragment}`)).toBeNull();
        expect(parseTerminalConnectUrl(`tauri://localhost.example/terminal/connect${fragment}`)).toBeNull();
        expect(parseTerminalConnectUrl('tauri://localhost/terminal/connect#key=desktop-key&server=tauri%3A%2F%2Flocalhost'))
            .toEqual({ publicKeyB64Url: 'desktop-key', serverUrl: null });
    });

    it('rejects non-terminal links', () => {
        expect(parseTerminalConnectUrl('happier://server?url=https%3A%2F%2Fstack.example.test')).toBeNull();
    });

    it('ignores unsafe server URL schemes', () => {
        expect(
            parseTerminalConnectUrl('happier://terminal?key=abcDEF_123-zzz&server=javascript%3Aalert(1)'),
        ).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: null,
        });
    });

    it('returns null for canonical format with missing key value', () => {
        expect(parseTerminalConnectUrl('happier://terminal?key=&server=https%3A%2F%2Fstack.example.test')).toBeNull();
    });

    it('normalizes server URL by trimming trailing slashes', () => {
        expect(
            parseTerminalConnectUrl(
                'happier://terminal?key=abcDEF_123-zzz&server=https%3A%2F%2Fstack.example.test%2F%2F',
            ),
        ).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });
    });
});

describe('parseTerminalConnectRouteParams', () => {
    it('passes the one opaque V4 route parameter through the strict parser', () => {
        const payload = encodeTerminalConnectLinkV4Payload({
            v: 4,
            publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            pairing: {
                v: 3,
                secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
                createdAtMs: 1_000,
                expiresAtMs: 61_000,
                homeServerIdentityId: 'srv_home_v4',
                supportsTokenOnly: false,
            },
            homeConnectionDescriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_v4',
                canonicalServerUrl: 'https://home.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
            },
        });

        expect(parseTerminalConnectRouteParams({ v4: payload })).toMatchObject({
            wireVersion: 4,
            serverIdentityId: 'srv_home_v4',
            homeConnectionDescriptor: { homeServerIdentityId: 'srv_home_v4' },
        });
    });

    it('delegates complete authenticated pairing parameters to the canonical parser', () => {
        expect(parseTerminalConnectRouteParams({
            key: 'abc',
            pairingSecret: 'secret',
            createdAt: '1000',
            expiresAt: '61000',
            serverIdentityId: 'srv_home_expected',
            supportsTokenOnly: '1',
        })).toEqual({
            publicKeyB64Url: 'abc',
            serverUrl: null,
            serverIdentityId: 'srv_home_expected',
            pairing: {
                secretB64Url: 'secret',
                createdAtMs: 1000,
                expiresAtMs: 61000,
            },
            supportsTokenOnly: true,
        });
    });

    it('rejects partial authenticated pairing parameters instead of treating them as legacy', () => {
        expect(parseTerminalConnectRouteParams({
            key: 'abc',
            pairingSecret: 'secret',
        })).toBeNull();
    });

    it('retains the released single-unknown-key legacy route shape', () => {
        expect(parseTerminalConnectRouteParams({ abcDEF_123: '' })).toEqual({
            publicKeyB64Url: 'abcDEF_123',
            serverUrl: null,
        });
        expect(parseTerminalConnectRouteParams({ server: 'https://example.test' })).toBeNull();
    });
});

describe('buildTerminalConnectDeepLink', () => {
    it('builds canonical deep links with encoded values', () => {
        expect(
            buildTerminalConnectDeepLink({
                publicKeyB64Url: 'abcDEF_123-zzz',
                serverUrl: 'https://stack.example.test/path?x=1',
            }),
        ).toBe(
            'happier://terminal?key=abcDEF_123-zzz&server=https%3A%2F%2Fstack.example.test%2Fpath%3Fx%3D1',
        );
    });

    it('includes complete authenticated-pairing context', () => {
        expect(buildTerminalConnectDeepLink({
            publicKeyB64Url: 'abc',
            serverUrl: null,
            pairing: {
                secretB64Url: 'secret',
                createdAtMs: 1000,
                expiresAtMs: 61000,
            },
            serverIdentityId: 'srv_home_expected',
            supportsTokenOnly: true,
        })).toBe(
            'happier://terminal?key=abc&pairingSecret=secret&createdAt=1000&expiresAt=61000&serverIdentityId=srv_home_expected&supportsTokenOnly=1',
        );
    });

    it('omits token-only support without authenticated pairing context', () => {
        expect(buildTerminalConnectDeepLink({
            publicKeyB64Url: 'abc',
            serverUrl: null,
            supportsTokenOnly: true,
        })).toBe('happier://terminal?abc');
        expect(parseTerminalConnectUrl(
            'happier://terminal?key=abc&supportsTokenOnly=1',
        )).toBeNull();
    });

    it('falls back to legacy format when server URL is missing', () => {
        expect(
            buildTerminalConnectDeepLink({
                publicKeyB64Url: 'abcDEF_123-zzz',
                serverUrl: null,
            }),
        ).toBe('happier://terminal?abcDEF_123-zzz');
    });
});

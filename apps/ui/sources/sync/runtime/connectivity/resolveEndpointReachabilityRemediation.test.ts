import { describe, expect, it } from 'vitest';

describe('resolveEndpointReachabilityRemediation', () => {
    it('returns a desktop Tailscale remediation with a callback slot for unreachable ts.net relays', async () => {
        const { resolveEndpointReachabilityRemediation } = await import('./resolveEndpointReachabilityRemediation');

        const remediation = resolveEndpointReachabilityRemediation({
            endpointUrl: 'https://relay.example.ts.net',
            readiness: {
                status: 'server_unreachable',
                errorMessage: 'Network request failed',
            },
            platformOs: 'macos',
            isDesktopShell: true,
        });

        expect(remediation).toMatchObject({
            kind: 'tailscale_unreachable',
            titleKey: 'server.reachabilityRemediation.tailscale.title',
            bodyKey: 'server.reachabilityRemediation.tailscale.desktopBody',
        });
        expect(remediation?.actions).toEqual([
            {
                id: 'prepare_tailscale',
                kind: 'callback',
                labelKey: 'server.reachabilityRemediation.tailscale.desktopPrepareAction',
                callbackSlot: 'tailscale.ensureReady',
            },
            {
                id: 'retry',
                kind: 'retry',
                labelKey: 'common.retry',
            },
        ]);
    });

    it('returns install guidance for unreachable ts.net relays on non-desktop clients', async () => {
        const { resolveEndpointReachabilityRemediation } = await import('./resolveEndpointReachabilityRemediation');

        const remediation = resolveEndpointReachabilityRemediation({
            endpointUrl: 'https://relay.example.ts.net:8443/path',
            readiness: {
                status: 'server_unreachable',
                errorMessage: 'Network request failed',
            },
            platformOs: 'ios',
            isDesktopShell: false,
        });

        expect(remediation).toMatchObject({
            kind: 'tailscale_unreachable',
            titleKey: 'server.reachabilityRemediation.tailscale.title',
            bodyKey: 'server.reachabilityRemediation.tailscale.nativeBody',
        });
        expect(remediation?.actions).toEqual([
            {
                id: 'install_tailscale',
                kind: 'external-url',
                labelKey: 'server.reachabilityRemediation.tailscale.installAction',
                url: 'https://tailscale.com/download/ios',
            },
            {
                id: 'retry',
                kind: 'retry',
                labelKey: 'common.retry',
            },
        ]);
    });

    it('returns null for non-tailscale or reachable endpoints', async () => {
        const { resolveEndpointReachabilityRemediation } = await import('./resolveEndpointReachabilityRemediation');

        expect(resolveEndpointReachabilityRemediation({
            endpointUrl: 'https://relay.example.com',
            readiness: {
                status: 'server_unreachable',
                errorMessage: 'Network request failed',
            },
            platformOs: 'web',
            isDesktopShell: false,
        })).toBeNull();

        expect(resolveEndpointReachabilityRemediation({
            endpointUrl: 'https://relay.example.ts.net',
            readiness: {
                status: 'auth_failed',
                errorMessage: 'Authenticated probe returned 401',
            },
            platformOs: 'web',
            isDesktopShell: false,
        })).toBeNull();
    });
});

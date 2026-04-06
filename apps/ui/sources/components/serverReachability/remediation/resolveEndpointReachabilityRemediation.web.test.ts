import { describe, expect, it } from 'vitest';

describe('resolveEndpointReachabilityRemediation.web', () => {
    it('returns web-tailored install guidance for unreachable ts.net relays', async () => {
        const { resolveEndpointReachabilityRemediation } = await import('./resolveEndpointReachabilityRemediation.web');

        const remediation = resolveEndpointReachabilityRemediation({
            endpointUrl: 'https://relay.example.ts.net:8443/path',
            readiness: {
                status: 'server_unreachable',
                errorMessage: 'Network request failed',
            },
            platformOs: 'web',
            isDesktopShell: false,
        });

        expect(remediation).toMatchObject({
            kind: 'tailscale_unreachable',
            titleKey: 'server.reachabilityRemediation.tailscale.title',
            bodyKey: 'server.reachabilityRemediation.tailscale.webBody',
        });
        expect(remediation?.actions).toEqual([
            {
                id: 'install_tailscale',
                kind: 'external-url',
                labelKey: 'server.reachabilityRemediation.tailscale.installAction',
                url: 'https://tailscale.com/download',
            },
            {
                id: 'retry',
                kind: 'retry',
                labelKey: 'common.retry',
            },
        ]);
    });
});

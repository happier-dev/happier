import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import {
    normalizeRelayAccessCanonicalPublicServerUrl,
    resolveRelayAccessConfiguredCanonicalPublicServerUrl,
} from './publicUrl.js';

vi.mock('../tailscale/index.js', async () => {
    const actual = await vi.importActual<typeof import('../tailscale/index.js')>('../tailscale/index.js');
    return {
        ...actual,
        runTailscaleStatusJson: vi.fn(),
        runTailscaleFunnelStatus: vi.fn(),
    };
});

describe('relayAccess publicUrl', () => {
    it('normalizes canonical relay access urls by stripping userinfo, query, hash, and trailing slash', () => {
        expect(
            normalizeRelayAccessCanonicalPublicServerUrl('https://user:pass@stack.example.test/path/?q=1#frag'),
        ).toBe('https://stack.example.test/path');
    });

    it('reads the persisted cloudflare named-tunnel config and resolves the canonical public url', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-access-'));
        try {
            await mkdir(join(homeDir, '.happier', 'relay', 'access'), { recursive: true });
            await writeFile(
                join(homeDir, '.happier', 'relay', 'access', 'local.json'),
                JSON.stringify({ providerId: 'cloudflareNamed', hostname: 'relay.example.test', token: 'secret' }),
                'utf8',
            );

            await expect(
                resolveRelayAccessConfiguredCanonicalPublicServerUrl({ HOME: homeDir }),
            ).resolves.toBe('https://relay.example.test');
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('does not treat a persisted tailscaleFunnel config as a canonical public url without an upstream match', async () => {
        const { runTailscaleStatusJson, runTailscaleFunnelStatus } = await import('../tailscale/index.js');
        vi.mocked(runTailscaleStatusJson).mockResolvedValue({
            backendState: 'Running',
            authUrl: null,
            dnsName: 'my-machine.tailnet.ts.net',
            tailnetName: 'tailnet.ts.net',
            tailscaleIps: [],
            loggedIn: true,
            running: true, daemonReachable: true,
        });
        vi.mocked(runTailscaleFunnelStatus).mockResolvedValue(
            'https://relay.example.test\n|-- / proxy http://127.0.0.1:3005',
        );

        const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-access-'));
        try {
            await mkdir(join(homeDir, '.happier', 'relay', 'access'), { recursive: true });
            await writeFile(
                join(homeDir, '.happier', 'relay', 'access', 'local.json'),
                JSON.stringify({ providerId: 'tailscaleFunnel' }),
                'utf8',
            );

            await expect(
            resolveRelayAccessConfiguredCanonicalPublicServerUrl({ HOME: homeDir }),
            ).resolves.toBeNull();
            expect(runTailscaleFunnelStatus).toHaveBeenCalledTimes(0);
            expect(runTailscaleStatusJson).toHaveBeenCalledTimes(0);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('resolves a persisted tailscaleFunnel canonical public url when the caller provides the matching upstream url', async () => {
        const { runTailscaleStatusJson, runTailscaleFunnelStatus } = await import('../tailscale/index.js');
        vi.mocked(runTailscaleStatusJson).mockResolvedValue({
            backendState: 'Running',
            authUrl: null,
            dnsName: 'my-machine.tailnet.ts.net',
            tailnetName: 'tailnet.ts.net',
            tailscaleIps: [],
            loggedIn: true,
            running: true, daemonReachable: true,
        });
        vi.mocked(runTailscaleFunnelStatus).mockResolvedValue(
            'https://relay.example.test\n|-- / proxy http://127.0.0.1:3005',
        );

        const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-access-'));
        try {
            await mkdir(join(homeDir, '.happier', 'relay', 'access'), { recursive: true });
            await writeFile(
                join(homeDir, '.happier', 'relay', 'access', 'local.json'),
                JSON.stringify({ providerId: 'tailscaleFunnel' }),
                'utf8',
            );

            await expect(
                resolveRelayAccessConfiguredCanonicalPublicServerUrl(
                    { HOME: homeDir },
                    { upstreamUrl: 'http://127.0.0.1:3005' },
                ),
            ).resolves.toBe('https://relay.example.test');
            expect(runTailscaleFunnelStatus).toHaveBeenCalledTimes(1);
            expect(runTailscaleStatusJson).toHaveBeenCalledTimes(1);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });
});

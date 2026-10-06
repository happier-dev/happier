import { beforeEach, describe, expect, it, vi } from 'vitest';

// The native IPC/event transport is the OS boundary; routing and URL parsers stay real.
const native = vi.hoisted(() => ({
    invoke: vi.fn(),
    listen: vi.fn(),
    stop: vi.fn(),
    receive: null as null | ((urls: string[]) => void),
}));
vi.mock('@/utils/platform/desktopHost', () => ({
    invokeDesktopHost: native.invoke,
    listenDesktopHostEvent: native.listen,
}));

import { buildTerminalConnectDeepLink, parseTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';
import { installDesktopDeepLinks } from './installDesktopDeepLinks';

const flush = async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

describe('desktop deep-link delivery', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        native.receive = null;
        native.invoke.mockResolvedValue(null);
        native.listen.mockImplementation(async (_event, receive) => {
            native.receive = receive;
            return native.stop;
        });
    });

    it('delivers a cold-launch legacy terminal link through the existing web pairing route', async () => {
        native.invoke.mockResolvedValue(['happier://terminal?abcDEF_123-zzz']);
        const navigate = vi.fn();
        const dispose = installDesktopDeepLinks(navigate);
        await flush();
        expect(navigate.mock.calls.map(([href]) => href)).toEqual(['/terminal/connect#key=abcDEF_123-zzz']);
        dispose();
        expect(native.stop).toHaveBeenCalled();
    });

    it('delivers successive running-app links with their server and pairing context in the hash', async () => {
        const navigate = vi.fn();
        const dispose = installDesktopDeepLinks(navigate);
        await flush();
        native.receive?.(['happier-preview://terminal?key=abc&server=https%3A%2F%2Frelay.example&pairingSecret=secret&createdAt=1000&expiresAt=61000']);
        native.receive?.(['happier-dev://terminal?key=next']);
        expect(navigate.mock.calls.map(([href]) => href)).toEqual([
            '/terminal/connect#key=abc&server=https%3A%2F%2Frelay.example&pairingSecret=secret&createdAt=1000&expiresAt=61000',
            '/terminal/connect#key=next',
        ]);
        dispose();
    });

    it('does not replay a stale initial snapshot after a live event during startup', async () => {
        native.invoke.mockImplementation(async () => {
            native.receive?.(['happier://terminal?key=new']);
            return ['happier://terminal?key=old'];
        });
        const navigate = vi.fn();
        const dispose = installDesktopDeepLinks(navigate);
        await flush();
        expect(navigate.mock.calls.map(([href]) => href)).toEqual(['/terminal/connect#key=new']);
        dispose();
    });

    it('ignores external URLs and routes account links through the existing system-path owner', async () => {
        const navigate = vi.fn();
        const dispose = installDesktopDeepLinks(navigate);
        await flush();
        native.receive?.(['https://untrusted.example/terminal/connect#key=abc', 'javascript:alert(1)', 'happier:///account?abc+123/=']);
        expect(navigate.mock.calls.map(([href]) => href)).toEqual(['/account?accountConnectKey=abc%2B123%2F%3D']);
        dispose();
    });

    it('preserves in-app routes in both double- and triple-slash system URLs', async () => {
        const navigate = vi.fn();
        const dispose = installDesktopDeepLinks(navigate);
        await flush();
        native.receive?.(['happier://session/abc?serverId=relay', 'happier:///session/next?serverId=relay']);
        expect(navigate.mock.calls.map(([href]) => href)).toEqual([
            '/session/abc?serverId=relay', '/session/next?serverId=relay',
        ]);
        dispose();
    });

    it('preserves strict V4 Home identity and token-only pairing through the existing codec', async () => {
        const home = {
            v: 1 as const,
            homeServerIdentityId: 'srv_home_v4',
            canonicalServerUrl: 'https://home.example.test',
            revision: 1,
            endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
        };
        const link = buildTerminalConnectDeepLink({
            publicKeyB64Url: 'A'.repeat(43), serverUrl: null,
            homeConnectionDescriptor: home, supportsTokenOnly: true,
            pairing: { secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', createdAtMs: 1000, expiresAtMs: 61000 },
        });
        native.invoke.mockResolvedValue([link]);
        const navigate = vi.fn();
        const dispose = installDesktopDeepLinks(navigate);
        await flush();
        const href = navigate.mock.calls[0]?.[0];
        expect(parseTerminalConnectUrl(`https://app.example.test${href}`)).toMatchObject({
            wireVersion: 4, homeConnectionDescriptor: home, supportsTokenOnly: true,
        });
        dispose();
    });

    it('keeps released V1 Home invites on the canonical secret-free update-required path', async () => {
        native.invoke.mockResolvedValue(['happier-dev:///pair?v=1&pairId=pid123&secret=sec_abc&server=https%3A%2F%2Fstack.example.test%2Fpath%3Fx%3D1']);
        const navigate = vi.fn();
        const dispose = installDesktopDeepLinks(navigate);
        await flush();
        expect(navigate.mock.calls.map(([href]) => href)).toEqual(['/restore?legacyPairingUpdateRequired=1']);
        dispose();
    });

    it('releases a late listener and never routes after disposal', async () => {
        let resolveListen!: (stop: () => void) => void;
        native.listen.mockImplementation((_event, receive) => {
            native.receive = receive;
            return new Promise<() => void>((resolve) => { resolveListen = resolve; });
        });
        const navigate = vi.fn();
        const dispose = installDesktopDeepLinks(navigate);
        dispose();
        resolveListen(native.stop);
        await flush();
        native.receive?.(['happier://terminal?key=abc']);
        expect(navigate).not.toHaveBeenCalled();
        expect(native.stop).toHaveBeenCalled();
    });
});

import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { buildHomeQrInviteDeepLink } from '@/auth/pairing/pairingUrl';
import { encodeBase64 } from '@/encryption/base64';
import { useScannedAuthUrlProcessor } from './useScannedAuthUrlProcessor';

const processorTestState = vi.hoisted(() => ({
    routerPush: vi.fn(),
    terminalProcess: vi.fn(async () => true),
    alertAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-router', () => createExpoRouterMock({
    router: { push: processorTestState.routerPush },
}).module);

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({
        openApproval: processorTestState.terminalProcess,
        isLoading: false,
    }),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alertAsync: processorTestState.alertAsync } }).module;
});

function buildHomeInviteLink(pairId: string): string {
    return buildHomeQrInviteDeepLink({
        invite: {
            v: 2,
            intent: 'home_device',
            direction: 'trusted_home_displays',
            pairId,
            home: {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                canonicalServerUrl: 'https://home-b.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
            },
            qrSecretBase64Url: encodeBase64(new Uint8Array(32).fill(10), 'base64url'),
            issuedAtMs: Date.now(),
            expiresAtMs: Date.now() + 60_000,
        },
    });
}

describe('useScannedAuthUrlProcessor', () => {
    it('opens Source setup review from account scanning without connecting a terminal and rejects terminal scanning', async () => {
        processorTestState.routerPush.mockClear();
        processorTestState.terminalProcess.mockClear();
        const path = '/projects/setup?source=source-a&target=srv_home_b';
        const account = await renderHook(() => useScannedAuthUrlProcessor({ allowedUrlKind: 'account', homeQrEntryIntent: 'add_home' }));
        let result = false;
        await act(async () => { result = await account.getCurrent().processAuthUrl(`https://app.test${path}`); });
        expect(result).toBe(true);
        expect(processorTestState.routerPush).toHaveBeenCalledWith(path);
        expect(processorTestState.terminalProcess).not.toHaveBeenCalled();
        processorTestState.routerPush.mockClear();
        const terminal = await renderHook(() => useScannedAuthUrlProcessor({ allowedUrlKind: 'terminal' }));
        await act(async () => { result = await terminal.getCurrent().processAuthUrl(`https://app.test${path}`); });
        expect(result).toBe(false);
        expect(processorTestState.routerPush).not.toHaveBeenCalled();
        await account.unmount();
        await terminal.unmount();
    });
    it('routes V2 Home input to the restore owner carrying the scanner-owned add-home intent', async () => {
        processorTestState.routerPush.mockClear();
        processorTestState.terminalProcess.mockClear();
        const rawLink = buildHomeInviteLink('pair-generic-account-scan');
        const hook = await renderHook(() => useScannedAuthUrlProcessor({
            allowedUrlKind: 'account',
            homeQrEntryIntent: 'add_home',
        }));

        let result = false;
        await act(async () => {
            result = await hook.getCurrent().processAuthUrl(rawLink);
        });

        expect(result).toBe(true);
        const routed = String(processorTestState.routerPush.mock.calls[0]?.[0] ?? '');
        expect(routed).toMatch(/^\/restore\?pairingHandoff=[A-Za-z0-9_-]+&entryIntent=add_home$/u);
        expect(routed).not.toContain(encodeURIComponent(rawLink));
        expect(routed).not.toContain('pairingLink=');
        expect(processorTestState.terminalProcess).not.toHaveBeenCalled();
    });

    it('routes a pasted Team join link to its join destination and refuses it where only terminals are admitted', async () => {
        processorTestState.routerPush.mockClear();
        processorTestState.alertAsync.mockClear();
        const link = 'https://app.example.test/join/tj_abc123?target=hx1.carrier&targetBinding=bind-1';
        const account = await renderHook(() => useScannedAuthUrlProcessor({
            allowedUrlKind: 'account',
            homeQrEntryIntent: 'add_home',
        }));
        let result = false;
        await act(async () => {
            result = await account.getCurrent().processAuthUrl(link);
        });
        expect(result).toBe(true);
        expect(processorTestState.routerPush).toHaveBeenCalledWith('/join/tj_abc123?target=hx1.carrier&targetBinding=bind-1');

        processorTestState.routerPush.mockClear();
        const terminal = await renderHook(() => useScannedAuthUrlProcessor({ allowedUrlKind: 'terminal' }));
        await act(async () => {
            result = await terminal.getCurrent().processAuthUrl(link);
        });
        expect(result).toBe(false);
        expect(processorTestState.routerPush).not.toHaveBeenCalled();
    });

    it('routes the same V2 Home input with enter_home when the entry point owns that intent', async () => {
        processorTestState.routerPush.mockClear();
        const rawLink = buildHomeInviteLink('pair-welcome-scan');
        const hook = await renderHook(() => useScannedAuthUrlProcessor({
            allowedUrlKind: 'account',
            homeQrEntryIntent: 'enter_home',
        }));

        await act(async () => {
            await hook.getCurrent().processAuthUrl(rawLink);
        });

        const routed = String(processorTestState.routerPush.mock.calls[0]?.[0] ?? '');
        expect(routed).toMatch(/^\/restore\?pairingHandoff=[A-Za-z0-9_-]+&entryIntent=enter_home$/u);
        expect(routed).not.toContain(encodeURIComponent(rawLink));
    });

    it('leaves a terminal-only scanner unable to route a Home invite', async () => {
        processorTestState.routerPush.mockClear();
        processorTestState.terminalProcess.mockClear();
        processorTestState.alertAsync.mockClear();
        const rawLink = buildHomeInviteLink('pair-terminal-scan');
        const hook = await renderHook(() => useScannedAuthUrlProcessor({ allowedUrlKind: 'terminal' }));

        let result = true;
        await act(async () => {
            result = await hook.getCurrent().processAuthUrl(rawLink);
        });

        expect(result).toBe(false);
        expect(processorTestState.routerPush).not.toHaveBeenCalled();
        expect(processorTestState.terminalProcess).not.toHaveBeenCalled();
        expect(processorTestState.alertAsync).toHaveBeenCalledWith(
            'Error',
            'Invalid authentication URL',
            [expect.objectContaining({ text: 'OK' })],
        );
    });

    it('recognizes the immutable released V1 invite with guidance and zero enrollment effects', async () => {
        // Exact output from cli-v0.2.1 commit b1d15a8a9c241737d1ca9b167459901e6259173a.
        const releasedV1Link =
            'happier-dev:///pair?v=1&pairId=pid123&secret=sec_abc&server=https%3A%2F%2Fstack.example.test%2Fpath%3Fx%3D1';
        processorTestState.routerPush.mockClear();
        processorTestState.terminalProcess.mockClear();
        processorTestState.alertAsync.mockClear();
        const hook = await renderHook(() => useScannedAuthUrlProcessor({
            allowedUrlKind: 'account',
            homeQrEntryIntent: 'add_home',
        }));

        let result = false;
        await act(async () => {
            result = await hook.getCurrent().processAuthUrl(releasedV1Link);
        });

        expect(result).toBe(true);
        expect(processorTestState.alertAsync).toHaveBeenCalledWith(
            'Update required',
            'This QR was created by an older version of Happier. Update Happier on the other device and create a new QR.',
            [
                expect.objectContaining({ text: 'Scan a new QR' }),
                expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
            ],
        );
        expect(processorTestState.routerPush).not.toHaveBeenCalled();
        expect(processorTestState.terminalProcess).not.toHaveBeenCalled();
        expect(JSON.stringify(processorTestState.alertAsync.mock.calls)).not.toContain('sec_abc');
    });

    it('recognizes a legacy account QR only to show Home QR guidance, without routing or connecting', async () => {
        processorTestState.routerPush.mockClear();
        processorTestState.terminalProcess.mockClear();
        processorTestState.alertAsync.mockClear();
        const hook = await renderHook(() => useScannedAuthUrlProcessor({
            allowedUrlKind: 'account',
            homeQrEntryIntent: 'add_home',
        }));

        let result = true;
        await act(async () => {
            result = await hook.getCurrent().processAuthUrl('happier-dev:///account?abc123');
        });

        expect(result).toBe(false);
        expect(processorTestState.alertAsync).toHaveBeenCalledWith(
            'Restore account',
            expect.stringContaining('older account QR'),
            [expect.objectContaining({ text: 'OK' })],
        );
        expect(processorTestState.routerPush).not.toHaveBeenCalled();
        expect(processorTestState.terminalProcess).not.toHaveBeenCalled();
    });
});

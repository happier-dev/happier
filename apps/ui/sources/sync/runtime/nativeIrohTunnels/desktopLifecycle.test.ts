import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyIrohHomeCarrierFailure } from '@happier-dev/iroh-native';
import {
    createDesktopIrohLifecycleModule,
    IROH_DESKTOP_STATUS_COMMAND,
    IROH_DESKTOP_START_COMMAND,
    IROH_DESKTOP_STOP_COMMAND,
} from './desktopLifecycle';
import { createIrohHomeTunnelSupervisor } from './supervisor';
import type { IrohHomeTunnelRequest } from './types';

const HOME_ID = 'srv_home_a';
const ENDPOINT_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const TAURI_INTERNALS_KEY = '__TAURI_INTERNALS__';
const ELECTRON_USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
    + ' happier-desktop/0.2.10 Chrome/150.0.0.0 Electron/43.4.0 Safari/537.36';
const TAURI_USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
    + ' Chrome/150.0.0.0 Safari/537.36 Tauri/2.0';

function desktopLease(leaseId: string, port: number): Record<string, unknown> {
    return {
        leaseId,
        homeServerIdentityId: HOME_ID,
        homeEndpointId: ENDPOINT_ID,
        runtimeOrigin: `http://127.0.0.1:${port}`,
        carrier: 'iroh',
        observedPath: 'direct',
        startedAtMs: 42,
    };
}

function makeRequest(overrides: Partial<IrohHomeTunnelRequest> = {}): IrohHomeTunnelRequest {
    return {
        remoteHostId: HOME_ID,
        purpose: 'home',
        homeServerIdentityId: HOME_ID,
        endpointId: ENDPOINT_ID,
        canonicalServerUrl: 'https://home.example.test',
        policy: 'automatic',
        relayUrls: ['https://relay.example.test'],
        directAddresses: ['192.168.1.10:4242'],
        verification: { kind: 'authenticated', token: 'token-a' },
        ...overrides,
    };
}

describe('sync/runtime/nativeIrohTunnels desktop lifecycle bridge', () => {
    const originalInternals = (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY];
    const originalNavigator = (globalThis as Record<string, unknown>).navigator;
    let hostInvoke: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        hostInvoke = vi.fn(async () => null);
    });

    afterEach(() => {
        if (originalInternals === undefined) delete (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY];
        else (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY] = originalInternals;
        (globalThis as Record<string, unknown>).navigator = originalNavigator;
    });

    function installDesktopHost(userAgent: string): void {
        (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY] = { invoke: hostInvoke };
        (globalThis as Record<string, unknown>).navigator = { userAgent };
    }

    function installBrowserRuntime(): void {
        (globalThis as Record<string, unknown>).navigator = { userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/150.0.0.0 Safari/537.36' };
    }

    it.each(['tauri', 'electron'] as const)('maps ensureHomeTunnel onto the shared %s host command with exact request facts', async (hostKind) => {
        installDesktopHost(hostKind === 'electron' ? ELECTRON_USER_AGENT : TAURI_USER_AGENT);
        const module = createDesktopIrohLifecycleModule();
        expect(module).not.toBeNull();
        hostInvoke.mockResolvedValueOnce(desktopLease('desktop-lease-1', 45901));

        const lease = await module!.ensureHomeTunnel(makeRequest());

        expect(lease).toEqual(desktopLease('desktop-lease-1', 45901));
        expect(hostInvoke).toHaveBeenCalledTimes(1);
        expect(hostInvoke).toHaveBeenCalledWith(IROH_DESKTOP_START_COMMAND, {
            request: {
                homeServerIdentityId: HOME_ID,
                endpointId: ENDPOINT_ID,
                policy: 'automatic',
                relayUrls: ['https://relay.example.test'],
                directAddresses: ['192.168.1.10:4242'],
            },
        });
    });

    it.each(['tauri', 'electron'] as const)('releases through %s via the canonical handle operation and stays typed for repeated releases', async (hostKind) => {
        installDesktopHost(hostKind === 'electron' ? ELECTRON_USER_AGENT : TAURI_USER_AGENT);
        const module = createDesktopIrohLifecycleModule();
        expect(module).not.toBeNull();

        await module!.releaseHomeTunnel('desktop-lease-1');
        await module!.releaseHomeTunnel('desktop-lease-1');

        expect(hostInvoke).toHaveBeenCalledTimes(2);
        expect(hostInvoke).toHaveBeenNthCalledWith(1, IROH_DESKTOP_STOP_COMMAND, { leaseId: 'desktop-lease-1' });
        expect(hostInvoke).toHaveBeenNthCalledWith(2, IROH_DESKTOP_STOP_COMMAND, { leaseId: 'desktop-lease-1' });
    });

    it.each(['tauri', 'electron'] as const)('polls transport-only status through the shared %s host command', async (hostKind) => {
        installDesktopHost(hostKind === 'electron' ? ELECTRON_USER_AGENT : TAURI_USER_AGENT);
        const module = createDesktopIrohLifecycleModule();
        expect(module).not.toBeNull();
        hostInvoke.mockResolvedValueOnce({ active: false, connectionActive: false, observedPath: 'relay' });

        await expect(module!.getTunnelStatus?.('desktop-lease-1')).resolves.toEqual({
            active: false,
            connectionActive: false,
            observedPath: 'relay',
        });
        expect(hostInvoke).toHaveBeenCalledWith(IROH_DESKTOP_STATUS_COMMAND, { leaseId: 'desktop-lease-1' });
    });

    it('returns no desktop module in a browser runtime and never reaches a host bridge', () => {
        installBrowserRuntime();
        expect(createDesktopIrohLifecycleModule()).toBeNull();
    });

    it('fails closed on malformed or misrouted host lease responses', async () => {
        installDesktopHost(ELECTRON_USER_AGENT);
        const module = createDesktopIrohLifecycleModule();
        expect(module).not.toBeNull();

        hostInvoke.mockResolvedValueOnce({ leaseId: 'desktop-lease-bad' });
        await expect(module!.ensureHomeTunnel(makeRequest())).rejects.toMatchObject({ name: 'IrohError', code: 'unknown' });

        hostInvoke.mockResolvedValueOnce({ ...desktopLease('desktop-lease-2', 45902), carrier: 'https' });
        await expect(module!.ensureHomeTunnel(makeRequest())).rejects.toMatchObject({ name: 'IrohError', code: 'unknown' });

        hostInvoke.mockResolvedValueOnce(undefined);
        await expect(module!.ensureHomeTunnel(makeRequest())).rejects.toMatchObject({ name: 'IrohError', code: 'unknown' });

        hostInvoke.mockResolvedValueOnce({
            ...desktopLease('desktop-lease-external', 45903),
            runtimeOrigin: 'https://attacker.example.test',
        });
        const malformedOrigin = await module!.ensureHomeTunnel(makeRequest()).catch((error: unknown) => error);
        expect(malformedOrigin).toMatchObject({ name: 'IrohError', code: 'unknown' });
        expect(classifyIrohHomeCarrierFailure(malformedOrigin).fallbackAllowed).toBe(true);
    });

    it('accepts any literal IPv4 loopback origin owned by the desktop host', async () => {
        installDesktopHost(ELECTRON_USER_AGENT);
        const module = createDesktopIrohLifecycleModule();
        expect(module).not.toBeNull();
        hostInvoke.mockResolvedValueOnce({
            ...desktopLease('desktop-lease-loopback', 45904),
            runtimeOrigin: 'http://127.0.0.2:45904',
        });

        await expect(module!.ensureHomeTunnel(makeRequest())).resolves.toMatchObject({
            runtimeOrigin: 'http://127.0.0.2:45904',
        });
    });

    it('preserves native error codes as IrohError so the shared fallback classifier keeps ownership', async () => {
        installDesktopHost(ELECTRON_USER_AGENT);
        const module = createDesktopIrohLifecycleModule();
        expect(module).not.toBeNull();

        // Identity and descriptor refusals stay fail closed across the bridge.
        hostInvoke.mockRejectedValueOnce(new Error('iroh_native_error:endpoint-identity-mismatch:wrong home'));
        const identityError = await module!.ensureHomeTunnel(makeRequest()).catch((error: unknown) => error);
        expect(identityError).toMatchObject({ name: 'IrohError', code: 'identity_mismatch' });
        expect(classifyIrohHomeCarrierFailure(identityError).fallbackAllowed).toBe(false);

        hostInvoke.mockRejectedValueOnce(new Error('iroh_native_error:endpoint-identity-invalid:bad id'));
        const descriptorError = await module!.ensureHomeTunnel(makeRequest()).catch((error: unknown) => error);
        expect(classifyIrohHomeCarrierFailure(descriptorError).fallbackAllowed).toBe(false);

        hostInvoke.mockRejectedValueOnce(new Error('iroh_native_error:endpoint_key_unavailable:key unavailable'));
        const keyError = await module!.ensureHomeTunnel(makeRequest()).catch((error: unknown) => error);
        expect(keyError).toMatchObject({ name: 'IrohError', code: 'endpoint_key_unavailable' });
        expect(classifyIrohHomeCarrierFailure(keyError).fallbackAllowed).toBe(true);

        // Availability/transport failures keep the honest fallback-allowed class.
        hostInvoke.mockRejectedValueOnce(new Error('iroh_native_error:unavailable:addon missing'));
        const unavailableError = await module!.ensureHomeTunnel(makeRequest()).catch((error: unknown) => error);
        expect(classifyIrohHomeCarrierFailure(unavailableError).fallbackAllowed).toBe(true);

        hostInvoke.mockRejectedValueOnce(new Error('HAPPIER_DESKTOP_NOT_IMPLEMENTED: iroh_ensure_home_tunnel'));
        const notImplementedError = await module!.ensureHomeTunnel(makeRequest()).catch((error: unknown) => error);
        expect(classifyIrohHomeCarrierFailure(notImplementedError).fallbackAllowed).toBe(true);

        hostInvoke.mockRejectedValueOnce(new Error('iroh_native_error:transport_closed:peer disconnected'));
        const closedError = await module!.ensureHomeTunnel(makeRequest()).catch((error: unknown) => error);
        expect(closedError).toMatchObject({ name: 'IrohError', code: 'transport_closed' });
        expect(classifyIrohHomeCarrierFailure(closedError).fallbackAllowed).toBe(true);
    });

    it('supervisor default composition selects the desktop bridge without bypassing the shared supervisor', async () => {
        installDesktopHost(TAURI_USER_AGENT);
        const supervisor = createIrohHomeTunnelSupervisor({ probe: async () => ({ ok: true }) });
        hostInvoke.mockResolvedValueOnce(desktopLease('desktop-lease-supervised', 45903));

        const lease = await supervisor.ensureTunnel(makeRequest());

        expect(lease.localUrl).toBe('http://127.0.0.1:45903');
        expect(lease.carrier).toBe('iroh');
        expect(hostInvoke).toHaveBeenCalledWith(IROH_DESKTOP_START_COMMAND, expect.objectContaining({ request: expect.any(Object) }));

        await supervisor.releaseTunnel(lease.leaseId);
        expect(hostInvoke).toHaveBeenCalledWith(IROH_DESKTOP_STOP_COMMAND, { leaseId: 'desktop-lease-supervised' });
    });

    it('keeps the non-desktop default on the optional Expo module with no desktop command carrier', async () => {
        installBrowserRuntime();
        const supervisor = createIrohHomeTunnelSupervisor({ probe: async () => ({ ok: true }) });

        // The Expo optional module resolves to nothing in this runtime, so the
        // supervisor reports the typed unavailable outcome; no host command is
        // ever invoked and no browser/global carrier exists.
        await expect(supervisor.ensureTunnel(makeRequest())).rejects.toMatchObject({ name: 'IrohError', code: 'unavailable' });
        expect(hostInvoke).not.toHaveBeenCalled();
    });
});

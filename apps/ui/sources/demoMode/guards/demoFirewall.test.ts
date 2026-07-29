import { afterEach, describe, expect, it, vi } from 'vitest';

import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { isServerProfilePersistenceSuspendedForDemo } from '@/sync/domains/server/serverProfiles';

import {
    getDemoFirewallDenyLog,
    installDemoFirewall,
    resetDemoFirewallForTests,
    uninstallDemoFirewall,
} from './demoFirewall';

describe('demoFirewall', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        resetDemoFirewallForTests();
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('suspends server-profile persistence while installed and resumes it on uninstall', () => {
        expect(isServerProfilePersistenceSuspendedForDemo()).toBe(false);

        installDemoFirewall();
        expect(isServerProfilePersistenceSuspendedForDemo()).toBe(true);

        // Nested installs keep persistence suspended until the last uninstall.
        installDemoFirewall();
        uninstallDemoFirewall();
        expect(isServerProfilePersistenceSuspendedForDemo()).toBe(true);

        uninstallDemoFirewall();
        expect(isServerProfilePersistenceSuspendedForDemo()).toBe(false);
    });

    it('blocks and logs runtimeFetch and direct global fetch paths', async () => {
        globalThis.fetch = vi.fn(async () => new Response('ok'));

        installDemoFirewall();

        await expect(runtimeFetch('https://example.test/runtime')).rejects.toThrow(/Demo mode blocked network egress/);
        await expect(globalThis.fetch('https://example.test/direct')).rejects.toThrow(/Demo mode blocked network egress/);

        expect(getDemoFirewallDenyLog()).toEqual([
            expect.objectContaining({ channel: 'runtimeFetch', url: 'https://example.test/runtime' }),
            expect.objectContaining({ channel: 'globalFetch', url: 'https://example.test/direct' }),
        ]);
    });

    it('allows same-origin Metro web bundle fetches without opening API egress', async () => {
        const fetchSpy = vi.fn(async () => new Response('bundle'));
        globalThis.fetch = fetchSpy;
        vi.stubGlobal('location', {
            origin: 'http://127.0.0.1:8090',
            href: 'http://127.0.0.1:8090/',
        });

        installDemoFirewall();

        await expect(globalThis.fetch(
            '/apps/ui/sources/components/sessions/shell/SessionsList.bundle?platform=web&dev=true&lazy=true&modulesOnly=true',
        )).resolves.toBeInstanceOf(Response);
        await expect(globalThis.fetch(
            '/_expo/static/js/web/ServerSettingsScreen-7d9f1a.chunk.js',
        )).resolves.toBeInstanceOf(Response);
        await expect(globalThis.fetch(
            '/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf',
        )).resolves.toBeInstanceOf(Response);
        await expect(globalThis.fetch('/v1/features')).rejects.toThrow(/Demo mode blocked network egress/);
        await expect(globalThis.fetch('/v1/features.bundle?platform=web')).rejects.toThrow(/Demo mode blocked network egress/);
        await expect(globalThis.fetch('/api/auth/restore')).rejects.toThrow(/Demo mode blocked network egress/);
        await expect(globalThis.fetch('/api/auth/restore.bundle?platform=web')).rejects.toThrow(/Demo mode blocked network egress/);
        await expect(globalThis.fetch('/socket.io/?EIO=4&transport=polling')).rejects.toThrow(/Demo mode blocked network egress/);
        await expect(globalThis.fetch(
            'https://cdn.example.test/apps/ui/sources/components/sessions/shell/SessionsList.bundle?platform=web',
        )).rejects.toThrow(/Demo mode blocked network egress/);
        await expect(runtimeFetch(
            'http://127.0.0.1:8090/apps/ui/sources/components/sessions/shell/SessionsList.bundle?platform=web',
        )).rejects.toThrow(/Demo mode blocked network egress/);

        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(getDemoFirewallDenyLog()).toEqual([
            expect.objectContaining({ channel: 'globalFetch', url: '/v1/features' }),
            expect.objectContaining({ channel: 'globalFetch', url: '/v1/features.bundle?platform=web' }),
            expect.objectContaining({ channel: 'globalFetch', url: '/api/auth/restore' }),
            expect.objectContaining({ channel: 'globalFetch', url: '/api/auth/restore.bundle?platform=web' }),
            expect.objectContaining({ channel: 'globalFetch', url: '/socket.io/?EIO=4&transport=polling' }),
            expect.objectContaining({
                channel: 'globalFetch',
                url: 'https://cdn.example.test/apps/ui/sources/components/sessions/shell/SessionsList.bundle?platform=web',
            }),
            expect.objectContaining({
                channel: 'runtimeFetch',
                url: 'http://127.0.0.1:8090/apps/ui/sources/components/sessions/shell/SessionsList.bundle?platform=web',
            }),
        ]);
    });

    it('allows the S2 restore lazy screen bundle request while the firewall is installed', async () => {
        const fetchSpy = vi.fn(async () => new Response('server settings bundle'));
        globalThis.fetch = fetchSpy;
        vi.stubGlobal('location', {
            origin: 'http://localhost:19364',
            href: 'http://localhost:19364/',
        });

        installDemoFirewall();

        await expect(globalThis.fetch(
            '/apps/ui/sources/components/settings/server/screens/ServerSettingsScreen.bundle?platform=web&dev=true&lazy=true&modulesOnly=true',
        )).resolves.toBeInstanceOf(Response);
        await expect(globalThis.fetch(
            '/v1/auth/restore',
            { method: 'POST' },
        )).rejects.toThrow(/Demo mode blocked network egress/);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(getDemoFirewallDenyLog()).toEqual([
            expect.objectContaining({
                channel: 'globalFetch',
                method: 'POST',
                url: '/v1/auth/restore',
            }),
        ]);
    });

    it('restores global fetch and runtimeFetch after uninstall', async () => {
        const fetchSpy = vi.fn(async () => new Response('ok'));
        globalThis.fetch = fetchSpy;

        installDemoFirewall();
        uninstallDemoFirewall();

        await expect(globalThis.fetch('https://example.test/direct')).resolves.toBeInstanceOf(Response);
        await expect(runtimeFetch('https://example.test/runtime')).resolves.toBeInstanceOf(Response);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('is safe across double install and double uninstall', async () => {
        const fetchSpy = vi.fn(async () => new Response('ok'));
        globalThis.fetch = fetchSpy;

        installDemoFirewall();
        installDemoFirewall();
        uninstallDemoFirewall();
        await expect(globalThis.fetch('https://example.test/still-blocked')).rejects.toThrow(/Demo mode blocked/);

        uninstallDemoFirewall();
        uninstallDemoFirewall();

        await expect(globalThis.fetch('https://example.test/restored')).resolves.toBeInstanceOf(Response);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});

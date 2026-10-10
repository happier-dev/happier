import { describe, expect, it, vi } from 'vitest';

import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

function profile(overrides: Partial<ServerProfile>): ServerProfile {
    return {
        id: 'home-a',
        name: '127.0.0.1:53288',
        serverUrl: 'http://127.0.0.1:53288',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
        ...overrides,
    };
}

describe('resolveHomeDisplayName', () => {
    it('names a Home by the name the Home itself publishes, the same on every device', async () => {
        const { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { resolveHomeDisplayName } = await import('./homeDisplayName');
        primeServerFeaturesSnapshot({
            serverId: 'home-a',
            snapshot: {
                status: 'ready',
                features: { ...createRootLayoutFeaturesResponse(), homePresentation: { v: 1, displayName: 'Leeroy’s Home' } },
            },
        });
        try {
            // The Home's published name wins over this device's own label for it.
            expect(resolveHomeDisplayName(profile({ name: 'Studio' }))).toBe('Leeroy’s Home');
        } finally {
            deleteServerFeaturesSnapshot({ serverId: 'home-a' });
        }
        // Until the Home publishes one, this device's label stands.
        expect(resolveHomeDisplayName(profile({ name: 'Studio' }))).toBe('Studio');
    });

    it('names a Home by the name it was given', async () => {
        const { resolveHomeDisplayName } = await import('./homeDisplayName');
        expect(resolveHomeDisplayName(profile({ name: 'Studio' }))).toBe('Studio');
    });

    it('does not present the address a profile was named after as a Home name', async () => {
        const { resolveHomeDisplayName } = await import('./homeDisplayName');
        expect(resolveHomeDisplayName(profile({}))).toBeNull();
        expect(resolveHomeDisplayName(profile({ name: 'http://127.0.0.1:53288' }))).toBeNull();
        expect(resolveHomeDisplayName(profile({
            name: 'home.example.test',
            serverUrl: 'https://home.example.test/',
        }))).toBeNull();
    });

    it('treats a stored name that is only an address as no name, even after the Home moved', async () => {
        const { resolveHomeDisplayName, resolveHomeDisplayLabel } = await import('./homeDisplayName');
        const moved = { serverUrl: 'http://192.168.5.15:53288' };
        for (const name of [
            '127.0.0.1:53288',
            '127.0.0.1',
            '[::1]:8443',
            'fe80::1',
            'https://old.example.com/home',
            'devbox.internal',
            'leeroy-mbp.tailfce179.ts.net:8443',
            'localhost',
            'devbox:8443',
        ]) {
            expect(resolveHomeDisplayName(profile({ name, ...moved })), name).toBeNull();
            expect(resolveHomeDisplayLabel(profile({ name, ...moved }), 'home-a'), name)
                .toBe('settingsAccount.thisHomeTitle');
        }
        // Words stay names, including single words and names with version dots.
        for (const name of ['Studio', 'devbox', 'Lab v2.1', 'Work Home']) {
            expect(resolveHomeDisplayName(profile({ name, ...moved })), name).toBe(name);
        }
    });

    it('calls an unnamed Personal Home by its product name', async () => {
        const { resolveHomeDisplayName } = await import('./homeDisplayName');
        expect(resolveHomeDisplayName(profile({ personalHomeBootstrapCompleted: true })))
            .toBe('personalHome.settings.defaultHomeLabel');
        expect(resolveHomeDisplayName(profile({ name: 'Laptop', personalHomeBootstrapCompleted: true })))
            .toBe('Laptop');
    });

    it('has no name for a missing profile', async () => {
        const { resolveHomeDisplayName } = await import('./homeDisplayName');
        expect(resolveHomeDisplayName(null)).toBeNull();
    });
});

describe('resolveHomeDisplayLabel', () => {
    it('shows a named Home by its name', async () => {
        const { resolveHomeDisplayLabel } = await import('./homeDisplayName');
        expect(resolveHomeDisplayLabel(profile({ name: 'Studio' }), 'home-a')).toBe('Studio');
        expect(resolveHomeDisplayLabel(profile({ personalHomeBootstrapCompleted: true }), 'home-a'))
            .toBe('personalHome.settings.defaultHomeLabel');
    });

    it('keeps unnamed Home titles human, leaving the address to distinguishing metadata', async () => {
        const { resolveHomeDisplayLabel } = await import('./homeDisplayName');
        expect(resolveHomeDisplayLabel(profile({}), 'home-a')).toBe('settingsAccount.thisHomeTitle');
        expect(resolveHomeDisplayLabel(profile({
            name: 'devbox.internal',
            serverUrl: 'https://devbox.internal/',
        }), 'home-a')).toBe('settingsAccount.thisHomeTitle');
    });

    it('keeps a missing Home profile human rather than exposing its internal id', async () => {
        const { resolveHomeDisplayLabel } = await import('./homeDisplayName');
        expect(resolveHomeDisplayLabel(null, 'home-a')).toBe('settingsAccount.thisHomeTitle');
    });
});

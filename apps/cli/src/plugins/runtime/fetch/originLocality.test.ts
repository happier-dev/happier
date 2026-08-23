import { describe, expect, it, vi } from 'vitest';

import {
    assessPluginNetworkOriginLocalities,
    assessPluginNetworkOriginLocality,
} from './originLocality';

const neverResolves = async (hostname: string): Promise<readonly string[]> => {
    throw new Error(`unexpected DNS lookup for ${hostname}`);
};

describe('plugin network origin locality', () => {
    it.each([
        ['https://127.0.0.1', 'private'],
        ['https://10.2.3.4', 'private'],
        ['https://172.16.0.1', 'private'],
        ['https://172.31.255.255', 'private'],
        ['https://192.168.1.2', 'private'],
        ['https://169.254.2.3', 'private'],
        ['https://[::1]', 'private'],
        ['https://[fd12::1]', 'private'],
        ['https://[fe80::1]', 'private'],
        ['https://93.184.216.34', 'public'],
        ['https://[2606:4700::1111]', 'public'],
        ['https://172.15.255.255', 'public'],
        ['https://172.32.0.1', 'public'],
    ] as const)('decides a literal address without any resolution (%s)', async (origin, expected) => {
        expect(await assessPluginNetworkOriginLocality(origin, {
            resolveAddresses: neverResolves,
        })).toBe(expected);
    });

    it.each([
        // Carrier-grade NAT: reachable inside the operator network, never public.
        'https://100.64.0.1',
        // The unspecified address is a routable localhost alias on many stacks.
        'https://0.0.0.0',
        // Benchmarking range, multicast, and the cloud metadata destination.
        'https://198.18.0.1',
        'https://224.0.0.1',
        'https://169.254.169.254',
        // An IPv4-mapped literal must inherit the embedded address's locality.
        'https://[::ffff:10.0.0.1]',
        // A 6to4 literal embeds its source IPv4 address.
        'https://[2002:a00:1::1]',
    ])('treats a non-public destination the spelling test missed as private (%s)', async (origin) => {
        expect(await assessPluginNetworkOriginLocality(origin, {
            resolveAddresses: neverResolves,
        })).toBe('private');
    });

    it('decides a hostname only from its resolved addresses', async () => {
        const resolveAddresses = vi.fn(async () => ['10.0.0.7']);
        expect(await assessPluginNetworkOriginLocality('https://git.internal.example', {
            resolveAddresses,
        })).toBe('private');
        expect(resolveAddresses).toHaveBeenCalledWith('git.internal.example');

        expect(await assessPluginNetworkOriginLocality('https://api.example.test', {
            resolveAddresses: async () => ['93.184.216.34'],
        })).toBe('public');
    });

    it('treats a hostname resolving to any non-public address as private', async () => {
        expect(await assessPluginNetworkOriginLocality('https://split.example.test', {
            resolveAddresses: async () => ['93.184.216.34', '192.168.1.9'],
        })).toBe('private');
    });

    it('fails closed on every destination it cannot positively call public', async () => {
        // A failed resolution is not evidence of a public destination.
        expect(await assessPluginNetworkOriginLocality('https://api.example.test', {
            resolveAddresses: async () => {
                throw new Error('ENOTFOUND');
            },
        })).toBe('private');
        expect(await assessPluginNetworkOriginLocality('https://api.example.test', {
            resolveAddresses: async () => [],
        })).toBe('private');
        // A cloud metadata name is refused before any resolution is attempted.
        expect(await assessPluginNetworkOriginLocality('https://metadata.google.internal', {
            resolveAddresses: neverResolves,
        })).toBe('private');
        // A loopback name answering outside loopback is a rebinding answer.
        expect(await assessPluginNetworkOriginLocality('https://localhost:4311', {
            resolveAddresses: async () => ['93.184.216.34'],
        })).toBe('private');
        expect(await assessPluginNetworkOriginLocality('not-a-url', {
            resolveAddresses: neverResolves,
        })).toBe('private');
    });

    it('resolves localhost through DNS like any other name', async () => {
        expect(await assessPluginNetworkOriginLocality('https://localhost:4311', {
            resolveAddresses: async () => ['127.0.0.1'],
        })).toBe('private');
    });

    it('classifies a set in one pass and resolves each distinct origin once', async () => {
        const resolveAddresses = vi.fn(async (hostname: string) => (
            hostname === 'git.internal.example' ? ['10.0.0.7'] : ['93.184.216.34']
        ));
        const localities = await assessPluginNetworkOriginLocalities([
            'https://api.example.test',
            'https://git.internal.example',
            'https://api.example.test',
        ], { resolveAddresses });

        expect(localities.get('https://api.example.test')).toBe('public');
        expect(localities.get('https://git.internal.example')).toBe('private');
        expect(resolveAddresses).toHaveBeenCalledTimes(2);
    });
});

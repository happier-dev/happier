import { describe, expect, it, vi } from 'vitest';

describe('sessionListProjectGroupingKeys', () => {
    it('normalizes windows separators and expands ~ using homeDir', async () => {
        const { resolveSessionProjectGroupingKeyParts } = await import('./sessionListProjectGroupingKeys');
        const parts = resolveSessionProjectGroupingKeyParts({
            host: 'example',
            machineId: 'm1',
            homeDir: 'C:\\Users\\Bob\\',
            path: '~\\repo\\',
        });

        expect(parts.homeDir).toBe('C:/Users/Bob');
        expect(parts.pathKey).toBe('C:/Users/Bob/repo');
        expect(parts.machineGroupId).toBe('host:example');
    });

    it('preserves UNC/network share prefixes when normalizing slashes', async () => {
        const { resolveSessionProjectGroupingKeyParts } = await import('./sessionListProjectGroupingKeys');
        const parts = resolveSessionProjectGroupingKeyParts({
            host: 'example',
            machineId: 'm1',
            path: '\\\\server\\share\\repo\\',
        });

        expect(parts.pathKey).toBe('//server/share/repo');
        expect(parts.machineGroupId).toBe('host:example');
    });

    it('prefers machine metadata when deriving session project grouping key parts', async () => {
        const { resolveSessionProjectGroupingKeyPartsWithMachineMetadata } = await import('./sessionListProjectGroupingKeys');
        const parts = resolveSessionProjectGroupingKeyPartsWithMachineMetadata(
            {
                host: 'session-host',
                machineId: 'm1',
                homeDir: '/home/session',
                path: '~/repo',
            },
            {
                host: ' machine-host ',
                homeDir: '/home/machine/',
            },
            '~/repo',
        );

        expect(parts).toEqual({
            displayPath: '~/repo',
            machineGroupId: 'host:machine-host',
            host: 'machine-host',
            machineId: 'm1',
            homeDir: '/home/machine',
            pathKey: '/home/machine/repo',
        });
    });

    it('reuses canonical grouping key parts for repeated equal inputs', async () => {
        const { resolveSessionProjectGroupingKeyParts, resolveSessionProjectGroupingKeyPartsWithMachineMetadata } = await import(
            './sessionListProjectGroupingKeys'
        );
        const first = resolveSessionProjectGroupingKeyParts({
            host: ' example ',
            machineId: 'm1',
            homeDir: '/home/u/',
            path: '~/repo/',
        });
        const second = resolveSessionProjectGroupingKeyParts({
            host: 'example',
            machineId: 'm1',
            homeDir: '/home/u',
            path: '~/repo',
        });
        const firstWithMachine = resolveSessionProjectGroupingKeyPartsWithMachineMetadata(
            {
                host: ' example ',
                machineId: 'm1',
                homeDir: '/home/u/',
                path: '~/repo',
            },
            {
                host: ' machine-host ',
                homeDir: '/home/machine/',
            },
            '~/repo',
        );
        const secondWithMachine = resolveSessionProjectGroupingKeyPartsWithMachineMetadata(
            {
                host: 'example',
                machineId: 'm1',
                homeDir: '/home/u',
                path: '~/repo',
            },
            {
                host: 'machine-host',
                homeDir: '/home/machine',
            },
            '~/repo',
        );

        expect(first).toBe(second);
        expect(firstWithMachine).toBe(secondWithMachine);
    });

    it('bounds canonical grouping key part caches via LRU eviction', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SESSION_LIST_PROJECT_GROUPING_CACHE_MAX', '1');
        vi.resetModules();

        try {
            const {
                resolveSessionProjectGroupingKeyParts,
                resolveSessionProjectGroupingKeyPartsWithMachineMetadata,
            } = await import('./sessionListProjectGroupingKeys');

            const first = resolveSessionProjectGroupingKeyParts({
                host: 'host-a',
                machineId: 'm1',
                homeDir: '/home/a',
                path: '~/repo',
            });
            resolveSessionProjectGroupingKeyParts({
                host: 'host-b',
                machineId: 'm2',
                homeDir: '/home/b',
                path: '~/repo',
            });

            expect(resolveSessionProjectGroupingKeyParts({
                host: 'host-a',
                machineId: 'm1',
                homeDir: '/home/a',
                path: '~/repo',
            })).not.toBe(first);

            const firstWithMachine = resolveSessionProjectGroupingKeyPartsWithMachineMetadata(
                {
                    host: 'session-host-a',
                    machineId: 'm1',
                    homeDir: '/home/session',
                    path: '~/repo',
                },
                {
                    host: 'machine-host-a',
                    homeDir: '/home/machine',
                },
                '~/repo',
            );
            resolveSessionProjectGroupingKeyPartsWithMachineMetadata(
                {
                    host: 'session-host-b',
                    machineId: 'm2',
                    homeDir: '/home/session',
                    path: '~/repo',
                },
                {
                    host: 'machine-host-b',
                    homeDir: '/home/machine',
                },
                '~/repo',
            );

            expect(resolveSessionProjectGroupingKeyPartsWithMachineMetadata(
                {
                    host: 'session-host-a',
                    machineId: 'm1',
                    homeDir: '/home/session',
                    path: '~/repo',
                },
                {
                    host: 'machine-host-a',
                    homeDir: '/home/machine',
                },
                '~/repo',
            )).not.toBe(firstWithMachine);
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    });
});

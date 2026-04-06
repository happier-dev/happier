import { describe, expect, it } from 'vitest';

import {
    resolveSessionProjectGroupingKeyParts,
    resolveSessionProjectGroupingKeyPartsWithMachineMetadata,
} from './sessionListProjectGroupingKeys';

describe('resolveSessionProjectGroupingKeyParts', () => {
    it('normalizes windows separators and expands ~ using homeDir', () => {
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

    it('preserves UNC/network share prefixes when normalizing slashes', () => {
        const parts = resolveSessionProjectGroupingKeyParts({
            host: 'example',
            machineId: 'm1',
            path: '\\\\server\\share\\repo\\',
        });

        expect(parts.pathKey).toBe('//server/share/repo');
        expect(parts.machineGroupId).toBe('host:example');
    });

    it('prefers machine metadata when deriving session project grouping key parts', () => {
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

    it('reuses canonical grouping key parts for repeated equal inputs', () => {
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
});

import { describe, expect, it } from 'vitest';

import { machineMetadataPlatformToTarget } from './machinePlatform';

describe('machineMetadataPlatformToTarget', () => {
    it('maps Windows variants to "windows"', () => {
        expect(machineMetadataPlatformToTarget('win32')).toBe('windows');
        expect(machineMetadataPlatformToTarget('Windows')).toBe('windows');
        expect(machineMetadataPlatformToTarget('WIN64')).toBe('windows');
    });

    it('maps Unix variants to "unix"', () => {
        expect(machineMetadataPlatformToTarget('darwin')).toBe('unix');
        expect(machineMetadataPlatformToTarget('Linux')).toBe('unix');
        expect(machineMetadataPlatformToTarget('macos')).toBe('unix');
        expect(machineMetadataPlatformToTarget('freebsd')).toBe('unix');
    });

    it('returns "auto" for unknown, empty, or nullish values', () => {
        expect(machineMetadataPlatformToTarget(null)).toBe('auto');
        expect(machineMetadataPlatformToTarget(undefined)).toBe('auto');
        expect(machineMetadataPlatformToTarget('')).toBe('auto');
        expect(machineMetadataPlatformToTarget('haiku')).toBe('auto');
    });
});

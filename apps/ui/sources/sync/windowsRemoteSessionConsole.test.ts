import { describe, expect, it } from 'vitest';

import { resolveWindowsRemoteSessionConsoleFromMachineMetadata } from './windowsRemoteSessionConsole';

describe('resolveWindowsRemoteSessionConsoleFromMachineMetadata', () => {
    it('returns undefined when machine is not Windows', () => {
        expect(
            resolveWindowsRemoteSessionConsoleFromMachineMetadata({
                platform: 'darwin',
                windowsRemoteSessionConsole: 'visible',
            } as any),
        ).toBeUndefined();
    });

    it('returns visible when explicitly set on Windows', () => {
        expect(
            resolveWindowsRemoteSessionConsoleFromMachineMetadata({
                platform: 'win32',
                windowsRemoteSessionConsole: 'visible',
            } as any),
        ).toBe('visible');
    });

    it('returns hidden when explicitly set on Windows', () => {
        expect(
            resolveWindowsRemoteSessionConsoleFromMachineMetadata({
                platform: 'win32',
                windowsRemoteSessionConsole: 'hidden',
            } as any),
        ).toBe('hidden');
    });

    it('returns undefined when unset on Windows', () => {
        expect(
            resolveWindowsRemoteSessionConsoleFromMachineMetadata({
                platform: 'win32',
            } as any),
        ).toBeUndefined();
    });
});

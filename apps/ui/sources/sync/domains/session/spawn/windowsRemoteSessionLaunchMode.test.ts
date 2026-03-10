import { describe, expect, it } from 'vitest';

import { resolveEffectiveWindowsRemoteSessionLaunchMode } from './windowsRemoteSessionLaunchMode';

describe('resolveEffectiveWindowsRemoteSessionLaunchMode', () => {
    it('returns undefined for non-Windows machines', () => {
        expect(resolveEffectiveWindowsRemoteSessionLaunchMode({
            machineMetadata: {
                platform: 'darwin',
                windowsRemoteSessionLaunchMode: 'console',
            } as any,
            settings: {
                sessionWindowsRemoteSessionLaunchMode: 'windows_terminal',
            } as any,
        })).toEqual({
            mode: undefined,
            source: 'unsupported',
        });
    });

    it('prefers a session override', () => {
        expect(resolveEffectiveWindowsRemoteSessionLaunchMode({
            machineMetadata: {
                platform: 'win32',
                windowsRemoteSessionLaunchMode: 'console',
            } as any,
            settings: {
                sessionWindowsRemoteSessionLaunchMode: 'hidden',
            } as any,
            sessionOverride: 'windows_terminal',
        })).toEqual({
            mode: 'windows_terminal',
            source: 'session',
        });
    });

    it('falls back to the machine override before settings', () => {
        expect(resolveEffectiveWindowsRemoteSessionLaunchMode({
            machineMetadata: {
                platform: 'win32',
                windowsRemoteSessionLaunchMode: 'console',
            } as any,
            settings: {
                sessionWindowsRemoteSessionLaunchMode: 'hidden',
            } as any,
        })).toEqual({
            mode: 'console',
            source: 'machine',
        });
    });

    it('uses the global setting when there is no machine override', () => {
        expect(resolveEffectiveWindowsRemoteSessionLaunchMode({
            machineMetadata: {
                platform: 'win32',
            } as any,
            settings: {
                sessionWindowsRemoteSessionLaunchMode: 'windows_terminal',
            } as any,
        })).toEqual({
            mode: 'windows_terminal',
            source: 'settings',
        });
    });

    it('maps the legacy visible value to console', () => {
        expect(resolveEffectiveWindowsRemoteSessionLaunchMode({
            machineMetadata: {
                platform: 'win32',
                windowsRemoteSessionConsole: 'visible',
            } as any,
            settings: {} as any,
        })).toEqual({
            mode: 'console',
            source: 'machine',
        });
    });

    it('uses hidden as the built-in fallback for Windows', () => {
        expect(resolveEffectiveWindowsRemoteSessionLaunchMode({
            machineMetadata: {
                platform: 'win32',
            } as any,
            settings: {} as any,
        })).toEqual({
            mode: 'hidden',
            source: 'default',
        });
    });
});

import { describe, expect, it } from 'vitest';

import { projectComputerProviderRows } from './computerProviderSettings';

describe('computer provider settings presentation', () => {
    it('keeps preferences distinct from unknown, missing and installed runtime facts', () => {
        const preferences = { enabledProviders: ['cua'] as const, defaultProvider: 'cua' as const };
        expect(projectComputerProviderRows(preferences, { status: 'idle' }).map(row => row.availability))
            .toEqual(['unknown', 'unknown']);
        expect(projectComputerProviderRows(preferences, { status: 'loading' }).map(row => row.availability))
            .toEqual(['loading', 'loading']);
        const rows = projectComputerProviderRows(preferences, { status: 'loaded', snapshot: { response: {
            protocolVersion: 1, results: {
                'dep.computer-cua-driver': { ok: true, checkedAt: 1, data: { installed: false } },
                'dep.computer-agent-desktop': { ok: true, checkedAt: 1, data: { installed: true, runtimeState: 'ready' } },
            },
        } } });
        expect(rows.map(row => ({ provider: row.provider, enabled: row.enabled, isDefault: row.isDefault, availability: row.availability })))
            .toEqual([
                { provider: 'cua', enabled: true, isDefault: true, availability: 'not_installed' },
                { provider: 'agent-desktop', enabled: false, isDefault: false, availability: 'ready' },
            ]);
    });

    it('preserves runtime facts during refresh and reports unavailable detection truthfully', () => {
        const preferences = { enabledProviders: ['cua'] as const, defaultProvider: 'cua' as const };
        const rows = projectComputerProviderRows(preferences, { status: 'loading', snapshot: { response: {
            protocolVersion: 1, results: {
                'dep.computer-cua-driver': { ok: true, checkedAt: 1, data: { installed: true, runtimeState: 'unavailable' } },
                'dep.computer-agent-desktop': { ok: false, checkedAt: 1, error: { code: 'unsupported_platform', message: 'Unsupported platform' } },
            },
        } } });
        expect(rows.map(row => row.availability)).toEqual(['unavailable', 'unavailable']);
        const downloading = projectComputerProviderRows(preferences, { status: 'loaded', snapshot: { response: {
            protocolVersion: 1, results: {
                'dep.computer-cua-driver': { ok: true, checkedAt: 1, data: { installed: false, runtimeState: 'downloading' } },
            },
        } } });
        expect(downloading[0]?.availability).toBe('installing');
        expect(rows[1]?.error).toEqual({ code: 'unsupported_platform', message: 'Unsupported platform' });
    });
});

import { describe, expect, it } from 'vitest';
import { getInstallablesRegistryEntries, type InstallableDepDataLike } from './installablesRegistry';
import { summarizeInstallables } from './installablesSummary';
import type { MachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';

const entries = getInstallablesRegistryEntries({ projectedInstallables: [
    { id: 'one', key: 'one', capabilityId: 'dep.one', sourceKind: 'manual_only', display: { name: 'One' },
        defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: 'off' }, experimental: false },
    { id: 'two', key: 'two', capabilityId: 'dep.two', sourceKind: 'manual_only', display: { name: 'Two' },
        defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: 'off' }, experimental: false },
] });
const dep = (installed: boolean, runtimeState?: InstallableDepDataLike['runtimeState']) => ({
    ok: true as const, checkedAt: 1, data: { installed, installedVersion: null, sourceKind: 'system',
        lastInstallLogPath: null, lastBackgroundUpdateCheckAtMs: null, ...(runtimeState ? { runtimeState } : {}) },
});
const loaded = (results: MachineCapabilitiesCacheState & { status: 'loaded' }) => results;

describe('held installables summary', () => {
    it('distinguishes unobserved, pending, failed, incomplete and an observed empty inventory', () => {
        expect(summarizeInstallables(entries, null)).toEqual({ status: 'unknown' });
        expect(summarizeInstallables(entries, { status: 'loading' })).toEqual({ status: 'loading' });
        expect(summarizeInstallables(entries, { status: 'error' })).toEqual({ status: 'unavailable' });
        expect(summarizeInstallables(entries, { status: 'not-supported' })).toEqual({ status: 'unavailable' });
        const empty = loaded({ status: 'loaded', snapshot: { response: { protocolVersion: 1, results: {} } } });
        expect(summarizeInstallables(entries, empty)).toEqual({ status: 'unknown' });
        expect(summarizeInstallables([], empty)).toEqual({ status: 'ready', installed: 0, ready: 0, held: false });
        const missing = loaded({ status: 'loaded', snapshot: { response: { protocolVersion: 1,
            results: { 'dep.one': { ok: true, checkedAt: 1, data: {} }, 'dep.two': dep(false) } } } });
        expect(summarizeInstallables(entries, missing)).toEqual({ status: 'unknown' });
        expect(summarizeInstallables(entries, { status: 'loading', snapshot: missing.snapshot })).toEqual({ status: 'loading' });
        expect(summarizeInstallables(entries, { status: 'error', snapshot: missing.snapshot })).toEqual({ status: 'unavailable' });
    });

    it('counts installed and ready separately using each real registry entry, and retains held facts on refresh failure', () => {
        const state = loaded({ status: 'loaded', snapshot: { response: { protocolVersion: 1,
            results: { 'dep.one': dep(true), 'dep.two': dep(true, 'downloading') },
        } } });
        expect(summarizeInstallables(entries, state)).toEqual({ status: 'ready', installed: 2, ready: 1, held: false });
        expect(summarizeInstallables(entries, { status: 'loading', snapshot: state.snapshot }))
            .toEqual({ status: 'ready', installed: 2, ready: 1, held: true });
        expect(summarizeInstallables(entries, { status: 'error', snapshot: state.snapshot }))
            .toEqual({ status: 'ready', installed: 2, ready: 1, held: true });
        state.snapshot.response.results['dep.two'] = dep(false);
        expect(summarizeInstallables(entries, state)).toEqual({ status: 'ready', installed: 1, ready: 1, held: false });
        state.snapshot.response.results['dep.two'] = { ok: false, checkedAt: 1, error: { message: 'failed' } };
        expect(summarizeInstallables(entries, state)).toEqual({ status: 'unavailable' });
        delete state.snapshot.response.results['dep.one'];
        expect(summarizeInstallables(entries, state)).toEqual({ status: 'unavailable' });
    });
});

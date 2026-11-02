import { describe, expect, it } from 'vitest';

import type { ComputerProviderSettingsRow } from '@/sync/domains/computer/computerProviderSettings';

import { resolveComputerProviderRowState } from './computerProviderRowState';

const row = (overrides: Partial<ComputerProviderSettingsRow> = {}): ComputerProviderSettingsRow => ({
    provider: 'agent-desktop', enabled: false, isDefault: false, availability: 'not_installed', ...overrides,
});
const idle = { phase: 'idle' } as const;

describe('computer provider row state', () => {
    it('says what turning a provider on does, and keeps the installed state quiet', () => {
        expect(resolveComputerProviderRowState({ row: row(), mutation: idle, online: true }))
            .toMatchObject({ status: { kind: 'installsOnEnable', tone: 'quiet', busy: false }, action: null, toggle: { value: false, disabled: false } });
        expect(resolveComputerProviderRowState({ row: row({ enabled: true, availability: 'ready' }), mutation: idle, online: true }))
            .toMatchObject({ status: { kind: 'installed', tone: 'quiet' }, action: 'makeDefault', toggle: { value: true, disabled: false, lockedReason: null } });
    });

    it('shows installing on the row being installed, with the switch already on', () => {
        const state = resolveComputerProviderRowState({ row: row(), mutation: { phase: 'installing', provider: 'agent-desktop' }, online: true });
        expect(state).toMatchObject({ status: { kind: 'installing', busy: true }, action: null, toggle: { value: true } });
        const other = resolveComputerProviderRowState({ row: row({ provider: 'cua', enabled: true, isDefault: true, availability: 'ready' }),
            mutation: { phase: 'installing', provider: 'agent-desktop' }, online: true });
        expect(other.status.kind).toBe('installed');
        expect(resolveComputerProviderRowState({ row: row({ availability: 'installing' }), mutation: idle, online: true }).status.kind).toBe('installing');
    });

    it('puts a failed install on its own row with a retry the person can see', () => {
        const failed = { phase: 'failed', errorCode: 'install_failed', error: 'checksum mismatch', provider: 'agent-desktop' } as const;
        expect(resolveComputerProviderRowState({ row: row(), mutation: failed, online: true }))
            .toMatchObject({ status: { kind: 'failed', tone: 'bad' }, action: 'retry', toggle: { value: false, disabled: false } });
        expect(resolveComputerProviderRowState({ row: row({ provider: 'cua', enabled: true, isDefault: true, availability: 'ready' }), mutation: failed, online: true })
            .status.kind).toBe('installed');
        // A failed save names no provider: no row claims it.
        expect(resolveComputerProviderRowState({ row: row(), mutation: { phase: 'failed', errorCode: 'x', error: 'y' }, online: true }).status.kind)
            .toBe('installsOnEnable');
    });

    it('asks for a repair when an enabled provider is missing its install', () => {
        expect(resolveComputerProviderRowState({ row: row({ enabled: true }), mutation: idle, online: true }))
            .toMatchObject({ status: { kind: 'missing', tone: 'warn' }, action: 'install' });
    });

    it('says a provider is unavailable on this platform and cannot be turned on', () => {
        expect(resolveComputerProviderRowState({ row: row({ availability: 'unavailable' }), mutation: idle, online: true }))
            .toMatchObject({ status: { kind: 'unavailable', tone: 'quiet' }, toggle: { value: false, disabled: true, lockedReason: 'unavailable' } });
        expect(resolveComputerProviderRowState({ row: row({ enabled: true, availability: 'unavailable' }), mutation: idle, online: true }).status.tone)
            .toBe('warn');
    });

    it('keeps the default on with no switch, and turning on waits for the machine to be online', () => {
        expect(resolveComputerProviderRowState({ row: row({ provider: 'cua', enabled: true, isDefault: true, availability: 'ready' }), mutation: idle, online: true }))
            .toMatchObject({ status: { kind: 'installed' }, action: null, toggle: null });
        expect(resolveComputerProviderRowState({ row: row({ availability: 'unknown' }), mutation: idle, online: false }))
            .toMatchObject({ status: { kind: 'none' }, toggle: { value: false, disabled: true, lockedReason: 'offline' } });
        // Turning a provider off, or making it the default, is only a saved preference, so both stay possible offline.
        expect(resolveComputerProviderRowState({ row: row({ enabled: true, availability: 'unknown' }), mutation: idle, online: false }))
            .toMatchObject({ action: 'makeDefault', toggle: { disabled: false } });
    });

    it('offers no next step while a change is saving', () => {
        expect(resolveComputerProviderRowState({ row: row({ enabled: true, availability: 'ready' }), mutation: { phase: 'saving' }, online: true }).action)
            .toBeNull();
    });
});

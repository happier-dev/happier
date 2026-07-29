import { describe, expect, it } from 'vitest';

import { resolveProviderSettingsTargetMachine } from './targetMachine';

describe('resolveProviderSettingsTargetMachine', () => {
    it('prefers the active non-revoked machine on the active server', () => {
        expect(resolveProviderSettingsTargetMachine({
            serverId: 'server-a',
            machines: [
                { id: 'machine-a', active: false, revokedAt: null },
                { id: 'machine-b', active: true, revokedAt: null },
            ],
            machineListByServerId: {
                'server-a': [
                    { id: 'machine-a', active: false, revokedAt: null },
                    { id: 'machine-b', active: true, revokedAt: null },
                ],
            },
        })).toBe('machine-b');
    });

    it('never selects a revoked or other-server machine', () => {
        expect(resolveProviderSettingsTargetMachine({
            serverId: 'server-a',
            machines: [{ id: 'other', active: true, revokedAt: null }],
            machineListByServerId: {
                'server-a': [{ id: 'revoked', active: true, revokedAt: 1 }],
                'server-b': [{ id: 'other', active: true, revokedAt: null }],
            },
        })).toBeNull();
    });

    it('keeps an explicit eligible machine selection instead of snapping back to the active machine', () => {
        expect(resolveProviderSettingsTargetMachine({
            serverId: 'server-a',
            preferredMachineId: 'machine-a',
            machines: [],
            machineListByServerId: {
                'server-a': [
                    { id: 'machine-a', active: false, revokedAt: null },
                    { id: 'machine-b', active: true, revokedAt: null },
                ],
            },
        })).toBe('machine-a');
    });
});

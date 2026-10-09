import { describe, expect, it } from 'vitest';

import { resolveNewSessionFolderChipState } from './newSessionFolderChipState';

describe('resolveNewSessionFolderChipState', () => {
    it('uses the shared Session home label in the ordinary chip, including an unavailable machine', () => {
        const input = { directoryKind: 'path' as const, selectedPath: '~\\', machineHomeDir: 'C:\\Users\\alice\\',
            machineUnavailableReason: null };
        expect(resolveNewSessionFolderChipState(input)).toEqual({ kind: 'folder', path: 'No folder' });
        expect(resolveNewSessionFolderChipState({ ...input, machineUnavailableReason: 'Offline' }))
            .toEqual({ kind: 'machine_unavailable', label: { kind: 'folder', path: 'No folder' }, reason: 'Offline' });
        expect(resolveNewSessionFolderChipState({ ...input, selectedPath: 'C:\\Users\\alice2' }))
            .toEqual({ kind: 'folder', path: 'C:\\Users\\alice2' });
    });

    it('shows the folder, or no folder, from the directory intent', () => {
        expect(resolveNewSessionFolderChipState({ directoryKind: 'path', selectedPath: '~/code/happier', machineUnavailableReason: null }))
            .toEqual({ kind: 'folder', path: '~/code/happier' });
        expect(resolveNewSessionFolderChipState({ directoryKind: 'managed', selectedPath: '', machineUnavailableReason: null }))
            .toEqual({ kind: 'none' });
    });

    it('is resolving, never “no folder”, while a folder intent has no path yet', () => {
        expect(resolveNewSessionFolderChipState({ directoryKind: 'path', selectedPath: '  ', machineUnavailableReason: null }))
            .toEqual({ kind: 'resolving', lastKnownPath: null });
    });

    it('keeps the current value, and the machine’s reason, while the machine is unavailable', () => {
        expect(resolveNewSessionFolderChipState({ directoryKind: 'path', selectedPath: '~/repo', machineUnavailableReason: 'Offline' }))
            .toEqual({ kind: 'machine_unavailable', label: { kind: 'folder', path: '~/repo' }, reason: 'Offline' });
        expect(resolveNewSessionFolderChipState({ directoryKind: 'managed', selectedPath: '', machineUnavailableReason: 'Offline' }))
            .toEqual({ kind: 'machine_unavailable', label: { kind: 'none' }, reason: 'Offline' });
    });
});

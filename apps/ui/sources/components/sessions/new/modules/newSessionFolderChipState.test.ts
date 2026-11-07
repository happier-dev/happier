import { describe, expect, it } from 'vitest';

import { resolveNewSessionFolderChipState } from './newSessionFolderChipState';

describe('resolveNewSessionFolderChipState', () => {
    it('stops loading after a failed directory read without overriding an explicit folder or No folder', () => {
        const input = { directoryKind: 'path' as const, selectedPath: '', machineUnavailableReason: null,
            directoryReadFailure: 'Could not check your folders' };
        expect(resolveNewSessionFolderChipState(input)).toEqual({ kind: 'failed', reason: input.directoryReadFailure });
        expect(resolveNewSessionFolderChipState({ ...input, selectedPath: '/chosen' }))
            .toEqual({ kind: 'folder', path: '/chosen' });
        expect(resolveNewSessionFolderChipState({ ...input, directoryKind: 'managed' }))
            .toEqual({ kind: 'none' });
    });

    it('keeps the last-known folder while the selected Machine is resolving, then uses its current folder', () => {
        const input = { directoryKind: 'path' as const, selectedPath: '', lastKnownPath: '/Users/alice/repo',
            machineHomeDir: '/Users/alice', machineUnavailableReason: null };
        expect(resolveNewSessionFolderChipState(input)).toEqual({ kind: 'resolving', lastKnownPath: '~/repo' });
        expect(resolveNewSessionFolderChipState({ ...input, machineUnavailableReason: 'Checking machine' }))
            .toEqual({ kind: 'machine_unavailable', label: { kind: 'folder', path: '~/repo' }, reason: 'Checking machine' });
        expect(resolveNewSessionFolderChipState({ ...input, selectedPath: '/Users/alice/new' }))
            .toEqual({ kind: 'folder', path: '~/new' });
        expect(resolveNewSessionFolderChipState({ ...input, directoryKind: 'managed' }))
            .toEqual({ kind: 'none' });
    });
    it('shows ~ for the machine home in the ordinary chip, including an unavailable machine', () => {
        const input = { directoryKind: 'path' as const, selectedPath: '~\\', machineHomeDir: 'C:\\Users\\alice\\',
            machineUnavailableReason: null };
        expect(resolveNewSessionFolderChipState(input)).toEqual({ kind: 'folder', path: '~' });
        expect(resolveNewSessionFolderChipState({ ...input, machineUnavailableReason: 'Offline' }))
            .toEqual({ kind: 'machine_unavailable', label: { kind: 'folder', path: '~' }, reason: 'Offline' });
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

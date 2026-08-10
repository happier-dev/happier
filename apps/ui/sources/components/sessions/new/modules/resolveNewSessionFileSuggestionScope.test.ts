import { describe, expect, it } from 'vitest';

import { resolveNewSessionFileSuggestionScope } from './resolveNewSessionFileSuggestionScope';

describe('resolveNewSessionFileSuggestionScope', () => {
    it('expands a home-relative selection against the machine home directory', () => {
        expect(resolveNewSessionFileSuggestionScope({
            targetServerId: 'server-1',
            selectedMachineId: 'machine-1',
            selectedMachineHomeDir: '/Users/dev',
            selectedPath: '~/code/app',
        })).toEqual({
            machineId: 'machine-1',
            path: '/Users/dev/code/app',
            serverId: 'server-1',
        });
    });

    it('expands in the machine home directory own separator style', () => {
        expect(resolveNewSessionFileSuggestionScope({
            targetServerId: 'server-1',
            selectedMachineId: 'machine-1',
            selectedMachineHomeDir: 'C:\\Users\\dev',
            selectedPath: '~/code/app',
        })?.path).toBe('C:\\Users\\dev\\code\\app');
    });

    it('passes an already absolute selection through unchanged', () => {
        expect(resolveNewSessionFileSuggestionScope({
            targetServerId: 'server-1',
            selectedMachineId: 'machine-1',
            selectedMachineHomeDir: '/Users/dev',
            selectedPath: '/srv/app',
        })?.path).toBe('/srv/app');
    });

    it('refuses a selection that is still home-relative because no home directory is known', () => {
        // Sending `~/code/app` as a ripgrep cwd does not search the user's home — it searches a
        // directory literally named `~`, or fails. Offering nothing is the honest answer.
        expect(resolveNewSessionFileSuggestionScope({
            targetServerId: 'server-1',
            selectedMachineId: 'machine-1',
            selectedMachineHomeDir: null,
            selectedPath: '~/code/app',
        })).toBeNull();
    });

    it('refuses an incomplete selection instead of searching a partial scope', () => {
        // A scope missing its folder would let the daemon fall back to its OWN working
        // directory, offering files from a tree the user never chose.
        expect(resolveNewSessionFileSuggestionScope({
            targetServerId: 'server-1',
            selectedMachineId: 'machine-1',
            selectedMachineHomeDir: '/Users/dev',
            selectedPath: '   ',
        })).toBeNull();
        expect(resolveNewSessionFileSuggestionScope({
            targetServerId: 'server-1',
            selectedMachineId: null,
            selectedMachineHomeDir: '/Users/dev',
            selectedPath: '/srv/app',
        })).toBeNull();
    });

    it('omits the server only when the host has not resolved one', () => {
        const withServer = resolveNewSessionFileSuggestionScope({
            targetServerId: 'server-1',
            selectedMachineId: 'machine-1',
            selectedPath: '/srv/app',
        });
        const withoutServer = resolveNewSessionFileSuggestionScope({
            targetServerId: null,
            selectedMachineId: 'machine-1',
            selectedPath: '/srv/app',
        });

        // A machine id is only unique within the server that issued it, so the server is part
        // of the address whenever the host knows it.
        expect(withServer?.serverId).toBe('server-1');
        expect(withoutServer && 'serverId' in withoutServer).toBe(false);
    });
});

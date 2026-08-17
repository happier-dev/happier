import { describe, expect, it } from 'vitest';

import { resolveNewSessionFileSuggestionScope } from '@/components/sessions/new/modules/resolveNewSessionFileSuggestionScope';

/**
 * The new-session composer's file search is addressed by the machine and folder the user just
 * picked, so this module is the counterpart of `resolveWorkspaceTargetForSession`. Both of its
 * decisions fail silently if they regress — an `@` picker that offers the wrong tree, or none
 * at all, looks exactly like "no files matched" — so both are pinned here rather than left to
 * the screen model that consumes it.
 */
describe('resolveNewSessionFileSuggestionScope', () => {
    const BASE = {
        targetServerId: 'server-a',
        selectedMachineId: 'machine-1',
        selectedMachineHomeDir: '/Users/dev',
    } as const;

    /**
     * `selectedPath` is display state and is routinely home-relative. A machine RPC cwd is
     * passed to ripgrep verbatim, so a literal `~` would address a directory actually named
     * `~` — the search would silently return nothing rather than the user's project.
     */
    it('expands a home-relative folder against the machine home directory', () => {
        expect(resolveNewSessionFileSuggestionScope({ ...BASE, selectedPath: '~/code/app' })).toEqual({
            serverId: 'server-a',
            machineId: 'machine-1',
            rootPath: '/Users/dev/code/app',
        });
    });

    /**
     * Without a home directory there is nothing to expand against, and a still-`~` path must
     * not be shipped to the daemon. This is the arm a machine that has not reported its
     * metadata yet lands in.
     */
    it('searches nothing when a home-relative folder cannot be expanded', () => {
        expect(resolveNewSessionFileSuggestionScope({
            ...BASE,
            selectedMachineHomeDir: null,
            selectedPath: '~/code/app',
        })).toBeNull();

        // `~alice` is another user's home and is deliberately not expanded by the path owner.
        expect(resolveNewSessionFileSuggestionScope({ ...BASE, selectedPath: '~alice/code' })).toBeNull();
    });

    /**
     * A partial address must fail closed. Passing one through would send ripgrep no usable
     * `cwd`, and the daemon would then search its OWN working directory and offer the user
     * files from an unrelated tree — a wrong answer, not a narrower one.
     */
    it('searches nothing when the address is incomplete', () => {
        expect(resolveNewSessionFileSuggestionScope({ ...BASE, selectedPath: null })).toBeNull();
        expect(resolveNewSessionFileSuggestionScope({ ...BASE, selectedPath: '   ' })).toBeNull();
        expect(resolveNewSessionFileSuggestionScope({ ...BASE, selectedMachineId: '', selectedPath: '/repo' })).toBeNull();
        expect(resolveNewSessionFileSuggestionScope({ ...BASE, targetServerId: null, selectedPath: '/repo' })).toBeNull();
    });

    /**
     * The scope is the file index's identity, so it must be normalized here and not merely at
     * the search boundary: a trailing separator or a repeated slash is spelling, and a
     * new-session composer on a folder must land on the same index an existing session there
     * already built.
     */
    it('normalizes the folder so spelling does not fork the index', () => {
        const canonical = resolveNewSessionFileSuggestionScope({ ...BASE, selectedPath: '/repo/app' });

        expect(canonical).toEqual({ serverId: 'server-a', machineId: 'machine-1', rootPath: '/repo/app' });
        expect(resolveNewSessionFileSuggestionScope({ ...BASE, selectedPath: '/repo/app/' })).toEqual(canonical);
        expect(resolveNewSessionFileSuggestionScope({ ...BASE, selectedPath: ' /repo//app ' })).toEqual(canonical);
    });

    /** Windows is first class: the home separator decides the expansion, not the host's. */
    it('expands and normalizes a Windows home-relative folder', () => {
        expect(resolveNewSessionFileSuggestionScope({
            ...BASE,
            selectedMachineHomeDir: 'C:\\Users\\dev',
            selectedPath: '~/code/app',
        })).toEqual({
            serverId: 'server-a',
            machineId: 'machine-1',
            rootPath: 'c:/users/dev/code/app',
        });
    });
});

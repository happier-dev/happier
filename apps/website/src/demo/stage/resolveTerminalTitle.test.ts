import { describe, expect, it } from 'vitest';
import { resolveTerminalTitle } from './resolveTerminalTitle';
import { scenarios } from '../scenarios';

describe('resolveTerminalTitle', () => {
    it('uses the active terminal command instead of hardcoding Claude', () => {
        const attachBeat = scenarios.remoteLaunch.beats.find(
            (beat) => beat.id === 'attach-terminal',
        );

        expect(resolveTerminalTitle(attachBeat, 'OpenCode attach')).toContain(
            'happier attach s-opencode-auth',
        );
    });

    it('keeps direct sessions truthful when the user started a provider CLI outside Happier', () => {
        const firstBeat = scenarios.directSessions.beats[0];

        // The scenario showcases an external provider session being adopted —
        // the terminal command must be the bare CLI name (codex, claude,
        // etc.), never the `happier <provider>` wrapper.
        expect(resolveTerminalTitle(firstBeat, 'auth-flow')).toContain('codex');
        expect(resolveTerminalTitle(firstBeat, 'auth-flow')).not.toContain('happier codex');
    });
});

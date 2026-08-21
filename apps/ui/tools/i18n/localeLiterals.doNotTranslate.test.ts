import { describe, expect, it } from 'vitest';

import { isDoNotTranslate } from './localeLiterals';

/**
 * `isDoNotTranslate` decides what is never offered for translation. Withholding a real command is
 * essential — a localised `happier connect <code>` is a command that does not run. But the rule
 * that recognises a command line used to accept any run of lowercase word-ish tokens, which is
 * exactly the shape of the prose fragments that sit either side of a `${...}` hole: "ready for
 * review", "just now", "m ago", " configured in Happier". Those were withheld from every locale and
 * therefore still render in English in all of them.
 *
 * A command line is distinguishable from prose: it starts with an executable, or carries a token no
 * sentence would contain (a flag, a path, a package spec, a <placeholder>) — and it does not read
 * like a sentence.
 */
describe('isDoNotTranslate', () => {
    it('withholds real commands and code', () => {
        for (const command of [
            'npx -y @modelcontextprotocol/server-playwright',
            'happier connect ',
            'happier daemon status',
            'claude setup-token',
            'git rebase --continue',
            'ssh user@host',
            '--force',
            'https://example.com/docs',
            '~/.happier/uploads',
            'src/new-file.ts',
        ]) {
            expect(isDoNotTranslate(command), command).toBe(true);
        }
    });

    it('offers prose fragments that merely look lowercase and terse', () => {
        for (const prose of [
            ' configured in Happier',
            'ready for review',
            'action required',
            'permission required',
            'just now',
            'm ago',
            'not connected',
            'needs re-auth',
            'this machine',
            'any machine',
            'local time',
            'daily at midnight',
            'on Monday at 9 AM',
            ' messages selected',
            'tmux is not detected on this machine. Install tmux and refresh detection.',
        ]) {
            expect(isDoNotTranslate(prose), prose).toBe(false);
        }
    });

    it('still withholds pure glue and empty fragments', () => {
        for (const glue of ['', '   ', ' · ', '%', '…', '(', ' - ']) {
            expect(isDoNotTranslate(glue), JSON.stringify(glue)).toBe(true);
        }
    });
});

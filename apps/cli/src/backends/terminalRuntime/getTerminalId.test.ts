import { describe, expect, it } from 'vitest';

import { getTerminalId } from './getTerminalId';

describe('getTerminalId', () => {
    it('derives terminal ids from supported environment fallbacks when no tty path is available', () => {
        expect(
            getTerminalId({
                env: { KITTY_WINDOW_ID: '42' } as NodeJS.ProcessEnv,
                isStdinTty: false,
            }),
        ).toBe('kitty-42');
        expect(
            getTerminalId({
                env: { TMUX_PANE: '%7' } as NodeJS.ProcessEnv,
                isStdinTty: false,
            }),
        ).toBe('tmux-%7');
        expect(
            getTerminalId({
                env: { TERM_SESSION_ID: 'w0t1p0:ABC' } as NodeJS.ProcessEnv,
                isStdinTty: false,
            }),
        ).toBe('apple-w0t1p0:ABC');
    });

    it('normalizes tty device paths into stable terminal ids', () => {
        expect(
            getTerminalId({
                env: {} as NodeJS.ProcessEnv,
                isStdinTty: true,
                resolveTtyPath: () => '/dev/pts/3',
            }),
        ).toBe('pts-3');
    });
});

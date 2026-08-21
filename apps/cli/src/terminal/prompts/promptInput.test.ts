import { afterEach, describe, expect, it, vi } from 'vitest';

import { isInteractiveTerminal, resolveInteractiveTerminal } from './promptInput';

describe('resolveInteractiveTerminal', () => {
    it('is interactive when stdin and stdout are both TTYs', () => {
        const hasControllingTty = vi.fn(() => false);

        expect(resolveInteractiveTerminal({
            stdinIsTty: true,
            stdoutIsTty: true,
            platform: 'darwin',
            hasControllingTty,
        })).toBe(true);

        // The cheap check answers it; no need to probe the device.
        expect(hasControllingTty).not.toHaveBeenCalled();
    });

    it('is interactive when stdin is a spent pipe but a controlling terminal is attached', () => {
        // This is the `curl -fsSL … | bash -s -- --run <cmd>` case: the installer
        // hands the CLI an exhausted pipe on stdin, but the user is still sitting
        // at a terminal. `promptInput` already prompts through a freshly-opened
        // /dev/tty here, so refusing to prompt at all is the bug.
        expect(resolveInteractiveTerminal({
            stdinIsTty: false,
            stdoutIsTty: true,
            platform: 'linux',
            hasControllingTty: () => true,
        })).toBe(true);
    });

    it('is interactive when stdout is redirected but a controlling terminal is attached', () => {
        // `happier … > out.txt` still prompts, because the prompt is written to
        // /dev/tty rather than to the redirected stdout.
        expect(resolveInteractiveTerminal({
            stdinIsTty: true,
            stdoutIsTty: false,
            platform: 'darwin',
            hasControllingTty: () => true,
        })).toBe(true);
    });

    it('is not interactive when there is no TTY and no controlling terminal', () => {
        // CI: /dev/tty may exist as a device node but cannot be opened.
        expect(resolveInteractiveTerminal({
            stdinIsTty: false,
            stdoutIsTty: false,
            platform: 'linux',
            hasControllingTty: () => false,
        })).toBe(false);
    });

    it('does not probe for a controlling terminal on Windows', () => {
        const hasControllingTty = vi.fn(() => true);

        expect(resolveInteractiveTerminal({
            stdinIsTty: false,
            stdoutIsTty: true,
            platform: 'win32',
            hasControllingTty,
        })).toBe(false);
        expect(hasControllingTty).not.toHaveBeenCalled();
    });
});

describe('isInteractiveTerminal — a caller saying nobody is watching', () => {
    const previousEnv = process.env.HAPPIER_NONINTERACTIVE;
    const previousStdin = process.stdin.isTTY;
    const previousStdout = process.stdout.isTTY;

    afterEach(() => {
        if (previousEnv === undefined) delete process.env.HAPPIER_NONINTERACTIVE;
        else process.env.HAPPIER_NONINTERACTIVE = previousEnv;
        process.stdin.isTTY = previousStdin;
        process.stdout.isTTY = previousStdout;
    });

    function pretendBothTtys(): void {
        process.stdin.isTTY = true;
        process.stdout.isTTY = true;
    }

    it('refuses to prompt under HAPPIER_NONINTERACTIVE=1 even with a terminal on both ends', () => {
        // The whole point: the terminal is still there. An installer, or
        // `happier setup --yes`, has said that nobody is sitting at it — so a
        // command that asks a question is a command that hangs.
        pretendBothTtys();
        process.env.HAPPIER_NONINTERACTIVE = '1';

        expect(isInteractiveTerminal()).toBe(false);
    });

    it('prompts with the same terminal once nothing claims the run is unattended', () => {
        pretendBothTtys();
        delete process.env.HAPPIER_NONINTERACTIVE;

        expect(isInteractiveTerminal()).toBe(true);
    });

    it('reads only the value the installers set, not any value at all', () => {
        pretendBothTtys();
        process.env.HAPPIER_NONINTERACTIVE = '0';

        expect(isInteractiveTerminal()).toBe(true);
    });
});

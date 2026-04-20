import { readlinkSync, realpathSync } from 'node:fs';

type GetTerminalIdParams = Readonly<{
    env?: NodeJS.ProcessEnv;
    isStdinTty?: boolean;
    resolveTtyPath?: () => string | null;
}>;

function resolveNodeTtyPath(): string | null {
    for (const candidate of ['/proc/self/fd/0', '/dev/fd/0', '/dev/stdin']) {
        try {
            const linked = readlinkSync(candidate);
            if (linked.startsWith('/dev/')) {
                return linked;
            }
        } catch {
            // fall through
        }

        try {
            const resolved = realpathSync(candidate);
            if (resolved.startsWith('/dev/') && resolved !== '/dev/fd/0') {
                return resolved;
            }
        } catch {
            // fall through
        }
    }

    return null;
}

export function getTerminalId(params: GetTerminalIdParams = {}): string | null {
    const env = params.env ?? process.env;
    const isStdinTty = params.isStdinTty ?? process.stdin.isTTY === true;

    if (isStdinTty) {
        const ttyPath = params.resolveTtyPath?.() ?? resolveNodeTtyPath();
        if (ttyPath?.startsWith('/dev/')) {
            return ttyPath.slice(5).replace(/\//g, '-');
        }
    }

    const kittyId = env.KITTY_WINDOW_ID?.trim();
    if (kittyId) return `kitty-${kittyId}`;

    const tmuxPane = env.TMUX_PANE?.trim();
    if (tmuxPane) return `tmux-${tmuxPane}`;

    const terminalSessionId = env.TERM_SESSION_ID?.trim();
    if (terminalSessionId) return `apple-${terminalSessionId}`;

    const wtSession = env.WT_SESSION?.trim();
    if (wtSession) return `wt-${wtSession}`;

    return null;
}

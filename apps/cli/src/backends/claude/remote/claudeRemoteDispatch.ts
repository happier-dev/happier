import { claudeRemote } from '../claudeRemote';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';

import type { EnhancedMode } from '../loop';

type NextMessage = () => Promise<{ message: string; mode: EnhancedMode } | null>;

type ClaudeRemoteDispatchDependencies = Readonly<{
    claudeRemote: typeof claudeRemote;
    claudeRemoteAgentSdk: typeof claudeRemoteAgentSdk;
}>;

function argsContainMcpConfigFlag(args?: string[] | null): boolean {
    const input = args ?? [];
    for (const arg of input) {
        if (arg === '--mcp-config') return true;
        if (typeof arg === 'string' && arg.startsWith('--mcp-config=')) return true;
    }
    return false;
}

export async function claudeRemoteDispatch<T extends { nextMessage: NextMessage }>(
    opts: T,
    deps?: Partial<ClaudeRemoteDispatchDependencies>,
): Promise<void> {
    const first = await opts.nextMessage();
    if (!first) return;

    let usedFirst = false;
    const nextMessage: NextMessage = async () => {
        if (!usedFirst) {
            usedFirst = true;
            return first;
        }
        return opts.nextMessage();
    };

    const runnerOpts = {
        ...opts,
        nextMessage,
    };

    const resolvedLegacy = deps?.claudeRemote ?? claudeRemote;
    const resolvedAgentSdk = deps?.claudeRemoteAgentSdk ?? claudeRemoteAgentSdk;

    // The Agent SDK runner cannot transparently passthrough CLI-only flags like `--mcp-config`.
    // If the user provided `--mcp-config`, route to the legacy runner so the underlying Claude Code
    // CLI sees those flags verbatim.
    if (first.mode.claudeRemoteAgentSdkEnabled === true && !argsContainMcpConfigFlag((opts as any).claudeArgs)) {
        await resolvedAgentSdk(runnerOpts as any);
        return;
    }

    await resolvedLegacy(runnerOpts as any);
}

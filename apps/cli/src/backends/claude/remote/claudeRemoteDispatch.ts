import { claudeRemote } from '../claudeRemote';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';

import type { EnhancedMode } from '../loop';

type NextMessage = () => Promise<{ message: string; mode: EnhancedMode } | null>;

type ClaudeRemoteDispatchDependencies = Readonly<{
    claudeRemote: typeof claudeRemote;
    claudeRemoteAgentSdk: typeof claudeRemoteAgentSdk;
}>;

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

    if (first.mode.claudeRemoteAgentSdkEnabled === true) {
        await resolvedAgentSdk(runnerOpts as any);
        return;
    }

    await resolvedLegacy(runnerOpts as any);
}

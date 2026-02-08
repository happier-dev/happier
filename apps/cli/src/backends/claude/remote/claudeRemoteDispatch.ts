import { claudeRemote } from '../claudeRemote';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';

import type { EnhancedMode } from '../loop';

type NextMessage = () => Promise<{ message: string; mode: EnhancedMode } | null>;

export async function claudeRemoteDispatch<T extends { nextMessage: NextMessage }>(opts: T): Promise<void> {
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

    if (first.mode.claudeRemoteAgentSdkEnabled === true) {
        await claudeRemoteAgentSdk(runnerOpts as any);
        return;
    }

    await claudeRemote(runnerOpts as any);
}

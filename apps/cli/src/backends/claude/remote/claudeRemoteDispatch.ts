import { claudeRemote } from '../claudeRemote';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';

import type { EnhancedMode } from '../loop';

type NextMessage = () => Promise<{ message: string; mode: EnhancedMode } | null>;

type ClaudeRemoteDispatchDependencies = Readonly<{
    claudeRemote: typeof claudeRemote;
    claudeRemoteAgentSdk: typeof claudeRemoteAgentSdk;
}>;

function isClaudeAgentSdkAuthenticationError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const message = (error as { message?: unknown }).message;
    if (typeof message !== 'string') return false;

    // Heuristic matching:
    // - Agent SDK often forwards the underlying API error JSON in the message.
    // - We only use this to decide whether it is safe to fall back to the legacy runner.
    //
    // Keep this conservative: only match known auth/401 indicators.
    if (message.includes('API Error: 401')) return true;
    if (message.includes('"type":"authentication_error"')) return true;
    if (message.includes('OAuth token has expired')) return true;
    if (message.includes('Failed to authenticate')) return true;
    return false;
}

export async function claudeRemoteDispatch<T extends { nextMessage: NextMessage }>(
    opts: T,
    deps?: Partial<ClaudeRemoteDispatchDependencies>,
): Promise<void> {
    const first = await opts.nextMessage();
    if (!first) return;

    let consumedBeyondFirst = false;
    const createNextMessage = (): NextMessage => {
        let usedFirst = false;
        return async () => {
            if (!usedFirst) {
                usedFirst = true;
                return first;
            }
            consumedBeyondFirst = true;
            return opts.nextMessage();
        };
    };

    const resolvedLegacy = deps?.claudeRemote ?? claudeRemote;
    const resolvedAgentSdk = deps?.claudeRemoteAgentSdk ?? claudeRemoteAgentSdk;

    if (first.mode.claudeRemoteAgentSdkEnabled === true) {
        try {
            await resolvedAgentSdk({ ...opts, nextMessage: createNextMessage() } as any);
            return;
        } catch (error) {
            if (!consumedBeyondFirst && isClaudeAgentSdkAuthenticationError(error)) {
                await resolvedLegacy({ ...opts, nextMessage: createNextMessage() } as any);
                return;
            }
            throw error;
        }
    }

    await resolvedLegacy({ ...opts, nextMessage: createNextMessage() } as any);
}

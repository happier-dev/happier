import { claudeRemote } from '../claudeRemote';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';

import type { EnhancedMode } from '../loop';

type NextMessage = () => Promise<{ message: string; mode: EnhancedMode } | null>;

type ClaudeRemoteDispatchDependencies = Readonly<{
    claudeRemote: typeof claudeRemote;
    claudeRemoteAgentSdk: typeof claudeRemoteAgentSdk;
}>;

export type ClaudeRemoteRunnerKind = 'legacy' | 'agentSdk';

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

function isClaudeAgentSdkProcessExitCodeOne(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('Claude Code process exited with code 1');
}

export async function claudeRemoteDispatch<T extends { nextMessage: NextMessage }>(
    opts: T & { onRunnerSelected?: ((runner: ClaudeRemoteRunnerKind) => void) | null },
    deps?: Partial<ClaudeRemoteDispatchDependencies>,
): Promise<void> {
	    const first = await opts.nextMessage();
	    if (!first) return;

	    const bufferedAfterFirst: Array<{ message: string; mode: EnhancedMode }> = [];
	    let didStartSession = false;
	    let didEmitMessage = false;
	    let didEmitAssistantText = false;

	    const originalOnSessionFound = (opts as any).onSessionFound as unknown;
	    const onSessionFound = (...args: any[]) => {
	        didStartSession = true;
	        if (typeof originalOnSessionFound === 'function') {
            originalOnSessionFound(...args);
        }
    };

	    const originalOnMessage = (opts as any).onMessage as unknown;
	    const onMessage = (...args: any[]) => {
	        didEmitMessage = true;
	        const firstArg = args[0];
	        if (firstArg && typeof firstArg === 'object') {
	            const messageType = (firstArg as any).type;
	            const role = (firstArg as any)?.message?.role ?? (firstArg as any)?.role;
	            if (messageType === 'assistant' || role === 'assistant') {
	                const content = (firstArg as any)?.message?.content ?? (firstArg as any)?.content;
	                if (typeof content === 'string') {
	                    if (content.trim().length > 0) didEmitAssistantText = true;
	                } else if (Array.isArray(content)) {
	                    for (const block of content) {
	                        if (!block || typeof block !== 'object') continue;
	                        const blockType = (block as any).type;
	                        if (blockType === 'text' && typeof (block as any).text === 'string' && String((block as any).text).trim().length > 0) {
	                            didEmitAssistantText = true;
	                            break;
	                        }
	                    }
	                }
	            }
	        }
	        if (typeof originalOnMessage === 'function') {
	            (originalOnMessage as any)(...args);
	        }
    };

    const baseOpts = { ...opts, onSessionFound, onMessage };
    const createAgentSdkNextMessage = (): NextMessage => {
        let usedFirst = false;
        return async () => {
            if (!usedFirst) {
                usedFirst = true;
                return first;
            }
            const next = await opts.nextMessage();
            if (next) bufferedAfterFirst.push(next);
            return next;
        };
    };
    const createLegacyReplayNextMessage = (): NextMessage => {
        const replay = [first, ...bufferedAfterFirst];
        let index = 0;
        return async () => {
            if (index < replay.length) {
                const next = replay[index];
                index += 1;
                return next;
            }
            return opts.nextMessage();
        };
    };

    const resolvedLegacy = deps?.claudeRemote ?? claudeRemote;
    const resolvedAgentSdk = deps?.claudeRemoteAgentSdk ?? claudeRemoteAgentSdk;

    // Back-compat: older clients/daemons may not include this provider-scoped flag on the queued prompt.
    // Default is enabled (see provider settings defaults + DEFAULT_CLAUDE_REMOTE_META_STATE).
    if (first.mode.claudeRemoteAgentSdkEnabled !== false) {
        try {
            baseOpts.onRunnerSelected?.('agentSdk');
            await resolvedAgentSdk({ ...baseOpts, nextMessage: createAgentSdkNextMessage() } as any);
            return;
        } catch (error) {
            const shouldFallbackBecauseExitCodeOne = isClaudeAgentSdkProcessExitCodeOne(error);
	            if (
	                (
	                    // Authentication errors are only safe to fall back from when the Agent SDK failed
	                    // before establishing/claiming a session id. Once a session is started, switching
	                    // runners can confuse session metadata and lead to duplicated/invalid resumes.
	                    (!didStartSession && !didEmitMessage && isClaudeAgentSdkAuthenticationError(error))
	                    // Claude Code sometimes exits with status 1 (e.g. resume failures, transient crashes)
	                    // after already emitting a session id, but before producing any assistant messages.
	                    // In that case we still prefer a best-effort fallback so the user isn't stuck.
	                    || (shouldFallbackBecauseExitCodeOne && !didEmitAssistantText)
	                )
	            ) {
	                baseOpts.onRunnerSelected?.('legacy');
	                await resolvedLegacy({ ...baseOpts, nextMessage: createLegacyReplayNextMessage() } as any);
	                return;
            }
            throw error;
        }
    }

    baseOpts.onRunnerSelected?.('legacy');
    await resolvedLegacy({ ...baseOpts, nextMessage: createLegacyReplayNextMessage() } as any);
}

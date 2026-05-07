import { claudeRemote } from '../claudeRemote';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';

import type { EnhancedMode } from '../loop';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import { repairClaudeTranscriptAfterInterrupt } from './agentSdk/repairClaudeTranscriptAfterInterrupt';

type NextMessage = () => Promise<{ message: string; mode: EnhancedMode } | null>;

type ClaudeRemoteDispatchDependencies = Readonly<{
    claudeRemote: typeof claudeRemote;
    claudeRemoteAgentSdk: typeof claudeRemoteAgentSdk;
}>;

type ResumeSessionAtRejectedHandler = (anchor: string) => Promise<void> | void;

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

function isClaudeAgentSdkEarlyExitError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const message = (error as { message?: unknown }).message;
    if (typeof message !== 'string') return false;
    if (message.includes('process exited with code 1')) return true;
    if (message.includes('exited with code 1')) return true;
    return false;
}

function isClaudeAgentSdkExecutableMissingError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const message = (error as { message?: unknown }).message;
    if (typeof message !== 'string') return false;

    if (message.includes('ENOENT')) return true;
    if (message.includes('Claude Code executable not found at')) return true;
    if (message.includes('Failed to spawn Claude Code process: spawn ')) return true;
    return false;
}

function readClaudeRejectedResumeSessionAtAnchor(error: unknown, expectedAnchor: string | null): string | null {
    if (!expectedAnchor) return null;
    if (!error || typeof error !== 'object') return null;

    const message = (error as { message?: unknown }).message;
    if (typeof message !== 'string') return null;

    const match = message.match(/No message found with message\.uuid of:\s*([^\s,.;]+)/);
    const rejectedAnchor = typeof match?.[1] === 'string' ? match[1].trim() : '';
    if (!rejectedAnchor) return null;
    return rejectedAnchor === expectedAnchor ? rejectedAnchor : null;
}

export async function claudeRemoteDispatch<T extends { nextMessage: NextMessage }>(
    opts: T & {
        onResumeSessionAtRejected?: ResumeSessionAtRejectedHandler | null;
        onRunnerSelected?: ((runner: ClaudeRemoteRunnerKind) => void) | null;
        resumeSessionAt?: string | null;
    },
    deps?: Partial<ClaudeRemoteDispatchDependencies>,
): Promise<void> {
    const first = await opts.nextMessage();
    if (!first) return;

    let consumedBeyondFirst = false;
    let didStartSession = false;
    let didEmitMessage = false;

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
        if (typeof originalOnMessage === 'function') {
            originalOnMessage(...args);
        }
    };

    const baseOpts = { ...opts, onSessionFound, onMessage };
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
    const resumeSessionAt =
        typeof opts.resumeSessionAt === 'string' && opts.resumeSessionAt.trim().length > 0
            ? opts.resumeSessionAt.trim()
            : null;

    // Back-compat: older clients/daemons may not include this provider-scoped flag on the queued prompt.
    // Default is enabled (see provider settings defaults + DEFAULT_CLAUDE_REMOTE_META_STATE).
    if (first.mode.claudeRemoteAgentSdkEnabled !== false) {
        let didRetryExecutableMissing = false;
        let didRetryWithoutResumeSessionAt = false;
        let omitResumeSessionAt = false;

        while (true) {
            try {
                baseOpts.onRunnerSelected?.('agentSdk');
                await repairClaudeTranscriptAfterInterrupt({
                    sessionId: (baseOpts as any).sessionId ?? null,
                    transcriptPath: (baseOpts as any).transcriptPath ?? null,
                    workDir: String((baseOpts as any).path ?? '').trim(),
                    claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
                }).catch(() => {});
                await resolvedAgentSdk({
                    ...baseOpts,
                    resumeSessionAt: omitResumeSessionAt ? null : resumeSessionAt,
                    nextMessage: createNextMessage(),
                } as any);
                return;
            } catch (error) {
                const canFallback = !consumedBeyondFirst && !didStartSession && !didEmitMessage;
                const rejectedResumeSessionAt = canFallback && !didRetryWithoutResumeSessionAt
                    ? readClaudeRejectedResumeSessionAtAnchor(error, resumeSessionAt)
                    : null;
                if (rejectedResumeSessionAt) {
                    didRetryWithoutResumeSessionAt = true;
                    omitResumeSessionAt = true;
                    await Promise.resolve(opts.onResumeSessionAtRejected?.(rejectedResumeSessionAt)).catch(() => {});
                    continue;
                }

                const shouldRetryAgentSdk =
                    !didRetryExecutableMissing
                    && canFallback
                    && isClaudeAgentSdkExecutableMissingError(error);

                if (shouldRetryAgentSdk) {
                    didRetryExecutableMissing = true;
                    continue;
                }

                if (canFallback && (isClaudeAgentSdkAuthenticationError(error) || isClaudeAgentSdkEarlyExitError(error))) {
                    baseOpts.onRunnerSelected?.('legacy');
                    await resolvedLegacy({ ...baseOpts, nextMessage: createNextMessage() } as any);
                    return;
                }
                throw error;
            }
        }
    }

    baseOpts.onRunnerSelected?.('legacy');
    await resolvedLegacy({ ...baseOpts, nextMessage: createNextMessage() } as any);
}

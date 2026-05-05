import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import { repairClaudeTranscriptAfterInterrupt } from '@/backends/claude/remote/sdk/agentSdk/repairClaudeTranscriptAfterInterrupt';
import { runClaudeRemoteAgentSdk } from '@/backends/claude/remote/sdk/runAgentSdk';
import type { RunClaudeRemoteAgentSdkOptions } from '@/backends/claude/remote/sdk/runAgentSdkTypes';

type NextMessage = () => Promise<{ message: string; mode: EnhancedMode } | null>;

type ClaudeRemoteDispatchDependencies = Readonly<{
    runClaudeRemoteAgentSdk: typeof runClaudeRemoteAgentSdk;
}>;

type ResumeSessionAtRejectedHandler = (anchor: string) => Promise<void> | void;

export type ClaudeRemoteRunnerKind = 'agentSdk';

type ClaudeRemoteDispatchOptions<TExtra extends object = object> = RunClaudeRemoteAgentSdkOptions &
    TExtra &
    Readonly<{
        onResumeSessionAtRejected?: ResumeSessionAtRejectedHandler | null;
        onRunnerSelected?: ((runner: ClaudeRemoteRunnerKind) => void) | null;
    }>;

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

export async function dispatchClaudeRemoteSession<TExtra extends object>(
    opts: ClaudeRemoteDispatchOptions<TExtra>,
    deps?: Partial<ClaudeRemoteDispatchDependencies>,
): Promise<void> {
    const first = await opts.nextMessage();
    if (!first) return;
    let consumedBeyondFirst = false;
    let didStartSession = false;
    let didEmitMessage = false;
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

    const resolvedAgentSdk = deps?.runClaudeRemoteAgentSdk ?? runClaudeRemoteAgentSdk;
    const resumeSessionAt =
        typeof opts.resumeSessionAt === 'string' && opts.resumeSessionAt.trim().length > 0
            ? opts.resumeSessionAt.trim()
            : null;

    // The canonical Claude remote entrypoint now always uses the Agent SDK runner.
    // The provider-specific enablement flag is still carried on the queued prompt for
    // downstream behavior, but it no longer switches the dispatcher between two live owners.
    let didRetryWithoutResumeSessionAt = false;
    let omitResumeSessionAt = false;

    while (true) {
        try {
            opts.onRunnerSelected?.('agentSdk');
            await repairClaudeTranscriptAfterInterrupt({
                sessionId: opts.sessionId,
                transcriptPath: opts.transcriptPath,
                workDir: opts.path.trim(),
                claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
            }).catch(() => {});
            const onSessionFound: RunClaudeRemoteAgentSdkOptions['onSessionFound'] = (...args) => {
                didStartSession = true;
                return opts.onSessionFound(...args);
            };
            const onMessage: RunClaudeRemoteAgentSdkOptions['onMessage'] = (...args) => {
                didEmitMessage = true;
                return opts.onMessage(...args);
            };
            await resolvedAgentSdk({
                ...opts,
                resumeSessionAt: omitResumeSessionAt ? null : resumeSessionAt,
                nextMessage: createNextMessage(),
                onSessionFound,
                onMessage,
            });
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

            throw error;
        }
    }
}

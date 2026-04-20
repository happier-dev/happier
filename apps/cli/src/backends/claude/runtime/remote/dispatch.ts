import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import { repairClaudeTranscriptAfterInterrupt } from '@/backends/claude/remote/sdk/agentSdk/repairClaudeTranscriptAfterInterrupt';
import { runClaudeRemoteAgentSdk } from '@/backends/claude/remote/sdk/runAgentSdk';

type NextMessage = () => Promise<{ message: string; mode: EnhancedMode } | null>;

type ClaudeRemoteDispatchDependencies = Readonly<{
    runClaudeRemoteAgentSdk: typeof runClaudeRemoteAgentSdk;
}>;

export type ClaudeRemoteRunnerKind = 'agentSdk';

export async function dispatchClaudeRemoteSession<T extends { nextMessage: NextMessage }>(
    opts: T & { onRunnerSelected?: ((runner: ClaudeRemoteRunnerKind) => void) | null },
    deps?: Partial<ClaudeRemoteDispatchDependencies>,
): Promise<void> {
    const first = await opts.nextMessage();
    if (!first) return;
    const createNextMessage = (): NextMessage => {
        let usedFirst = false;
        return async () => {
            if (!usedFirst) {
                usedFirst = true;
                return first;
            }
            return opts.nextMessage();
        };
    };

    const resolvedAgentSdk = deps?.runClaudeRemoteAgentSdk ?? runClaudeRemoteAgentSdk;

    // The canonical Claude remote entrypoint now always uses the Agent SDK runner.
    // The provider-specific enablement flag is still carried on the queued prompt for
    // downstream behavior, but it no longer switches the dispatcher between two live owners.
    opts.onRunnerSelected?.('agentSdk');
    await repairClaudeTranscriptAfterInterrupt({
        sessionId: (opts as any).sessionId ?? null,
        transcriptPath: (opts as any).transcriptPath ?? null,
        workDir: String((opts as any).path ?? '').trim(),
        claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
    }).catch(() => {});
    await resolvedAgentSdk({ ...opts, nextMessage: createNextMessage() } as any);
}

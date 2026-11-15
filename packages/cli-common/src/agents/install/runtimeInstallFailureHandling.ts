import type { InstallAgentCliResult, AgentCliInstallPlan } from '../install.js';
import type { RuntimeInstallLifecycleContext } from './runtimeInstallLifecycleContext.js';
import { AgentCliDownloadError } from '../downloadGitHubReleaseAsset.js';
import { ExecFileTerminationError } from '../../process/index.js';
import { ArchiveExpandedByteLimitError, ArchiveExtractionTimeoutError } from '@happier-dev/release-runtime/archiveExtraction';
import { GitHubReleaseRateLimitError } from '@happier-dev/release-runtime/github';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

type RuntimeInstallFailureErrorCode = 'archive-expanded-byte-limit' | 'managed-runtime-unavailable' | 'command-failed' | 'command-timed-out' | 'termination-failed' | AgentCliDownloadError['errorCode'];

function resolveRuntimeInstallFailureMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function classifyRuntimeInstallFailureErrorCode(error: unknown, message: string): RuntimeInstallFailureErrorCode {
    if (error instanceof ArchiveExpandedByteLimitError) return error.code;
    if (error instanceof AgentCliDownloadError) return error.errorCode;
    if (error instanceof GitHubReleaseRateLimitError) return 'rate-limited';
    if (error instanceof ExecFileTerminationError) return 'termination-failed';
    if (error instanceof ArchiveExtractionTimeoutError) return 'command-timed-out';
    if (
        message.startsWith('Managed pnpm is unavailable') ||
        message.startsWith('Managed JavaScript runtime is unavailable')
    ) {
        return 'managed-runtime-unavailable';
    }
    return 'command-failed';
}

export function buildRuntimeInstallFailureResult(params: Readonly<{
    error: unknown;
    plan: AgentCliInstallPlan;
    lifecycleContext: RuntimeInstallLifecycleContext;
}>): InstallAgentCliResult {
    const errorMessage = resolveRuntimeInstallFailureMessage(params.error);
    const errorCode = classifyRuntimeInstallFailureErrorCode(params.error, errorMessage);
    params.lifecycleContext.appendLogLine(params.lifecycleContext.logPath, errorMessage);
    return {
        ok: false,
        errorCode,
        errorMessage,
        // The download wrapper owns the broad outcome; its cause owns the
        // transport diagnosis (DNS, timeout, HTTP), rather than "download-failed".
        ...(errorCode === 'download-failed' ? { failureCause: projectActionFailureCauseV1(
            params.error instanceof AgentCliDownloadError ? params.error.cause ?? params.error : params.error,
            'agent.install.download', { allowUnknownErrorCode: false },
        ) } : {}),
        plan: params.plan,
        logPath: params.lifecycleContext.logPath,
    };
}

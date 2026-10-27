import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import { ProviderCliNotFoundError } from '@/runtime/managedTools/requireProviderCliCommand';
import { logger } from '@/ui/logger';

type SurfaceSession = NonNullable<Parameters<typeof surfacePrimarySessionRuntimeIssue>[0]['session']>
    & Readonly<{ getLastObservedMessageSeq?: () => number | null }>;

/**
 * A missing codex CLI is a permanent environmental failure, not a transient turn error.
 * Surfaces it as a session-owned failed turn with remediation so the session records the
 * failure instead of idling with blocked pending input. Returns whether the error was a
 * missing-CLI failure (surfaced); all other errors are left to their existing handling.
 */
export async function surfaceMissingCodexCliIssue(params: Readonly<{
    session: SurfaceSession;
    error: unknown;
}>): Promise<boolean> {
    if (!(params.error instanceof ProviderCliNotFoundError)) return false;
    await surfacePrimarySessionRuntimeIssue({
        provider: 'codex',
        session: params.session,
        sessionSeq: params.session.getLastObservedMessageSeq?.() ?? undefined,
        cause: 'status_error',
        error: params.error,
        allocateTurnWhenIdle: true,
        // The same launch failure surfaces from multiple layers (runtime startOrLoad,
        // resume-fallback retries, strict-resume reporting); reuse the failed turn
        // instead of allocating a duplicate session-owned turn for each surface.
        suppressUntrustedDuplicate: true,
    }).catch((surfaceError) => {
        logger.debug('[codex] Failed to surface missing-CLI session issue (non-fatal)', surfaceError);
    });
    return true;
}

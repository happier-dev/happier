import type { BackendCommandRunResult } from '@happier-dev/plugin-sdk/scm/backend';
import { logger } from '@/ui/logger';

/** Host execution facts; these do not change the public backend result contract. */
export type ScmExecResult = BackendCommandRunResult & Readonly<{
    signal?: string;
    aborted?: boolean;
    commandKind?: string;
    elapsedMs?: number;
}>;

export function observeScmCommandResult(
    input: Readonly<{ bin: string; args: readonly string[] }>,
    result: ScmExecResult,
    startedAt: number,
): ScmExecResult {
    // The first argument identifies the command, never log paths, operands, stdin or environment.
    const commandKind = input.args[0]?.startsWith('-') ? 'option-prefixed' : input.args[0] ?? 'default';
    const elapsedMs = Math.max(0, performance.now() - startedAt);
    const observed = { ...result, commandKind, elapsedMs };
    if (result.success || (!result.timedOut && !result.signal && !result.aborted)) return observed;
    const cause = { bin: input.bin, commandKind, elapsedMs, exitCode: result.exitCode,
        signal: result.signal ?? null, timedOut: result.timedOut === true, aborted: result.aborted === true };
    logger.warnLocalFile('[SCM] Command failed', cause);
    const termination = result.timedOut ? 'timed out' : result.aborted ? 'was aborted' : `was terminated by ${result.signal}`;
    return { ...observed, stderr: result.stderr || `SCM ${commandKind} ${termination} (exit ${result.exitCode}, ${Math.round(elapsedMs)} ms)` };
}

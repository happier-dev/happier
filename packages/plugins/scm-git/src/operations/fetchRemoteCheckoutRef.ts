import type { ScmRemoteResponse, ScmWorkingSnapshot } from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES, normalizeScmOperationOutcome } from '@happier-dev/plugin-sdk/scm';
import type { ScmBackendContext } from '../types.js';
import { getScmCommandIndeterminateErrorCode, runScmCommand } from '../runtime.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { mapGitErrorCode } from '../remote.js';

function validateFetchRemoteName(remoteName: string): { ok: true } | { ok: false; error: string } {
    if (!remoteName.trim()) return { ok: false, error: 'Remote checkout requires a configured remote' };
    if (
        remoteName !== remoteName.trim()
        || remoteName.startsWith('-')
        || /[\s\0-\x1f\x7f:/\\]/.test(remoteName)
        || remoteName.includes('..')
        || remoteName.includes('@{')
        || remoteName === '.'
    ) {
        return { ok: false, error: 'Remote checkout remote name contains unsupported syntax' };
    }
    return { ok: true };
}

function validateRemoteCheckoutRef(remoteRef: string): { ok: true } | { ok: false; error: string } {
    if (
        remoteRef !== remoteRef.trim()
        || !remoteRef.startsWith('refs/')
        || remoteRef.startsWith('-')
        || remoteRef.endsWith('/')
        || remoteRef.endsWith('.')
        || /[\s\0-\x1f\x7f:~^?*[\\]/.test(remoteRef)
        || remoteRef.includes('..')
        || remoteRef.includes('@{')
        || remoteRef.split('/').some((segment) => (
            !segment
            || segment === '.'
            || segment === '..'
            || segment.startsWith('.')
            || segment.endsWith('.lock')
        ))
    ) {
        return { ok: false, error: 'Remote checkout ref contains unsupported syntax' };
    }
    return { ok: true };
}

/** Fetch the provider's exact ref through a configured remote; branch refs are never rewritten. */
export async function fetchGitRemoteCheckoutRef(input: Readonly<{
    context: ScmBackendContext;
    snapshot: Pick<ScmWorkingSnapshot, 'repo'>;
    remoteName?: string;
    remoteRef: string;
    signal?: AbortSignal;
}>): Promise<ScmRemoteResponse> {
    const validation = validateRemoteCheckoutRef(input.remoteRef);
    if (!validation.ok) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: validation.error };
    const remoteName = input.remoteName ?? input.snapshot.repo.remotes?.[0]?.name;
    if (!remoteName) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
        error: 'Remote checkout requires a configured remote' };
    const remoteValidation = validateFetchRemoteName(remoteName);
    if (!remoteValidation.ok) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: remoteValidation.error };
    input.signal?.throwIfAborted();
    const fetched = await runScmCommand({
        bin: 'git', cwd: input.context.cwd, args: ['fetch', remoteName, input.remoteRef],
        timeoutMs: 30_000, env: buildScmNonInteractiveEnv(), signal: input.signal,
    });
    input.signal?.throwIfAborted();
    if (fetched.success) return { success: true, stdout: fetched.stdout, stderr: fetched.stderr };
    const unknownCode = getScmCommandIndeterminateErrorCode(fetched);
    const errorCode = unknownCode ?? mapGitErrorCode(fetched.stderr);
    const result = { success: false, errorCode, error: fetched.stderr || 'Remote ref fetch failed' };
    return { ...result, outcome: unknownCode
        ? { v: 1, kind: 'outcome_unknown', errorCode, reconciliation: { kind: 'repository_status', cwd: input.context.cwd }, nextActions: [{ kind: 'refresh' }] }
        : normalizeScmOperationOutcome(result) };
}

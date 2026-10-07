import { SCM_OPERATION_ERROR_CODES, type ScmCommitResolveOutcomeRequest, type ScmCommitResolveOutcomeResponse, type ScmOperationErrorCode } from '@happier-dev/plugin-sdk/scm';

import type { ScmBackendContext } from '../types.js';
import { getScmCommandIndeterminateErrorCode, normalizeCommitRef } from '../runtime.js';
import { runGitCommand } from './commitExecutionRuntime.js';

/** Both immediate recovery and later resolution observe the actual ref history. */
export async function observeGitCommitPublication(input: {
    cwd: string;
    candidateOid: string;
    expectedHeadOid: string | null;
    expectedRef: string | null;
}): Promise<
    | { success: true; state: 'not_published' | 'published' | 'unknown' }
    | { success: false; error: string; errorCode: ScmOperationErrorCode }
> {
    const run = (args: string[]) => runGitCommand({ cwd: input.cwd, args });
    const refuse = (result: Awaited<ReturnType<typeof run>>, fallback: string) => ({
        success: false as const, error: result.stderr || fallback,
        errorCode: getScmCommandIndeterminateErrorCode(result) ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    });
    if (input.expectedRef === null) {
        const symbolic = await run(['symbolic-ref', '-q', 'HEAD']);
        if (symbolic.success) return { success: true, state: 'unknown' };
        if (symbolic.exitCode !== 1 || getScmCommandIndeterminateErrorCode(symbolic)) return refuse(symbolic, 'Could not inspect the detached target');
    }
    const tip = await run(['--no-replace-objects', 'rev-parse', '--verify', `${input.expectedRef ?? 'HEAD'}^{commit}`]);
    if (!tip.success) {
        if (input.expectedHeadOid === null && input.expectedRef !== null) {
            const absent = await run(['show-ref', '--verify', '--quiet', input.expectedRef]);
            if (absent.exitCode === 1 && !getScmCommandIndeterminateErrorCode(absent)) return { success: true, state: 'not_published' };
        }
        return refuse(tip, 'Could not inspect the expected target');
    }
    const tipOid = tip.stdout.trim();
    if (tipOid === input.expectedHeadOid) return { success: true, state: 'not_published' };
    if (tipOid === input.candidateOid) return { success: true, state: 'published' };
    const ancestor = await run(['--no-replace-objects', 'merge-base', '--is-ancestor', input.candidateOid, tipOid]);
    if (ancestor.success) return { success: true, state: 'published' };
    if (ancestor.exitCode !== 1 || getScmCommandIndeterminateErrorCode(ancestor)) return refuse(ancestor, 'Could not inspect the candidate ancestry');
    return { success: true, state: 'unknown' };
}

/** Observe only: an existing object is not evidence that this writer published it. */
export async function gitCommitResolveOutcome(input: {
    context: ScmBackendContext;
    request: ScmCommitResolveOutcomeRequest;
}): Promise<ScmCommitResolveOutcomeResponse> {
    const { context, request } = input;
    const publication: ScmCommitResolveOutcomeResponse['publication'] = {
        state: 'unknown', candidateOid: request.candidateOid,
        expectedHeadOid: request.expectedHeadOid, expectedRef: request.expectedRef,
        // Ref observation cannot prove that the live index was reconciled after publication.
        indexReconciliation: 'pending',
    };
    const refuse = (error: string, errorCode: ScmOperationErrorCode = SCM_OPERATION_ERROR_CODES.INVALID_REQUEST): ScmCommitResolveOutcomeResponse => ({ success: false, publication, error, errorCode });
    const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
    if (!oid.test(request.candidateOid) || (request.expectedHeadOid !== null && !oid.test(request.expectedHeadOid)) ||
        (request.expectedRef !== null && (!request.expectedRef.startsWith('refs/') || !normalizeCommitRef(request.expectedRef).ok))) {
        return refuse('Outcome resolution requires a known commit object, expected parent and full target ref');
    }
    const run = (args: string[]) => runGitCommand({ cwd: context.cwd, args });
    // Raw commit bytes cannot be affected by replacement refs or configured display formatting.
    const object = await run(['--no-replace-objects', 'cat-file', 'commit', request.candidateOid]);
    if (!object.success) return refuse(object.stderr || 'The candidate commit is unavailable', getScmCommandIndeterminateErrorCode(object) ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
    const boundary = object.stdout.indexOf('\n\n');
    if (boundary < 0) return refuse('The candidate commit cannot be inspected');
    const headers = object.stdout.slice(0, boundary).split('\n');
    const candidateTreeOid = headers.find((line) => line.startsWith('tree '))?.slice(5);
    const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
    if (!candidateTreeOid || !oid.test(candidateTreeOid) ||
        (request.expectedHeadOid === null ? parents.length !== 0 : parents.length !== 1 || parents[0] !== request.expectedHeadOid)) {
        return refuse('The candidate does not have the expected parent');
    }
    publication.actualMessage = object.stdout.slice(boundary + 2).replace(/\n$/, '');
    const observed = await observeGitCommitPublication({ cwd: context.cwd, ...request });
    if (!observed.success) return refuse(observed.error, observed.errorCode);
    publication.state = observed.state;
    return { success: true, publication, candidateTreeOid };
}

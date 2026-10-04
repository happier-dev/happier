import { SCM_OPERATION_ERROR_CODES, type ScmCommitResolveOutcomeRequest, type ScmCommitResolveOutcomeResponse, type ScmOperationErrorCode } from '@happier-dev/plugin-sdk/scm';

import type { ScmBackendContext } from '../types.js';
import { getScmCommandIndeterminateErrorCode, normalizeCommitRef } from '../runtime.js';
import { runGitCommand } from './commitExecutionRuntime.js';

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
    const result = (): ScmCommitResolveOutcomeResponse => ({ success: true, publication, candidateTreeOid });
    const ref = request.expectedRef ?? 'HEAD';
    if (request.expectedRef === null) {
        const symbolic = await run(['symbolic-ref', '-q', 'HEAD']);
        if (symbolic.success) return result();
        if (symbolic.exitCode !== 1 || getScmCommandIndeterminateErrorCode(symbolic)) return refuse(symbolic.stderr || 'Could not inspect the detached target', getScmCommandIndeterminateErrorCode(symbolic) ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
    }
    const tip = await run(['--no-replace-objects', 'rev-parse', '--verify', `${ref}^{commit}`]);
    if (!tip.success) {
        if (request.expectedHeadOid === null && request.expectedRef !== null) {
            const absent = await run(['show-ref', '--verify', '--quiet', request.expectedRef]);
            if (absent.exitCode === 1 && !getScmCommandIndeterminateErrorCode(absent)) {
                publication.state = 'not_published';
                return result();
            }
        }
        return refuse(tip.stderr || 'Could not inspect the expected target', getScmCommandIndeterminateErrorCode(tip) ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
    }
    const tipOid = tip.stdout.trim();
    if (tipOid === request.expectedHeadOid) publication.state = 'not_published';
    else if (tipOid === request.candidateOid) publication.state = 'published';
    else {
        const ancestor = await run(['--no-replace-objects', 'merge-base', '--is-ancestor', request.candidateOid, tipOid]);
        if (ancestor.success) publication.state = 'published';
        else if (ancestor.exitCode !== 1 || getScmCommandIndeterminateErrorCode(ancestor)) return refuse(ancestor.stderr || 'Could not inspect the candidate ancestry', getScmCommandIndeterminateErrorCode(ancestor) ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
    }
    return result();
}

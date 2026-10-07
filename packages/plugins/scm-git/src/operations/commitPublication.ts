import { accessSync, constants, closeSync, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { resolveGitIndexPath } from '@happier-dev/cli-common/scm/gitTemporaryIndex';
import { SCM_OPERATION_ERROR_CODES, type ScmCommitCreateRequest, type ScmCommitCreateResponse, type ScmOperationErrorCode } from '@happier-dev/plugin-sdk/scm';

import { getScmCommandIndeterminateErrorCode, type ScmExecResult } from '../runtime.js';
import { mapGitErrorCode } from '../remote.js';
import type { ScmBackendContext } from '../types.js';
import { createGitTemporaryIndex, runGitCommand, type GitTemporaryIndex } from './commitExecutionRuntime.js';
import { readGitStateFile, resolveGitStatePath } from './branchOperationState.js';
import { createGitExecutionFeatureDetector, type GitExecutionFeatures } from '../repository.js';
import { applyValidatedGitPatch } from './applyValidatedGitPatch.js';
import { parseNumStatZ } from '../statusParser.js';
import { observeGitCommitPublication } from './commitOutcome.js';

const COMMIT_STATE_FILES = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'SQUASH_MSG', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'AUTO_MERGE'] as const;
export type GitCommitTarget = Readonly<{ headOid: string | null; ref: string | null; baseTreeOid: string; mergeHeads: readonly string[]; cherryPickOid: string | null; stateFiles: readonly Readonly<{ name: typeof COMMIT_STATE_FILES[number]; content: string | null }>[] }>;

function failure(errorCode: ScmOperationErrorCode, error: string): ScmCommitCreateResponse {
    const needsInput = errorCode === SCM_OPERATION_ERROR_CODES.COMMIT_HEAD_CHANGED || errorCode === SCM_OPERATION_ERROR_CODES.COMMIT_STAGING_CONFLICT || errorCode === SCM_OPERATION_ERROR_CODES.COMMIT_HOOK_CONTENT_CHANGED || errorCode === SCM_OPERATION_ERROR_CODES.SCM_SOURCE_CHANGED;
    return { success: false, errorCode, error, outcome: needsInput
        ? { v: 1, kind: 'needs_input', errorCode, message: error, nextActions: [{ kind: 'refresh' }] }
        : { v: 1, kind: 'failed', errorCode, message: error, nextActions: [{ kind: 'refresh' }] } };
}

export async function captureGitCommitTarget(context: ScmBackendContext, request: ScmCommitCreateRequest): Promise<
    { success: true; target: GitCommitTarget } | { success: false; response: ScmCommitCreateResponse }
> {
    const cwd = context.cwd;
    const run = (args: string[], stdin?: string) => runGitCommand({ cwd, args, stdin });
    const symbolic = await run(['symbolic-ref', '-q', 'HEAD']);
    if (!symbolic.success && symbolic.exitCode !== 1) return { success: false, response: failure(mapGitErrorCode(symbolic.stderr), symbolic.stderr) };
    const ref = symbolic.success ? symbolic.stdout.trim() : null;
    const head = await run(['rev-parse', '--verify', 'HEAD']);
    const headOid: string | null = head.success ? head.stdout.trim() : null;
    if (!head.success) {
        const absent = ref ? await run(['show-ref', '--verify', '--quiet', ref]) : null;
        if (!absent || absent.exitCode !== 1) return { success: false, response: failure(mapGitErrorCode(head.stderr), head.stderr || 'Could not inspect HEAD') };
    }
    if ((request.expectedHeadOid !== undefined && request.expectedHeadOid !== headOid) ||
        (request.expectedRef !== undefined && request.expectedRef !== ref)) {
        return { success: false, response: { ...failure(SCM_OPERATION_ERROR_CODES.COMMIT_HEAD_CHANGED, 'HEAD or its branch changed before commit admission'),
            publication: { state: 'not_published', expectedHeadOid: request.expectedHeadOid === undefined ? headOid : request.expectedHeadOid,
                expectedRef: request.expectedRef === undefined ? ref : request.expectedRef, indexReconciliation: 'not_required' } } };
    }
    const tree = headOid ? await run(['--no-replace-objects', 'rev-parse', `${headOid}^{tree}`]) : await run(['hash-object', '-w', '-t', 'tree', '--stdin'], '');
    if (!tree.success) return { success: false, response: failure(mapGitErrorCode(tree.stderr), tree.stderr || 'Could not capture the base tree') };
    const stateFiles = await Promise.all(COMMIT_STATE_FILES.map(async (name) => ({ name, content: await readGitStateFile(context, name, 'raw') })));
    const mergeHeads = (stateFiles.find((file) => file.name === 'MERGE_HEAD')?.content ?? '').split(/\s+/).filter(Boolean);
    const cherryPickOid = stateFiles.find((file) => file.name === 'CHERRY_PICK_HEAD')?.content?.trim() ?? null;
    if (mergeHeads.length && (request.mode === 'amend' || request.scope?.kind === 'paths' || request.patches?.length)) {
        return { success: false, response: failure(SCM_OPERATION_ERROR_CODES.BRANCH_OPERATION_IN_PROGRESS, 'Complete the merge through an ordinary staged or all-pending commit') };
    }
    return { success: true, target: { headOid, ref, baseTreeOid: tree.stdout.trim(), mergeHeads, cherryPickOid, stateFiles } };
}

function identityEnvironment(identity: string, role: 'AUTHOR' | 'COMMITTER') {
    const match = /^(.*) <([^<>]+)> ([-0-9]+ [+-][0-9]{4})$/.exec(identity.trim());
    if (!match) throw new Error(`Could not resolve Git ${role.toLowerCase()} identity`);
    return { [`GIT_${role}_NAME`]: match[1]!, [`GIT_${role}_EMAIL`]: match[2]!, [`GIT_${role}_DATE`]: match[3]! };
}

function parseHookChanges(raw: string): NonNullable<ScmCommitCreateResponse['hookContentChanges']>['changes'] {
    const tokens = raw.split('\0');
    const changes: NonNullable<ScmCommitCreateResponse['hookContentChanges']>['changes'] = [];
    for (let i = 0; i < tokens.length - 1; i += 2) {
        const status = tokens[i]!;
        const path = tokens[i + 1]!;
        const kind = status[0] === 'A' ? 'added' : status[0] === 'D' ? 'deleted' : status[0] === 'T' ? 'type_changed' : 'modified';
        changes.push({ path, kind });
    }
    return changes;
}

/** Preserve staged differences relative to the captured base, using Git's content/mode/rename merge. */
async function reconcileIndex(input: { cwd: string; target: GitCommitTarget; candidateOid: string; candidateTree: string; expectedIndexTreeOid?: string; index: GitTemporaryIndex; identityEnv: Record<string, string>; gitFeatures: GitExecutionFeatures }): Promise<{ success: true; treeOid: string } | { success: false; response: ScmCommitCreateResponse }> {
    const refuse = (errorCode: ScmOperationErrorCode, error: string) => ({ success: false as const, response: failure(errorCode, error) });
    const run = (args: string[], stdin?: string) => runGitCommand({ cwd: input.cwd, args, stdin, env: { ...input.identityEnv, ...input.index.env } });
    const live = await run(['write-tree']);
    if (!live.success) return refuse(SCM_OPERATION_ERROR_CODES.COMMIT_STAGING_CONFLICT, live.stderr || 'The current index cannot be represented as a tree');
    const liveTree = live.stdout.trim();
    if (input.expectedIndexTreeOid !== undefined && liveTree !== input.expectedIndexTreeOid) return refuse(SCM_OPERATION_ERROR_CODES.SCM_SOURCE_CHANGED, 'Staged source changed since the accepted plan was validated');
    let mergedTree = input.candidateTree;
    if (liveTree !== input.target.baseTreeOid && liveTree !== input.candidateTree) {
        if (!input.gitFeatures.stagedIntentMerge) return refuse(SCM_OPERATION_ERROR_CODES.COMMIT_STAGING_CONFLICT, 'This Git version cannot safely reconcile staged intent with the accepted commit; staged work was preserved');
        const stagedCommit = await run(['-c', 'commit.gpgSign=false', 'commit-tree', liveTree, ...(input.target.headOid ? ['-p', input.target.headOid] : []), '-m', 'Staged tree for index reconciliation']);
        if (!stagedCommit.success) return refuse(mapGitErrorCode(stagedCommit.stderr), stagedCommit.stderr || 'Could not inspect staged intent');
        let mergeBase = input.target.headOid;
        if (!mergeBase) {
            const emptyBase = await run(['-c', 'commit.gpgSign=false', 'commit-tree', input.target.baseTreeOid, '-m', 'Empty base for index reconciliation']);
            if (!emptyBase.success) return refuse(mapGitErrorCode(emptyBase.stderr), emptyBase.stderr || 'Could not inspect unborn staging intent');
            mergeBase = emptyBase.stdout.trim();
        }
        const merged = await run(['--no-replace-objects', 'merge-tree', '--write-tree', `--merge-base=${mergeBase}`, input.candidateOid, stagedCommit.stdout.trim()]);
        if (merged.success) mergedTree = merged.stdout.split('\n')[0]!.trim();
        else {
            // Git reports a conflict for adjacent insertions even when the staged blob
            // already contains every accepted insertion. Prove that subset at its exact
            // index coordinates without rewriting staged entries or their flags.
            // Deletions/replacements are excluded: reverse insertion alone cannot prove
            // that a staged blob already includes an accepted deletion.
            const patch = await run(['diff', '--binary', '--full-index', '--no-renames', '--unified=0', input.target.baseTreeOid, input.candidateTree]);
            const stats = patch.success ? await run(['apply', '--numstat', '-z', '-'], patch.stdout) : null;
            const files = stats?.success ? parseNumStatZ(stats.stdout).files : [];
            const insertionsOnly = files.length > 0 && files.every((file) => !file.binary && file.insertions > 0 && file.deletions === 0);
            const included = insertionsOnly && await applyValidatedGitPatch({ cwd: input.cwd, patch: patch.stdout,
                target: 'index', reverse: true, checkOnly: true, env: { ...input.identityEnv, ...input.index.env } });
            if (!included || !included.success) return refuse(SCM_OPERATION_ERROR_CODES.COMMIT_STAGING_CONFLICT, merged.stderr || merged.stdout || 'Staged content conflicts with the accepted commit');
            mergedTree = liveTree;
        }
    }
    // Change only entries whose content/mode changed. Unrelated stage entries and index flags survive.
    const changes = await run(['diff-tree', '--no-renames', '--raw', '--no-abbrev', '-r', '-z', liveTree, mergedTree]);
    if (!changes.success) return refuse(mapGitErrorCode(changes.stderr), changes.stderr || 'Could not compute index reconciliation');
    const tokens = changes.stdout.split('\0');
    let indexInfo = '';
    for (let i = 0; i < tokens.length - 1; i += 2) {
        const fields = tokens[i]!.split(' ');
        indexInfo += `${fields[1]} ${fields[3]}\t${tokens[i + 1]}\0`;
    }
    if (indexInfo) {
        const update = await run(['update-index', '-z', '--index-info'], indexInfo);
        if (!update.success) return refuse(mapGitErrorCode(update.stderr), update.stderr || 'Could not reconcile index entries');
    }
    const verified = await run(['write-tree']);
    if (!verified.success || verified.stdout.trim() !== mergedTree) return refuse(SCM_OPERATION_ERROR_CODES.COMMIT_STAGING_CONFLICT, verified.stderr || 'Reconciled index did not match the verified staged tree');
    return { success: true, treeOid: verified.stdout.trim() };
}

export async function publishGitCommit(input: { context: ScmBackendContext; request: ScmCommitCreateRequest; target: GitCommitTarget; index: GitTemporaryIndex; message: string; gitFeatures?: () => Promise<GitExecutionFeatures> }): Promise<ScmCommitCreateResponse> {
    const { context, request, target, index } = input;
    const cwd = context.cwd;
    let candidateOid: string | undefined;
    let actualMessage: string | undefined;
    let state: 'not_published' | 'published' | 'unknown' = 'not_published';
    let indexReconciliation: 'not_required' | 'pending' | 'reconciled' | 'failed' = 'not_required';
    let indexTreeOid: string | undefined;
    // What the lab's per-commit lines say: which normal hook stopped or expanded the commit, when the
    // constructed commit was made, and whether repository signing actually signed it.
    let hookName: string | undefined;
    let committedAtMs: number | undefined;
    let signed: boolean | undefined;
    let stdout = '';
    let stderr = '';
    let responseForCleanup: ScmCommitCreateResponse | undefined;
    const decorate = (response: ScmCommitCreateResponse): ScmCommitCreateResponse => (responseForCleanup = {
        ...response, stdout, stderr,
        ...(state === 'published' && candidateOid ? { commitSha: candidateOid } : {}),
        publication: { state, expectedHeadOid: target.headOid, expectedRef: target.ref, ...(candidateOid ? { candidateOid } : {}), ...(actualMessage !== undefined ? { actualMessage } : {}), indexReconciliation, ...(indexTreeOid !== undefined ? { indexTreeOid } : {}),
            ...(hookName !== undefined ? { hookName } : {}), ...(committedAtMs !== undefined ? { committedAtMs } : {}), ...(signed !== undefined ? { signed } : {}) },
    });
    const run = async (args: string[], stdin?: string, env: Record<string, string | undefined> = index.env): Promise<ScmExecResult> => {
        // Preserve the existing user-commit command budget for hooks/signing; the backend's shorter
        // generic command default must not replace it during the plumbing extraction.
        const result = await runGitCommand({ cwd, args, stdin, env, timeoutMs: 20_000 });
        return result;
    };
    let lockFd: number | undefined;
    let indexLockPath: string | undefined;
    let reconciledIndex: GitTemporaryIndex | undefined;
    try {
        const gitFeatures = await (input.gitFeatures ?? createGitExecutionFeatureDetector())();
        let hooksDirectory: string | undefined;
        if (!gitFeatures.hookRun) {
            if (process.platform === 'win32') return decorate(failure(SCM_OPERATION_ERROR_CODES.COMMIT_HOOK_FAILED, 'This Git for Windows cannot run commit hooks'));
            const root = await run(['rev-parse', '--show-toplevel']);
            if (!root.success) return decorate(failure(mapGitErrorCode(root.stderr), root.stderr));
            const hooks = await run(['-C', root.stdout.trim(), 'rev-parse', '--git-path', 'hooks']);
            if (!hooks.success) return decorate(failure(mapGitErrorCode(hooks.stderr), hooks.stderr));
            hooksDirectory = resolve(root.stdout.trim(), hooks.stdout.trim());
        }
        const runHook = async (hook: string, args: readonly string[], env: Record<string, string | undefined>, stdin?: string): Promise<ScmExecResult> => {
            if (gitFeatures.hookRun) {
                const stdinFile = join(dirname(index.indexPath), 'post-rewrite-input');
                if (stdin !== undefined) writeFileSync(stdinFile, stdin);
                return run(['hook', 'run', '--ignore-missing', ...(stdin === undefined ? [] : [`--to-stdin=${stdinFile}`]), hook, '--', ...args], undefined, env);
            }
            const hookPath = join(hooksDirectory!, hook);
            try { accessSync(hookPath, constants.X_OK); }
            catch (error) {
                const code = error instanceof Error && 'code' in error ? error.code : undefined;
                if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return { success: true, stdout: '', stderr: '', exitCode: 0 };
                throw error;
            }
            // Before `git hook run`, let Git's POSIX shell-alias executor exec the resolved
            // hook directly. Git supplies root cwd/GIT_PREFIX and argv quoting; the existing
            // command service still owns stdin, output, cancellation and process-tree cleanup.
            const inheritedConfig = process.env.GIT_CONFIG_PARAMETERS;
            const launcher = '!f() { if test "$1" = set; then GIT_CONFIG_PARAMETERS=$2; export GIT_CONFIG_PARAMETERS; else unset GIT_CONFIG_PARAMETERS; fi; shift 2; exec "$@"; }; f';
            return run(['-c', `alias.happier-commit-hook=${launcher}`, 'happier-commit-hook', inheritedConfig === undefined ? 'unset' : 'set', inheritedConfig ?? '', hookPath, ...args], stdin, env);
        };
        const author = await run(['var', 'GIT_AUTHOR_IDENT']);
        const committer = await run(['var', 'GIT_COMMITTER_IDENT']);
        if (!author.success || !committer.success) return decorate(failure(SCM_OPERATION_ERROR_CODES.COMMIT_IDENTITY_REQUIRED, author.stderr || committer.stderr || 'Commit identity is unavailable'));
        let authorIdentity = author.stdout.trim();
        const parents: string[] = [];
        if (request.mode === 'amend' && target.headOid) {
            const original = await run(['show', '-s', '--format=%an <%ae> %ad%x00%P', '--date=raw', target.headOid]);
            if (!original.success) return decorate(failure(mapGitErrorCode(original.stderr), original.stderr));
            const [identity, ancestry] = original.stdout.trim().split('\0');
            authorIdentity = identity!;
            parents.push(...(ancestry ?? '').split(' ').filter(Boolean));
        } else {
            if (target.headOid) parents.push(target.headOid);
            parents.push(...target.mergeHeads);
            if (target.cherryPickOid) {
                const picked = await run(['show', '-s', '--format=%an <%ae> %ad', '--date=raw', target.cherryPickOid]);
                if (!picked.success) return decorate(failure(mapGitErrorCode(picked.stderr), picked.stderr));
                authorIdentity = picked.stdout.trim();
            }
        }
        const identityEnv = { ...identityEnvironment(authorIdentity, 'AUTHOR'), ...identityEnvironment(committer.stdout, 'COMMITTER') };
        const hookEnv = { ...identityEnv, ...index.env, GIT_EDITOR: ':' };
        const selectedTree = await run(['write-tree']);
        if (!selectedTree.success) return decorate(failure(mapGitErrorCode(selectedTree.stderr), selectedTree.stderr));
        let beforeTreeOid = selectedTree.stdout.trim();
        if (request.expectedCandidateTreeOid !== undefined && beforeTreeOid !== request.expectedCandidateTreeOid) {
            return decorate(failure(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, 'Prepared commit tree does not match the accepted candidate tree'));
        }
        if (request.acceptedHookTreeOid !== undefined) {
            // The host binds explicit inclusion to the displayed before/after trees and
            // captured parent/ref. Re-run normal hooks on precisely that accepted tree.
            const accepted = await run(['cat-file', '-t', request.acceptedHookTreeOid]);
            if (!accepted.success || accepted.stdout.trim() !== 'tree') return decorate(failure(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, 'The accepted hook tree is unavailable'));
            const load = await run(['read-tree', request.acceptedHookTreeOid]);
            if (!load.success) return decorate(failure(mapGitErrorCode(load.stderr), load.stderr || 'Could not load the accepted hook tree'));
            const verified = await run(['write-tree']);
            if (!verified.success || verified.stdout.trim() !== request.acceptedHookTreeOid) return decorate(failure(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, 'The private index does not match the accepted hook tree'));
            beforeTreeOid = request.acceptedHookTreeOid;
        }
        // The non-editor API follows Git's -m hook order and message cleanup. Git itself discovers/runs hooks.
        const messageFile = join(dirname(index.indexPath), 'COMMIT_EDITMSG');
        const preCommit = await runHook('pre-commit', [], hookEnv);
        stdout += preCommit.stdout; stderr += preCommit.stderr;
        if (!preCommit.success) hookName = 'pre-commit';
        if (!preCommit.success) return decorate(failure(getScmCommandIndeterminateErrorCode(preCommit) ?? SCM_OPERATION_ERROR_CODES.COMMIT_HOOK_FAILED, preCommit.stderr || 'Pre-commit hook failed'));
        writeFileSync(messageFile, input.message + '\n');
        if (request.signOff) {
            const trailer = await run(['interpret-trailers', '--in-place', '--if-exists=addIfDifferentNeighbor', '--if-missing=add', '--trailer', `Signed-off-by: ${committer.stdout.trim().replace(/> .*/, '>')}`, messageFile], undefined, hookEnv);
            if (!trailer.success) return decorate(failure(mapGitErrorCode(trailer.stderr), trailer.stderr));
        }
        // The tree after each content-capable hook names the hook that expanded the selection.
        const treeAfter = async () => { const tree = await run(['write-tree']); return tree.success ? tree.stdout.trim() : null; };
        let expandedBy: string | undefined = (await treeAfter()) !== beforeTreeOid ? 'pre-commit' : undefined;
        for (const [hook, args] of [['prepare-commit-msg', [messageFile, 'message']], ['commit-msg', [messageFile]]] as const) {
            const result = await runHook(hook, args, hookEnv);
            stdout += result.stdout; stderr += result.stderr;
            if (!result.success) hookName = hook;
            if (result.success && expandedBy === undefined && (await treeAfter()) !== beforeTreeOid) expandedBy = hook;
            if (!result.success) return decorate(failure(getScmCommandIndeterminateErrorCode(result) ?? SCM_OPERATION_ERROR_CODES.COMMIT_HOOK_FAILED, result.stderr || `${hook} hook failed`));
        }
        const candidateTreeResult = await run(['write-tree']);
        if (!candidateTreeResult.success) return decorate(failure(mapGitErrorCode(candidateTreeResult.stderr), candidateTreeResult.stderr));
        const candidateTree = candidateTreeResult.stdout.trim();
        if (candidateTree !== beforeTreeOid) {
            hookName = expandedBy;
            const changed = await run(['diff-tree', '--no-renames', '--name-status', '-r', '-z', beforeTreeOid, candidateTree]);
            if (!changed.success) return decorate(failure(mapGitErrorCode(changed.stderr), changed.stderr));
            const errorCode = SCM_OPERATION_ERROR_CODES.COMMIT_HOOK_CONTENT_CHANGED;
            return decorate({ ...failure(errorCode, 'Commit hooks changed the selected content; review and explicitly include it or cancel'),
                outcome: { v: 1, kind: 'needs_input', errorCode, nextActions: [{ kind: 'refresh' }] },
                hookContentChanges: { beforeTreeOid, afterTreeOid: candidateTree, changes: parseHookChanges(changed.stdout) } });
        }
        const cleanup = await run(['config', '--get', 'commit.cleanup']);
        if (!cleanup.success && cleanup.exitCode !== 1) return decorate(failure(mapGitErrorCode(cleanup.stderr), cleanup.stderr));
        const mode = cleanup.success ? cleanup.stdout.trim() : 'whitespace';
        if (!['default', 'whitespace', 'strip', 'verbatim', 'scissors'].includes(mode)) return decorate(failure(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, 'Unsupported commit.cleanup configuration'));
        let cleaned = readFileSync(messageFile, 'utf8');
        if (mode !== 'verbatim') {
            const clean = await run(['stripspace', ...(mode === 'strip' ? ['--strip-comments'] : [])], cleaned, hookEnv);
            if (!clean.success) return decorate(failure(mapGitErrorCode(clean.stderr), clean.stderr));
            cleaned = clean.stdout;
        }
        if (!cleaned.trim()) return decorate(failure(SCM_OPERATION_ERROR_CODES.COMMIT_EMPTY, 'Commit message is empty after hooks and cleanup'));
        actualMessage = cleaned.replace(/\n$/, '');
        const signing = await run(['config', '--type=bool', '--get', 'commit.gpgSign']);
        if (!signing.success && signing.exitCode !== 1) return decorate(failure(SCM_OPERATION_ERROR_CODES.COMMIT_SIGNING_FAILED, signing.stderr));
        const object = await run(['commit-tree', candidateTree, ...parents.flatMap((parent) => ['-p', parent]), ...(signing.stdout.trim() === 'true' ? ['-S'] : [])], cleaned, hookEnv);
        if (!object.success) return decorate(failure(getScmCommandIndeterminateErrorCode(object) ?? mapGitErrorCode(object.stderr), object.stderr || 'Could not construct and sign the commit'));
        candidateOid = object.stdout.trim();
        signed = signing.stdout.trim() === 'true';
        const committedAt = /([0-9]+) [+-][0-9]{4}$/.exec(identityEnv.GIT_COMMITTER_DATE ?? '')?.[1];
        if (committedAt !== undefined) committedAtMs = Number(committedAt) * 1000;

        const indexPathResult = await resolveGitIndexPath({ cwd, runGit: (command) => runGitCommand({ ...command, args: [...command.args] }) });
        if (!indexPathResult.success) return decorate(failure(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, indexPathResult.error));
        const indexPath = indexPathResult.indexPath;
        const sharing = await run(['config', '--get', 'core.sharedRepository']);
        if (!sharing.success && sharing.exitCode !== 1) return decorate(failure(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, sharing.stderr));
        // Git 2.43 setup.c#git_config_perm / path.c#calc_shared_perm: named
        // policies loosen umask, while explicit octal modes replace it.
        const value = sharing.stdout.trim();
        let sharedMode = 0;
        let replaceMode = false;
        if (sharing.success && value !== 'umask') {
            if (['group', 'all', 'world', 'everybody'].includes(value)) sharedMode = value === 'group' ? 0o660 : 0o664;
            else if (/^[+-]?[0-7]+$/.test(value)) {
                const mode = Number.parseInt(value, 8);
                sharedMode = mode === 0 ? 0 : mode === 1 ? 0o660 : mode === 2 ? 0o664 : mode & 0o666;
                replaceMode = mode !== 0 && mode !== 1 && mode !== 2;
                if (replaceMode && (mode & 0o600) !== 0o600) return decorate(failure(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, 'core.sharedRepository must grant owner read and write permissions'));
            } else {
                const bool = await run(['config', '--bool', '--get', 'core.sharedRepository']);
                if (!bool.success) return decorate(failure(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, bool.stderr));
                sharedMode = bool.stdout.trim() === 'true' ? 0o660 : 0;
            }
        }
        indexLockPath = `${indexPath}.lock`;
        try { lockFd = openSync(indexLockPath, 'wx'); }
        catch (error) {
            indexLockPath = undefined;
            const code = error instanceof Error && 'code' in error ? error.code : undefined;
            return decorate(failure(code === 'EEXIST' ? SCM_OPERATION_ERROR_CODES.INDEX_LOCKED : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error instanceof Error ? error.message : String(error)));
        }
        if (sharedMode) {
            const mode = fstatSync(lockFd).mode & 0o777;
            if (!(mode & 0o200)) sharedMode &= ~0o222;
            if (mode & 0o100) sharedMode |= (sharedMode & 0o444) >> 2;
            fchmodSync(lockFd, replaceMode ? sharedMode : mode | sharedMode);
        }
        const current = await createGitTemporaryIndex({ cwd, seed: { kind: 'current-index' } });
        if (!current.success) return decorate(current);
        reconciledIndex = current.tempIndex;
        const reconciliation = await reconcileIndex({ cwd, target, candidateOid, candidateTree, expectedIndexTreeOid: request.expectedIndexTreeOid, index: reconciledIndex, identityEnv, gitFeatures });
        if (!reconciliation.success) return decorate(reconciliation.response);
        // Prepare the verified bytes before ref publication; the native index lock excludes terminal Git.
        writeFileSync(lockFd, readFileSync(reconciledIndex.indexPath));
        fsyncSync(lockFd);
        let targetMatches: boolean | undefined;
        const publication = await runGitCommand({ cwd, args: ['update-ref', '-m', `commit${request.mode === 'amend' ? ' (amend)' : target.headOid ? '' : ' (initial)'}: ${actualMessage.split('\n')[0]}`, '--stdin'],
            env: hookEnv,
            timeoutMs: 20_000,
            stdin: `start\nupdate HEAD ${candidateOid} ${target.headOid ?? '0'.repeat(candidateOid.length)}\nprepare\n`,
            stdinInteraction: { readyLine: 'prepare: ok', respond: async () => {
                // Git holds HEAD and its referent locks here, so even equal-OID branch switches cannot race this check.
                const symbolic = await run(['symbolic-ref', '-q', 'HEAD']);
                targetMatches = symbolic.success ? symbolic.stdout.trim() === target.ref : symbolic.exitCode === 1 && target.ref === null;
                const currentState = await Promise.all(target.stateFiles.map((file) => readGitStateFile(context, file.name, 'raw')));
                targetMatches &&= currentState.every((content, position) => content === target.stateFiles[position]!.content);
                return targetMatches ? 'commit\n' : 'abort\n';
            } },
        });
        stdout += publication.stdout; stderr += publication.stderr;
        if (publication.success && targetMatches) state = 'published';
        else if (getScmCommandIndeterminateErrorCode(publication)) {
            state = 'unknown';
            const observed = await observeGitCommitPublication({ cwd, candidateOid, expectedHeadOid: target.headOid, expectedRef: target.ref });
            if (observed.success && observed.state === 'published') state = 'published';
        }
        if (state !== 'published') {
            const indeterminate = getScmCommandIndeterminateErrorCode(publication);
            if (indeterminate) return decorate({ ...failure(indeterminate, publication.stderr || 'Commit publication could not be resolved'),
                outcome: { v: 1, kind: 'outcome_unknown', errorCode: indeterminate, reconciliation: { kind: 'repository_status', cwd }, nextActions: [{ kind: 'refresh' }] } });
            const observed = await captureGitCommitTarget(context, { message: input.message });
            const changed = targetMatches === false || (observed.success && (observed.target.headOid !== target.headOid || observed.target.ref !== target.ref ||
                observed.target.stateFiles.some((file, position) => file.content !== target.stateFiles[position]!.content)));
            if (changed) return decorate(failure(SCM_OPERATION_ERROR_CODES.COMMIT_HEAD_CHANGED, publication.stderr || 'HEAD or its operation state changed before publication'));
            if (publication.stderr.includes('ref updates aborted by hook')) {
                hookName = 'reference-transaction';
                return decorate(failure(SCM_OPERATION_ERROR_CODES.COMMIT_HOOK_FAILED, publication.stderr));
            }
            return decorate(failure(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, publication.stderr || 'Commit reference transaction failed'));
        }
        indexReconciliation = 'pending';
        // Remove only the operation state captured by this commit, while the native index lock
        // still excludes a new terminal merge/cherry-pick from starting in this worktree.
        for (const file of target.stateFiles) {
            if (file.content === null) continue;
            if (await readGitStateFile(context, file.name, 'raw') !== file.content) throw new Error(`Git ${file.name} changed after publication; refresh operation state`);
            const statePath = await resolveGitStatePath(context, file.name);
            if (!statePath) throw new Error(`Could not resolve Git ${file.name} after publication`);
            unlinkSync(statePath);
        }
        closeSync(lockFd); lockFd = undefined;
        try { renameSync(indexLockPath!, indexPath); indexLockPath = undefined; indexReconciliation = 'reconciled'; indexTreeOid = reconciliation.treeOid; }
        catch (error) {
            indexReconciliation = 'failed';
            return decorate({ ...failure(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, `Commit was created, but index reconciliation failed: ${error instanceof Error ? error.message : String(error)}`),
                outcome: { v: 1, kind: 'effect_applied_with_warning', errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, effect: { kind: 'commit', commitSha: candidateOid }, nextActions: [{ kind: 'reconcile_index' }] } });
        }
        const postEnv = { ...identityEnv, GIT_EDITOR: ':', GIT_INDEX_FILE: indexPath };
        const post = await runHook('post-commit', [], postEnv);
        stdout += post.stdout; stderr += post.stderr;
        if (!post.success) hookName = 'post-commit';
        if (!post.success) return decorate({ ...failure(getScmCommandIndeterminateErrorCode(post) ?? SCM_OPERATION_ERROR_CODES.COMMIT_HOOK_FAILED, post.stderr || 'Commit was created, but post-commit hook failed'),
            outcome: { v: 1, kind: 'effect_applied_with_warning', errorCode: getScmCommandIndeterminateErrorCode(post) ?? SCM_OPERATION_ERROR_CODES.COMMIT_HOOK_FAILED, effect: { kind: 'commit', commitSha: candidateOid }, nextActions: [{ kind: 'refresh' }] } });
        if (request.mode === 'amend' && target.headOid) {
            const rewriteInput = `${target.headOid} ${candidateOid}\n`;
            const notes = await run(['notes', 'copy', '--for-rewrite=amend'], rewriteInput, postEnv);
            if (!notes.success) return decorate({ ...failure(mapGitErrorCode(notes.stderr), notes.stderr || 'Commit was created, but notes rewriting failed'), outcome: { v: 1, kind: 'effect_applied_with_warning', errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, effect: { kind: 'commit', commitSha: candidateOid }, nextActions: [{ kind: 'refresh' }] } });
            const rewrite = await runHook('post-rewrite', ['amend'], postEnv, rewriteInput);
            stdout += rewrite.stdout; stderr += rewrite.stderr;
            if (!rewrite.success) hookName = 'post-rewrite';
            if (!rewrite.success) return decorate({ ...failure(getScmCommandIndeterminateErrorCode(rewrite) ?? SCM_OPERATION_ERROR_CODES.COMMIT_HOOK_FAILED, rewrite.stderr || 'Commit was created, but post-rewrite hook failed'), outcome: { v: 1, kind: 'effect_applied_with_warning', errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_HOOK_FAILED, effect: { kind: 'commit', commitSha: candidateOid }, nextActions: [{ kind: 'refresh' }] } });
        }
        return decorate({ success: true, commitSha: candidateOid });
    } catch (error) {
        const response = failure(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error instanceof Error ? error.message : String(error));
        if (state === 'published' && candidateOid) {
            if (indexReconciliation === 'pending') indexReconciliation = 'failed';
            response.outcome = { v: 1, kind: 'effect_applied_with_warning', errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, effect: { kind: 'commit', commitSha: candidateOid }, nextActions: [{ kind: 'refresh' }] };
        }
        return decorate(response);
    } finally {
        const cleanupErrors: string[] = [];
        for (const cleanup of [() => { if (lockFd !== undefined) closeSync(lockFd); }, () => { if (indexLockPath) unlinkSync(indexLockPath); }, () => reconciledIndex?.cleanup()]) {
            try { cleanup(); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
        }
        if (cleanupErrors.length && responseForCleanup) {
            responseForCleanup.success = false;
            responseForCleanup.errorCode = SCM_OPERATION_ERROR_CODES.COMMAND_FAILED;
            responseForCleanup.error = [responseForCleanup.error, `Commit resource cleanup failed: ${cleanupErrors.join('; ')}`].filter(Boolean).join('\n');
            if (state === 'published' && candidateOid) responseForCleanup.outcome = { v: 1, kind: 'effect_applied_with_warning', errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, effect: { kind: 'commit', commitSha: candidateOid }, nextActions: [{ kind: 'refresh' }] };
        }
    }
}

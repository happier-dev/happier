import { dirname, join, resolve } from 'node:path';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { TurnChangeSetSchema } from '@happier-dev/protocol/sessions/changes/schemas';
import type { RepositoryCheckpointCommitEvidence, TurnChangeSet } from '@happier-dev/protocol';
import { ScmCommitOidSchema, type ScmBranchWorkEvidence, type ScmPullRequestSummary, type ScmPullRequestWorkEvidence } from '@happier-dev/protocol/scm';
import { readScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { configuration } from '@/configuration';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { runGitCheckpointCommand } from './gitCheckpointCommands';
import { buildRepositoryCheckpointScopePrefix, encodeRepositoryCheckpointScope, parseRepositoryCheckpointRef } from './refs';
import type { RepositoryCheckpointCaptureResult, RepositoryCheckpointRef } from './types';

const InitialEvidenceSchema = z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('available'), ref: z.string(), originalRef: z.string(), commitSha: z.string(), treeSha: z.string() }),
    z.strictObject({ state: z.literal('unavailable'), reason: z.string(), recoverable: z.optional(z.literal(true)) }),
]);
export type RepositoryCheckpointInitialEvidence = z.infer<typeof InitialEvidenceSchema>;

function gitTimestampMs(value: string | undefined): number | undefined {
    if (!value || !/^\d+$/.test(value)) return undefined;
    const milliseconds = Number(value) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

/** One opaque identity for the actual local Git common directory, shared by branch graph readers. */
async function readLocalBranchRepositoryKey(cwd: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const result = await runGitCheckpointCommand({ cwd, signal, args: ['--no-replace-objects', 'rev-parse', '--git-common-dir'] });
    signal?.throwIfAborted();
    if (!result.success) throw new Error(result.stderr || 'Branch graph is unavailable');
    const directory = await currentWorkspaceSource().realpath(resolve(cwd, result.stdout.trim()));
    const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
    return storage.deriveOpaqueIdentity({ purpose: 'usage_accounting_identity',
        value: JSON.stringify(['local-branch-repository', directory]) });
}

/** This is a retained changed-file lower bound, never authorship or inferred line survival. */
async function readRetainedChange(cwd: string, commitSha: string, targetSha: string, signal?: AbortSignal)
    : Promise<RepositoryCheckpointCommitEvidence['retainedChange']> {
    const run = (args: string[]) => runGitCheckpointCommand({ cwd, signal, args: ['--no-replace-objects', ...args] });
    signal?.throwIfAborted();
    const [original, changed] = await Promise.all([
        run(['diff', '--no-ext-diff', '--no-textconv', '--numstat', '--no-renames', '-z', `${commitSha}^`, commitSha, '--']),
        run(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', commitSha, targetSha, '--']),
    ]);
    signal?.throwIfAborted();
    if (!original.success || !changed.success) return undefined;
    const changedPaths = new Set(changed.stdout.split('\0').filter(Boolean));
    let addedLines = 0;
    let removedLines = 0;
    let partial = false;
    for (const row of original.stdout.split('\0').filter(Boolean)) {
        // --no-renames gives one NUL-terminated path, including tabs/newlines, after two numeric columns.
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
        if (!match) { partial = true; continue; }
        const [, added, removed, path] = match;
        if (changedPaths.has(path) || added === '-' || removed === '-') { partial = true; continue; }
        addedLines += Number(added);
        removedLines += Number(removed);
    }
    return { targetSha, method: 'changed_file_tree_comparison', status: partial ? 'partial' : 'retained', addedLines, removedLines };
}

/** A branch without hosting metadata still has a witnessed immutable local graph. */
export async function readRepositoryCheckpointBranchEvidence(input: Readonly<{
    cwd: string; sessionId: string; signal?: AbortSignal;
}>): Promise<ScmBranchWorkEvidence[]> {
    const git = async (args: string[]) => {
        input.signal?.throwIfAborted();
        const result = await runGitCheckpointCommand({ cwd: input.cwd, args: ['--no-replace-objects', ...args], signal: input.signal });
        input.signal?.throwIfAborted();
        if (!result.success) throw new Error(result.stderr || 'Branch graph is unavailable');
        return result.stdout;
    };
    const repositoryKey = await readLocalBranchRepositoryKey(input.cwd, input.signal);
    const refs = await git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)', 'refs/heads/']);
    const branches = refs.trim().split('\n').flatMap(row => {
        const [ref, headSha, type] = row.split('\0');
        return ref?.startsWith('refs/heads/') && ScmCommitOidSchema.safeParse(headSha).success && type === 'commit'
            ? [{ ref, headSha }] : [];
    });
    const graphs = new Map<string, Set<string>>();
    for (const { headSha } of branches) {
        if (graphs.has(headSha)) continue;
        const graph = await git(['rev-list', headSha]);
        graphs.set(headSha, new Set(graph.trim().split('\n').filter(oid => ScmCommitOidSchema.safeParse(oid).success)));
    }
    const witnesses = await readRepositoryCheckpointCommitEvidence({ ...input, repositoryKey,
        commitShas: [...new Set([...graphs.values()].flatMap(graph => [...graph]))] });
    const retained = new Map<string, Promise<RepositoryCheckpointCommitEvidence['retainedChange']>>();
    return Promise.all(branches.flatMap(branch => witnesses.filter(witness => graphs.get(branch.headSha)!.has(witness.commitSha))
        .map(async witness => {
            const key = JSON.stringify([witness.commitSha, branch.headSha]);
            if (!retained.has(key)) retained.set(key, readRetainedChange(input.cwd, witness.commitSha, branch.headSha, input.signal));
            const retainedChange = await retained.get(key);
            return { ...witness, branch, ...(retainedChange ? { retainedChange } : {}) };
        })));
}

export async function readRepositoryCheckpointPullRequestEvidence(input: Readonly<{
    cwd: string; sessionId: string; pullRequests: readonly ScmPullRequestSummary[]; signal?: AbortSignal;
}>): Promise<ScmPullRequestWorkEvidence[]> {
    const evidence: ScmPullRequestWorkEvidence[] = [];
    const refs = await runGitCheckpointCommand({ cwd: input.cwd, signal: input.signal,
        args: ['--no-replace-objects', 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)', 'refs/heads/'] });
    input.signal?.throwIfAborted();
    const branches = refs.success ? refs.stdout.trim().split('\n').flatMap(row => {
        const [ref, headSha, type] = row.split('\0');
        return ref?.startsWith('refs/heads/') && ScmCommitOidSchema.safeParse(headSha).success && type === 'commit'
            ? [{ ref, headSha }] : [];
    }) : null;
    const branchRepositoryKey = branches === null ? undefined : await readLocalBranchRepositoryKey(input.cwd, input.signal);
    const retained = new Map<string, Promise<RepositoryCheckpointCommitEvidence['retainedChange']>>();
    const repositories = new Map<string, { commits: Set<string>; pullRequests: { summary: ScmPullRequestSummary; commits: Set<string> }[] }>();
    for (const pullRequest of input.pullRequests) {
        input.signal?.throwIfAborted();
        const { headSha, baseSha, provider } = pullRequest;
        const repository = readScmHostingRepositoryIdentity(provider);
        // Identity and endpoints come from the existing hosting reader, not branch labels.
        if (!repository || !ScmCommitOidSchema.safeParse(headSha).success
            || !ScmCommitOidSchema.safeParse(baseSha).success) continue;
        const graph = await runGitCheckpointCommand({ cwd: input.cwd, signal: input.signal,
            args: ['--no-replace-objects', 'rev-list', `${baseSha}..${headSha}`] });
        input.signal?.throwIfAborted();
        if (!graph.success) continue;
        const commits = new Set(graph.stdout.trim().split('\n').filter(oid => ScmCommitOidSchema.safeParse(oid).success));
        const repositoryKey = JSON.stringify(repository);
        let group = repositories.get(repositoryKey);
        if (!group) {
            group = { commits: new Set<string>(), pullRequests: [] };
            repositories.set(repositoryKey, group);
        }
        for (const commit of commits) group.commits.add(commit);
        group.pullRequests.push({ summary: pullRequest, commits });
    }
    for (const [repositoryKey, group] of repositories) {
        const witnesses = await readRepositoryCheckpointCommitEvidence({ cwd: input.cwd, sessionId: input.sessionId,
            repositoryKey, commitShas: [...group.commits], signal: input.signal });
        for (const pullRequest of group.pullRequests) {
            for (const witness of witnesses.filter(witness => pullRequest.commits.has(witness.commitSha))) {
                const headSha = pullRequest.summary.headSha!;
                const key = JSON.stringify([witness.commitSha, headSha]);
                if (!retained.has(key)) retained.set(key, readRetainedChange(input.cwd, witness.commitSha, headSha, input.signal));
                const retainedChange = await retained.get(key);
                evidence.push({ ...witness, pullRequest: pullRequest.summary,
                    ...(branches ? { branchRepositoryKey, branches: branches.filter(branch => branch.headSha === headSha) } : {}),
                    ...(retainedChange ? { retainedChange } : {}) });
            }
        }
    }
    input.signal?.throwIfAborted();
    return evidence;
}

export async function readRepositoryCheckpointCommitEvidence(input: Readonly<{
    cwd: string; sessionId: string; repositoryKey: string; commitShas: readonly string[];
    signal?: AbortSignal;
}>): Promise<RepositoryCheckpointCommitEvidence[]> {
    input.signal?.throwIfAborted();
    const root = await runGitCheckpointCommand({ cwd: input.cwd, args: ['rev-parse', '--show-toplevel'], signal: input.signal });
    if (!root.success || !root.stdout.trim()) throw new Error('Checkpoint repository is unavailable');
    const cwd = root.stdout.trim();
    const scopeId = `${input.sessionId}:${cwd}`;
    const directory = join(await evidenceDirectory(cwd, scopeId, input.signal), 'turns');
    let entries: string[];
    try { entries = (await currentWorkspaceSource().readdir(directory)).map(entry => entry.name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const git = async (args: string[], stdin?: string) => {
        input.signal?.throwIfAborted();
        const result = await runGitCheckpointCommand({ cwd, args: ['--no-replace-objects', ...args], signal: input.signal, stdin });
        input.signal?.throwIfAborted();
        return result;
    };
    // One invocation-local read of actual retained objects replaces per-turn subprocesses.
    // It is not a cache: moved/pruned refs are re-read on every evidence request.
    const refs = await git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(tree)%00%(committerdate:unix)',
        buildRepositoryCheckpointScopePrefix(scopeId)]);
    if (!refs.success) throw new Error('Retained checkpoint refs are unavailable');
    const endpoints = new Map(refs.stdout.trim().split('\n').map(row => {
        const [ref, commitSha, objectType, treeSha, time] = row.split('\0');
        return [ref, { commitSha, objectType, treeSha, committedAtMs: gitTimestampMs(time) }] as const;
    }));
    const commits = new Map<string, { beforeTree: string; afterTree: string; committedAtMs?: number }>();
    const oids = [...new Set(input.commitShas)].filter(oid => ScmCommitOidSchema.safeParse(oid).success).sort();
    if (oids.length) {
        // Read the actual immutable objects in batches; a branch graph must not
        // require two subprocesses for every historical commit.
        const result = await git(['log', '--no-walk=unsorted', '--format=%H%x00%T%x00%P%x00%ct', '--stdin'], oids.join('\n'));
        if (!result.success) throw new Error('Commit objects are unavailable');
        const candidates = result.stdout.trim().split('\n').flatMap(row => {
            const [oid, afterTree, parents, time] = row.split('\0');
            const [parent, ...otherParents] = (parents ?? '').split(' ');
            return parent && !otherParents.length ? [{ oid, afterTree, parent, committedAtMs: gitTimestampMs(time) }] : [];
        });
        if (candidates.length) {
            const parentRows = await git(['log', '--no-walk=unsorted', '--format=%H%x00%T', '--stdin'],
                [...new Set(candidates.map(row => row.parent))].join('\n'));
            if (!parentRows.success) throw new Error('Parent objects are unavailable');
            const trees = new Map(parentRows.stdout.trim().split('\n').map(row => {
                const [oid, tree] = row.split('\0'); return [oid, tree] as const;
            }));
            for (const { oid, afterTree, parent, committedAtMs } of candidates) {
                const beforeTree = trees.get(parent);
                if (beforeTree) commits.set(oid, { beforeTree, afterTree, committedAtMs });
            }
        }
    }
    const evidence: RepositoryCheckpointCommitEvidence[] = [];
    for (const entry of entries.sort()) {
        if (!entry.endsWith('.json')) continue;
        input.signal?.throwIfAborted();
        const turn = createStoredReadSchema(TurnChangeSetSchema).parse(JSON.parse((await currentWorkspaceSource().readFile(join(directory, entry))).toString('utf8')));
        const checkpoint = turn.repositoryCheckpoint;
        if (turn.sessionId !== input.sessionId || checkpoint?.scopeId !== scopeId || checkpoint.contentConfidence !== 'exact') continue;
        const readEndpoint = (ref: string | undefined, phase: 'turn-start' | 'turn-final') => {
            if (!ref) return null;
            const parsed = parseRepositoryCheckpointRef({ scopeId, ref });
            if (parsed?.phase !== phase || parsed.checkpointId !== turn.turnId) return null;
            const receipts = checkpoint.receipts.filter(receipt => receipt.ref === ref && receipt.commitSha);
            const receipt = receipts[0];
            if (!receipt?.commitSha || !ScmCommitOidSchema.safeParse(receipt.commitSha).success) return null;
            const endpoint = endpoints.get(ref);
            if (endpoint?.objectType !== 'commit' || endpoint.commitSha !== receipt.commitSha
                || !ScmCommitOidSchema.safeParse(endpoint.treeSha).success) return null;
            // The native message-start → turn-start alias pins the immutable commit,
            // not a separate tree receipt. Resolve its tree from that exact Git object.
            if (receipts.some(other => other.commitSha !== receipt.commitSha
                || (other.treeSha ? other.treeSha !== endpoint.treeSha : other.id !== 'checkpoint.aliased'))) return null;
            return { ...receipt, treeSha: endpoint.treeSha };
        };
        const start = readEndpoint(checkpoint.startRef, 'turn-start');
        const final = readEndpoint(checkpoint.finalRef, 'turn-final');
        if (!start || !final || start.treeSha === final.treeSha) continue;
        for (const [commitSha, facts] of commits) {
            if (facts.beforeTree !== start.treeSha || facts.afterTree !== final.treeSha) continue;
            evidence.push({ sessionId: turn.sessionId, turnId: turn.turnId, repositoryKey: input.repositoryKey,
                checkpointRef: checkpoint.finalRef!, checkpointCommitSha: final.commitSha!, commitSha,
                ...(facts.committedAtMs !== undefined ? { committedAtMs: facts.committedAtMs } : {}),
                ...(endpoints.get(checkpoint.finalRef!)?.committedAtMs !== undefined
                    ? { checkpointCommittedAtMs: endpoints.get(checkpoint.finalRef!)!.committedAtMs } : {}),
                attributionScope: checkpoint.attributionScope });
        }
    }
    input.signal?.throwIfAborted();
    return evidence;
}

/** `evidenceRoot` is `rev-parse --git-path happier/checkpoint-evidence`, when discovery already read it. */
async function evidenceDirectory(cwd: string, scopeId: string, signal?: AbortSignal, evidenceRoot?: string): Promise<string> {
    if (evidenceRoot) return join(evidenceRoot, encodeRepositoryCheckpointScope(scopeId));
    const result = await runGitCheckpointCommand({ cwd, args: ['rev-parse', '--git-path', 'happier/checkpoint-evidence'], signal });
    if (!result.success || !result.stdout.trim()) throw new Error(result.stderr || 'Checkpoint evidence directory is unavailable');
    return join(resolve(cwd, result.stdout.trim()), encodeRepositoryCheckpointScope(scopeId));
}

export function buildRepositoryCheckpointInitialRef(scopeId: string): string {
    return `${buildRepositoryCheckpointScopePrefix(scopeId)}session-initial`;
}

export async function readRepositoryCheckpointInitialEvidence(input: Readonly<{ cwd: string; scopeId: string; evidenceRoot?: string }>): Promise<RepositoryCheckpointInitialEvidence | null> {
    try { return createStoredReadSchema(InitialEvidenceSchema).parse(JSON.parse((await currentWorkspaceSource().readFile(join(await evidenceDirectory(input.cwd, input.scopeId, undefined, input.evidenceRoot), 'initial.json'))).toString('utf8'))); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

/** Evidence lives in the repository's Git directory: publish it through the workspace source. */
async function writeEvidenceJson(path: string, value: unknown): Promise<void> {
    const source = currentWorkspaceSource();
    await source.mkdir(dirname(path), { recursive: true });
    const written = await source.replaceFile({ destPath: path, source: { kind: 'bytes', bytes: Buffer.from(JSON.stringify(value, null, 2)) } });
    if (!written.success) throw Object.assign(new Error(written.error), { code: written.errorCode });
}

/** The dispatch owner records the first attempt; a later success cannot rename itself session start. */
export async function retainRepositoryCheckpointInitialEvidence(input: Readonly<{
    cwd: string; scopeId: string; checkpointRef: RepositoryCheckpointRef; captured: RepositoryCheckpointCaptureResult;
    recovered?: true; sessionIsNew?: boolean;
    readEarliestPromptLocalId?: () => Promise<string | null>;
    evidenceRoot?: string;
}>): Promise<void> {
    const directory = () => evidenceDirectory(input.cwd, input.scopeId, undefined, input.evidenceRoot);
    const existing = await readRepositoryCheckpointInitialEvidence(input);
    if (existing && !(input.recovered && existing.state === 'unavailable' && existing.recoverable)) return;
    // A Team launch may attach to its precreated Session row. Attachment alone
    // cannot tell whether execution is fresh; Home's first user identity can.
    if (!input.recovered && input.sessionIsNew !== true
        && await input.readEarliestPromptLocalId?.() !== input.checkpointRef.checkpointId) {
        await writeEvidenceJson(join(await directory(), 'initial.json'), {
            state: 'unavailable', reason: 'Initial checkpoint requires canonical earliest prompt evidence for this resumed or unknown session', recoverable: true,
        });
        return;
    }
    let evidence: RepositoryCheckpointInitialEvidence;
    if (!input.captured.success) {
        evidence = { state: 'unavailable', reason: input.captured.error };
    } else {
        const olderRefs = await runGitCheckpointCommand({ cwd: input.cwd,
            args: ['for-each-ref', '--format=%(refname)', buildRepositoryCheckpointScopePrefix(input.scopeId)] });
        if (!input.recovered && (!olderRefs.success || olderRefs.stdout.split('\n').some((ref) => ref !== input.checkpointRef.ref
            && parseRepositoryCheckpointRef({ scopeId: input.scopeId, ref })?.phase === 'message-start'))) {
            await writeEvidenceJson(join(await directory(), 'initial.json'), {
                state: 'unavailable', reason: 'Historical initial checkpoint receipt requires recovery from canonical session evidence', recoverable: true,
            });
            return;
        }
        const ref = buildRepositoryCheckpointInitialRef(input.scopeId);
        const pinned = await runGitCheckpointCommand({ cwd: input.cwd, args: ['update-ref', ref, input.captured.commitSha, ''] });
        if (!pinned.success) {
            // An existing immutable pin wins over resumed dispatch. Resolve it; never overwrite it.
            const previous = await runGitCheckpointCommand({ cwd: input.cwd, args: ['rev-parse', '--verify', `${ref}^{commit}`] });
            const tree = previous.success ? await runGitCheckpointCommand({ cwd: input.cwd, args: ['rev-parse', '--verify', `${previous.stdout.trim()}^{tree}`] }) : null;
            evidence = previous.success && tree?.success
                ? { state: 'available', ref, originalRef: ref, commitSha: previous.stdout.trim(), treeSha: tree.stdout.trim() }
                : { state: 'unavailable', reason: pinned.stderr || 'Initial checkpoint could not be pinned' };
        } else evidence = { state: 'available', ref, originalRef: input.checkpointRef.ref,
            commitSha: input.captured.commitSha, treeSha: input.captured.treeSha };
    }
    await writeEvidenceJson(join(await directory(), 'initial.json'), evidence);
}

export async function retainRepositoryCheckpointTurnEvidence(input: Readonly<{ cwd: string; scopeId: string; turnChangeSet: TurnChangeSet;
    evidenceRoot?: string }>): Promise<void> {
    const parsed = TurnChangeSetSchema.parse(input.turnChangeSet);
    await writeEvidenceJson(join(await evidenceDirectory(input.cwd, input.scopeId, undefined, input.evidenceRoot), 'turns', `${encodeRepositoryCheckpointScope(parsed.turnId)}.json`), parsed);
}

export async function readRepositoryCheckpointTurnEvidence(input: Readonly<{ cwd: string; scopeId: string; turnId: string }>): Promise<TurnChangeSet | null> {
    try {
        return createStoredReadSchema(TurnChangeSetSchema).parse(JSON.parse((await currentWorkspaceSource().readFile(join(await evidenceDirectory(input.cwd, input.scopeId), 'turns', `${encodeRepositoryCheckpointScope(input.turnId)}.json`))).toString('utf8')));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

export async function findRepositoryCheckpointTurnEvidenceByReceipt(input: Readonly<{
    cwd: string; scopeId: string; receiptId: string;
}>): Promise<TurnChangeSet | null> {
    const directory = join(await evidenceDirectory(input.cwd, input.scopeId), 'turns');
    let entries: string[];
    try { entries = (await currentWorkspaceSource().readdir(directory)).map(entry => entry.name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const matches: TurnChangeSet[] = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const turn = createStoredReadSchema(TurnChangeSetSchema).parse(JSON.parse((await currentWorkspaceSource().readFile(join(directory, entry))).toString('utf8')));
        if (turn.repositoryCheckpoint?.scopeId === input.scopeId
            && turn.repositoryCheckpoint.receipts.some((receipt) => receipt.id === input.receiptId || receipt.ref === input.receiptId)) matches.push(turn);
    }
    if (matches.length > 1) throw new Error('Checkpoint receipt selector is ambiguous; select an explicit turn');
    return matches[0] ?? null;
}

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { TurnChangeSetSchema, type TurnChangeSet } from '@happier-dev/protocol';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { runGitCheckpointCommand } from './gitCheckpointCommands';
import { buildRepositoryCheckpointScopePrefix, encodeRepositoryCheckpointScope } from './refs';
import type { RepositoryCheckpointCaptureResult, RepositoryCheckpointRef } from './types';

const InitialEvidenceSchema = z.discriminatedUnion('state', [
    z.object({ state: z.literal('available'), ref: z.string(), originalRef: z.string(), commitSha: z.string(), treeSha: z.string() }).strict(),
    z.object({ state: z.literal('unavailable'), reason: z.string(), recoverable: z.literal(true).optional() }).strict(),
]);
export type RepositoryCheckpointInitialEvidence = z.infer<typeof InitialEvidenceSchema>;

async function evidenceDirectory(cwd: string, scopeId: string): Promise<string> {
    const result = await runGitCheckpointCommand({ cwd, args: ['rev-parse', '--git-path', 'happier/checkpoint-evidence'] });
    if (!result.success || !result.stdout.trim()) throw new Error(result.stderr || 'Checkpoint evidence directory is unavailable');
    return join(resolve(cwd, result.stdout.trim()), encodeRepositoryCheckpointScope(scopeId));
}

export function buildRepositoryCheckpointInitialRef(scopeId: string): string {
    return `${buildRepositoryCheckpointScopePrefix(scopeId)}session-initial`;
}

export async function readRepositoryCheckpointInitialEvidence(input: Readonly<{ cwd: string; scopeId: string }>): Promise<RepositoryCheckpointInitialEvidence | null> {
    try { return InitialEvidenceSchema.parse(JSON.parse(await readFile(join(await evidenceDirectory(input.cwd, input.scopeId), 'initial.json'), 'utf8'))); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

/** The dispatch owner records the first attempt; a later success cannot rename itself session start. */
export async function retainRepositoryCheckpointInitialEvidence(input: Readonly<{
    cwd: string; scopeId: string; checkpointRef: RepositoryCheckpointRef; captured: RepositoryCheckpointCaptureResult;
    recovered?: true; sessionIsNew?: boolean;
}>): Promise<void> {
    const existing = await readRepositoryCheckpointInitialEvidence(input);
    if (existing && !(input.recovered && existing.state === 'unavailable' && existing.recoverable)) return;
    if (!input.recovered && input.sessionIsNew !== true) {
        await writeJsonAtomic(join(await evidenceDirectory(input.cwd, input.scopeId), 'initial.json'), {
            state: 'unavailable', reason: 'Initial checkpoint requires canonical earliest prompt evidence for this resumed or unknown session', recoverable: true,
        });
        return;
    }
    let evidence: RepositoryCheckpointInitialEvidence;
    if (!input.captured.success) {
        evidence = { state: 'unavailable', reason: input.captured.error };
    } else {
        const olderRefs = await runGitCheckpointCommand({ cwd: input.cwd,
            args: ['for-each-ref', '--format=%(refname)', `${buildRepositoryCheckpointScopePrefix(input.scopeId)}message-start/`] });
        if (!input.recovered && (!olderRefs.success || olderRefs.stdout.split('\n').some((ref) => ref && ref !== input.checkpointRef.ref))) {
            await writeJsonAtomic(join(await evidenceDirectory(input.cwd, input.scopeId), 'initial.json'), {
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
    await writeJsonAtomic(join(await evidenceDirectory(input.cwd, input.scopeId), 'initial.json'), evidence);
}

export async function retainRepositoryCheckpointTurnEvidence(input: Readonly<{ cwd: string; scopeId: string; turnChangeSet: TurnChangeSet }>): Promise<void> {
    const parsed = TurnChangeSetSchema.parse(input.turnChangeSet);
    await writeJsonAtomic(join(await evidenceDirectory(input.cwd, input.scopeId), 'turns', `${encodeRepositoryCheckpointScope(parsed.turnId)}.json`), parsed);
}

export async function readRepositoryCheckpointTurnEvidence(input: Readonly<{ cwd: string; scopeId: string; turnId: string }>): Promise<TurnChangeSet | null> {
    try {
        return TurnChangeSetSchema.parse(JSON.parse(await readFile(join(await evidenceDirectory(input.cwd, input.scopeId), 'turns', `${encodeRepositoryCheckpointScope(input.turnId)}.json`), 'utf8')));
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
    try { entries = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const matches: TurnChangeSet[] = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const turn = TurnChangeSetSchema.parse(JSON.parse(await readFile(join(directory, entry), 'utf8')));
        if (turn.repositoryCheckpoint?.scopeId === input.scopeId
            && turn.repositoryCheckpoint.receipts.some((receipt) => receipt.id === input.receiptId || receipt.ref === input.receiptId)) matches.push(turn);
    }
    if (matches.length > 1) throw new Error('Checkpoint receipt selector is ambiguous; select an explicit turn');
    return matches[0] ?? null;
}

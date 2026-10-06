import { compareTurnChangeSetChronology } from '@happier-dev/protocol/sessions/changes/mergeTurnChangeSets';
import { extractCanonicalDiffFiles, readTurnChangeToolMetadata } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';
import { TurnChangeSetSchema } from '@happier-dev/protocol/sessions/changes/schemas';
import type { TurnChangeSet } from '@happier-dev/protocol';
import { decodeTranscriptBody } from '@/session/services/transcript/transcriptBodyDecoder';
import { parseRepositoryCheckpointRef } from './refs';
import { runGitCheckpointCommand } from './gitCheckpointCommands';
import { readRepositoryCheckpointInitialEvidence, readRepositoryCheckpointTurnEvidence,
    retainRepositoryCheckpointInitialEvidence, retainRepositoryCheckpointTurnEvidence } from './sessionEvidence';
import type { ReadRepositoryCheckpointTranscriptPage } from './readRepositoryCheckpointTranscriptPage';

/** Canonical transport evidence is opened and parsed by existing owners, never supplied by an Action caller. */
export async function recoverRepositoryCheckpointEvidence(input: Readonly<{
    cwd: string; sessionId: string; scopeId: string; readTranscriptPage: ReadRepositoryCheckpointTranscriptPage;
}>): Promise<void> {
    const turns = new Map<string, TurnChangeSet>();
    let earliestUserPrompt: { seq: number; localId?: string | null } | undefined;
    let afterSeq = 0;
    for (;;) {
        const page = await input.readTranscriptPage({ sessionId: input.sessionId, afterSeq });
        for (const message of page.messages) {
            const classified = decodeTranscriptBody(message.content);
            if (classified?.semanticRole === 'user' && (!earliestUserPrompt || message.seq < earliestUserPrompt.seq)) {
                earliestUserPrompt = { seq: message.seq, localId: message.localId };
            }
            for (const call of classified?.toolCalls ?? []) {
            if (call.name !== 'Diff') continue;
            const toolInput = call.input;
            const metadata = readTurnChangeToolMetadata(toolInput);
            if (!metadata || metadata.sessionId !== input.sessionId) continue;
            if (metadata.repositoryCheckpoint && metadata.repositoryCheckpoint.scopeId !== input.scopeId) continue;
            const candidate = TurnChangeSetSchema.parse({ sessionId: metadata.sessionId, turnId: metadata.turnId,
                seqRange: metadata.seqRange, status: metadata.turnStatus, provider: metadata.provider,
                derivedAt: message.createdAt, files: extractCanonicalDiffFiles(toolInput, metadata),
                ...(metadata.repositoryCheckpoint ? { repositoryCheckpoint: metadata.repositoryCheckpoint } : {}) });
            const previous = turns.get(candidate.turnId);
            turns.set(candidate.turnId, previous ? { ...candidate, files: [...previous.files, ...candidate.files],
                ...(candidate.repositoryCheckpoint ?? previous.repositoryCheckpoint
                    ? { repositoryCheckpoint: candidate.repositoryCheckpoint ?? previous.repositoryCheckpoint } : {}) } : candidate);
            }
        }
        if (!page.hasMore) break;
        if (page.nextAfterSeq === null || page.nextAfterSeq <= afterSeq) throw new Error('Checkpoint transcript continuation did not advance');
        afterSeq = page.nextAfterSeq;
    }
    const ordered = [...turns.values()].sort(compareTurnChangeSetChronology);
    for (const turn of ordered) {
        const existing = await readRepositoryCheckpointTurnEvidence({ cwd: input.cwd, scopeId: input.scopeId, turnId: turn.turnId });
        const checkpointFiles = existing?.files.filter((file) => file.source === 'scm_checkpoint') ?? [];
        await retainRepositoryCheckpointTurnEvidence({ cwd: input.cwd, scopeId: input.scopeId,
            turnChangeSet: { ...turn, files: [...(checkpointFiles.length ? checkpointFiles : turn.files.filter((file) => file.source === 'scm_checkpoint')),
                ...turn.files.filter((file) => file.source !== 'scm_checkpoint')],
                ...(existing?.repositoryCheckpoint ? { repositoryCheckpoint: existing.repositoryCheckpoint } : {}) } });
    }
    const initial = await readRepositoryCheckpointInitialEvidence(input);
    if (initial && !(initial.state === 'unavailable' && initial.recoverable)) return;
    const first = ordered[0];
    const receipt = first?.repositoryCheckpoint?.receipts.find((item) => item.id === 'checkpoint.captured' && item.phase === 'message-start' && item.ref && item.commitSha && item.treeSha);
    if (!receipt?.ref || !receipt.commitSha || !receipt.treeSha) return;
    const checkpointRef = parseRepositoryCheckpointRef({ scopeId: input.scopeId, ref: receipt.ref });
    if (!checkpointRef || checkpointRef.phase !== 'message-start'
        || !earliestUserPrompt?.localId || checkpointRef.checkpointId !== earliestUserPrompt.localId) return;
    const commit = await runGitCheckpointCommand({ cwd: input.cwd, args: ['rev-parse', '--verify', `${receipt.ref}^{commit}`] });
    const tree = await runGitCheckpointCommand({ cwd: input.cwd, args: ['rev-parse', '--verify', `${receipt.ref}^{tree}`] });
    if (!commit.success || !tree.success || commit.stdout.trim() !== receipt.commitSha || tree.stdout.trim() !== receipt.treeSha) return;
    await retainRepositoryCheckpointInitialEvidence({ ...input, checkpointRef, recovered: true,
        captured: { success: true, checkpointRef, commitSha: receipt.commitSha, treeSha: receipt.treeSha, receipts: [] } });
}

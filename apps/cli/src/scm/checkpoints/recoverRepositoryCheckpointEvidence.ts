import { compareTurnChangeSetChronology } from '@happier-dev/protocol/sessions/changes/mergeTurnChangeSets';
import { extractCanonicalDiffFiles, readTurnChangeToolMetadata } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';
import { TurnChangeSetSchema } from '@happier-dev/protocol/sessions/changes/schemas';
import type { TurnChangeSet } from '@happier-dev/protocol';
import { decodeTranscriptBody } from '@/session/services/transcript/transcriptBodyDecoder';
import { parseRepositoryCheckpointRef } from './refs';
import { runGitCheckpointCommand } from './gitCheckpointCommands';
import { readRepositoryCheckpointInitialEvidence, readRepositoryCheckpointTurnEvidence,
    retainRepositoryCheckpointInitialEvidence, retainRepositoryCheckpointTurnEvidence } from './sessionEvidence';
import type { ReadRepositoryCheckpointTranscriptPage, RepositoryCheckpointTranscriptPage, RepositoryCheckpointTranscriptEvidence } from './readRepositoryCheckpointTranscriptPage';

/** Keep transcript parsing at its owner before evidence crosses into a folder member's process. */
export function projectRepositoryCheckpointTranscriptPage(input: Readonly<{
    page: RepositoryCheckpointTranscriptPage; sessionId: string; scopeId: string;
    turnId?: string;
}>): Readonly<{ evidence: RepositoryCheckpointTranscriptEvidence; hasMore: boolean; nextAfterSeq: number | null }> {
    if ('evidence' in input.page) return input.page;
    const turns: TurnChangeSet[] = [];
    let earliestUserPrompt: RepositoryCheckpointTranscriptEvidence['earliestUserPrompt'];
    for (const message of input.page.messages) {
        const classified = decodeTranscriptBody(message.content);
        if (!input.turnId && classified?.semanticRole === 'user'
            && (!earliestUserPrompt || message.seq < earliestUserPrompt.seq)) {
            earliestUserPrompt = { seq: message.seq, localId: message.localId };
        }
        for (const call of classified?.toolCalls ?? []) {
            if (call.name !== 'Diff') continue;
            const metadata = readTurnChangeToolMetadata(call.input);
            if (!metadata || metadata.sessionId !== input.sessionId) continue;
            if (metadata.repositoryCheckpoint && metadata.repositoryCheckpoint.scopeId !== input.scopeId) continue;
            if (input.turnId && metadata.turnId !== input.turnId) continue;
            turns.push(TurnChangeSetSchema.parse({ sessionId: metadata.sessionId, turnId: metadata.turnId,
                seqRange: metadata.seqRange, status: metadata.turnStatus, provider: metadata.provider,
                derivedAt: message.createdAt, files: extractCanonicalDiffFiles(call.input, metadata),
                ...(metadata.repositoryCheckpoint ? { repositoryCheckpoint: metadata.repositoryCheckpoint } : {}) }));
        }
    }
    return { evidence: { turns, ...(earliestUserPrompt ? { earliestUserPrompt } : {}) },
        hasMore: input.page.hasMore, nextAfterSeq: input.page.nextAfterSeq };
}

/** A receipt can identify a turn after earlier pages already supplied that turn's Diff fragments. */
export async function readRepositoryCheckpointTranscriptEvidence(input: Readonly<{
    readTranscriptPage: ReadRepositoryCheckpointTranscriptPage;
    sessionId: string; scopeId: string; afterSeq?: number; turnId?: string; checkpointReceiptId?: string;
}>): Promise<Readonly<{ evidence: RepositoryCheckpointTranscriptEvidence; hasMore: boolean; nextAfterSeq: number | null }>> {
    if (!input.checkpointReceiptId || input.turnId) {
        return projectRepositoryCheckpointTranscriptPage({ ...input,
            page: await input.readTranscriptPage({ sessionId: input.sessionId, scopeId: input.scopeId, afterSeq: input.afterSeq }) });
    }
    const turns: TurnChangeSet[] = [];
    let afterSeq = input.afterSeq ?? 0;
    for (;;) {
        const page = projectRepositoryCheckpointTranscriptPage({ ...input,
            page: await input.readTranscriptPage({ sessionId: input.sessionId, scopeId: input.scopeId, afterSeq }) });
        turns.push(...page.evidence.turns);
        if (!page.hasMore) break;
        if (page.nextAfterSeq === null || page.nextAfterSeq <= afterSeq) throw new Error('Checkpoint transcript continuation did not advance');
        afterSeq = page.nextAfterSeq;
    }
    const selected = new Set(turns.filter(turn => turn.repositoryCheckpoint?.receipts.some(receipt =>
        receipt.id === input.checkpointReceiptId || receipt.ref === input.checkpointReceiptId)).map(turn => turn.turnId));
    return { evidence: { turns: turns.filter(turn => selected.has(turn.turnId)) }, hasMore: false, nextAfterSeq: null };
}

/** Canonical transport evidence is opened and parsed by existing owners, never supplied by an Action caller. */
export async function recoverRepositoryCheckpointEvidence(input: Readonly<{
    cwd: string; sessionId: string; scopeId: string; readTranscriptPage: ReadRepositoryCheckpointTranscriptPage;
}>): Promise<void> {
    const turns = new Map<string, TurnChangeSet>();
    let earliestUserPrompt: { seq: number; localId?: string | null } | undefined;
    let afterSeq = 0;
    for (;;) {
        const page = projectRepositoryCheckpointTranscriptPage({ ...input,
            page: await input.readTranscriptPage({ sessionId: input.sessionId, scopeId: input.scopeId, afterSeq }) });
        if (page.evidence.earliestUserPrompt && (!earliestUserPrompt || page.evidence.earliestUserPrompt.seq < earliestUserPrompt.seq)) {
            earliestUserPrompt = page.evidence.earliestUserPrompt;
        }
        for (const candidate of page.evidence.turns) {
            const previous = turns.get(candidate.turnId);
            turns.set(candidate.turnId, previous ? { ...candidate, files: [...previous.files, ...candidate.files],
                ...(candidate.repositoryCheckpoint ?? previous.repositoryCheckpoint
                    ? { repositoryCheckpoint: candidate.repositoryCheckpoint ?? previous.repositoryCheckpoint } : {}) } : candidate);
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

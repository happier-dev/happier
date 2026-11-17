import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import { extractCanonicalDiffFiles, readTurnChangeToolMetadata } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createHostScmCommandRunner, type ScmCommandRunner } from '@/scm/runtime';
import { createRepositoryCheckpointPromptLifecycle } from './repositoryCheckpointPromptLifecycle';

const execFile = promisify(execFileCallback);

async function createWorkspace(kind: 'git' | 'not_repo'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `happier-checkpoint-send-${kind}-`));
    if (kind === 'git') {
        const git = (...args: string[]) => execFile('git', args, { cwd: dir });
        await git('init', '-q');
        await writeFile(join(dir, 'tracked.txt'), 'before\n');
        await git('add', 'tracked.txt');
        await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial');
    }
    return dir;
}

describe('repository checkpoint on the send path', () => {
    it.each(['not_repo', 'git'] as const)('[p03redesign.F1] discovers the repository before each send, not on it (%s)', async kind => {
        const dir = await createWorkspace(kind);
        // The exec service is the boundary (the daemon's systemTool in production); real Git runs beneath it.
        const host = createHostScmCommandRunner({ isCurrent: () => true });
        const commands: string[] = [];
        let inFlight = 0;
        const scmCommandRunner: ScmCommandRunner = async command => {
            commands.push(command.args.join(' '));
            inFlight += 1;
            try { return await host(command); } finally { inFlight -= 1; }
        };
        const session = createMutableApiSessionClientFixture({ overrides: { sessionId: `send-path-${kind}`,
            async enqueueAgentMessageCommitted() { return { persisted: true, delivered: false }; } } });
        const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: dir, provider: 'codex',
            source: { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } }, scmCommandRunner });
        const discoveriesOnSend: number[] = [];
        try {
            for (let turn = 1; turn <= 2; turn += 1) {
                // The person types the next message while the Session is idle.
                await new Promise<void>(resolve => setImmediate(resolve));
                await vi.waitFor(() => expect(inFlight).toBe(0));
                const before = commands.length;
                await lifecycle.onBeforePromptDispatch?.({ messageId: `message-${turn}`, prompt: 'reply' });
                discoveriesOnSend.push(commands.slice(before).filter(command => command === 'rev-parse --show-toplevel').length);
                await lifecycle.onTurnStarted?.({ messageId: `message-${turn}`, turnId: `turn-${turn}`, sequence: turn * 10 });
                await lifecycle.onTurnFinal?.({ messageId: `message-${turn}`, turnId: `turn-${turn}`, status: 'completed', sequence: turn * 10 + 1 });
            }
            expect(discoveriesOnSend).toEqual([0, 0]);
        } finally {
            await lifecycle.onSessionEnd?.();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('[p03.CHECKPOINT-OP] runs each checkpoint as a few Git processes and keeps the card', async () => {
        const dir = await createWorkspace('git');
        const git = (cwd: string, ...args: string[]) => execFile('git', args, { cwd });
        const commit = (cwd: string, message: string) => git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
        // Fixture: renamed, deleted, binary and submodule (gitlink) paths besides the dirty and untracked ones.
        await writeFile(join(dir, 'rename-me.txt'), 'stable content for rename detection\n'.repeat(4));
        await writeFile(join(dir, 'delete-me.txt'), 'gone\n');
        await writeFile(join(dir, 'image.bin'), Buffer.from([0, 1, 2, 255, 0, 13, 10]));
        const sub = join(dir, 'sub');
        await mkdir(sub);
        await git(sub, 'init', '-q');
        await writeFile(join(sub, 'inner.txt'), 'inner\n');
        await git(sub, 'add', 'inner.txt');
        await commit(sub, 'inner');
        await git(dir, 'add', '-A');
        await commit(dir, 'fixture');
        const host = createHostScmCommandRunner({ isCurrent: () => true });
        let phase = 'open';
        let inFlight = 0;
        const commands: Record<string, string[]> = {};
        const scmCommandRunner: ScmCommandRunner = async command => {
            // `-c key=value` and `--no-replace-objects` are options of the one process, not commands.
            const args = [...command.args];
            while (args[0] === '-c' || args[0] === '--no-replace-objects') args.splice(0, args[0] === '-c' ? 2 : 1);
            // Discovery for the next send is prepared while the Session goes idle, off both critical paths.
            (commands[args.includes('--show-toplevel') ? 'discover' : phase] ??= []).push(args[0] ?? '');
            inFlight += 1;
            try { return await host(command); } finally { inFlight -= 1; }
        };
        const messages: ACPMessageData[] = [];
        const session = createMutableApiSessionClientFixture({ overrides: { sessionId: 'checkpoint-op',
            async enqueueAgentMessageCommitted(_provider, body) { messages.push(body); return { persisted: true, delivered: false }; } } });
        const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: dir, provider: 'codex', sessionIsNew: true,
            source: { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } }, scmCommandRunner });
        const settle = async (next: string) => {
            await new Promise<void>(resolve => setImmediate(resolve));
            await vi.waitFor(() => expect(inFlight).toBe(0));
            phase = next;
        };
        try {
            for (let turn = 1; turn <= 2; turn += 1) {
                await settle(`send-${turn}`);
                await lifecycle.onBeforePromptDispatch?.({ messageId: `message-${turn}`, prompt: 'edit' });
                await settle(`start-${turn}`);
                await lifecycle.onTurnStarted?.({ messageId: `message-${turn}`, turnId: `turn-${turn}`, sequence: turn * 10 });
                await settle(`work-${turn}`);
                if (turn === 2) {
                    await writeFile(join(dir, 'tracked.txt'), 'after\n');
                    await writeFile(join(dir, 'untracked.txt'), 'new\n');
                    await rename(join(dir, 'rename-me.txt'), join(dir, 'renamed.txt'));
                    await rm(join(dir, 'delete-me.txt'));
                    await writeFile(join(dir, 'image.bin'), Buffer.from([0, 9, 9, 255, 0]));
                    await writeFile(join(sub, 'inner.txt'), 'inner 2\n');
                    await git(sub, 'add', 'inner.txt');
                    await commit(sub, 'inner 2');
                }
                await settle(`end-${turn}`);
                await lifecycle.publishTurnChangeSet({ eventKind: 'turn-final', turnChangeSet: {
                    sessionId: session.sessionId, turnId: `turn-${turn}`, seqRange: { startSeqInclusive: turn * 10, endSeqInclusive: turn * 10 + 1 },
                    status: 'completed', provider: 'codex', derivedAt: 1, files: [] } });
            }
            await settle('idle');
            const cards = messages.filter(message => message.type === 'tool-call' && message.name === 'Diff');
            const card = cards.at(-1);
            if (!card || card.type !== 'tool-call') throw new Error('Missing checkpoint card');
            const files = extractCanonicalDiffFiles(card.input, readTurnChangeToolMetadata(card.input)!)
                .map(file => ({ filePath: file.filePath, previousFilePath: file.previousFilePath ?? null, changeKind: file.changeKind,
                    source: file.source, binary: file.binary === true, diff: typeof file.unifiedDiff === 'string' && file.unifiedDiff.length > 0 }))
                .sort((a, b) => a.filePath.localeCompare(b.filePath));
            expect(files).toEqual([
                { filePath: 'delete-me.txt', previousFilePath: null, changeKind: 'deleted', source: 'scm_checkpoint', binary: false, diff: true },
                { filePath: 'image.bin', previousFilePath: null, changeKind: 'modified', source: 'scm_checkpoint', binary: true, diff: true },
                { filePath: 'renamed.txt', previousFilePath: 'rename-me.txt', changeKind: 'renamed', source: 'scm_checkpoint', binary: false, diff: true },
                { filePath: 'sub', previousFilePath: null, changeKind: 'modified', source: 'scm_checkpoint', binary: false, diff: true },
                { filePath: 'tracked.txt', previousFilePath: null, changeKind: 'modified', source: 'scm_checkpoint', binary: false, diff: true },
                { filePath: 'untracked.txt', previousFilePath: null, changeKind: 'added', source: 'scm_checkpoint', binary: false, diff: true },
            ]);
            // A steady-state turn: one discovery while idle, then three short Git sequences.
            expect({ send: commands['send-2'], start: commands['start-2'], end: commands['end-2'] }).toEqual({
                send: ['add', 'write-tree', 'commit-tree', 'update-ref'],
                start: ['update-ref'],
                end: ['add', 'write-tree', 'commit-tree', 'update-ref', 'diff'],
            });
            expect(commands['work-2'] ?? []).toEqual([]);
            expect(commands.idle ?? []).toEqual([]);
            // Session open + after each of the two turns.
            expect(commands.discover).toEqual(['rev-parse', 'rev-parse', 'rev-parse']);
        } finally {
            await lifecycle.onSessionEnd?.();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

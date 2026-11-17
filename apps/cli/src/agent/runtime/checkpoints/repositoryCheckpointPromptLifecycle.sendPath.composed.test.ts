import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { runRepositoryCheckpointPhaseHere } from '@/scm/checkpoints/repositoryCheckpointPhase';
import {
    decodeRunnerDaemonPluginServiceWireValueV1,
    encodeRunnerDaemonPluginServiceWireValueV1,
    RunnerDaemonPluginServiceOperationV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import type { RunnerDaemonPluginServicesDispatchV1 } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { createRunnerDaemonScmCheckpointPhaseRunner, createRunnerDaemonScmCommandRunner } from '@/agent/runtime/session/process/runnerDaemonScmCommand';

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

    // Fixture: renamed, deleted, binary and submodule (gitlink) paths besides the dirty and untracked ones.
    async function runCheckpointFixture(transport: 'per-command' | 'daemon-phase') {
        const dir = await createWorkspace('git');
        const git = (cwd: string, ...args: string[]) => execFile('git', args, { cwd });
        const commit = (cwd: string, message: string) => git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
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
        const roundTrips: Record<string, string[]> = {};
        // The exec service is the process boundary; every Git process is counted where it runs.
        const gitProcesses: ScmCommandRunner = async command => {
            // `-c key=value` and `--no-replace-objects` are options of the one process, not commands.
            const args = [...command.args];
            while (args[0] === '-c' || args[0] === '--no-replace-objects') args.splice(0, args[0] === '-c' ? 2 : 1);
            // Discovery for the next send is prepared while the Session goes idle, off both critical paths.
            (commands[args.includes('--show-toplevel') ? 'discover' : phase] ??= []).push(args[0] ?? '');
            inFlight += 1;
            try { return await host(command); } finally { inFlight -= 1; }
        };
        // The runner→daemon services channel is the transport boundary: operations cross it as wire values,
        // and the daemon side runs them as its `host_scm.*` cases do.
        const dispatch: RunnerDaemonPluginServicesDispatchV1 = async sent => {
            const operation = RunnerDaemonPluginServiceOperationV1Schema.parse(JSON.parse(JSON.stringify(sent)));
            if (!operation.kind.startsWith('host_scm.') || !('command' in operation && operation.command.args.includes('--show-toplevel'))) {
                (roundTrips[phase] ??= []).push(operation.kind);
            }
            const reply = async (): Promise<unknown> => {
                if (operation.kind === 'host_scm.checkpoint_v1') {
                    return JSON.parse(JSON.stringify(await runRepositoryCheckpointPhaseHere(operation.checkpoint, { scmCommandRunner: gitProcesses })));
                }
                if (operation.kind !== 'host_scm.run_v1') throw new Error(`Unexpected operation ${operation.kind}`);
                const { command } = operation;
                return await gitProcesses({ bin: command.bin, cwd: command.cwd, args: command.args,
                    ...(command.stdin !== undefined ? { stdin: command.stdin } : {}),
                    ...(command.env ? { env: Object.fromEntries(Object.entries(command.env).map(([key, value]) => [key, value ?? undefined])) } : {}) });
            };
            return decodeRunnerDaemonPluginServiceWireValueV1(encodeRunnerDaemonPluginServiceWireValueV1(await reply()));
        };
        const requestBase = () => ({ requestId: randomUUID(), invocationId: 'checkpoint-op' });
        const ports = transport === 'per-command' ? { scmCommandRunner: gitProcesses } : {
            scmCommandRunner: createRunnerDaemonScmCommandRunner({ dispatch, requestBase }),
            scmCheckpointPhaseRunner: createRunnerDaemonScmCheckpointPhaseRunner({ dispatch, requestBase }),
        };
        const messages: ACPMessageData[] = [];
        const session = createMutableApiSessionClientFixture({ overrides: { sessionId: 'checkpoint-op',
            async enqueueAgentMessageCommitted(_provider, body) { messages.push(body); return { persisted: true, delivered: false }; } } });
        const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: dir, provider: 'codex', sessionIsNew: true,
            source: { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } }, ...ports });
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
            return { files, commands, roundTrips };
        } finally {
            await lifecycle.onSessionEnd?.();
            await rm(dir, { recursive: true, force: true });
        }
    }

    const EXPECTED_CARD = [
        { filePath: 'delete-me.txt', previousFilePath: null, changeKind: 'deleted', source: 'scm_checkpoint', binary: false, diff: true },
        { filePath: 'image.bin', previousFilePath: null, changeKind: 'modified', source: 'scm_checkpoint', binary: true, diff: true },
        { filePath: 'renamed.txt', previousFilePath: 'rename-me.txt', changeKind: 'renamed', source: 'scm_checkpoint', binary: false, diff: true },
        { filePath: 'sub', previousFilePath: null, changeKind: 'modified', source: 'scm_checkpoint', binary: false, diff: true },
        { filePath: 'tracked.txt', previousFilePath: null, changeKind: 'modified', source: 'scm_checkpoint', binary: false, diff: true },
        { filePath: 'untracked.txt', previousFilePath: null, changeKind: 'added', source: 'scm_checkpoint', binary: false, diff: true },
    ];

    it('[p03.CHECKPOINT-OP] runs each checkpoint as a few Git processes and keeps the card', async () => {
        const { files, commands } = await runCheckpointFixture('per-command');
        expect(files).toEqual(EXPECTED_CARD);
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
    });

    it('[p03.CHECKPOINT-OP-2] runs each checkpoint phase as one daemon operation and keeps the card', async () => {
        const { files, commands, roundTrips } = await runCheckpointFixture('daemon-phase');
        expect(files).toEqual(EXPECTED_CARD);
        expect({ send: roundTrips['send-2'], start: roundTrips['start-2'], end: roundTrips['end-2'] }).toEqual({
            send: ['host_scm.checkpoint_v1'], start: ['host_scm.run_v1'], end: ['host_scm.checkpoint_v1'],
        });
        // The same Git processes, now local to the daemon.
        expect({ send: commands['send-2'], start: commands['start-2'], end: commands['end-2'] }).toEqual({
            send: ['add', 'write-tree', 'commit-tree', 'update-ref'],
            start: ['update-ref'],
            end: ['add', 'write-tree', 'commit-tree', 'update-ref', 'diff'],
        });
        expect([...Object.keys(roundTrips)].filter(name => name.startsWith('work-') || name === 'idle')).toEqual([]);
    });
});

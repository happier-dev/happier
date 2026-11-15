import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

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
});

import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { buildRepositoryCheckpointRefs } from '@/scm/checkpoints';

import { createRepositoryCheckpointPromptLifecycle } from './repositoryCheckpointPromptLifecycle';

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd, env: process.env });
    return stdout.trim();
}

async function createGitRepo(): Promise<string> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'happier-checkpoint-lifecycle-'));
    await runGit(repoRoot, ['init']);
    await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
    await runGit(repoRoot, ['config', 'user.name', 'Happier Test']);
    await writeFile(join(repoRoot, 'tracked.txt'), 'initial\n', 'utf8');
    await runGit(repoRoot, ['add', 'tracked.txt']);
    await runGit(repoRoot, ['commit', '-m', 'initial']);
    return await runGit(repoRoot, ['rev-parse', '--show-toplevel']);
}

function createMessageCapturingSession(sessionId: string): Readonly<{
    session: ApiSessionClient;
    messages: ACPMessageData[];
}> {
    const messages: ACPMessageData[] = [];
    const session = createMutableApiSessionClientFixture({
        overrides: {
            sessionId,
            sendAgentMessage(_provider, body) {
                messages.push(body);
            },
        },
    });
    return { session, messages };
}

function readCheckpointMeta(messages: readonly ACPMessageData[]): Record<string, unknown> | null {
    const toolCall = messages.find((message) => message.type === 'tool-call');
    const input = toolCall && 'input' in toolCall && toolCall.input && typeof toolCall.input === 'object'
        ? toolCall.input as Record<string, unknown>
        : null;
    const meta = input?._happier;
    if (!meta || typeof meta !== 'object') return null;
    const checkpoint = (meta as Record<string, unknown>).repositoryCheckpoint;
    return checkpoint && typeof checkpoint === 'object' ? checkpoint as Record<string, unknown> : null;
}

describe('createRepositoryCheckpointPromptLifecycle', () => {
    it('does not persist unavailable checkpoint metadata without file evidence', async () => {
        const runtimeDirectory = await mkdtemp(join(tmpdir(), 'happier-checkpoint-nongit-'));
        try {
            const { session, messages } = createMessageCapturingSession('session-nongit');
            const lifecycle = createRepositoryCheckpointPromptLifecycle({
                session,
                runtimeDirectory,
                provider: 'codex',
                protocol: 'codex',
            });

            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message-1', prompt: 'change nothing' });
            await lifecycle.onTurnStarted?.({ messageId: 'message-1', turnId: 'turn-1' });
            await lifecycle.onTurnFinal?.({ messageId: 'message-1', turnId: 'turn-1', status: 'completed' });

            expect(messages).toEqual([]);
        } finally {
            await rm(runtimeDirectory, { recursive: true, force: true });
        }
    });

    it('does not persist zero-file checkpoint diffs as user-visible Diff messages', async () => {
        const repoRoot = await createGitRepo();
        try {
            const { session, messages } = createMessageCapturingSession('session-zero');
            const lifecycle = createRepositoryCheckpointPromptLifecycle({
                session,
                runtimeDirectory: repoRoot,
                provider: 'codex',
                protocol: 'codex',
            });

            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message-1', prompt: 'change nothing' });
            await lifecycle.onTurnStarted?.({ messageId: 'message-1', turnId: 'turn-1' });
            await lifecycle.onTurnFinal?.({ messageId: 'message-1', turnId: 'turn-1', status: 'completed' });

            expect(messages).toEqual([]);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('projects changed checkpoint diffs with diff_computed receipts', async () => {
        const repoRoot = await createGitRepo();
        try {
            const { session, messages } = createMessageCapturingSession('session-changed');
            const lifecycle = createRepositoryCheckpointPromptLifecycle({
                session,
                runtimeDirectory: repoRoot,
                provider: 'codex',
                protocol: 'codex',
            });

            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message-1', prompt: 'change tracked.txt' });
            await lifecycle.onTurnStarted?.({ messageId: 'message-1', turnId: 'turn-1' });
            await writeFile(join(repoRoot, 'tracked.txt'), 'changed\n', 'utf8');
            await lifecycle.onTurnFinal?.({ messageId: 'message-1', turnId: 'turn-1', status: 'completed' });

            const toolCall = messages.find((message) => message.type === 'tool-call');
            const input = toolCall && 'input' in toolCall && toolCall.input && typeof toolCall.input === 'object'
                ? toolCall.input as Record<string, unknown>
                : null;

            expect(messages.map((message) => message.type)).toEqual(['tool-call', 'tool-result']);
            expect(input?.files).toEqual([
                expect.objectContaining({
                    file_path: 'tracked.txt',
                    source: 'scm_checkpoint',
                    confidence: 'exact',
                    provider: 'scm:git',
                    unified_diff: expect.stringContaining('+changed'),
                }),
            ]);
            expect(readCheckpointMeta(messages)).toMatchObject({
                contentConfidence: 'exact',
                baseRefSource: 'turn_start',
                receipts: expect.arrayContaining([
                    expect.objectContaining({ id: 'checkpoint.captured', phase: 'message-start' }),
                    expect.objectContaining({ id: 'checkpoint.aliased', phase: 'turn-start' }),
                    expect.objectContaining({ id: 'checkpoint.finalized', phase: 'turn-final' }),
                    expect.objectContaining({ id: 'checkpoint.diff_computed' }),
                ]),
            });
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('falls back to the message-start checkpoint when a runtime does not emit turn-start', async () => {
        const repoRoot = await createGitRepo();
        try {
            const { session, messages } = createMessageCapturingSession('session-message-start-fallback');
            const lifecycle = createRepositoryCheckpointPromptLifecycle({
                session,
                runtimeDirectory: repoRoot,
                provider: 'codex',
                protocol: 'codex',
            });

            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message-1', prompt: 'change nothing' });
            await lifecycle.onTurnFinal?.({ messageId: 'message-1', turnId: 'turn-1', status: 'completed' });

            expect(messages).toEqual([]);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('projects alias failure checkpoint metadata when the message-start ref disappears', async () => {
        const repoRoot = await createGitRepo();
        try {
            const { session, messages } = createMessageCapturingSession('session-alias');
            const lifecycle = createRepositoryCheckpointPromptLifecycle({
                session,
                runtimeDirectory: repoRoot,
                provider: 'codex',
                protocol: 'codex',
            });
            const refs = buildRepositoryCheckpointRefs({
                scopeId: `session-alias:${repoRoot}`,
                messageId: 'message-1',
                turnId: 'turn-1',
            });

            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message-1', prompt: 'change nothing' });
            await runGit(repoRoot, ['update-ref', '-d', refs.messageStart!.ref]);
            await lifecycle.onTurnStarted?.({ messageId: 'message-1', turnId: 'turn-1' });
            await lifecycle.onTurnFinal?.({ messageId: 'message-1', turnId: 'turn-1', status: 'completed' });

            expect(messages).toEqual([]);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('projects final capture failure checkpoint metadata', async () => {
        const repoRoot = await createGitRepo();
        try {
            const { session, messages } = createMessageCapturingSession('session-final');
            const lifecycle = createRepositoryCheckpointPromptLifecycle({
                session,
                runtimeDirectory: repoRoot,
                provider: 'codex',
                protocol: 'codex',
            });

            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message-1', prompt: 'change nothing' });
            await lifecycle.onTurnStarted?.({ messageId: 'message-1', turnId: 'turn-1' });
            await rename(join(repoRoot, '.git'), join(repoRoot, '.git.removed'));
            await lifecycle.onTurnFinal?.({ messageId: 'message-1', turnId: 'turn-1', status: 'completed' });

            expect(messages).toEqual([]);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('projects diff failure checkpoint metadata', async () => {
        const repoRoot = await createGitRepo();
        try {
            const { session, messages } = createMessageCapturingSession('session-diff');
            const lifecycle = createRepositoryCheckpointPromptLifecycle({
                session,
                runtimeDirectory: repoRoot,
                provider: 'codex',
                protocol: 'codex',
            });
            const refs = buildRepositoryCheckpointRefs({
                scopeId: `session-diff:${repoRoot}`,
                messageId: 'message-1',
                turnId: 'turn-1',
            });

            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message-1', prompt: 'change nothing' });
            await lifecycle.onTurnStarted?.({ messageId: 'message-1', turnId: 'turn-1' });
            await runGit(repoRoot, ['update-ref', '-d', refs.turnStart!.ref]);
            await lifecycle.onTurnFinal?.({ messageId: 'message-1', turnId: 'turn-1', status: 'completed' });

            expect(messages).toEqual([]);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });
});

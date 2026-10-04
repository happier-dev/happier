import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareTurnChangeSetChronology, mergeTurnChangeSets } from '@happier-dev/protocol';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { buildRepositoryCheckpointRefs } from '@/scm/checkpoints';
import { NormalizedToolTurnChangeTracker } from '@/agent/tools/diff/normalizedToolTurnChangeTracker';
import { buildTurnChangeSetDiffInput } from '@/agent/tools/diff/buildTurnChangeSetDiffInput';
import { deriveTurnChangeSetsFromMessages } from '../../../../../ui/sources/sync/domains/session/changes/derivation/deriveTurnChangeSetsFromMessages';
import type { Message } from '@happier-dev/session-core';

import { createRepositoryCheckpointPromptLifecycle } from './repositoryCheckpointPromptLifecycle';
import { createWorktreeAttributionRegistry } from './worktreeAttributionRegistry';
import * as scmRuntime from '@/scm/runtime';
import { readRepositoryCheckpointInitialEvidence } from '@/scm/checkpoints/sessionEvidence';
import { encodeRepositoryCheckpointScope } from '@/scm/checkpoints/refs';
import { recoverRepositoryCheckpointEvidence } from '@/scm/checkpoints/recoverRepositoryCheckpointEvidence';

/**
 * Only the SCM/process boundary is controlled: the real Git checkpoint adapter still runs, but the
 * test can interleave a peer capture interval at the exact final-capture and diff boundaries.
 */
const checkpointBoundaryHooks = vi.hoisted(() => ({
    beforeFinalCapture: null as null | (() => void),
    beforeDiff: null as null | (() => void),
}));

vi.mock('@/scm/checkpoints/gitCheckpointAdapter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/scm/checkpoints/gitCheckpointAdapter')>();
    return {
        ...actual,
        gitCheckpointAdapter: {
            ...actual.gitCheckpointAdapter,
            async capture(request: Parameters<typeof actual.gitCheckpointAdapter.capture>[0]) {
                if (request.checkpointRef.phase === 'turn-final') {
                    checkpointBoundaryHooks.beforeFinalCapture?.();
                }
                return await actual.gitCheckpointAdapter.capture(request);
            },
            async diff(request: Parameters<typeof actual.gitCheckpointAdapter.diff>[0]) {
                checkpointBoundaryHooks.beforeDiff?.();
                return await actual.gitCheckpointAdapter.diff(request);
            },
        },
    };
});

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
            async enqueueAgentMessageCommitted(_provider, body) {
                messages.push(body);
                return { persisted: true, delivered: false };
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
    it('does not invent a session initial baseline when a resumed session has no retained local evidence', async () => {
        const repoRoot = await createGitRepo();
        const { session } = createMessageCapturingSession('old-session-with-pruned-checkpoints');
        const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: repoRoot,
            provider: 'codex', protocol: 'codex', sessionIsNew: false });
        try {
            await writeFile(join(repoRoot, 'tracked.txt'), 'already changed before resume\n');
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'resumed', prompt: 'continue' });
            expect(await readRepositoryCheckpointInitialEvidence({ cwd: repoRoot, scopeId: `${session.sessionId}:${repoRoot}` })).toMatchObject({
                state: 'unavailable', recoverable: true,
            });
        } finally { await lifecycle.onSessionEnd?.(); await rm(repoRoot, { recursive: true, force: true }); }
    });
    it('does not inherit initial-session newness after the current session transport is swapped', async () => {
        const repoRoot = await createGitRepo(); let sessionId = 'fresh-original-session';
        const { session } = createMessageCapturingSession(sessionId);
        Object.defineProperty(session, 'sessionId', { get: () => sessionId });
        const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: repoRoot,
            provider: 'codex', protocol: 'codex', sessionIsNew: true });
        try {
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'first', prompt: 'edit' });
            sessionId = 'older-swapped-session';
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'swapped', prompt: 'continue old session' });
            expect(await readRepositoryCheckpointInitialEvidence({ cwd: repoRoot, scopeId: `${sessionId}:${repoRoot}` })).toMatchObject({ state: 'unavailable', recoverable: true });
        } finally { await lifecycle.onSessionEnd?.(); await rm(repoRoot, { recursive: true, force: true }); }
    });
    it('pins the first pre-dispatch snapshot across turns and resumed lifecycles', async () => {
        const repoRoot = await createGitRepo();
        const { session } = createMessageCapturingSession('session-initial');
        const initialRef = `${buildRepositoryCheckpointRefs({ scopeId: `${session.sessionId}:${repoRoot}` }).encodedScope}`;
        const ref = `refs/happier/checkpoints/${initialRef}/session-initial`;
        let lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: repoRoot, provider: 'codex', protocol: 'codex', sessionIsNew: true });
        try {
            await writeFile(join(repoRoot, 'tracked.txt'), 'pre-existing dirt\n');
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'first', prompt: 'edit' });
            const baseline = await runGit(repoRoot, ['rev-parse', '--verify', ref]);
            expect(await runGit(repoRoot, ['show', `${baseline}:tracked.txt`])).toBe('pre-existing dirt');
            await writeFile(join(repoRoot, 'tracked.txt'), 'agent change\n');
            await lifecycle.onSessionEnd?.();
            lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: repoRoot, provider: 'codex', protocol: 'codex' });
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'resumed', prompt: 'continue' });
            expect(await runGit(repoRoot, ['rev-parse', '--verify', ref])).toBe(baseline);
        } finally {
            await lifecycle.onSessionEnd?.();
            await rm(repoRoot, { recursive: true, force: true });
        }
    });
    it('recovers an older initial receipt from complete canonical transcript pages but never a later receipt', async () => {
        const repoRoot = await createGitRepo(); const { session, messages } = createMessageCapturingSession('legacy-initial');
        const scopeId = `${session.sessionId}:${repoRoot}`;
        const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: repoRoot, provider: 'codex', protocol: 'codex', sessionIsNew: true });
        try {
            await writeFile(join(repoRoot, 'tracked.txt'), 'legacy initial dirt\n');
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'first', prompt: 'edit' });
            await lifecycle.onTurnStarted?.({ messageId: 'first', turnId: 'legacy-turn', sequence: 2 });
            await writeFile(join(repoRoot, 'tracked.txt'), 'legacy agent change\n');
            await lifecycle.onTurnFinal?.({ messageId: 'first', turnId: 'legacy-turn', status: 'completed', sequence: 3 });
            const toolCall = messages.find((message) => message.type === 'tool-call');
            if (!toolCall) throw new Error('Missing canonical tool message');
            const clearInitial = async () => {
                await runGit(repoRoot, ['update-ref', '-d', `refs/happier/checkpoints/${encodeRepositoryCheckpointScope(scopeId)}/session-initial`]);
                await rm(join(repoRoot, '.git', 'happier', 'checkpoint-evidence', encodeRepositoryCheckpointScope(scopeId)), { recursive: true, force: true });
            };
            await clearInitial();
            const read = (firstPromptId: string) => async ({ afterSeq }: { afterSeq?: number }) => afterSeq === 1
                ? { messages: [{ seq: 4, createdAt: 4, content: { role: 'agent', content: { type: 'acp', provider: 'codex', data: toolCall } } }], hasMore: false, nextAfterSeq: null }
                : { messages: [{ seq: 1, createdAt: 1, localId: firstPromptId, content: { role: 'user', content: { type: 'text', text: 'edit' } } }], hasMore: true, nextAfterSeq: 1 };
            await recoverRepositoryCheckpointEvidence({ cwd: repoRoot, scopeId, sessionId: session.sessionId, readTranscriptPage: read('earlier-unrepresented-prompt') });
            expect(await readRepositoryCheckpointInitialEvidence({ cwd: repoRoot, scopeId })).toBeNull();
            await recoverRepositoryCheckpointEvidence({ cwd: repoRoot, scopeId, sessionId: session.sessionId, readTranscriptPage: read('first') });
            const initial = await readRepositoryCheckpointInitialEvidence({ cwd: repoRoot, scopeId });
            expect(initial?.state).toBe('available');
            if (initial?.state !== 'available') throw new Error('Missing recovered initial receipt');
            expect(await runGit(repoRoot, ['show', `${initial.commitSha}:tracked.txt`])).toBe('legacy initial dirt');
        } finally { await lifecycle.onSessionEnd?.(); await rm(repoRoot, { recursive: true, force: true }); }
    });

    afterEach(() => {
        vi.restoreAllMocks();
        checkpointBoundaryHooks.beforeFinalCapture = null;
        checkpointBoundaryHooks.beforeDiff = null;
    });

    it('keeps a failed first capture unavailable after a successful later dispatch', async () => {
        const repoRoot = await createGitRepo();
        const { session } = createMessageCapturingSession('initial-failed');
        const realCommand = scmRuntime.runScmCommand;
        let failNextStage = true;
        vi.spyOn(scmRuntime, 'runScmCommand').mockImplementation(async (input) => {
            if (failNextStage && input.args[0] === 'add') {
                failNextStage = false;
                return { success: false, stdout: '', stderr: 'First checkpoint object write failed', exitCode: 1 };
            }
            return await realCommand(input);
        });
        const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: repoRoot, provider: 'codex', protocol: 'codex', sessionIsNew: true });
        try {
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'first', prompt: 'edit' });
            await writeFile(join(repoRoot, 'tracked.txt'), 'agent ran after failed capture\n');
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'later', prompt: 'continue' });
            expect(await readRepositoryCheckpointInitialEvidence({ cwd: repoRoot, scopeId: `${session.sessionId}:${repoRoot}` })).toEqual({
                state: 'unavailable', reason: 'First checkpoint object write failed',
            });
            expect(await runGit(repoRoot, ['show', `${buildRepositoryCheckpointRefs({ scopeId: `${session.sessionId}:${repoRoot}`, messageId: 'later' }).messageStart?.ref}:tracked.txt`])).toBe('agent ran after failed capture');
        } finally { await lifecycle.onSessionEnd?.(); await rm(repoRoot, { recursive: true, force: true }); }
    });

    it.each([false, true])('orders tool and checkpoint-only turns by runtime chronology despite delayed publication (checkpoint first: %s)', async (checkpointFirst) => {
        const repoRoot = await createGitRepo();
        const { session, messages } = createMessageCapturingSession('chronology');
        const lifecycle = createRepositoryCheckpointPromptLifecycle({
            session, runtimeDirectory: repoRoot, provider: 'codex', protocol: 'codex',
        });
        const tracker = new NormalizedToolTurnChangeTracker({ provider: 'codex' });
        try {
            const checkpointSequence = checkpointFirst ? 10 : 30;
            const toolSequence = checkpointFirst ? 30 : 10;
            if (!checkpointFirst) await writeFile(join(repoRoot, 'tracked.txt'), 'tool\n');
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message-checkpoint', prompt: 'edit with shell' });
            await lifecycle.onTurnStarted?.({ messageId: 'message-checkpoint', turnId: 'checkpoint', sequence: checkpointSequence });
            await writeFile(join(repoRoot, 'tracked.txt'), 'checkpoint\n');
            await lifecycle.onTurnFinal?.({ messageId: 'message-checkpoint', turnId: 'checkpoint', status: 'completed', sequence: checkpointSequence + 2 });

            tracker.beginTurn({ turnId: 'tool', agentTurnId: 'native-tool', sequence: toolSequence });
            tracker.observeToolCall({ callId: 'edit', toolName: 'Edit', args: {
                file_path: 'tracked.txt', old_string: checkpointFirst ? 'checkpoint\n' : 'initial\n', new_string: 'tool\n',
            } });
            tracker.observeToolResult({ callId: 'edit', isError: false });
            const toolTurn = tracker.completeTurn({ sessionId: session.sessionId, status: 'completed', sequence: toolSequence + 2 });
            expect(toolTurn).not.toBeNull();
            const checkpointInput = messages.find((message) => message.type === 'tool-call');
            if (!checkpointInput || checkpointInput.type !== 'tool-call' || !toolTurn) throw new Error('Missing turn evidence');
            const toolInput = buildTurnChangeSetDiffInput({ turnChangeSet: toolTurn, protocol: 'codex', rawToolName: 'Edit' });
            const toMessage = (id: string, input: unknown, createdAt: number): Message => ({
                kind: 'tool-call', id, localId: null, createdAt, children: [],
                tool: { name: 'Diff', state: 'completed', input, createdAt, startedAt: createdAt,
                    completedAt: createdAt, description: null, result: { status: 'completed' } },
            });
            // Publish the older turn last, with a newer publication timestamp: arrival is not turn order.
            const earlier = checkpointFirst ? checkpointInput.input : toolInput;
            const later = checkpointFirst ? toolInput : checkpointInput.input;
            const turns = deriveTurnChangeSetsFromMessages([toMessage('later', later, 100), toMessage('earlier', earlier, 200)]);
            const ordered = [...turns].sort(compareTurnChangeSetChronology);
            expect(ordered.map((turn) => turn.turnId)).toEqual(checkpointFirst ? ['checkpoint', 'tool'] : ['tool', 'checkpoint']);
            expect(ordered.at(-1)?.turnId).toBe(checkpointFirst ? 'tool' : 'checkpoint');
            if (checkpointFirst) expect(ordered.at(-1)?.files[0]?.newText).toBe('tool\n');
            else expect(ordered.at(-1)?.files[0]?.unifiedDiff).toContain('+checkpoint');
            const aggregate = mergeTurnChangeSets({ sessionId: session.sessionId, turns });
            expect(aggregate.files).toHaveLength(1);
            expect(aggregate.files[0]?.turns).toEqual(checkpointFirst ? ['checkpoint', 'tool'] : ['tool', 'checkpoint']);
        } finally {
            await lifecycle.onSessionEnd?.();
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('uses resolved Git roots for nested directories while keeping linked worktrees separate', async () => {
        const repoRoot = await createGitRepo();
        const linkedRoot = `${repoRoot}-linked`;
        const registry = createWorktreeAttributionRegistry();
        const lifecycles: ReturnType<typeof createRepositoryCheckpointPromptLifecycle>[] = [];
        try {
            await mkdir(join(repoRoot, 'nested'));
            await runGit(repoRoot, ['worktree', 'add', '--detach', linkedRoot]);
            for (const [index, runtimeDirectory] of [repoRoot, join(repoRoot, 'nested'), linkedRoot].entries()) {
                const { session } = createMessageCapturingSession(`root-${index}`);
                const lifecycle = createRepositoryCheckpointPromptLifecycle({
                    session, runtimeDirectory, provider: 'codex', protocol: 'codex', attributionRegistry: registry,
                });
                lifecycles.push(lifecycle);
                await lifecycle.onBeforePromptDispatch?.({ messageId: 'message', prompt: 'inspect' });
            }
            expect(registry.resolveAttributionScope({ repoRoot, intervalId: 'root-0:message' })).toBe('shared_worktree');
            expect(registry.resolveAttributionScope({ repoRoot, intervalId: 'root-1:message' })).toBe('shared_worktree');
            expect(registry.resolveAttributionScope({
                repoRoot: await runGit(linkedRoot, ['rev-parse', '--show-toplevel']), intervalId: 'root-2:message',
            })).toBe('no_happier_checkpoint_overlap_observed');
        } finally {
            for (const lifecycle of lifecycles) await lifecycle.onSessionEnd?.();
            await rm(linkedRoot, { recursive: true, force: true });
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it.each(['abort', 'shutdown', 'failed_capture'] as const)('releases an interval after %s without contaminating later turns', async (completion) => {
        const repoRoot = await createGitRepo();
        const registry = createWorktreeAttributionRegistry();
        const { session } = createMessageCapturingSession('cleanup');
        const lifecycle = createRepositoryCheckpointPromptLifecycle({
            session, runtimeDirectory: repoRoot, provider: 'codex', protocol: 'codex', attributionRegistry: registry,
        });
        try {
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message', prompt: 'inspect' });
            if (completion === 'abort') {
                await lifecycle.onTurnAbortedBeforeStart?.({ messageId: 'message' });
                await lifecycle.onTurnAbortedBeforeStart?.({ messageId: 'message' });
            } else if (completion === 'shutdown') {
                await lifecycle.onSessionEnd?.();
                await lifecycle.onSessionEnd?.();
            } else {
                await rename(join(repoRoot, '.git'), join(repoRoot, '.git.removed'));
                await lifecycle.onTurnFinal?.({ messageId: 'message', turnId: 'turn', status: 'interrupted' });
            }
            expect(registry.resolveAttributionScope({ repoRoot, intervalId: 'cleanup:message' })).toBe('unknown');
            const later = registry.begin({ repoRoot, intervalId: 'later:message' });
            expect(registry.resolveAttributionScope(later)).toBe('no_happier_checkpoint_overlap_observed');
            registry.end(later);
        } finally {
            await lifecycle.onSessionEnd?.();
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('records a peer interval that begins while the final capture is still running', async () => {
        const repoRoot = await createGitRepo();
        try {
            const { session, messages } = createMessageCapturingSession('session-capture-overlap');
            const attributionRegistry = createWorktreeAttributionRegistry();
            const lifecycle = createRepositoryCheckpointPromptLifecycle({
                session,
                runtimeDirectory: repoRoot,
                provider: 'codex',
                protocol: 'codex',
                attributionRegistry,
            });

            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message-1', prompt: 'change tracked.txt' });
            await lifecycle.onTurnStarted?.({ messageId: 'message-1', turnId: 'turn-1' });
            await writeFile(join(repoRoot, 'tracked.txt'), 'changed\n', 'utf8');
            checkpointBoundaryHooks.beforeFinalCapture = () => {
                attributionRegistry.begin({ repoRoot, intervalId: 'session-peer:message-9' });
            };
            await lifecycle.onTurnFinal?.({ messageId: 'message-1', turnId: 'turn-1', status: 'completed' });

            expect(readCheckpointMeta(messages)).toMatchObject({
                contentConfidence: 'exact',
                attributionScope: 'shared_worktree',
            });
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps the captured attribution when a peer interval begins only after the final capture', async () => {
        const repoRoot = await createGitRepo();
        try {
            const { session, messages } = createMessageCapturingSession('session-capture-after');
            const attributionRegistry = createWorktreeAttributionRegistry();
            const lifecycle = createRepositoryCheckpointPromptLifecycle({
                session,
                runtimeDirectory: repoRoot,
                provider: 'codex',
                protocol: 'codex',
                attributionRegistry,
            });

            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message-1', prompt: 'change tracked.txt' });
            await lifecycle.onTurnStarted?.({ messageId: 'message-1', turnId: 'turn-1' });
            await writeFile(join(repoRoot, 'tracked.txt'), 'changed\n', 'utf8');
            checkpointBoundaryHooks.beforeDiff = () => {
                attributionRegistry.begin({ repoRoot, intervalId: 'session-peer:message-9' });
            };
            await lifecycle.onTurnFinal?.({ messageId: 'message-1', turnId: 'turn-1', status: 'completed' });

            expect(readCheckpointMeta(messages)).toMatchObject({
                contentConfidence: 'exact',
                attributionScope: 'no_happier_checkpoint_overlap_observed',
            });
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

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

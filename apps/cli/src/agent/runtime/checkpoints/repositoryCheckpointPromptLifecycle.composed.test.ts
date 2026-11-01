import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';

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
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { createRuntimeTranscriptProjector } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { extractCanonicalDiffFiles, readTurnChangeToolMetadata } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';
import { readTurnChangesFromDiffTool } from '../../../../../ui/sources/components/sessions/files/turnChanges/readTurnChangesFromDiffTool';
import { createDeferred } from '@/testkit/async/deferred';
import { captureScmComparison, deleteCapturedScmComparison, prepareCapturedScmComparisonInvestigation, readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';

/**
 * Only the SCM/process boundary is controlled: the real Git checkpoint adapter still runs, but the
 * test can interleave a peer capture interval at the exact final-capture and diff boundaries.
 */
const checkpointBoundaryHooks = vi.hoisted(() => ({
    beforeFinalCapture: null as null | (() => void),
    beforeDiff: null as null | (() => void),
    beforeAlias: null as null | (() => Promise<void>),
}));

vi.mock('@/scm/checkpoints/gitCheckpointAdapter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/scm/checkpoints/gitCheckpointAdapter')>();
    return {
        ...actual,
        gitCheckpointAdapter: {
            ...actual.gitCheckpointAdapter,
            async alias(request: Parameters<typeof actual.gitCheckpointAdapter.alias>[0]) {
                await checkpointBoundaryHooks.beforeAlias?.();
                return await actual.gitCheckpointAdapter.alias(request);
            },
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
    it.each([
        { status: 'completed', checkpoint: 'git', evidence: 'tool' },
        { status: 'interrupted', checkpoint: 'git', evidence: 'tool' },
        { status: 'aborted', checkpoint: 'git', evidence: 'tool' },
        { status: 'completed', checkpoint: 'git', evidence: 'native' },
        { status: 'completed', checkpoint: 'git', evidence: 'absolute_tool' },
        { status: 'completed', checkpoint: 'git', evidence: 'absolute_native' },
        { status: 'completed', checkpoint: 'not_repo', evidence: 'tool' },
        { status: 'completed', checkpoint: 'failed_capture', evidence: 'tool' },
        { status: 'completed', checkpoint: 'delayed_alias', evidence: 'tool' },
        { status: 'completed', checkpoint: 'thrown_capture', evidence: 'tool' },
    ] as const)('publishes one combined card for a $status runtime turn ($checkpoint/$evidence)', async ({ status, checkpoint, evidence }) => {
        const repoRoot = checkpoint === 'not_repo' ? await mkdtemp(join(tmpdir(), 'happier-no-checkpoint-')) : await createGitRepo();
        const { session, messages } = createMessageCapturingSession(`combined-${status}-${checkpoint}-${evidence}`);
        const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: repoRoot, provider: 'codex', protocol: 'codex' });
        const bridge = createKeyedStreamedTranscriptBridge({ provider: 'codex', createSessionForStream: () => session });
        const project = createRuntimeTranscriptProjector();
        const tracker = new NormalizedToolTurnChangeTracker({ provider: 'codex' });
        const aliasEntered = createDeferred<void>();
        const releaseAlias = createDeferred<void>();
        let aliasReleased = checkpoint !== 'delayed_alias';
        let capturedBeforeAlias = false;
        const checkpointAvailable = checkpoint === 'git' || checkpoint === 'delayed_alias';
        const nativeEvidence = evidence === 'native' || evidence === 'absolute_native';
        const evidencePath = evidence === 'absolute_tool' || evidence === 'absolute_native' ? join(repoRoot, 'tracked.txt') : 'tracked.txt';
        let sequence = 0;
        const projectEvent = (event: Record<string, unknown>) => project({
            session, provider: 'codex', runtimeMessageDeltaBridge: bridge, normalizedToolTurnChangeTracker: tracker,
            toolNormalizationProtocol: 'codex', publishTurnChangeSet: lifecycle.publishTurnChangeSet,
            event: { sessionId: session.sessionId, turnId: 'turn', emittedAtMs: ++sequence, sequence, ...event },
        });
        try {
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message', prompt: 'edit' });
            if (checkpoint === 'delayed_alias') {
                checkpointBoundaryHooks.beforeAlias = async () => { aliasEntered.resolve(); await releaseAlias.promise; };
                checkpointBoundaryHooks.beforeFinalCapture = () => { capturedBeforeAlias = !aliasReleased; };
            }
            if (checkpoint === 'thrown_capture') checkpointBoundaryHooks.beforeFinalCapture = () => { throw new Error('Git capture process failed'); };
            const start = lifecycle.onTurnStarted?.({ messageId: 'message', turnId: 'turn', sequence: 1 });
            if (checkpoint === 'delayed_alias') await aliasEntered.promise;
            else await start;
            await projectEvent({ kind: 'turn-start', startedBy: 'host' });
            if (nativeEvidence) await projectEvent({ kind: 'file-edit', editId: 'edit', path: evidencePath, oldContent: 'initial\n', newContent: 'changed\n' });
            else {
                await projectEvent({ kind: 'tool-call', toolCallId: 'edit', toolName: 'Edit', input: {
                    file_path: evidencePath, old_string: 'initial\n', new_string: 'changed\n',
                } });
                await projectEvent({ kind: 'tool-result', toolCallId: 'edit', output: { status: 'completed' } });
            }
            await writeFile(join(repoRoot, 'tracked.txt'), 'changed\n');
            if (checkpoint === 'failed_capture') await rename(join(repoRoot, '.git'), join(repoRoot, '.git.removed'));
            const terminal = projectEvent(status === 'completed' ? { kind: 'turn-complete', agentTurnId: 'native-turn' }
                : status === 'interrupted' ? { kind: 'turn-failed', agentTurnId: 'native-turn', diagnostic: { code: 'provider_error', severity: 'error' } }
                    : { kind: 'turn-cancelled', agentTurnId: 'native-turn', cause: 'user' });
            if (checkpoint === 'delayed_alias') {
                await new Promise<void>(resolve => setImmediate(resolve));
                aliasReleased = true;
                releaseAlias.resolve();
            }
            await terminal;
            await start;
            // The original required terminal projection owns durable publication; the later
            // prompt-loop cleanup hook must neither publish a second card nor hide a refusal.
            expect(messages.filter(message => message.type === 'tool-call' && message.name === 'Diff')).toHaveLength(1);
            await lifecycle.onTurnFinal?.({ messageId: 'message', turnId: 'turn', status, sequence });
            const cards = messages.filter(message => message.type === 'tool-call' && message.name === 'Diff');
            expect(cards).toHaveLength(1);
            const card = cards[0];
            if (!card || card.type !== 'tool-call') throw new Error('Missing combined card');
            const metadata = readTurnChangeToolMetadata(card.input);
            expect(metadata).toMatchObject({ turnId: 'turn', turnStatus: status, provider: 'codex', seqRange: { startSeqInclusive: 1, endSeqInclusive: sequence },
                repositoryCheckpoint: { contentConfidence: checkpointAvailable ? 'exact' : 'unavailable', baseRefSource: checkpoint === 'not_repo' ? 'unavailable' : 'turn_start' } });
            const files = extractCanonicalDiffFiles(card.input, metadata!);
            expect(files).toEqual(expect.arrayContaining([
                expect.objectContaining({ filePath: 'tracked.txt', source: nativeEvidence ? 'provider_native' : 'provider_tool', agentTurnId: 'native-turn', providerMessageId: 'edit' }),
            ]));
            if (checkpointAvailable) expect(files).toContainEqual(expect.objectContaining({ filePath: 'tracked.txt', source: 'scm_checkpoint' }));
            else expect(files).toHaveLength(1);
            if (nativeEvidence) expect(messages).toContainEqual(expect.objectContaining({ type: 'file-edit', filePath: evidencePath }));
            else {
                expect(messages).toContainEqual(expect.objectContaining({ type: 'tool-call', name: 'Edit' }));
                expect(messages).toContainEqual(expect.objectContaining({ type: 'tool-result' }));
            }
            const turns = deriveTurnChangeSetsFromMessages([{ kind: 'tool-call', id: 'card', localId: null, createdAt: 1, children: [],
                tool: { name: 'Diff', state: 'completed', input: card.input, createdAt: 1, startedAt: 1, completedAt: 1, description: null, result: { status: 'completed' } } }]);
            expect(mergeTurnChangeSets({ sessionId: session.sessionId, turns }).files).toHaveLength(1);
            expect(readTurnChangesFromDiffTool({ name: 'Diff', input: card.input })).toMatchObject({ turnId: 'turn',
                files: [{ fullPath: 'tracked.txt', linesAdded: 1, linesRemoved: 1 }],
                firstHunkAnchors: { 'tracked.txt': { kind: 'diffLine', startLine: 1 } },
            });
            expect(capturedBeforeAlias).toBe(false);
        } finally {
            releaseAlias.resolve();
            checkpointBoundaryHooks.beforeAlias = null;
            checkpointBoundaryHooks.beforeFinalCapture = null;
            bridge.clear(); await lifecycle.onSessionEnd?.(); await rm(repoRoot, { recursive: true, force: true });
        }
    });
    it('recovers one interrupted turn card after reconnect without admitting later uncaptured bytes', async () => {
        const repoRoot = await createGitRepo();
        const { session, messages } = createMessageCapturingSession('interrupted-history');
        const scopeId = `${session.sessionId}:${repoRoot}`;
        const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: repoRoot, provider: 'codex', protocol: 'codex', sessionIsNew: true });
        const bridge = createKeyedStreamedTranscriptBridge({ provider: 'codex', createSessionForStream: () => session });
        const tracker = new NormalizedToolTurnChangeTracker({ provider: 'codex' });
        const project = createRuntimeTranscriptProjector();
        const captures: Awaited<ReturnType<typeof captureScmComparison>>[] = [];
        let sequence = 0;
        const projectEvent = (event: Record<string, unknown>) => project({ session, provider: 'codex', runtimeMessageDeltaBridge: bridge,
            normalizedToolTurnChangeTracker: tracker, toolNormalizationProtocol: 'codex', publishTurnChangeSet: lifecycle.publishTurnChangeSet,
            event: { sessionId: session.sessionId, turnId: 'interrupted', emittedAtMs: ++sequence, sequence, ...event } });
        const capture = () => captureScmComparison({ cwd: repoRoot, sessionId: session.sessionId,
            source: { kind: 'turnCheckpoint', turnId: 'interrupted' }, readTranscriptPage: async () => ({
                messages: [
                    { seq: 1, createdAt: 1, localId: 'first', content: { role: 'user', content: { type: 'text', text: 'edit' } } },
                    ...messages.map((data, index) => ({ seq: index + 2, createdAt: index + 2,
                        content: { role: 'agent', content: { type: 'acp', provider: 'codex', data } } })),
                ], hasMore: false, nextAfterSeq: null,
            }) });
        try {
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'first', prompt: 'edit' });
            await lifecycle.onTurnStarted?.({ messageId: 'first', turnId: 'interrupted', sequence: 1 });
            await projectEvent({ kind: 'turn-start', startedBy: 'host' });
            await projectEvent({ kind: 'file-edit', editId: 'edit', path: 'tracked.txt', oldContent: 'initial\n', newContent: 'captured change\n' });
            await writeFile(join(repoRoot, 'tracked.txt'), 'captured change\n');
            await projectEvent({ kind: 'turn-failed', agentTurnId: 'native-interrupted', diagnostic: { code: 'provider_error', severity: 'error' } });
            await lifecycle.onTurnFinal?.({ messageId: 'first', turnId: 'interrupted', status: 'interrupted', sequence });
            const cards = messages.filter(message => message.type === 'tool-call' && message.name === 'Diff');
            expect(cards).toHaveLength(1);
            const card = cards[0];
            if (!card || card.type !== 'tool-call') throw new Error('Missing interrupted turn card');
            const metadata = readTurnChangeToolMetadata(card.input);
            expect(metadata).toMatchObject({ turnStatus: 'interrupted', repositoryCheckpoint: { contentConfidence: 'exact' } });
            expect(new Set(extractCanonicalDiffFiles(card.input, metadata!).map(file => file.source)))
                .toEqual(new Set(['provider_native', 'scm_checkpoint']));
            const original = await capture(); captures.push(original);
            expect(original.comparison.inventory).toMatchObject({ state: 'complete', files: [{ path: 'tracked.txt' }] });

            await lifecycle.onSessionEnd?.();
            await writeFile(join(repoRoot, 'tracked.txt'), 'late uncaptured edit\n');
            await writeFile(join(repoRoot, 'late-only.txt'), 'never captured by the turn\n');
            // A reconnect may rebuild local evidence from the committed merged card, while
            // the Git endpoint objects remain the authority for historical file bytes.
            await rm(join(repoRoot, '.git', 'happier', 'checkpoint-evidence', encodeRepositoryCheckpointScope(scopeId)), { recursive: true, force: true });
            const recovered = await capture();
            expect(recovered).toEqual(original);
            const pinned = await prepareCapturedScmComparisonInvestigation({ cwd: repoRoot, sessionId: session.sessionId,
                comparisonId: original.comparison.id, directory: join(repoRoot, 'investigation') });
            expect(await readFile(join(pinned.beforeDirectory, 'tracked.txt'), 'utf8')).toBe('initial\n');
            expect(await readFile(join(pinned.afterDirectory, 'tracked.txt'), 'utf8')).toBe('captured change\n');
            await expect(readFile(join(pinned.afterDirectory, 'late-only.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

            const startRef = metadata?.repositoryCheckpoint?.startRef;
            if (!startRef) throw new Error('Missing captured start ref');
            await runGit(repoRoot, ['update-ref', '-d', startRef]);
            const unavailable = await capture(); captures.push(unavailable);
            expect(unavailable.comparison.endpoints).toEqual({});
            expect(unavailable.comparison.inventory).toMatchObject({ state: 'unavailable', files: [] });
            expect(unavailable.metadata.contentConfidence).toBe('unavailable');
            expect(await readCapturedScmComparison({ cwd: repoRoot, sessionId: session.sessionId, comparisonId: original.comparison.id })).toEqual(original);
        } finally {
            await Promise.all(captures.map(captured => deleteCapturedScmComparison({ cwd: repoRoot, sessionId: session.sessionId, comparisonId: captured.comparison.id })));
            bridge.clear(); await lifecycle.onSessionEnd?.(); await rm(repoRoot, { recursive: true, force: true });
        }
    });

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
        const firstMessageId = 'plugin-input-v1:first-id';
        const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: repoRoot, provider: 'codex', protocol: 'codex', sessionIsNew: true });
        try {
            await writeFile(join(repoRoot, 'tracked.txt'), 'legacy initial dirt\n');
            await lifecycle.onBeforePromptDispatch?.({ messageId: firstMessageId, prompt: 'edit' });
            await lifecycle.onTurnStarted?.({ messageId: firstMessageId, turnId: 'legacy-turn', sequence: 2 });
            await writeFile(join(repoRoot, 'tracked.txt'), 'legacy agent change\n');
            await lifecycle.onTurnFinal?.({ messageId: firstMessageId, turnId: 'legacy-turn', status: 'completed', sequence: 3 });
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
            await recoverRepositoryCheckpointEvidence({ cwd: repoRoot, scopeId, sessionId: session.sessionId, readTranscriptPage: read(firstMessageId) });
            const initial = await readRepositoryCheckpointInitialEvidence({ cwd: repoRoot, scopeId });
            expect(initial?.state).toBe('available');
            if (initial?.state !== 'available') throw new Error('Missing recovered initial receipt');
            expect(await runGit(repoRoot, ['show', `${initial.commitSha}:tracked.txt`])).toBe('legacy initial dirt');
        } finally { await lifecycle.onSessionEnd?.(); await rm(repoRoot, { recursive: true, force: true }); }
    });

    it('does not promote a later dispatch when an earlier opaque message-start checkpoint exists', async () => {
        const repoRoot = await createGitRepo();
        const { session } = createMessageCapturingSession('opaque-history');
        const scopeId = `${session.sessionId}:${repoRoot}`;
        const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: repoRoot,
            provider: 'codex', protocol: 'codex', sessionIsNew: true });
        try {
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'plugin-input-v1:first-id', prompt: 'edit' });
            await runGit(repoRoot, ['update-ref', '-d', `refs/happier/checkpoints/${encodeRepositoryCheckpointScope(scopeId)}/session-initial`]);
            await rm(join(repoRoot, '.git', 'happier', 'checkpoint-evidence', encodeRepositoryCheckpointScope(scopeId), 'initial.json'));
            await writeFile(join(repoRoot, 'tracked.txt'), 'already changed after first dispatch\n');
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'later-safe-id', prompt: 'continue' });
            expect(await readRepositoryCheckpointInitialEvidence({ cwd: repoRoot, scopeId })).toMatchObject({ state: 'unavailable', recoverable: true });
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

            await writeFile(join(repoRoot, 'tracked.txt'), 'before prompt\n', 'utf8');
            await lifecycle.onBeforePromptDispatch?.({ messageId: 'message-1', prompt: 'change tracked.txt' });
            await writeFile(join(repoRoot, 'tracked.txt'), 'changed\n', 'utf8');
            await lifecycle.onTurnFinal?.({ messageId: 'message-1', turnId: 'turn-1', status: 'completed' });

            expect(messages.find((message) => message.type === 'tool-call')).toMatchObject({
                input: {
                    files: [{
                        file_path: 'tracked.txt',
                        unified_diff: expect.stringContaining('-before prompt\n+changed'),
                    }],
                },
            });
            expect(readCheckpointMeta(messages)).toMatchObject({
                baseRefSource: 'message_start',
                receipts: expect.arrayContaining([
                    expect.objectContaining({ id: 'checkpoint.captured', phase: 'message-start' }),
                    expect.objectContaining({ id: 'checkpoint.diff_computed' }),
                ]),
            });
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('emits no standalone diff for alias failure without file evidence', async () => {
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

    it('emits no standalone diff for final capture failure without file evidence', async () => {
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

    it('emits no standalone diff for diff failure without file evidence', async () => {
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

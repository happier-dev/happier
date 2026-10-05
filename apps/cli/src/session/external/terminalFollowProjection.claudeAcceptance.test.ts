import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { mapPluginExternalTerminalSourceItem } from './pluginExternalSessionsAdapter';
import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { createExternalSessionTerminalFollowProjector } from './terminalFollowProjection';

type TerminalOperationsFixture = Readonly<{
    operations: Readonly<{
        startProviderSession(): Promise<void>;
        sendTurnPrompt(text: string): Promise<void>;
        resetOrDisposeRuntime(): Promise<void>;
    }>;
    nativeRuntime: Readonly<{
        observeSourceTranscript(input: Readonly<{ providerSessionId: string; sourceId: string; row: unknown }>): Promise<void>;
        observeTerminalLifecycle(evidence: unknown): Promise<void>;
        send(input: Readonly<{ v: 1; text: string }>, options: Readonly<Record<string, unknown>>): Promise<unknown>;
        setOnPromptAcceptedByProvider(listener: (identity: Readonly<{ localIds?: readonly string[] }>) => void): void;
    }>;
}>;

// Cross-package test composition follows terminalFollowProjection.claude.test.ts: runtime
// imports retain plugin compilation ownership while the actual internal path remains real.
const fixturesPath = '../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit.js';
const operationsPath = '../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/turnOperations.testkit.js';
const fixtures = await import(fixturesPath) as {
    createTerminalHostFixture(): Readonly<{ service: NonNullable<AgentSessionHostServices['terminalHost']> }>;
    createEventsFixture(): Readonly<{ service: unknown }>;
    createPluginContextFixture(terminal: unknown, events: unknown): Readonly<{
        agentRuntime: Pick<AgentSessionHostServices, 'transcripts'>;
    }>;
    expectRuntimeEnvelope(runtime: unknown): TerminalOperationsFixture;
};
const leaf = await import(operationsPath) as {
    createClaudeUnifiedTerminalTurnOperations(params: unknown): unknown;
};

describe('Claude terminal acceptance and host transcript ordering', () => {
    it('keeps absorbed Pending input unsettled until preceding transcript output has durable custody', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-ordered-acceptance-'));
        const providerSessionId = '33333333-3333-3333-3333-333333333333';
        const projectDir = join(root, 'projects', '-tmp-claude-project');
        const transcriptPath = join(projectDir, `${providerSessionId}.jsonl`);
        await mkdir(projectDir, { recursive: true });
        await writeFile(transcriptPath, `${JSON.stringify({ type: 'assistant', uuid: 'history',
            timestamp: new Date(500).toISOString(), message: { role: 'assistant', content: 'history' } })}\n`);
        const contributionPath = '../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/contribution.js';
        const contributionModule = await import(contributionPath);
        const contribution: AgentExternalSessionsContribution = contributionModule.createClaudeExternalSessionsContribution({
            env: { CLAUDE_CONFIG_DIR: root },
        });
        const invocation = () => ({
            signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000,
            maxSerializedBytes: 524_288, exec: createUnavailablePluginServices().exec,
            managedEndpointRead: async () => { throw new Error('File-backed fixture'); },
            ripgrep: { run: async () => { throw new Error('Transcript fixture has no content search'); } },
        });
        const identity = await contribution.resolveLinkIdentity({ ...invocation(),
            source: { kind: 'claudeConfig', configDir: root }, remoteSessionId: providerSessionId });
        if (!identity.ok) throw new Error(identity.code);
        const page = await contribution.pageTranscript({ ...invocation(), source: identity.value.source,
            remoteSessionId: providerSessionId, direction: 'older', maxItems: 200 });
        if (!page.ok || !page.value.tailCursor) throw new Error('Missing live source cursor');
        const terminal = fixtures.createTerminalHostFixture();
        const ctx = fixtures.createPluginContextFixture(terminal.service, fixtures.createEventsFixture().service);
        // The OS follow boundary is controlled; native queue parsing and acceptance remain real.
        vi.mocked(ctx.agentRuntime.transcripts.fileFollow.follow).mockResolvedValue({
            id: 'ordered-acceptance-follow',
            drainNow: async () => undefined,
            close: async () => undefined,
        });
        const envelope = fixtures.expectRuntimeEnvelope(leaf.createClaudeUnifiedTerminalTurnOperations({
            ctx, directory: '/tmp/claude-project', happierSessionId: 'ordered-acceptance-session',
            hostPreference: 'zellij', launchEnv: {}, permissionMode: 'default',
            knownProviderSession: {
                providerSessionId, transcriptPath,
            },
        }));
        const order: string[] = [];
        let releaseCommit!: () => void;
        const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
        // The durable outbox is the system boundary. Both host projectors below it stay real.
        const session = {
            sessionId: 'ordered-acceptance-session',
            enqueueAgentMessageCommitted: async () => {
                order.push('assistant-enqueue-started');
                await commitGate;
                order.push('assistant-custodied');
                return { persisted: true, delivered: true };
            },
        };
        const publish = createExternalSessionTerminalFollowProjector({
            sessionId: session.sessionId,
            agentId: 'claude',
            observeSourceTranscript: (input) => envelope.nativeRuntime.observeSourceTranscript(input),
            projectRuntimeEvent: (event) => projectRuntimeTranscriptEvent({ session, provider: 'claude', event,
                admission: { signal: new AbortController().signal, requireDelivery: true } }),
        });
        let priorOutput: Promise<void> | undefined;
        try {
            await envelope.operations.startProviderSession();
            await envelope.operations.sendTurnPrompt('first prompt');
            await envelope.nativeRuntime.observeTerminalLifecycle({
                agentId: 'claude', type: 'prompt_submitted', source: 'hook', promptText: 'first prompt',
            });
            envelope.nativeRuntime.setOnPromptAcceptedByProvider((identity) => {
                for (const localId of identity.localIds ?? []) order.push(`accepted:${localId}`);
            });
            const steer = envelope.nativeRuntime.send({ v: 1, text: 'be more concise' }, {
                deliverAs: 'steer', localInputId: 'pending-steer', localInputIds: ['pending-steer'],
                userMessageSeq: 31, userMessageSeqs: [31],
            });
            void steer.catch(() => undefined);
            await vi.waitFor(() => expect(terminal.service.injectUserPrompt).toHaveBeenCalledTimes(2));
            const follow = vi.mocked(ctx.agentRuntime.transcripts.fileFollow.follow).mock.calls[0]?.[0];
            if (!follow) throw new Error('Native transcript follow was not bound');
            const emit = async (row: unknown, sequence: number) => await follow.onLine({
                line: JSON.stringify(row), sourcePath: transcriptPath, sequence,
            });
            const rows = [
                { type: 'queue-operation', operation: 'enqueue', sessionId: providerSessionId,
                    content: 'be more concise', timestamp: new Date(2000).toISOString() },
                { type: 'queue-operation', operation: 'remove', sessionId: providerSessionId,
                    content: 'be more concise', timestamp: new Date(2001).toISOString() },
                { type: 'user', uuid: 'tool-result-before-absorption', sessionId: providerSessionId,
                    timestamp: new Date(2500).toISOString(),
                    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'work', content: 'preceding output' }] } },
                { type: 'attachment', uuid: 'absorbed-steer', parentUuid: 'tool-result-before-absorption',
                    isSidechain: false, sessionId: providerSessionId, timestamp: new Date(3000).toISOString(),
                    attachment: { type: 'queued_command', prompt: 'be more concise', commandMode: 'prompt', origin: { kind: 'human' } } },
            ];
            await appendFile(transcriptPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
            const fresh = await contribution.readAfterTranscript({ ...invocation(), source: identity.value.source,
                remoteSessionId: providerSessionId, cursor: page.value.tailCursor, maxItems: 200, projection: 'terminal' });
            if (!fresh.ok || fresh.value.outcome !== 'advanced') throw new Error('Missing fresh native rows');
            priorOutput = publish({ kind: 'data', providerSessionId, fromCursor: page.value.tailCursor,
                nextCursor: fresh.value.nextCursor, items: fresh.value.items.map(mapPluginExternalTerminalSourceItem) });
            await vi.waitFor(() => expect(order).toEqual(['assistant-enqueue-started']));
            for (const [index, row] of rows.entries()) await emit(row, index + 1);
            expect(order).toEqual(['assistant-enqueue-started']);
            releaseCommit();
            await priorOutput;
            await vi.waitFor(() => expect(order).toEqual([
                'assistant-enqueue-started', 'assistant-custodied', 'accepted:pending-steer',
            ]));
        } finally {
            releaseCommit();
            await priorOutput;
            await envelope.operations.resetOrDisposeRuntime();
            await rm(root, { recursive: true, force: true });
        }
    });
});

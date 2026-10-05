import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    AgentExternalSessionsContribution,
    AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';
import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionPermissionsService } from '@happier-dev/plugin-sdk/sessions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import { mapPluginExternalTranscriptItem } from './pluginExternalSessionsAdapter';
import { createExternalSessionTerminalFollowProjector } from './terminalFollowProjection';

const unavailableManagedEndpointRead: AgentExternalSessionsManagedEndpointRead =
    async () => {
        throw new Error('Managed endpoint read is unavailable in this file-backed fixture');
    };
const unavailableInvocationExec = createUnavailablePluginServices().exec;
// Packaged process execution is outside these transcript-only fixtures.
const unavailableInvocationRipgrep = { run: async () => { throw new Error('Packaged ripgrep unavailable in transcript fixture'); } };

function invocation() {
    return {
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 30_000,
        maxSerializedBytes: 524_288,
        managedEndpointRead: unavailableManagedEndpointRead,
        exec: unavailableInvocationExec,
        ripgrep: unavailableInvocationRipgrep,
    };
}

function jsonl(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

async function loadClaudeContribution(
    env: NodeJS.ProcessEnv,
): Promise<AgentExternalSessionsContribution> {
    const contributionPath =
        '../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/contribution.js';
    const contributionModule = await import(contributionPath);
    const createContribution =
        contributionModule.createClaudeExternalSessionsContribution as (
            options: Readonly<{ env?: NodeJS.ProcessEnv }>,
        ) => AgentExternalSessionsContribution;
    return createContribution({ env });
}

/**
 * Pins the producer half of the `terminalFollow` contract for the real Claude
 * External Sessions contribution — the Agent the terminal-follow projector was
 * written against. Terminal follow is declaration-gated
 * (`surfaces.externalSession.sources[].terminalFollow.userRowClassification`),
 * and these two cases are what that declaration would have to be true about.
 */
describe('Claude terminal follow projection', () => {
    const roots: string[] = [];

    afterEach(async () => {
        vi.clearAllMocks();
        await Promise.all(
            roots.splice(0).map(async (root) =>
                await rm(root, { recursive: true, force: true })),
        );
    });

    async function seedClaudeSession(): Promise<Readonly<{
        contribution: AgentExternalSessionsContribution;
        source: Parameters<AgentExternalSessionsContribution['pageTranscript']>[0]['source'];
        remoteSessionId: string;
        sessionFilePath: string;
    }>> {
        const root = await mkdtemp(join(
            tmpdir(),
            'happier-claude-terminal-follow-projection-',
        ));
        roots.push(root);
        const configDir = join(root, 'claude-config');
        const projectId = '-repo-claude-terminal-follow';
        const remoteSessionId = '33333333-3333-3333-3333-333333333333';
        const projectDir = join(configDir, 'projects', projectId);
        const sessionFilePath = join(projectDir, `${remoteSessionId}.jsonl`);
        await mkdir(projectDir, { recursive: true });
        await writeFile(sessionFilePath, [
            jsonl({
                type: 'user',
                uuid: 'user-history-1',
                timestamp: '2026-08-18T08:00:00.000Z',
                message: { content: 'historical human turn' },
            }),
            jsonl({
                type: 'assistant',
                uuid: 'assistant-history-1',
                timestamp: '2026-08-18T08:00:01.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'historical answer' }] },
            }),
        ].join(''), 'utf8');

        const contribution = await loadClaudeContribution(
            { CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv,
        );
        const identity = await contribution.resolveLinkIdentity({
            ...invocation(),
            source: { kind: 'claudeConfig', configDir },
            remoteSessionId,
        });
        if (!identity.ok) throw new Error(identity.code);
        return {
            contribution,
            source: identity.value.source,
            remoteSessionId,
            sessionFilePath,
        };
    }

    function createProjector() {
        const enqueueAgentMessageCommitted = vi.fn(async () => ({
            persisted: true,
            delivered: true,
        }));
        const enqueueUserTextMessageCommitted = vi.fn(async () => ({
            persisted: true,
            delivered: true,
        }));
        const session = {
            sessionId: 'hosted-claude-session',
            sendUserTextMessage: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => undefined),
            enqueueAgentMessageCommitted,
            enqueueUserTextMessageCommitted,
        };
        const project = createExternalSessionTerminalFollowProjector({
            sessionId: session.sessionId,
            agentId: 'claude',
            projectRuntimeEvent: async (event) =>
                await projectRuntimeTranscriptEvent({
                    session,
                    provider: 'claude',
                    event,
                }),
        });
        return {
            project,
            session,
            enqueueAgentMessageCommitted,
            enqueueUserTextMessageCommitted,
        };
    }

    it('admits Claude source-fact user rows during the initial replay phase', async () => {
        const seeded = await seedClaudeSession();
        const initial = await seeded.contribution.pageTranscript({
            ...invocation(),
            source: seeded.source,
            remoteSessionId: seeded.remoteSessionId,
            direction: 'older',
            maxItems: 200,
        });
        if (!initial.ok || !initial.value.tailCursor) {
            throw new Error('Expected an accepted Claude tail cursor');
        }
        const items = initial.value.items.map(mapPluginExternalTranscriptItem);
        expect(items.find((item) => item.kind === 'user')?.userProjection)
            .toBe('source_fact');

        const {
            project,
            enqueueAgentMessageCommitted,
            enqueueUserTextMessageCommitted,
        } = createProjector();
        await project({
            kind: 'data',
            phase: 'initial_replay',
            items,
            fromCursor: null,
            nextCursor: initial.value.tailCursor,
        });

        expect(enqueueUserTextMessageCommitted).toHaveBeenCalledTimes(1);
        expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(1);
    });

    it('commits mixed assistant context while the native question remains unanswered', async () => {
        const seeded = await seedClaudeSession();
        const initial = await seeded.contribution.pageTranscript({
            ...invocation(), source: seeded.source, remoteSessionId: seeded.remoteSessionId,
            direction: 'older', maxItems: 200,
        });
        if (!initial.ok || !initial.value.tailCursor) throw new Error('Expected a Claude tail cursor');
        // Like the contribution loader above, load plugin source at runtime without pulling it into the host compilation root.
        const permissionHookModulePath = '../../../../../packages/plugins/claude/src/agent/runtime/shared/permissionHookHandler.js';
        const permissionHookModule = await import(permissionHookModulePath);
        const createClaudePermissionHookHandler = permissionHookModule.createClaudePermissionHookHandler as (
            ctx: Readonly<{
                sessions: { current: { permissions: Pick<SessionPermissionsService, 'requestDecision'> } };
                agentRuntime: { toolExecution: Pick<AgentSessionHostServices['toolExecution'], 'before'> };
            }>,
        ) => (data: Readonly<Record<string, unknown>>) => Promise<unknown>;
        let answer!: (value: { decision: 'approved' }) => void;
        const decision = new Promise<{ decision: 'approved' }>((resolve) => { answer = resolve; });
        // Plugin host permission transport remains pending; the permission engine and transcript projection stay real.
        const requestDecision = vi.fn(() => decision);
        const handler = createClaudePermissionHookHandler({
            sessions: { current: { permissions: { requestDecision } } },
            agentRuntime: { toolExecution: { before: async (input) => ({ status: 'continue', input: input.input }) } },
        });
        const toolInput = { questions: [{
            header: 'Cleanup', question: 'Remove scratch files?', multiSelect: false,
            options: [{ label: 'Remove', description: 'Delete files' }, { label: 'Keep', description: 'Inspect files' }],
        }] };
        let answered = false;
        const pending = handler({
            hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
            tool_use_id: 'question_1', tool_input: toolInput,
        }).then((result) => { answered = true; return result; });
        try {
            await vi.waitFor(() => expect(requestDecision).toHaveBeenCalledOnce());
            await appendFile(seeded.sessionFilePath, jsonl({
                type: 'assistant', uuid: 'context_and_question', timestamp: new Date().toISOString(),
                message: { role: 'assistant', content: [
                    { type: 'text', text: 'The scratch files are no longer needed by the build.' },
                    { type: 'tool_use', id: 'question_1', name: 'AskUserQuestion', input: toolInput },
                ] },
            }));
            const after = await seeded.contribution.readAfterTranscript({
                ...invocation(), source: seeded.source, remoteSessionId: seeded.remoteSessionId,
                cursor: initial.value.tailCursor, maxItems: 200,
            });
            if (!after.ok || after.value.outcome !== 'advanced') throw new Error('Expected a transcript advance');
            const { project, enqueueAgentMessageCommitted } = createProjector();
            await project({
                kind: 'data', items: after.value.items.map(mapPluginExternalTranscriptItem),
                fromCursor: initial.value.tailCursor, nextCursor: after.value.nextCursor,
            });
            expect(answered).toBe(false);
            expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith('claude', expect.objectContaining({
                type: 'message', message: 'The scratch files are no longer needed by the build.',
            }), expect.anything());
            expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith('claude', expect.objectContaining({
                type: 'tool-call', callId: 'question_1', name: 'AskUserQuestion',
            }), expect.anything());
            answer({ decision: 'approved' });
            await expect(pending).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
            const settled = await seeded.contribution.readAfterTranscript({
                ...invocation(), source: seeded.source, remoteSessionId: seeded.remoteSessionId,
                cursor: after.value.nextCursor, maxItems: 200,
            });
            expect(settled).toEqual({ ok: true, value: { outcome: 'already_current' } });
        } finally {
            answer({ decision: 'approved' });
            await pending;
        }
    });

    it('fails closed when a live Claude user row carries only the source-fact classification', async () => {
        const seeded = await seedClaudeSession();
        const initial = await seeded.contribution.pageTranscript({
            ...invocation(),
            source: seeded.source,
            remoteSessionId: seeded.remoteSessionId,
            direction: 'older',
            maxItems: 200,
        });
        if (!initial.ok || !initial.value.tailCursor) {
            throw new Error('Expected an accepted Claude tail cursor');
        }

        await appendFile(seeded.sessionFilePath, [
            jsonl({
                type: 'user',
                uuid: 'user-live-1',
                timestamp: '2026-08-18T08:00:02.000Z',
                message: { content: 'typed into the live terminal' },
            }),
        ].join(''), 'utf8');

        const after = await seeded.contribution.readAfterTranscript({
            ...invocation(),
            source: seeded.source,
            remoteSessionId: seeded.remoteSessionId,
            cursor: initial.value.tailCursor,
            maxItems: 200,
        });
        if (!after.ok || after.value.outcome !== 'advanced') {
            throw new Error('Expected a Claude transcript advance');
        }
        const liveItems = after.value.items.map(mapPluginExternalTranscriptItem);
        // The producer cannot distinguish a terminal-typed turn from a host
        // prompt echo: `readAfterTranscript` carries no follow phase and no
        // host-submitted-prompt evidence, so it can only repeat `source_fact`.
        expect(liveItems.find((item) => item.kind === 'user')?.userProjection)
            .toBe('source_fact');

        const { project, enqueueAgentMessageCommitted, session } = createProjector();
        await expect(project({
            kind: 'data',
            items: liveItems,
            fromCursor: initial.value.tailCursor,
            nextCursor: after.value.nextCursor,
        })).rejects.toThrow('external_session_terminal_transcript_item_invalid');

        expect(enqueueAgentMessageCommitted).not.toHaveBeenCalled();
        expect(session.sendUserTextMessage).not.toHaveBeenCalled();
        expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
    });
});

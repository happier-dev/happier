import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    AgentExternalSessionsContribution,
    AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';
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

function invocation() {
    return {
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 30_000,
        maxSerializedBytes: 524_288,
        managedEndpointRead: unavailableManagedEndpointRead,
        exec: unavailableInvocationExec,
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

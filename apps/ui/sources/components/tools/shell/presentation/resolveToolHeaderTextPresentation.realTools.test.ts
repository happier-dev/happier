import { describe, expect, it, vi } from 'vitest';

import type { ToolCall } from "@happier-dev/session-core/messages";
import { qualifyTranscriptAccountActor } from '@happier-dev/session-core/messages';
import { SessionMessageAccountActorV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';

import { knownTools } from '@/components/tools/catalog';
import { resolveExecutionRunTitle } from '@/components/sessions/runs/resolveExecutionRunTitle';
import { resolveToolHeaderTextPresentation } from './resolveToolHeaderTextPresentation';
import { installToolShellPresentationCommonModuleMocks } from './toolShellPresentationTestHelpers';

installToolShellPresentationCommonModuleMocks();

function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
    const now = 1;
    return {
        name: 'Unknown',
        state: 'completed',
        input: {},
        result: null,
        createdAt: now,
        startedAt: now,
        completedAt: now,
        description: null,
        permission: undefined,
        ...overrides,
    };
}

describe('resolveToolHeaderTextPresentation (real known tools)', () => {
    it('names the change-summary Run by its product purpose without exposing its raw intent', () => {
        const tool = makeToolCall({ name: 'SubAgentRun', state: 'running', input: {
            intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            requestedConfiguration: { modelId: 'gpt-6-luna' },
        } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe(resolveExecutionRunTitle({ intent: 'scm_diff_summary' }));
        expect(model.subtitle).toBeNull();
    });

    it('names the authenticated answering person using the existing Home-qualified sanitized Account actor', () => {
        const tool = makeToolCall({ name: 'AskUserQuestion', description: 'Worker question', input: {},
            permission: { id: 'question', status: 'approved', answeredBy: { kind: 'person', accountId: 'bob' } } });
        const actor = qualifyTranscriptAccountActor(SessionMessageAccountActorV1Schema.parse({ v: 1, accountId: 'bob',
            profile: { name: 'Bob Chen', firstName: null, lastName: null, username: null, avatarUrl: null } }), 'home');
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null, serverId: 'home',
            viewerScope: { serverId: 'home', accountId: 'alice' }, answeringAccountActor: actor });
        expect(model.answeredBy).toEqual({ kind: 'person', accountId: 'bob' });
        expect(model.answeredByLabel).toContain('Bob Chen');
        const self = resolveToolHeaderTextPresentation({ tool, metadata: null, serverId: 'home',
            viewerScope: { serverId: 'home', accountId: 'bob' } });
        expect(self.answeredByLabel?.toLowerCase()).toContain('you');
        for (const other of [actor && { ...actor, serverId: 'other-home' }, actor && { ...actor, accountId: 'worker-owner' }]) {
            const unknown = resolveToolHeaderTextPresentation({ tool, metadata: null, serverId: 'home',
                viewerScope: { serverId: 'other-home', accountId: 'bob' }, answeringAccountActor: other });
            expect(unknown.answeredByLabel).toBeTruthy();
            expect(unknown.answeredByLabel).not.toContain('Bob Chen');
            expect(unknown.answeredByLabel?.toLowerCase()).not.toContain('you');
        }
        expect(model.title).toBe(self.title);
        expect(model.subtitle).toBe(self.subtitle);
    });
    it('projects the admitted question answerer beside the unchanged worker description, never an authored label', () => {
        const tool = makeToolCall({ name: 'AskUserQuestion', description: 'Worker question',
            input: { questions: [], answeredBy: { kind: 'session', sessionId: 'forged' } },
            permission: { id: 'question', status: 'approved', answeredBy: { kind: 'session', sessionId: 'manager' } } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null,
            answeringSession: { sessionId: 'manager', name: 'Daily coordinator' } });
        expect(model.answeredBy).toEqual({ kind: 'session', sessionId: 'manager' });
        expect(model.answeredByLabel).toContain('Daily coordinator');
        const withoutActor = resolveToolHeaderTextPresentation({ tool: { ...tool, permission: { id: 'question', status: 'approved' } },
            metadata: null, answeringSession: { sessionId: 'manager', name: 'Forged owner' } });
        expect(withoutActor.answeredBy).toBeNull();
        expect(withoutActor.answeredByLabel).toBeNull();
        const person = resolveToolHeaderTextPresentation({ tool: { ...tool,
            permission: { id: 'question', status: 'approved', answeredBy: { kind: 'person' } } }, metadata: null,
            answeringSession: { sessionId: 'manager', name: 'Bot owner' } });
        expect(person.answeredBy).toEqual({ kind: 'person' });
        expect(person.answeredByLabel).toBeTruthy();
        expect(person.answeredByLabel).not.toContain('Bot owner');
        expect(model.title).toBe(withoutActor.title);
        expect(model.subtitle).toBe(withoutActor.subtitle);
        const unnamed = resolveToolHeaderTextPresentation({ tool, metadata: null,
            answeringSession: { sessionId: 'other-session', name: 'Bot owner' } });
        expect(unnamed.answeredByLabel).toBeTruthy();
        expect(unnamed.answeredByLabel).not.toContain('Bot owner');
        expect(resolveToolHeaderTextPresentation({ tool: { ...tool,
            permission: { ...tool.permission!, status: 'pending' } }, metadata: null }).answeredByLabel).toBeNull();
    });
    it('renders Read with Read File title and path subtitle', () => {
        const tool = makeToolCall({ name: 'Read', input: { file_path: '/tmp/example.txt' } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Read File');
        expect(model.subtitle).toBe('/tmp/example.txt');
    });

    it('renders Glob with Search Files title and pattern subtitle', () => {
        const tool = makeToolCall({ name: 'Glob', input: { pattern: '{package.json,go.mod}' } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Search Files');
        expect(model.subtitle).toBe('{package.json,go.mod}');
    });

    it('renders Grep with Search Content title and pattern subtitle', () => {
        const tool = makeToolCall({ name: 'Grep', input: { pattern: '\\\\bTODO\\\\b' } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Search Content');
        expect(model.subtitle).toBe('\\\\bTODO\\\\b');
    });

    it('renders WebFetch with Fetch URL title and host subtitle', () => {
        const tool = makeToolCall({ name: 'WebFetch', input: { url: 'https://example.com/docs' } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Fetch URL');
        expect(model.subtitle).toBe('example.com');
    });

    it('renders WebSearch with Web Search title and query subtitle', () => {
        const tool = makeToolCall({ name: 'WebSearch', input: { query: 'how to test X' } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Web Search');
        expect(model.subtitle).toBe('how to test X');
    });

    it('labels a provider-native Task with the session model and reported subagent type', () => {
        const tool = makeToolCall({
            name: 'Task',
            input: { description: 'Summarize third run', subagent_type: 'explore' },
        });
        const model = resolveToolHeaderTextPresentation({
            tool,
            metadata: {
                flavor: 'opencode',
                sessionModelsV1: {
                    v: 1,
                    agentId: 'opencode',
                    updatedAt: 1,
                    currentModelId: 'muse-spark-1.3',
                    availableModels: [{ id: 'muse-spark-1.3', name: 'Muse Spark 1.3' }],
                },
            } as any,
        });
        expect(model.title).toBe('Muse Spark 1.3 Explore Agent');
        expect(model.subtitle).toBe('Summarize third run');
    });

    it('prefers the last provider-accepted model over the current provider selection', () => {
        const model = resolveToolHeaderTextPresentation({
            tool: makeToolCall({ name: 'Task', input: { subagent_type: 'explore' } }),
            metadata: {
                flavor: 'opencode',
                sessionAppliedModelV1: {
                    v: 1,
                    provider: 'opencode',
                    updatedAt: 2,
                    modelId: 'accepted-model',
                },
                sessionModelsV1: {
                    v: 1,
                    agentId: 'opencode',
                    updatedAt: 3,
                    currentModelId: 'selected-model',
                    availableModels: [
                        { id: 'accepted-model', name: 'Accepted Model' },
                        { id: 'selected-model', name: 'Selected Model' },
                    ],
                },
            } as any,
        });

        expect(model.title).toBe('Accepted Model Explore Agent');
    });

    it('keeps the generic Subagent fallback when no model, agent, or subagent type is known', () => {
        const tool = makeToolCall({ name: 'Task', input: { description: 'Summarize third run' } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Subagent');
    });

    it('labels a Codex native subagent from its role and latest applied prompt model', () => {
        const tool = makeToolCall({
            name: 'SubAgent',
            input: { prompt: 'Inspect the consent seam', role: 'explorer', nickname: 'Kepler' },
        });
        const model = resolveToolHeaderTextPresentation({
            tool,
            metadata: {
                flavor: 'codex',
                sessionAppliedModelV1: {
                    v: 1,
                    provider: 'codex',
                    updatedAt: 2,
                    modelId: 'gpt-5.6-sol',
                },
                sessionModelsV1: {
                    v: 1,
                    agentId: 'codex',
                    updatedAt: 1,
                    currentModelId: 'gpt-5.6-luna',
                    availableModels: [
                        { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
                        { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
                    ],
                },
            } as any,
        });

        expect(model.title).toBe('GPT-5.6-Sol Explorer Agent');
    });

    it('renders SubAgentRun with Sub-agent title and compacted subtitle', () => {
        const tool = makeToolCall({
            name: 'SubAgentRun',
            description:
                '{"status":"timeout","summary":"Timed out after 120000ms","error":{"code":"execution_run_timeout","message":"Timed out after 120000ms"}}',
        });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Subagent');
        expect(model.subtitle).toBe('Timed out after 120000ms');
    });

    it('labels a managed execution run with its requested model and intent', () => {
        const tool = makeToolCall({
            name: 'SubAgentRun',
            state: 'running',
            input: {
                intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                requestedConfiguration: { modelId: 'gpt-5.6-sol' },
            },
            description: null,
            result: null,
        });
        const model = resolveToolHeaderTextPresentation({
            tool,
            metadata: {
                flavor: 'codex',
                sessionModelsV1: {
                    v: 1,
                    agentId: 'codex',
                    updatedAt: 1,
                    currentModelId: 'gpt-5.6-sol',
                    availableModels: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
                },
            } as any,
        });
        expect(model.title).toBe('GPT-5.6-Sol Review Agent');
        expect(model.subtitle).toBe('review');
    });

    it('uses the managed execution run agent logo instead of the generic subagent glyph', () => {
        const tool = makeToolCall({
            name: 'SubAgentRun',
            state: 'running',
            input: {
                intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            },
        });
        const icon = knownTools.SubAgentRun.icon(18, '#111', { tool, metadata: null });

        expect(icon).toMatchObject({ props: { agentId: 'codex', size: 18 } });
    });

    it('normalizes TaskCreate to SubAgent for rendering', () => {
        const tool = makeToolCall({ name: 'TaskCreate', input: { description: 'Summarize third run' } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.normalizedToolName).toBe('SubAgent');
        expect(model.title).toBe('Subagent');
        expect(model.subtitle).toBe('Summarize third run');
    });

    it('renders AskUserQuestion with Question title and header subtitle', () => {
        const tool = makeToolCall({
            name: 'AskUserQuestion',
            input: {
                questions: [
                    {
                        header: 'Next Tool Stress?',
                        question: 'For a deeper tool+runtime stress test, should I run `yarn install`?',
                        options: [
                            { label: 'Yes', description: 'Run it' },
                            { label: 'No', description: 'Skip it' },
                        ],
                        multiSelect: false,
                    },
                ],
            },
        });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Question');
        expect(model.subtitle).toBe('Next Tool Stress?');
    });

    it('renders WorkspaceIndexingPermission with the shared translated default title', () => {
        const tool = makeToolCall({
            name: 'WorkspaceIndexingPermission',
            input: {
                options: [
                    { id: 'allow', name: 'Allow indexing' },
                ],
            },
        });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Workspace indexing');
    });

    it('capitalizes simple lowercase tool names (skill)', () => {
        const tool = makeToolCall({ name: 'skill', input: {} });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Skill');
    });
});

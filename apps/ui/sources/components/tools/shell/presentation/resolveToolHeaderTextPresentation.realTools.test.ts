import { describe, expect, it, vi } from 'vitest';

import type { ToolCall } from '@/sync/domains/messages/messageTypes';

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
                    provider: 'opencode',
                    updatedAt: 1,
                    currentModelId: 'muse-spark-1.3',
                    availableModels: [{ id: 'muse-spark-1.3', name: 'Muse Spark 1.3' }],
                },
            } as any,
        });
        expect(model.title).toBe('Muse Spark 1.3 Explore Agent');
        expect(model.subtitle).toBe('Summarize third run');
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
                    provider: 'codex',
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
                    provider: 'codex',
                    updatedAt: 1,
                    currentModelId: 'gpt-5.6-sol',
                    availableModels: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
                },
            } as any,
        });
        expect(model.title).toBe('GPT-5.6-Sol Review Agent');
        expect(model.subtitle).toBe('review');
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

    it('names TaskOutput after the background task it reads, not after a subagent', () => {
        const tool = makeToolCall({ name: 'TaskOutput', input: { task_id: 'task_1', block: true, timeout: 30000 } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.normalizedToolName).toBe('TaskOutput');
        expect(model.title).toBe('Task output');
        expect(model.subtitle).toBe('task_1');
    });

    it('names TaskStop after the command it stopped when the result reports one', () => {
        const tool = makeToolCall({
            name: 'TaskStop',
            input: { task_id: 'task_1' },
            result: { message: 'Stopped task_1', task_id: 'task_1', task_type: 'local_bash', command: 'sleep 600' },
        });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.normalizedToolName).toBe('TaskStop');
        expect(model.title).toBe('Stop task');
        expect(model.subtitle).toBe('sleep 600');
    });

    it('falls back to the task id for TaskStop while the stop is still in flight', () => {
        const tool = makeToolCall({ name: 'TaskStop', state: 'running', input: { task_id: 'task_1' }, result: null });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.subtitle).toBe('task_1');
    });

    it('shows the invoked Claude skill in the title before a result arrives', () => {
        const tool = makeToolCall({
            name: 'Skill',
            state: 'running',
            input: { skill: ' claude-conversations ', args: 'search recent sessions' },
        });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Skill: claude-conversations');
    });

    it.each([{}, { skill: ' ' }, { skill: 42 }])('keeps the generic Skill title for unusable input %j', (input) => {
        const tool = makeToolCall({ name: 'skill', input });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Skill');
    });
});

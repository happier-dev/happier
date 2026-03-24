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

    it('renders Task with Sub-agent title and description subtitle', () => {
        const tool = makeToolCall({ name: 'Task', input: { description: 'Summarize third run' } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Subagent');
        expect(model.subtitle).toBe('Summarize third run');
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

    it('renders SubAgentRun with intent/backend context while running before transcript content arrives', () => {
        const tool = makeToolCall({
            name: 'SubAgentRun',
            state: 'running',
            input: { intent: 'review', backendId: 'codex' },
            description: null,
            result: null,
        });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Subagent');
        expect(model.subtitle).toBe('review · codex');
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

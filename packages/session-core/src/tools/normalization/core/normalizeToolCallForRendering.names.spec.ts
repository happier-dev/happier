import { describe, expect, it } from 'vitest';

import { normalizeToolCallForRendering } from "./normalizeToolCallForRendering.js";
import { makeTool } from "./normalizeToolCallForRendering._testHelpers.js";

describe('normalizeToolCallForRendering (names)', () => {
    it('projects CLI scripts from the shell without changing ordinary or compound shell calls', () => {
        const command = 'happier tools run --agent-bridge script.js';
        const result = { stdout: '{"count":2}', stderr: 'reading sources' };
        expect(normalizeToolCallForRendering(makeTool({ name: 'Bash', input: { command }, result }))).toMatchObject({
            name: 'Script',
            input: { code: command, origin: 'cli' },
            result: { output: { count: 2 }, ...result },
        });
        expect(normalizeToolCallForRendering(makeTool({ name: 'Bash', input: { command: command + ' && echo done' } })).name).toBe('Bash');
        const native = makeTool({ name: 'Script', input: { code: 'return 2;', origin: 'native' }, result: { output: 2 } });
        expect(normalizeToolCallForRendering(native)).toMatchObject({ name: 'Script', input: native.input, result: native.result });
    });

    it('projects stdin source and preserves a structured shell failure', () => {
        const command = '"$HAPPIER_CLI_BIN" tools run --agent-bridge - <<\'SCRIPT\'\nreturn await tools.search({ query: "issues" });\nSCRIPT';
        const result = { exitCode: 1, output: 'script could not connect' };
        const normalized = normalizeToolCallForRendering(makeTool({ name: 'Bash', input: { command }, result }));
        expect(normalized).toMatchObject({
            name: 'Script',
            input: { code: 'return await tools.search({ query: "issues" });', origin: 'cli' },
            result: { output: 'script could not connect' },
        });
    });

    it('projects the inline runner source and its completed and refused calls from the CLI receipt', () => {
        const code = 'await tools.search({ query: "issues" });\nawait mcp.issues.update();';
        const refusalCause = { kind: 'access_denied' };
        const command = `happier tools run --agent-bridge --code '${code}'`;
        const result = JSON.stringify({
            ok: false,
            error: { code: 'permission_denied', message: 'Tool permission denied.', failureCause: refusalCause },
            calls: [
                { operation: 'search', ok: true },
                { operation: 'call', source: 'issues', tool: 'update', ok: false, errorCode: 'permission_denied' },
            ],
        });
        expect(normalizeToolCallForRendering(makeTool({ name: 'Bash', input: { command }, result }))).toMatchObject({
            name: 'Script',
            input: { code, origin: 'cli' },
            result: {
                error: 'Tool permission denied.',
                calls: [
                    { tool: 'search', status: 'completed' },
                    { source: 'issues', tool: 'update', status: 'error', refusalCause },
                ],
            },
        });
    });
    it('maps legacy tool names to canonical V2 tool names', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'CodexPatch',
                input: { changes: { '/tmp/a.txt': { add: { content: 'x' } } } },
                result: { ok: true },
            }),
        );
        expect(normalized.name).toBe('Patch');
    });

    it('maps edit calls with a changes map to Patch', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'edit',
                input: {
                    changes: {
                        '/tmp/a.txt': {
                            type: 'update',
                            old_content: 'a',
                            new_content: 'b',
                            unified_diff: '@@ -1 +1 @@\n-a\n+b\n',
                        },
                    },
                },
            }),
        );
        expect(normalized.name).toBe('Patch');
    });

    it('maps execute/shell variants to Bash', () => {
        const execute = normalizeToolCallForRendering(
            makeTool({
                name: 'execute',
                input: { command: ['bash', '-lc', 'echo hi'] },
            }),
        );
        expect(execute.name).toBe('Bash');

        const bash = normalizeToolCallForRendering(
            makeTool({
                name: 'bash',
                input: { command: ['bash', '-lc', 'echo hi'] },
            }),
        );
        expect(bash.name).toBe('Bash');
    });

    it('maps common lowercase tool names to canonical TitleCase names', () => {
        const tools = [
            { name: 'glob', expected: 'Glob', input: { glob: '*.ts' } },
            { name: 'grep', expected: 'Grep', input: { pattern: 'x' } },
            { name: 'ls', expected: 'LS', input: { path: '.' } },
            { name: 'web_fetch', expected: 'WebFetch', input: { href: 'https://example.com' } },
            { name: 'web_search', expected: 'WebSearch', input: { q: 'cats' } },
        ];

        for (const item of tools) {
            const normalized = normalizeToolCallForRendering(
                makeTool({
                    name: item.name,
                    input: item.input,
                }),
            );
            expect(normalized.name).toBe(item.expected);
        }
    });

    it('prefers ACP titles for wrapped web tools over generic ACP kinds', () => {
        const webFetch = normalizeToolCallForRendering(
            makeTool({
                name: 'read',
                input: { _acp: { title: 'web_fetch' }, title: 'web_fetch' },
            }),
        );
        expect(webFetch.name).toBe('WebFetch');

        const webSearch = normalizeToolCallForRendering(
            makeTool({
                name: 'search',
                input: { _acp: { title: 'web_search' }, title: 'web_search' },
            }),
        );
        expect(webSearch.name).toBe('WebSearch');
    });

    it('maps Claude teammate Agent tool calls to the canonical SubAgent renderer name', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'Agent',
                input: {
                    name: 'alpha',
                    team_name: 'qa-team',
                    description: 'Inspect repo, report one fact',
                },
                result: null,
                state: 'running',
                completedAt: null,
            }),
        );

        expect(normalized.name).toBe('SubAgent');
    });

    it('maps generic Task tool calls to the canonical SubAgent renderer name', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'Task',
                input: {
                    description: 'Inspect the repo and report back',
                    prompt: 'Inspect the repo and report back',
                },
                result: null,
                state: 'running',
                completedAt: null,
            }),
        );

        expect(normalized.name).toBe('SubAgent');
    });

    it('maps workspace indexing permission prompts to known tool name', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'Unknown tool',
                state: 'running',
                input: {
                    toolCall: { title: 'Workspace Indexing Permission', toolCallId: 'workspace-indexing-permission' },
                    permissionId: 'workspace-indexing-permission',
                },
                result: null,
                completedAt: null,
                description: 'Unknown tool',
            }),
        );

        expect(normalized.name).toBe('WorkspaceIndexingPermission');
    });

    it('prefers explicit canonical tool metadata from _happier/_happy', () => {
        const happier = normalizeToolCallForRendering(
            makeTool({
                name: 'TaskUpdate',
                state: 'running',
                input: {
                    _happier: { canonicalToolName: 'SubAgent' },
                    subject: 'x',
                },
                result: null,
                completedAt: null,
            }),
        );
        expect(happier.name).toBe('SubAgent');

        const happy = normalizeToolCallForRendering(
            makeTool({
                name: 'future_tool',
                state: 'running',
                input: { _happy: { canonicalToolName: 'FutureTool' } },
                completedAt: null,
            }),
        );
        expect(happy.name).toBe('FutureTool');
    });

    it('does not map contradictory change_title aliases to the change title renderer', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'happier/change_title',
                input: {},
                description: 'Tool: playwright/browser_navigate',
            }),
        );

        expect(normalized.name).toBe('unknown');
    });
});

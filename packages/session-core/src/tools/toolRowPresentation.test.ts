import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../messages/index.js';
import { resolveToolRowPresentation } from './toolRowPresentation.js';

describe('tool row presentation', () => {
    it('names a denied shell call by its command and keeps denial ahead of completed transport state', () => {
        const tool: ToolCall = { name: 'Bash', input: { command: 'pwd' }, description: 'execute',
            state: 'completed', result: null, createdAt: 1, startedAt: 1, completedAt: 2,
            permission: { id: 'permission', status: 'denied' } };
        expect(resolveToolRowPresentation(tool)).toMatchObject({ title: 'Run pwd', statusKind: 'permission_blocked' });
    });

    it('preserves the retained command denial without private AgentState or an Action approval', () => {
        // R54 Verdant server:cmvnkwbz9008gmcwqpaef961f, bounded live row projection.
        // The app adds permission.status=denied from AgentState; public recipients never receive it.
        const tool: ToolCall = { name: 'Bash', input: { command: '/bin/bash -lc pwd', cwd: '/repo' },
            description: null, state: 'completed', createdAt: 1, startedAt: 1, completedAt: 2,
            result: { type: 'commandExecution', id: 'exec-retained', command: '/bin/bash -lc pwd',
                source: 'agent', status: 'declined', aggregatedOutput: '', exitCode: null, durationMs: null,
                _happier: { v: 2, protocol: 'acp', provider: 'codex', rawToolName: 'Bash', canonicalToolName: 'Bash' } } };
        expect(resolveToolRowPresentation(tool)).toEqual({ title: 'Run pwd', statusKind: 'permission_blocked' });
        expect(resolveToolRowPresentation({ ...tool, permission: { id: 'exec-retained', status: 'denied' } }))
            .toEqual(resolveToolRowPresentation(tool));
        expect(resolveToolRowPresentation({ ...tool, result: { type: 'other', status: 'declined' } }).statusKind).toBe('completed');
        expect(resolveToolRowPresentation({ ...tool, result: { type: 'commandExecution', status: 'completed', stdout: 'Permission denied' } }).statusKind).toBe('completed');
        expect(resolveToolRowPresentation({ ...tool, result: { type: 'commandExecution', status: 'declined', isError: true } }).statusKind).toBe('error');
    });
});

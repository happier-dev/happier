import { describe, expect, it } from 'vitest';
import {
    KNOWN_CODEX_ROLLOUT_TOOL_NAMES,
    canonicalizeCodexRolloutToolName,
    normalizeCodexRolloutToolInput,
} from '../localControl/rolloutToolNameMapping';

describe('codex local-control rollout tool mapping', () => {
    const expectedInventory = [
        'shell',
        'shell_command',
        'exec_command',
        'context7__get-library-docs',
        'context7__resolve-library-id',
        'update_plan',
        'write_stdin',
        'view_image',
        'request_user_input',
        'read_mcp_resource',
        'list_mcp_resources',
        'list_mcp_resource_templates',
        'apply_patch',
    ] as const;

    it('keeps the observed non-mcp tool inventory stable (drift detection)', () => {
        const actual = [...KNOWN_CODEX_ROLLOUT_TOOL_NAMES];

        if (JSON.stringify(actual) !== JSON.stringify(expectedInventory)) {
            throw new Error(
                [
                    'Codex rollout tool inventory drift detected.',
                    'If this change is intentional, update expectedInventory in rolloutToolNameMapping.test.ts and KNOWN_CODEX_ROLLOUT_TOOL_NAMES in rolloutToolNameMapping.ts together.',
                    `Observed inventory: ${JSON.stringify(actual)}`,
                ].join('\n'),
            );
        }

        expect(actual).toEqual(expectedInventory);
    });

    it('keeps non-mcp inventory entries unique', () => {
        const actual = [...KNOWN_CODEX_ROLLOUT_TOOL_NAMES];
        const unique = new Set(actual);
        expect(unique.size).toBe(actual.length);
    });

    it('canonicalizes exec_command as Bash (default-visible)', () => {
        expect(canonicalizeCodexRolloutToolName('exec_command')).toEqual({
            canonicalToolName: 'Bash',
            visibility: 'default',
        });
    });

    it('canonicalizes shell/shell_command as Bash (default-visible)', () => {
        expect(canonicalizeCodexRolloutToolName('shell')).toEqual({
            canonicalToolName: 'Bash',
            visibility: 'default',
        });
        expect(canonicalizeCodexRolloutToolName('shell_command')).toEqual({
            canonicalToolName: 'Bash',
            visibility: 'default',
        });
    });

    it('canonicalizes apply_patch as Patch (default-visible)', () => {
        expect(canonicalizeCodexRolloutToolName('apply_patch')).toEqual({
            canonicalToolName: 'Patch',
            visibility: 'default',
        });
    });

    it('canonicalizes legacy context7__* tools as mcp__context7__* (default-visible)', () => {
        expect(canonicalizeCodexRolloutToolName('context7__get-library-docs')).toEqual({
            canonicalToolName: 'mcp__context7__get-library-docs',
            visibility: 'default',
        });
        expect(canonicalizeCodexRolloutToolName('context7__resolve-library-id')).toEqual({
            canonicalToolName: 'mcp__context7__resolve-library-id',
            visibility: 'default',
        });
    });

    it('treats mcp__* tools as pass-through (default-visible)', () => {
        expect(canonicalizeCodexRolloutToolName('mcp__playwright__browser_click')).toEqual({
            canonicalToolName: 'mcp__playwright__browser_click',
            visibility: 'default',
        });
    });

    it('marks agent-internal tools as debug-only or ignore', () => {
        expect(canonicalizeCodexRolloutToolName('update_plan').visibility).toBe('debug-only');
        expect(canonicalizeCodexRolloutToolName('write_stdin').visibility).toBe('ignore');
    });

    it('defaults unknown tool names to debug-only (do not drop)', () => {
        expect(canonicalizeCodexRolloutToolName('new_tool').visibility).toBe('debug-only');
    });

    it('parses JSON string inputs when possible', () => {
        expect(normalizeCodexRolloutToolInput('exec_command', '{"cmd":"echo hi"}')).toEqual({ cmd: 'echo hi' });
    });

    it('normalizes apply_patch input into an object with patch', () => {
        expect(normalizeCodexRolloutToolInput('apply_patch', '*** Begin Patch\n*** End Patch')).toEqual({
            patch: '*** Begin Patch\n*** End Patch',
        });
    });
});

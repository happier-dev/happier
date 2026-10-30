import { describe, expect, it } from 'vitest';
import {
    KNOWN_CODEX_ROLLOUT_TOOL_NAMES,
    canonicalizeCodexRolloutToolName,
    normalizeCodexRolloutToolInput,
} from './toolInvocation.js';

describe('codex terminal-mode rollout tool mapping', () => {
    it('retains the native code-mode script as a visible tool without interpreting its code', () => {
        const code = 'const result = await tools.exec_command({cmd:"pwd"}); text(result);';
        expect(canonicalizeCodexRolloutToolName('exec')).toEqual({ canonicalToolName: 'exec', visibility: 'default' });
        expect(normalizeCodexRolloutToolInput('exec', code)).toBe(code);
    });

    it('keeps non-mcp inventory entries unique', () => {
        const actual = [...KNOWN_CODEX_ROLLOUT_TOOL_NAMES];
        const unique = new Set(actual);
        expect(unique.size).toBe(actual.length);
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


    it('canonicalizes title-control aliases as change_title (default-visible)', () => {
        expect(canonicalizeCodexRolloutToolName('change_title')).toEqual({
            canonicalToolName: 'change_title',
            visibility: 'default',
        });
        expect(canonicalizeCodexRolloutToolName('session_title_set')).toEqual({
            canonicalToolName: 'change_title',
            visibility: 'default',
        });
        expect(canonicalizeCodexRolloutToolName('happier_change_title')).toEqual({
            canonicalToolName: 'change_title',
            visibility: 'default',
        });
        expect(canonicalizeCodexRolloutToolName('mcp__happy__change_title')).toEqual({
            canonicalToolName: 'change_title',
            visibility: 'default',
        });
        expect(canonicalizeCodexRolloutToolName('mcp__happier__session_title_set')).toEqual({
            canonicalToolName: 'change_title',
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
        expect(canonicalizeCodexRolloutToolName('spawn_agent').visibility).toBe('ignore');
        expect(canonicalizeCodexRolloutToolName('wait_agent').visibility).toBe('ignore');
        expect(canonicalizeCodexRolloutToolName('close_agent').visibility).toBe('ignore');
    });

    it('defaults unknown tool names to debug-only (do not drop)', () => {
        expect(canonicalizeCodexRolloutToolName('new_tool').visibility).toBe('debug-only');
    });

    it('parses JSON string inputs when possible', () => {
        expect(normalizeCodexRolloutToolInput('exec_command', '{"cmd":"echo hi"}')).toEqual({ cmd: 'echo hi' });
    });

});

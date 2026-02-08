import { describe, expect, it } from 'vitest';

import { extractShellCommand } from './shellCommand';

describe('extractShellCommand', () => {
    it('extracts a command from argv[] arrays', () => {
        const input = JSON.stringify({ argv: ['/bin/bash', '-lc', 'ls -la'] });
        expect(extractShellCommand(input)).toBe('ls -la');
    });

    it('extracts nested commands from toolCall.rawInput', () => {
        const input = JSON.stringify({
            toolCall: { rawInput: { command: ['/bin/zsh', '-lc', 'git status'] } },
        });
        expect(extractShellCommand(input)).toBe('git status');
    });

    it('extracts a command from JSON-stringified ACP args', () => {
        const input = JSON.stringify({
            command: ['/bin/zsh', '-lc', 'echo hello'],
            cwd: '/tmp',
        });
        expect(extractShellCommand(input)).toBe('echo hello');
    });

    it('extracts a command from JSON-stringified simple args', () => {
        const input = JSON.stringify({ command: 'pwd' });
        expect(extractShellCommand(input)).toBe('pwd');
    });

    it('returns null for malformed or non-object inputs', () => {
        expect(extractShellCommand('{not-json')).toBeNull();
        expect(extractShellCommand('hello')).toBeNull();
        expect(extractShellCommand(['echo', 'hi'])).toBeNull();
    });
});

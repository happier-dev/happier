import { describe, expect, it } from 'vitest';

import {
    parseClaudeTerminalRawSpawnOptionOverrides,
    partitionClaudeTerminalUserArgs,
} from './argv.js';

describe('Claude terminal argv leaf', () => {
    it('normalizes managed spawn option overrides from inline and split flags', () => {
        expect(parseClaudeTerminalRawSpawnOptionOverrides([
            '--model= opus ',
            '--fallback-model',
            ' haiku ',
            '--system-prompt= custom ',
            '--append-system-prompt',
            ' append ',
        ])).toEqual({
            model: 'opus',
            fallbackModel: 'haiku',
            customSystemPrompt: 'custom',
            appendSystemPrompt: 'append',
        });
    });

    it('partitions raw args while preserving positional prompts after flags', () => {
        expect(partitionClaudeTerminalUserArgs([
            '--model=raw-opus',
            '--mcp-config',
            '/tmp/claude-mcp.json',
            '--permission-mode=acceptEdits',
            'prompt text',
        ])).toEqual({
            flagArgs: ['--mcp-config', '/tmp/claude-mcp.json'],
            positionalArgs: ['prompt text'],
            trailingPermissionFlagArgs: ['--permission-mode', 'acceptEdits'],
        });
    });

    it.each([
        ['--mcp-config', '{"mcpServers":{"fixture":{"env":{"TOKEN":"synthetic-terminal-marker"}}}}'],
        ['--mcp-config={"mcpServers":{"fixture":{"env":{"TOKEN":"synthetic-terminal-marker"}}}}'],
    ])('rejects inline MCP JSON before direct terminal spawn', (...args) => {
        expect(() => partitionClaudeTerminalUserArgs(args)).toThrow(/MCP config file path/u);
    });

    it('keeps the last explicit permission override as the trailing permission flag', () => {
        expect(partitionClaudeTerminalUserArgs([
            '--permission-mode',
            'default',
            '--dangerously-skip-permissions',
        ])).toEqual({
            flagArgs: [],
            positionalArgs: [],
            trailingPermissionFlagArgs: ['--permission-mode', 'bypassPermissions'],
        });
    });

    it('does not let bare --resume consume a following permission flag', () => {
        expect(partitionClaudeTerminalUserArgs([
            '--resume',
            '--permission-mode',
            'bypassPermissions',
        ])).toEqual({
            flagArgs: ['--resume'],
            positionalArgs: [],
            trailingPermissionFlagArgs: ['--permission-mode', 'bypassPermissions'],
        });
    });

    it('keeps the optional value of the short -r resume flag attached', () => {
        expect(partitionClaudeTerminalUserArgs([
            '-r',
            'session-id',
            '--permission-mode',
            'bypassPermissions',
        ])).toEqual({
            flagArgs: ['-r', 'session-id'],
            positionalArgs: [],
            trailingPermissionFlagArgs: ['--permission-mode', 'bypassPermissions'],
        });
    });

    it('treats user-supplied yolo allow flags as managed so callers can add one canonical copy', () => {
        expect(partitionClaudeTerminalUserArgs([
            '--allow-dangerously-skip-permissions',
            '--allow-dangerously-skip-permissions',
            'prompt text',
        ])).toEqual({
            flagArgs: [],
            positionalArgs: ['prompt text'],
            trailingPermissionFlagArgs: [],
        });
    });
});

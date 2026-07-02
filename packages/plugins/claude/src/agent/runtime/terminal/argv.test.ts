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
            '{"mcpServers":{}}',
            '--permission-mode=acceptEdits',
            'prompt text',
        ])).toEqual({
            flagArgs: ['--mcp-config', '{"mcpServers":{}}'],
            positionalArgs: ['prompt text'],
            trailingPermissionFlagArgs: ['--permission-mode', 'acceptEdits'],
        });
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
});

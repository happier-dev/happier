import { describe, expect, it } from 'vitest';

import { probeClaudePreflightModels } from './models.js';

describe('probeClaudePreflightModels', () => {
    it('returns Claude static model facts with context windows when the CLI supports effort options', async () => {
        const models = await probeClaudePreflightModels({
            cwd: '/tmp/project',
            timeoutMs: 1_500,
            probeHelpText: async () => '  --effort <level>  Effort level for the current session',
        });

        expect(models).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'claude-fable-5',
                contextWindowTokens: 1_000_000,
                modelOptions: expect.arrayContaining([expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'high',
                })]),
            }),
            expect.objectContaining({
                id: 'claude-opus-4-8',
                contextWindowTokens: 1_000_000,
                modelOptions: expect.arrayContaining([expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'high',
                })]),
            }),
            expect.objectContaining({
                id: 'claude-opus-4-7',
                contextWindowTokens: 1_000_000,
                modelOptions: expect.arrayContaining([expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'xhigh',
                })]),
            }),
        ]));
    });

    it('returns null when the installed CLI does not expose effort options', async () => {
        const models = await probeClaudePreflightModels({
            cwd: '/tmp/project',
            timeoutMs: 1_500,
            probeHelpText: async () => 'Claude Code help output without the required option',
        });

        expect(models).toBeNull();
    });
});

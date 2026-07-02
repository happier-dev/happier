import { describe, expect, it } from 'vitest';

import {
    normalizeClaudeToolNameToCanonicalToolNameV2,
    normalizeClaudeToolUseNamesInSdkMessage,
} from './toolUseNames.js';

describe('normalizeClaudeToolUseNames', () => {
    it('maps Claude Agent Teams tool names to canonical tool names', () => {
        expect(normalizeClaudeToolNameToCanonicalToolNameV2('TeamCreate')).toBe('AgentTeamCreate');
        expect(normalizeClaudeToolNameToCanonicalToolNameV2('TeamDelete')).toBe('AgentTeamDelete');
        expect(normalizeClaudeToolNameToCanonicalToolNameV2('SendMessage')).toBe('AgentTeamSendMessage');
        expect(normalizeClaudeToolNameToCanonicalToolNameV2('sendMessage')).toBe('AgentTeamSendMessage');
    });

    it('maps Claude teammate Agent tool uses to canonical SubAgent', () => {
        expect(normalizeClaudeToolNameToCanonicalToolNameV2('Agent')).toBe('SubAgent');
    });

    it('normalizes tool_use name in assistant SDK messages', () => {
        const message = {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { prompt: 'Hello' } },
                ],
            },
        };

        const normalized = normalizeClaudeToolUseNamesInSdkMessage(message);
        expect(normalized).not.toBe(message);
        expect((normalized as { message: { content: Array<{ name: string }> } }).message.content[0]?.name).toBe('SubAgent');
    });
});


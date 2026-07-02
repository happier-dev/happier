import { describe, expect, it } from 'vitest';

import type { RawJSONLines } from '../transcripts/rawJsonLines.js';
import { isClaudePromptRootSidechainUserMessage, markClaudeRecordAsSidechain } from './records.js';

describe('Claude sidechain records', () => {
    it('detects prompt-root user rows and marks imported rows as sidechains', () => {
        const promptRoot = {
            type: 'user',
            isSidechain: true,
            message: { role: 'user', content: 'build this' },
        } as RawJSONLines;

        expect(isClaudePromptRootSidechainUserMessage(promptRoot)).toBe(true);
        expect(isClaudePromptRootSidechainUserMessage({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: 'not prompt root' }] },
        } as RawJSONLines)).toBe(false);

        const imported = { type: 'assistant', uuid: 'a1' } as RawJSONLines;
        expect(markClaudeRecordAsSidechain(imported, 'toolu_1')).toMatchObject({
            isSidechain: true,
            sidechainId: 'toolu_1',
        });
    });
});

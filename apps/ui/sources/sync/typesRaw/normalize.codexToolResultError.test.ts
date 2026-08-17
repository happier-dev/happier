import { describe, expect, it } from 'vitest';

import { normalizeRawMessage } from './normalize';

describe('normalizeRawMessage Codex tool results', () => {
    it.each([
        { isError: true, expectedIsError: true },
        { isError: false, expectedIsError: false },
    ])('preserves an authoritative isError=$isError result', ({ isError, expectedIsError }) => {
        const normalized = normalizeRawMessage('message-1', null, 1_000, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call-result',
                    callId: 'call-1',
                    output: 'command output',
                    id: 'result-1',
                    isError,
                },
            },
        });

        expect(normalized).not.toBeNull();
        expect(normalized?.role).toBe('agent');
        if (!normalized || normalized.role !== 'agent') return;
        expect(normalized.content[0]).toMatchObject({
            type: 'tool-result',
            tool_use_id: 'call-1',
            is_error: expectedIsError,
        });
    });
});

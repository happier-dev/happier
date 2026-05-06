import { describe, expect, it } from 'vitest';

import { getTaskLifecycleEventFromRawContent } from './taskLifecycle';

function rawContent(type: string) {
    return {
        content: {
            type: 'acp',
            data: { type, id: 'turn-1' },
        },
    };
}

describe('taskLifecycle', () => {
    it.each(['turn_failed', 'turn_cancelled', 'turn_aborted'] as const)(
        'parses terminal lifecycle marker %s',
        (type) => {
            expect(getTaskLifecycleEventFromRawContent(rawContent(type), 123)).toEqual({
                type,
                id: 'turn-1',
                createdAt: 123,
            });
        },
    );
});

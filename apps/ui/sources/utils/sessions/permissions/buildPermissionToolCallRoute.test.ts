import { describe, expect, it } from 'vitest';

import { buildPermissionToolCallRoute } from './buildPermissionToolCallRoute';

describe('buildPermissionToolCallRoute', () => {
    it('builds an encoded nested tool route with a stable child jump id', () => {
        expect(
            buildPermissionToolCallRoute({
                sessionId: 'session-1',
                location: {
                    kind: 'nested',
                    parentMessageId: 'tool:call:parent/1',
                    messageId: 'tool:call:child/2',
                    seq: 42,
                },
            }),
        ).toBe('/session/session-1/message/tool%3Acall%3Aparent%2F1?jumpChildId=tool%3Acall%3Achild%2F2');
    });
});

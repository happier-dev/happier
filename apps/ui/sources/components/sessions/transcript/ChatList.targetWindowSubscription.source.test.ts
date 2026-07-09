import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const CHAT_LIST_SOURCE = readFileSync(new URL('./ChatList.tsx', import.meta.url), 'utf8');

describe('ChatList target-window state subscription boundary', () => {
    it('subscribes to target-window state owner transitions instead of render-only reads', () => {
        expect(CHAT_LIST_SOURCE).toContain('React.useSyncExternalStore');
        expect(CHAT_LIST_SOURCE).toContain('subscribeSessionTargetWindowState');
        expect(CHAT_LIST_SOURCE).toContain('getSessionTargetWindowSnapshot');
    });
});

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { BrowserFirstUseConnecting } from './BrowserFirstUseConnecting';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

describe('BrowserFirstUseConnecting', () => {
    it('names no agent while none resolves, instead of a fallback name mid-sentence', async () => {
        const screen = await renderScreen(<BrowserFirstUseConnecting firstUse="opening" machineName="devbox" agent={null} testID="c" />);
        try {
            expect(screen.getTextContent()).toContain('browserPresence.stream.connectingTitleAgentless');
            expect(screen.getTextContent()).not.toContain('"agent":');
        } finally { await screen.unmount(); }
    });
});

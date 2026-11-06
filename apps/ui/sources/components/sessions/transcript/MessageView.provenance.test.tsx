import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import type { UserTextMessage } from '@/sync/domains/messages/messageTypes';
import { storage } from '@/sync/domains/state/storageStore';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

installMessageViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => params ? `${key}: ${Object.values(params).join(' ')}` : key,
        });
    },
});

describe('MessageView session sender provenance', () => {
    let previousState: ReturnType<typeof storage.getState>;
    beforeEach(() => { previousState = storage.getState(); });
    afterEach(() => {
        standardCleanup();
        storage.setState(previousState);
    });

    it.each([
        { via: 'action', cached: true },
        { via: 'mcp', cached: true },
        { via: 'mcp', cached: false },
    ] as const)('identifies a session-authored user message via $via (cached sender: $cached)', async ({ via, cached }) => {
        const { MessageView } = await import('./MessageView');
        const sourceSessionId = 'source-session-exact-id';
        storage.setState({
            sessions: cached ? {
                [sourceSessionId]: createSessionFixture({
                    id: sourceSessionId,
                    metadata: { name: 'Review companion', path: '/workspace', host: 'local' },
                }),
            } : {},
            sessionListRenderables: {},
        });
        const message = {
            kind: 'user-text', id: 'sent-message', localId: 'sent-message', createdAt: 1,
            text: 'Please inspect the pending changes.',
            meta: { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId, via } },
        } satisfies UserTextMessage;
        const screen = await renderScreen(<MessageView sessionId="recipient" metadata={null} message={message} />);

        const attribution = screen.findByTestId('transcript-provenance-attribution:sent-message');
        expect(attribution).not.toBeNull();
        expect(attribution?.props.children).toContain(sourceSessionId);
        expect(attribution?.props.children).toContain(cached ? 'Review companion' : 'message.provenanceSession');
        expect(attribution?.props.children).toContain(via);
        expect(attribution?.props.selectable).toBe(true);
    });

    it.each([
        undefined,
        { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'source', via: 'unknown' } },
        { happierProvenanceV1: { v: 2, kind: 'happierSession', sourceSessionId: 'source', via: 'mcp' } },
    ])('keeps human and unsupported-provenance messages without a session attribution', async (meta) => {
        const { MessageView } = await import('./MessageView');
        const message = {
            kind: 'user-text', id: 'human-message', localId: 'human-message', createdAt: 1,
            text: 'A normal message.', meta,
        } satisfies UserTextMessage;
        const screen = await renderScreen(<MessageView sessionId="recipient" metadata={null} message={message} />);

        expect(screen.findAllByTestId('transcript-provenance-attribution:human-message')).toHaveLength(0);
    });
});

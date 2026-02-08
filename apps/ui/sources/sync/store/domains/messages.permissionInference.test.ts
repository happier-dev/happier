import { describe, expect, it } from 'vitest';

import { inferLatestUserPermissionModeFromMessages } from './messages';

describe('inferLatestUserPermissionModeFromMessages', () => {
    it('maps legacy provider tokens to canonical intents', () => {
        const res = inferLatestUserPermissionModeFromMessages([
            {
                kind: 'user-text',
                id: 'm2',
                localId: null,
                createdAt: 200,
                text: 'hi',
                meta: { permissionMode: 'acceptEdits' as any },
            } as any,
            {
                kind: 'user-text',
                id: 'm1',
                localId: null,
                createdAt: 100,
                text: 'older',
                meta: { permissionMode: 'bypassPermissions' as any },
            } as any,
        ]);

        expect(res).toEqual({ mode: 'safe-yolo', updatedAt: 200 });
    });

    it('returns null when no user message carries a parseable permissionMode', () => {
        expect(
            inferLatestUserPermissionModeFromMessages([
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 10, text: 'ok' } as any,
            ]),
        ).toBeNull();
    });
});


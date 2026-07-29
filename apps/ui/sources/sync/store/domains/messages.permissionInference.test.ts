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

    it('ignores recovered history while live messages still infer permission mode', () => {
        expect(inferLatestUserPermissionModeFromMessages([
            {
                kind: 'user-text', id: 'live', localId: 'live-local', createdAt: 100, text: 'live',
                meta: { permissionMode: 'acceptEdits' },
            } as any,
            {
                kind: 'user-text', id: 'history', localId: null, createdAt: 9_000, sourceCreatedAt: 50,
                text: 'history', meta: { permissionMode: 'bypassPermissions' },
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
            } as any,
        ])).toEqual({ mode: 'safe-yolo', updatedAt: 100 });
    });
});

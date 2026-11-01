import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../typesRaw';
import { parseSessionMediaMessageMeta } from '../domains/sessionMedia/sessionMediaMessageMeta';
import { createReducer, reducer } from './reducer';

describe('tool-result session media ownership', () => {
    it.each(['main', 'sidechain', 'orphan', 'namespaced'] as const)(
        'keeps images and unavailable items on their owning tool (%s)',
        (mode) => {
            const state = createReducer();
            const single = mode === 'namespaced';
            const ids = single ? ['sc:task:read-1'] : ['read-1', 'read-2', 'read-3'];
            const sidechain = mode === 'sidechain' || single ? { sidechainId: 'task', isSidechain: true } : { isSidechain: false };
            const calls: NormalizedMessage = {
                id: 'calls', localId: null, createdAt: 1, role: 'agent', ...sidechain,
                content: ids.map(id => ({
                    type: 'tool-call', id, name: 'Read', input: {}, description: null,
                    uuid: `call-${id}`, parentUUID: null,
                })),
            };
            const results: NormalizedMessage = {
                id: 'results', localId: null, createdAt: 2, role: 'agent', ...sidechain,
                content: ids.map(id => ({
                    type: 'tool-result', tool_use_id: id, content: 'Read finished', is_error: false,
                    uuid: `result-${id}`, parentUUID: null,
                })),
                meta: { happier: { kind: 'session_media.v1', payload: {
                    media: [{
                        id: 'image-1', role: 'output', category: 'tool-artifact', mediaKind: 'image',
                        name: 'comparison.png', path: '.happier/uploads/artifacts/comparison.png',
                        mimeType: 'image/png', sizeBytes: 80,
                        origin: { source: 'tool-output', toolCallId: 'read-1' },
                    }],
                    ...(!single ? { unavailable: [{
                        id: 'b'.repeat(64), role: 'output', category: 'tool-artifact', mediaKind: 'image',
                        code: 'persistence_failed', origin: {
                            source: 'tool-output',
                            toolCallIdHash: createHash('sha256').update('read-3').digest('hex'),
                        },
                    }] } : {}),
                } } },
            };
            if (mode === 'orphan') {
                reducer(state, [results]);
                reducer(state, [calls]);
            } else {
                reducer(state, [calls, results]);
            }
            const mediaFor = (id: string) => {
                const row = [...state.messages.values()].find(message => message.tool?.id === id);
                expect(row?.tool?.state).toBe('completed');
                return parseSessionMediaMessageMeta(row?.meta);
            };
            expect(mediaFor(ids[0]!).inlineImages).toHaveLength(1);
            expect(mediaFor(ids[0]!).unavailableMedia).toEqual([]);
            if (!single) {
                expect(mediaFor('read-2').inlineImages).toEqual([]);
                expect(mediaFor('read-2').unavailableMedia).toEqual([]);
                expect(mediaFor('read-3').inlineImages).toEqual([]);
                expect(mediaFor('read-3').unavailableMedia).toMatchObject([{ code: 'persistence_failed' }]);
            }
        },
    );
});

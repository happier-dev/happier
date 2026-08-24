import { describe, expect, it } from 'vitest';

import type { SessionDraftDocumentV1 } from '@happier-dev/protocol';

import { createSessionDraftRepository } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import {
    createExistingSessionDraftSemanticValues,
} from './existingSessionDraftSemanticValues';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const address = { kind: 'session', sessionId: 'session-a' } as const;

function field<T>(mutationId: string, value: T) {
    return { mutationId, value };
}

function remoteDocument(): SessionDraftDocumentV1 {
    return {
        v: 1,
        composer: {
            text: field('00000000-0000-4000-8000-000000000001', 'hello'),
            mentions: field('00000000-0000-4000-8000-000000000002', [{
                kind: 'skill',
                name: 'review',
                tokenText: '$review',
            }]),
            attachments: field('00000000-0000-4000-8000-000000000003', []),
        },
        target: {
            kind: 'session',
            routing: {
                recipient: field('00000000-0000-4000-8000-000000000004', null),
                agentContinuation: field('00000000-0000-4000-8000-000000000005', null),
                executionRunDelivery: field('00000000-0000-4000-8000-000000000006', 'interrupt'),
            },
        },
        extensions: {
            'future.plugin': {
                futureField: field('00000000-0000-4000-8000-000000000007', { nested: ['preserve-me'] }),
            },
        },
    };
}

describe('existingSessionDraftSemanticValues', () => {
    it('maps incumbent field ids onto canonical document fields without losing unknown extensions', async () => {
        const document = remoteDocument();
        const repository = createSessionDraftRepository({
            storage: {
                getString: () => undefined,
                set: () => undefined,
                delete: () => undefined,
            },
            transport: {
                read: async () => ({
                    status: 'present',
                    record: {
                        address,
                        revision: 1,
                        content: { t: 'plain', v: { v: 1, address, document } },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                }),
                list: async () => ({ items: [] }),
                mutate: async () => {
                    throw new Error('not used');
                },
            },
            cipher: {
                seal: async () => ({ t: 'plain', v: { v: 1, address, document } }),
                open: async () => document,
            },
            syncEnabled: true,
            randomUUID: (() => {
                let next = 100;
                return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
            })(),
            now: () => 2,
        });
        await repository.materializeExact(scope, address);
        const semantics = createExistingSessionDraftSemanticValues(repository);

        expect(semantics.read(scope, address.sessionId, 'structuredInput.mentions')).toEqual([{
            kind: 'skill',
            name: 'review',
            tokenText: '$review',
        }]);
        expect(semantics.read(scope, address.sessionId, 'routing.executionRunDelivery')).toBe('interrupt');

        semantics.write(scope, address.sessionId, 'structuredInput.mentions', [{
            kind: 'session',
            sessionId: 'session-b',
            tokenText: '@session-b',
        }]);

        const updated = repository.getSessionDraftSnapshot(scope, address)?.document;
        expect(updated?.composer.mentions.value).toEqual([{
            kind: 'session',
            sessionId: 'session-b',
            tokenText: '@session-b',
        }]);
        expect(updated?.extensions).toEqual(document.extensions);
    });

    it('clears fields to their canonical empty values and rejects malformed stored semantics', async () => {
        const baseDocument = remoteDocument();
        const document: SessionDraftDocumentV1 = {
            ...baseDocument,
            target: baseDocument.target.kind === 'session'
                ? {
                    ...baseDocument.target,
                    routing: {
                        ...baseDocument.target.routing,
                        executionRunDelivery: {
                            ...baseDocument.target.routing.executionRunDelivery,
                            value: 'future-mode',
                        },
                    },
                }
                : baseDocument.target,
        };
        const repository = createSessionDraftRepository({
            storage: { getString: () => undefined, set: () => undefined, delete: () => undefined },
            transport: {
                read: async () => ({
                    status: 'present',
                    record: { address, revision: 1, content: { t: 'plain', v: { v: 1, address, document } }, createdAt: 1, updatedAt: 1 },
                }),
                list: async () => ({ items: [] }),
                mutate: async () => { throw new Error('not used'); },
            },
            cipher: { seal: async () => ({ t: 'plain', v: { v: 1, address, document } }), open: async () => document },
            syncEnabled: true,
        });
        await repository.materializeExact(scope, address);
        const semantics = createExistingSessionDraftSemanticValues(repository);

        expect(semantics.read(scope, address.sessionId, 'routing.executionRunDelivery')).toBeUndefined();
        semantics.clear(scope, address.sessionId, 'structuredInput.mentions');
        expect(repository.getSessionDraftSnapshot(scope, address)?.document.composer.mentions.value).toEqual([]);
    });

    it('distinguishes automatic recipient routing from an explicit manual Session recipient', async () => {
        const document = remoteDocument();
        const repository = createSessionDraftRepository({
            storage: { getString: () => undefined, set: () => undefined, delete: () => undefined },
            transport: {
                read: async () => ({
                    status: 'present',
                    record: { address, revision: 1, content: { t: 'plain', v: { v: 1, address, document } }, createdAt: 1, updatedAt: 1 },
                }),
                list: async () => ({ items: [] }),
                mutate: async () => { throw new Error('not used'); },
            },
            cipher: { seal: async () => ({ t: 'plain', v: { v: 1, address, document } }), open: async () => document },
            syncEnabled: true,
        });
        await repository.materializeExact(scope, address);
        const semantics = createExistingSessionDraftSemanticValues(repository);

        expect(semantics.read(scope, address.sessionId, 'routing.recipient')).toBeUndefined();
        semantics.write(scope, address.sessionId, 'routing.recipient', null);
        expect(repository.getSessionDraftSnapshot(scope, address)?.document.target).toMatchObject({
            kind: 'session',
            routing: { recipient: { value: { mode: 'manual', recipient: null } } },
        });
        expect(semantics.read(scope, address.sessionId, 'routing.recipient')).toBeNull();
        semantics.clear(scope, address.sessionId, 'routing.recipient');
        expect(semantics.read(scope, address.sessionId, 'routing.recipient')).toBeUndefined();
    });
});

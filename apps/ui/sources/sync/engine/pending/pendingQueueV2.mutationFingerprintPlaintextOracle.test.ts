import { beforeEach, describe, expect, it } from 'vitest';

import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';
import { encodeBase64 } from '@/encryption/base64';
import { storage } from '@/sync/domains/state/storage';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { updatePendingMessageV2 as updatePendingMessageV2Impl } from './pendingQueueV2';
import {
    buildSession,
    createPendingQueueEncryption,
    resetPendingQueueState,
} from './pendingQueueV2.testHelpers';

/**
 * The server is the adversary here: it holds only what the PATCH carries. This
 * reconstructs the published client algorithm (the client is open source, so the
 * domain string and the canonicalization are public) and tries it against a
 * candidate plaintext.
 */
function serverSideCandidateTag(params: Readonly<{
    sessionId: string;
    predecessorLocalId: string;
    replacementLocalId: string;
    candidateText: string;
}>): string {
    const canonicalPayload = stableJsonStringify({
        v: 1,
        sessionId: params.sessionId,
        predecessorLocalId: params.predecessorLocalId,
        replacementLocalId: params.replacementLocalId,
        messageRole: 'user',
        rawRecord: {
            role: 'user',
            content: { type: 'text', text: params.candidateText },
            meta: {},
        },
    });
    return encodeBase64(
        sha256(utf8ToBytes(`happier.pending-message-mutation.v1\u0000${canonicalPayload}`)),
        'base64url',
    );
}

describe('pendingQueueV2 Pending mutation equality tag on an E2EE session', () => {
    const outboxScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    const updatePendingMessageV2 = (
        params: Omit<Parameters<typeof updatePendingMessageV2Impl>[0], 'outboxScope'>,
    ) => updatePendingMessageV2Impl({ ...params, outboxScope });

    beforeEach(() => {
        resetPendingQueueState();
    });

    it('does not let the server confirm a candidate plaintext from the transmitted tag', async () => {
        const sessionId = 's_e2ee_mutation_tag_oracle';
        const localId = 'pending-local-id-original';
        const replacementLocalId = 'pending-local-id-replacement';
        const secretText = 'the merger closes friday at 4pm';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'server-row-id',
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'original',
            rawRecord: { role: 'user', content: { type: 'text', text: 'original' }, meta: {} },
        });

        let requestBody: Record<string, unknown> | null = null;
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'server-row-id',
            text: secretText,
            replacementLocalId,
            encryption,
            request: async (_path, init) => {
                requestBody = JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>;
                return Response.json({ ok: true, localId: replacementLocalId });
            },
        });

        const body = requestBody as Record<string, unknown> | null;
        // The content itself is E2EE: the server holds ciphertext, never the record.
        expect(typeof body?.ciphertext).toBe('string');
        expect(body?.content).toBeUndefined();
        const transmittedTag = body?.replacementMutationFingerprint;
        expect(transmittedTag).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u));

        // A server-side dictionary run over plausible message texts.
        const dictionary = [
            'ok',
            'ship it',
            'the merger closes friday at 4pm',
            'the merger closes friday at 5pm',
            'lgtm',
        ];
        const recoveredPlaintext = dictionary.find((candidateText) => (
            serverSideCandidateTag({
                sessionId,
                predecessorLocalId: localId,
                replacementLocalId,
                candidateText,
            }) === transmittedTag
        )) ?? null;

        expect(recoveredPlaintext).toBeNull();
    });

    it('still recognizes an exact response-loss retry on an E2EE session', async () => {
        const sessionId = 's_e2ee_mutation_tag_rejoin';
        const localId = 'pending-local-id-original';
        const replacementLocalId = 'pending-local-id-replacement';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'server-row-id',
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'original',
            rawRecord: { role: 'user', content: { type: 'text', text: 'original' }, meta: {} },
        });

        const requestBodies: Record<string, unknown>[] = [];
        const request = async (_path: string, init?: RequestInit) => {
            requestBodies.push(JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>);
            if (requestBodies.length === 1) throw new Error('response lost after server admission');
            return Response.json({ ok: true, localId: replacementLocalId });
        };

        await expect(updatePendingMessageV2({
            sessionId,
            pendingId: 'server-row-id',
            text: 'prepared edit',
            replacementLocalId,
            encryption,
            request,
        })).rejects.toThrow('response lost after server admission');

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'server-row-id',
            text: 'prepared edit',
            replacementLocalId,
            encryption,
            request,
        });

        expect(requestBodies).toHaveLength(2);
        expect(requestBodies[1]?.replacementMutationFingerprint)
            .toBe(requestBodies[0]?.replacementMutationFingerprint);
        expect(requestBodies[0]?.replacementMutationFingerprint)
            .toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u));
    });

    it('changes the tag when the admitted payload changes under the same identities', async () => {
        const sessionId = 's_e2ee_mutation_tag_discriminates';
        const localId = 'pending-local-id-original';
        const replacementLocalId = 'pending-local-id-replacement';
        const encryption = await createPendingQueueEncryption({ sessionId });

        const tagFor = async (text: string): Promise<unknown> => {
            resetPendingQueueState();
            storage.getState().applySessions([buildSession({ sessionId })]);
            storage.getState().upsertPendingMessage(sessionId, {
                id: 'server-row-id',
                localId,
                createdAt: 1,
                updatedAt: 1,
                source: 'server_pending',
                deliveryStatus: 'accepted',
                text: 'original',
                rawRecord: { role: 'user', content: { type: 'text', text: 'original' }, meta: {} },
            });
            let captured: Record<string, unknown> | null = null;
            await updatePendingMessageV2({
                sessionId,
                pendingId: 'server-row-id',
                text,
                replacementLocalId,
                encryption,
                request: async (_path, init) => {
                    captured = JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>;
                    return Response.json({ ok: true, localId: replacementLocalId });
                },
            });
            return (captured as Record<string, unknown> | null)?.replacementMutationFingerprint;
        };

        expect(await tagFor('first payload')).not.toBe(await tagFor('second payload'));
    });

    it('keeps a plain Session tag verifiable against the record the server receives', async () => {
        // A plain Account holds no secret to key with, and the server already
        // stores this exact record, so its tag stays the unkeyed digest and the
        // server can still recompute it from the content it was sent.
        const sessionId = 's_plain_mutation_tag_verifiable';
        const localId = 'pending-local-id-original';
        const replacementLocalId = 'pending-local-id-replacement';
        const text = 'prepared edit';

        storage.getState().applySessions([
            buildSession({ sessionId, overrides: { encryptionMode: 'plain' } }),
        ]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'server-row-id',
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'original',
            rawRecord: { role: 'user', content: { type: 'text', text: 'original' }, meta: {} },
        });

        let requestBody: Record<string, unknown> | null = null;
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'server-row-id',
            text,
            replacementLocalId,
            encryption: null,
            request: async (_path, init) => {
                requestBody = JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>;
                return Response.json({ ok: true, localId: replacementLocalId });
            },
        });

        const body = requestBody as Record<string, unknown> | null;
        expect(body?.content).toEqual({
            t: 'plain',
            v: { role: 'user', content: { type: 'text', text }, meta: {} },
        });
        expect(body?.replacementMutationFingerprint).toBe(serverSideCandidateTag({
            sessionId,
            predecessorLocalId: localId,
            replacementLocalId,
            candidateText: text,
        }));
    });
});

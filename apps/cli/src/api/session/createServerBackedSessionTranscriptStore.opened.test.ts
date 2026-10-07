import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec, SessionSharedMetadataV1Schema } from '@happier-dev/protocol';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { encodeBase64, encrypt } from '@/api/encryption';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createServerBackedSessionTranscriptStore } from './createServerBackedSessionTranscriptStore';
import { createSessionTranscriptFollowLeaseRegistry, followSessionTranscript } from './followSessionTranscript';
import { fetchOpenedSessionStateFromServer } from './snapshotSync';

describe('opened transcript follow projection', () => {
    afterEach(() => vi.restoreAllMocks());

    it('validates the opened follow projection as full opened rows and versioned Agent state', () => {
        const spec = getActionSpec('transcript.follow');
        if (!spec.outputSchema) throw new Error('transcript.follow must declare its output schema');
        expect(spec.inputSchema.safeParse({ cursor: '0', projection: 'openedMessagesV1', agentStateVersion: -1 }).success).toBe(true);
        expect(spec.inputSchema.safeParse({ cursor: '0', projection: 'unknown' }).success).toBe(false);
        expect(spec.inputSchema.safeParse({ cursor: '0', projection: 'openedMessagesV1', agentStateVersion: 1.5 }).success).toBe(false);
        const row = { id: 'stored-id', seq: 1, localId: 'local-id', updatedAt: 4, createdAt: 3,
            messageRole: 'agent', sidechainId: null, content: { t: 'plain', v: { role: 'agent', content: { type: 'message', message: 'hello' } } } };
        const result = { ok: true, leaseId: 'lease', projection: 'openedMessagesV1', items: [row],
            nextCursor: '1', truncated: false, agentState: { version: 2, value: { requests: {} } }, sharedMetadata: null };
        expect(spec.outputSchema.parse(result)).toEqual(result);
        expect(spec.outputSchema.safeParse({ ...result, items: [{ ...row, content: { t: 'encrypted', c: 'sealed' } }] }).success).toBe(false);
        expect(spec.outputSchema.safeParse({ ...result, agentState: { version: 2, value: {}, authority: true } }).success).toBe(false);
        expect(spec.outputSchema.safeParse({ ...result, items: [{ seq: 1, text: 'lossy' }] }).success).toBe(false);
    });

    it.each(['plain', 'e2ee'] as const)('returns complete %s rows without compact suppression and only newer Agent state', async (mode) => {
        const ctx = { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey' as const };
        const payload = {
            role: 'agent',
            content: { type: 'acp', agentId: 'codex', data: {
                type: 'tool-call', callId: 'empty-diff', name: 'Diff', input: JSON.stringify({
                    files: [], _happier: { sessionChangeScope: 'turn', turnId: 'turn-1', sessionId: 'session-1',
                        provider: 'codex', source: 'scm_checkpoint', confidence: 'exact', turnStatus: 'completed',
                        seqRange: { startSeqInclusive: 4, endSeqInclusive: 5 } },
                }),
            } },
        };
        const row = { id: 'stored-row', seq: 4, localId: 'durable-local', createdAt: 10, updatedAt: 20,
            messageRole: 'agent', sidechainId: 'side-1',
            content: mode === 'plain' ? { t: 'plain', v: payload }
                : { t: 'encrypted', c: encodeBase64(encrypt(ctx.encryptionKey, ctx.encryptionVariant, payload)) } };
        const state = { requests: { permission: { tool: 'write', arguments: { path: 'file' }, createdAt: 10 } } };
        vi.spyOn(axios, 'get').mockImplementation(async (url) => ({ status: 200, data: String(url).includes('/messages?')
            ? { messages: [row], hasMore: false, nextBeforeSeq: null, nextAfterSeq: 4 }
            : { session: createSessionRecordFixture({ id: 'session-1', encryptionMode: mode,
                metadata: mode === 'plain' ? JSON.stringify({}) : encodeBase64(encrypt(ctx.encryptionKey, ctx.encryptionVariant, {})),
                agentState: mode === 'plain' ? JSON.stringify(state) : encodeBase64(encrypt(ctx.encryptionKey, ctx.encryptionVariant, state)),
                agentStateVersion: 3 }) } }));
        const store = createServerBackedSessionTranscriptStore({ token: 'token', sessionId: 'session-1',
            ...(mode === 'plain' ? { mode, ctx: null } : { mode, ctx }),
            readOpenedSessionState: async (versions) => {
                return await fetchOpenedSessionStateFromServer({ token: 'token', sessionId: 'session-1',
                    ...(mode === 'plain' ? { mode, ctx: null } : { mode, ctx }),
                    accountEncryptionCurrentness: null, currentMetadataLayoutVersion: 0,
                    currentMetadataVersion: versions.sharedMetadataVersion, currentAgentStateVersion: versions.agentStateVersion });
            },
        });
        const registry = createSessionTranscriptFollowLeaseRegistry({ idleTtlMs: 600_000 });
        try {
            const follow = (agentStateVersion: number) => runWithServerHttpBaseUrl('https://example.invalid', () => followSessionTranscript({
                store, registry, sessionId: 'session-1',
                input: { cursor: '3', leaseId: 'opened', projection: 'openedMessagesV1', agentStateVersion, sharedMetadataVersion: 1 },
            }));
            const first = await follow(2);
            expect(first).toEqual({ ok: true, leaseId: 'opened', projection: 'openedMessagesV1',
                items: [{ ...row, content: { t: 'plain', v: payload } }], nextCursor: '4', truncated: false,
                agentState: { version: 3, value: state }, sharedMetadata: null });
            const outputSchema = getActionSpec('transcript.follow').outputSchema;
            if (!outputSchema) throw new Error('transcript.follow must declare its output schema');
            expect(outputSchema.parse(first)).toEqual(first);
            expect(await follow(3)).toMatchObject({ agentState: null });
            expect(await follow(4)).toMatchObject({ agentState: null });
        } finally { await registry.dispose(); }
    });

    it.each(['corrupt_or_unopenable', 'mode_mismatch'] as const)('surfaces %s rows without content and continues on the same lease', async (openFailure) => {
        const ctx = { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey' as const };
        const payload = { role: 'user', content: { type: 'text', text: 'after corrupt row' } };
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
            messages: [{ id: 'unopenable', seq: 1, createdAt: 10, content: openFailure === 'mode_mismatch'
                ? { t: 'plain', v: { private: 'must not cross' } } : { t: 'encrypted', c: 'corrupt' } },
                { id: 'valid', seq: 2, createdAt: 11, content: { t: 'encrypted', c: encodeBase64(encrypt(ctx.encryptionKey, ctx.encryptionVariant, payload)) } }],
            hasMore: false, nextBeforeSeq: null, nextAfterSeq: 2,
        } });
        const store = createServerBackedSessionTranscriptStore({ token: 'token', sessionId: 'session-1', mode: 'e2ee',
            ctx, readOpenedSessionState: async () => ({ agentState: null, sharedMetadata: null }) });
        const registry = createSessionTranscriptFollowLeaseRegistry({ idleTtlMs: 600_000 });
        try {
            const follow = (cursor: string) => runWithServerHttpBaseUrl('https://example.invalid', () => followSessionTranscript({ store, registry,
                sessionId: 'session-1', input: { cursor, leaseId: 'opened', projection: 'openedMessagesV1' },
            }));
            const result = await follow('0');
            expect(result).toMatchObject({ items: [
                { id: 'unopenable', content: { t: 'plain', v: null }, openFailure },
                { id: 'valid', content: { t: 'plain', v: payload } },
            ], nextCursor: '2', truncated: false });
            const outputSchema = getActionSpec('transcript.follow').outputSchema;
            if (!outputSchema) throw new Error('transcript.follow must declare its output schema');
            expect(outputSchema.parse(result)).toEqual(result);
            expect(JSON.stringify(result)).not.toContain('corrupt"');
            expect(JSON.stringify(result)).not.toContain('must not cross');
            vi.mocked(axios.get).mockResolvedValueOnce({ status: 200, data: { messages: [], hasMore: false, nextAfterSeq: 2 } });
            expect(await follow('2')).toMatchObject({ items: [], nextCursor: '2' });
            expect(registry.activeCount()).toBe(1);
        } finally { await registry.dispose(); }
    });

    it('opens Agent state from the canonical layout-1 owner tuple on a keyless plain Account', async () => {
        const credentials = { token: 'token', encryption: null } as const;
        const state = { controlledByUser: false };
        const tuple = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
            metadata: { path: '/private', host: 'host', flavor: 'codex' }, agentState: state, storedContentMode: 'plain' });
        const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: createSessionRecordFixture({
            id: 'session-1', encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: tuple.sharedMetadata.ciphertext,
            ownerMetadata: tuple.ownerMetadata, share: null, metadataVersion: 1, agentState: tuple.agentState, agentStateVersion: 3,
        }) } });
        const read = (currentAgentStateVersion: number) => runWithServerHttpBaseUrl('https://example.invalid', () => fetchOpenedSessionStateFromServer({
            token: credentials.token, sessionId: 'session-1', credentials,
            accountEncryptionCurrentness: createAccountEncryptionCurrentnessFixture(),
            mode: 'plain', ctx: null, currentMetadataLayoutVersion: 1, currentMetadataVersion: 1, currentAgentStateVersion,
        }));
        expect(await read(2)).toEqual({ agentState: { version: 3, value: state }, sharedMetadata: null });
        expect(await read(3)).toEqual({ agentState: null, sharedMetadata: null });
        expect(await read(4)).toEqual({ agentState: null, sharedMetadata: null });
        get.mockResolvedValueOnce({ status: 200, data: { session: createSessionRecordFixture({
            id: 'session-1', encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: tuple.sharedMetadata.ciphertext,
            ownerMetadata: tuple.ownerMetadata, share: null, metadataVersion: 1, agentState: null, agentStateVersion: 4,
        }) } });
        expect(await read(3)).toEqual({ agentState: { version: 4, value: null }, sharedMetadata: null });
    });

    it('follows metadata-only E2EE shared-editor confirmations without disclosing owner state', async () => {
        const ctx = { encryptionKey: new Uint8Array(32).fill(19), encryptionVariant: 'dataKey' as const };
        const sharedMetadata = SessionSharedMetadataV1Schema.parse({
            v: 1,
            actionConfirmationsV1: {
                v: 1,
                requests: { 'action:pending': {
                    tool: 'Happier Action confirmation', kind: 'user_action', source: 'happier_action',
                    createdAt: 1, turnId: 'turn-1',
                    arguments: { actionId: 'session.activity.get', preview: { summary: 'Read activity' }, sessionId: 'session-1', turnId: 'turn-1' },
                    responseTarget: { kind: 'happier_action_confirmation_v1', requestId: 'action:pending',
                        actionId: 'session.activity.get', inputDigestV1: `sha256:${'a'.repeat(64)}`,
                        runtimeAccountId: 'account-owner', sessionId: 'session-1', turnId: 'turn-1' },
                } },
                completedRequests: {},
            },
            publicAgentState: { completedRequests: {
                'public-completion': { tool: 'Bash', createdAt: 1, completedAt: 2, status: 'approved' },
            } },
        });
        const privateTuple = buildSessionMetadataEnvelopeFields({
            credentials: { token: 'session-runtime-token', encryption: null }, accountEncryptionMode: 'plain',
            metadata: { path: '/private-owner-path', host: 'owner-host' },
            agentState: { requests: { secret: { tool: 'Bash', arguments: { command: 'private-owner-command' }, createdAt: 1 } } },
            storedContentMode: 'e2ee', encryptionKey: ctx.encryptionKey, encryptionVariant: ctx.encryptionVariant,
        });
        vi.spyOn(axios, 'get').mockImplementation(async (url) => ({ status: 200, data: String(url).includes('/messages?')
            ? { messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null }
            : { session: createSessionRecordFixture({ id: 'session-1', encryptionMode: 'e2ee', metadataLayoutVersion: 1,
                share: null,
                metadata: encodeBase64(encrypt(ctx.encryptionKey, ctx.encryptionVariant, sharedMetadata)), metadataVersion: 7,
                // The role must ignore owner-private carriers even when they are present at the HTTP boundary.
                ownerMetadata: privateTuple.ownerMetadata,
                agentState: privateTuple.agentState, agentStateVersion: 9,
            }) } }));
        const store = createServerBackedSessionTranscriptStore({ token: 'session-runtime-token', sessionId: 'session-1', mode: 'e2ee', ctx,
            readOpenedSessionState: (versions) => fetchOpenedSessionStateFromServer({
                token: 'session-runtime-token', sessionId: 'session-1', mode: 'e2ee', ctx,
                metadataAuthority: 'shared_editor', accountEncryptionCurrentness: null,
                currentMetadataLayoutVersion: 1, currentMetadataVersion: versions.sharedMetadataVersion, currentAgentStateVersion: versions.agentStateVersion,
            }),
        });
        const registry = createSessionTranscriptFollowLeaseRegistry({ idleTtlMs: 600_000 });
        try {
            const read = (cursor: string, sharedMetadataVersion: number) => runWithServerHttpBaseUrl('https://example.invalid', () => followSessionTranscript({
                store, registry, sessionId: 'session-1',
                input: { cursor, leaseId: 'shared-metadata', projection: 'openedMessagesV1', agentStateVersion: -1, sharedMetadataVersion },
            }));
            const result = await read('0', -1);
            expect(result).toMatchObject({ ok: true, agentState: null, sharedMetadata: { version: 7, value: sharedMetadata } });
            expect(JSON.stringify(result)).not.toContain('private-owner');
            expect(await read('0', 7)).toMatchObject({ agentState: null, sharedMetadata: null });
            expect(await read('tail', -1)).toMatchObject({ items: [], agentState: null, sharedMetadata: { version: 7, value: sharedMetadata } });
        } finally { await registry.dispose(); }
    });
});

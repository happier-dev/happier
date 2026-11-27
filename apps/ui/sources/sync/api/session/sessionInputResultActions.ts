import { readSessionMessageByLocalId } from './readSessionMessageByLocalId';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { SessionInputRefusalDispositionV1Schema, type SessionInputResultGetResultV1 } from '@happier-dev/protocol/sessions/messages/sessionInputResultV1';
import { parseTranscriptLookupMessageFromUnknown, readSessionInputResult } from '@happier-dev/session-core/transcript';
import { fetchSessionMessagesPage, openSessionStoredContent, type SessionStoredContentContext } from '@happier-dev/sync-client';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { readSessionMessageReply } from './sessionMessageReplyApi';

type Input = Parameters<NonNullable<ActionExecutorDeps['sessionInputResultGet']>>[0];
const unavailable = { ok: false, code: 'result_read_failed' } as const;

export async function readSessionInputResultForAction(input: Input, scope: ServerAccountScope): Promise<SessionInputResultGetResultV1> {
    try {
        return await runWithServerAccountScopeRequestGuard({ scope, ...(input.signal ? { signal: input.signal } : {}),
            staleError: () => new Error('Session input result scope retired'),
        }, guard => runWithServerRequestAuthorityForServerAccountScope({ scope,
            activeRequest: async () => { throw new Error('Session input result requires captured Account authority'); },
        }, async authority => {
            const encryptionCurrentness = captureEncryptionGenerationCurrentness(authority.context.encryption, scope);
            const check = () => {
                guard.check();
                if (!encryptionCurrentness.isCurrent()) throw new Error('Session encryption retired');
            };
            const isCurrent = () => { check(); return true; };
            const result = await readSessionInputResult({ ...input, signal: guard.signal }, {
                resolveSession: async needsTranscript => {
                    check();
                    const snapshot = await readSessionSnapshotForAuthority({
                        authority, sessionId: input.sessionId, isCurrent, signal: guard.signal,
                        includeTurns: false, includeMetadataTupleMutationSnapshot: false,
                    }).catch((error: unknown) => {
                        if (error instanceof SessionSnapshotReadError && error.httpStatus === 404) return null;
                        throw error;
                    });
                    check();
                    if (snapshot?.session.access?.capabilities.readTranscript !== true) {
                        return { ok: false, code: 'session_not_found' };
                    }
                    const { session } = snapshot;
                    const address = { serverId: scope.serverId, sessionId: session.id };
                    if (!needsTranscript) return { ok: true, address };
                    const encryption = authority.context.encryption?.getSessionEncryption(session.id) ?? null;
                    const contentContext: SessionStoredContentContext | null = session.encryptionMode === 'plain' ? { mode: 'plain' }
                        : session.encryptionMode === 'e2ee' && encryption ? { mode: 'e2ee', encryption } : null;
                    if (!contentContext) return { ok: false, code: 'encryption_material_unavailable' };
                    return { ok: true, address, transcript: {
                        openContent: async content => {
                            check();
                            const opened = await openSessionStoredContent(contentContext, content);
                            check();
                            return opened.status === 'ready' ? opened.value : null;
                        },
                        readPage: async ({ afterSeq, limit }) => {
                            const page = await fetchSessionMessagesPage({ sessionId: session.id, scope: 'main', afterSeq, limit,
                                signal: guard.signal, requestJson: async (path, signal) => {
                                    check();
                                    const response = await authority.request(path, { signal }, { retry: 'none' });
                                    check();
                                    if (!response.ok) throw new Error('Session result transcript unavailable');
                                    return await response.json();
                                },
                            });
                            check();
                            return page.messages;
                        },
                    } };
                },
                readOriginal: async (sessionId, localId) => {
                    check();
                    const response = await readSessionMessageByLocalId(authority.request, sessionId, localId, guard.signal);
                    check();
                    if (response.status === 404) {
                        const payload: unknown = await response.json().catch(() => null);
                        check();
                        const parsed = SessionInputRefusalDispositionV1Schema.safeParse(
                            payload && typeof payload === 'object' && 'inputDisposition' in payload ? payload.inputDisposition : null);
                        return { type: 'not_found', ...(parsed.success && parsed.data.localId === localId ? { inputDisposition: parsed.data.result } : {}) };
                    }
                    if (!response.ok) throw new Error('Session input original unavailable');
                    const payload: unknown = await response.json();
                    check();
                    const row = parseTranscriptLookupMessageFromUnknown(
                        payload && typeof payload === 'object' && 'message' in payload ? payload.message : null);
                    if (!row) throw new Error('Invalid Session input original');
                    return { type: 'found', message: row };
                },
                readReply: (sessionId, localId) => readSessionMessageReply({ scope, sessionId, localId, signal: guard.signal, isCurrent }),
            });
            check();
            return result;
        }));
    } catch {
        return input.signal?.aborted ? { ok: false, code: 'cancelled' } : unavailable;
    }
}

import type { ParsedSearchQuery } from '@happier-dev/protocol';

import { buildSessionMessagesPath, parseSessionMessagesResponseJson } from '@/sync/api/session/sessionMessagesApi';
import type { ApiSessionMessagesResponse } from '@/sync/api/types/apiTypes';
import { createSessionSearchMatcher } from '@/sync/domains/session/searchQuery';
import { assertUiSessionEncryptionModeAllowed, resolveUiClientEncryptionRequirement } from '@/sync/domains/settings/clientEncryptionRequirement';
import { storage } from '@/sync/domains/state/storageStore';
import { withServerReadLifetime } from '@/sync/http/client';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import { resolveScopedSessionCryptoContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import type { ResolvedServerSessionRpcContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { readStoredSessionRawRecord } from '@/sync/runtime/readStoredSessionContent';
import { normalizeRawMessage } from '@/sync/typesRaw';

export type SessionTranscriptSearchResult = Readonly<{ matched: boolean; excluded: boolean }>;

/** Read-only search: never opens a session, hydrates the transcript store, or advances read state. */
export async function searchSessionTranscript(input: Readonly<{
    context: Extract<ResolvedServerSessionRpcContext, { scope: 'scoped' }>;
    sessionId: string;
    query: ParsedSearchQuery;
    initialText: string;
    signal: AbortSignal;
}>): Promise<SessionTranscriptSearchResult> {
    const { context, sessionId, signal } = input;
    const matcher = createSessionSearchMatcher(input.query, input.initialText);
    const result = () => ({ matched: matcher.matched, excluded: matcher.excluded });
    const checkCancelled = () => {
        if (signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    };
    checkCancelled();
    if (matcher.settled) return result();
    const crypto = await resolveScopedSessionCryptoContext({
        serverId: context.targetServerId, serverUrl: context.targetServerUrl,
        token: context.token, sessionId,
        decryptEncryptionKey: (key) => context.encryption.decryptEncryptionKey(key),
        timeoutMs: context.timeoutMs,
    });
    checkCancelled();
    if (crypto.encryptionMode === 'unknown') throw new Error('Session encryption unavailable');
    const settings = storage.getState().settings;
    assertUiSessionEncryptionModeAllowed({
        mode: crypto.encryptionMode,
        requirement: resolveUiClientEncryptionRequirement({ syncedSettings: settings, localSettings: settings }),
    });
    if (crypto.encryptionMode === 'e2ee') {
        await context.encryption.initializeSessions(new Map([[sessionId, crypto.sessionDataKey]]));
    }
    const encryption = crypto.encryptionMode === 'e2ee' ? context.encryption.getSessionEncryption(sessionId) : null;
    if (crypto.encryptionMode === 'e2ee' && !encryption) throw new Error('Session encryption unavailable');

    let afterSeq = 0;
    for (;;) {
        checkCancelled();
        const path = buildSessionMessagesPath({ sessionId, scope: 'all', afterSeq });
        const page = await withServerReadLifetime<ApiSessionMessagesResponse>({
            method: 'GET', signal, responseSizeBounded: true,
            headers: { Authorization: `Bearer ${context.token}` },
        }, async (init, consume) => consume(await runtimeFetchWithServerReachability({
            serverUrl: context.targetServerUrl, token: context.token,
            url: `${context.targetServerUrl}${path}`, init, timeoutMs: context.timeoutMs,
        })), async (response) => {
            if (!response.ok) throw new Error(`Transcript search failed (${response.status})`);
            return parseSessionMessagesResponseJson(await response.json());
        });
        if (page instanceof Response) throw new Error('Missing transcript page');
        for (const message of page.messages) {
            checkCancelled();
            if (message.content.t !== (crypto.encryptionMode === 'plain' ? 'plain' : 'encrypted')) {
                throw new Error('Transcript storage mode mismatch');
            }
            const raw = await readStoredSessionRawRecord({
                content: message.content,
                ...(encryption ? { decryptEncrypted: async (ciphertext: string) => {
                    const decrypted: unknown = await encryption.decryptRaw(ciphertext);
                    if (decrypted == null) throw new Error('Transcript decryption failed');
                    return decrypted;
                } } : {}),
            });
            if (!raw) continue;
            const normalized = normalizeRawMessage(message.id, message.localId ?? null, message.createdAt, raw, {
                seq: message.seq, messageRole: message.messageRole,
            });
            if (normalized?.role === 'user') {
                matcher.addText(normalized.content.text);
            } else if (normalized?.role === 'agent') {
                for (const content of normalized.content) {
                    if (content.type === 'text') matcher.addText(content.text);
                    else if (content.type === 'tool-call' && content.description) matcher.addText(content.description);
                }
            }
            if (matcher.settled) return result();
        }
        const next = page.nextAfterSeq ?? Math.max(afterSeq, ...page.messages.map((message) => message.seq));
        if (next <= afterSeq) {
            if (page.hasMore === true) throw new Error('Transcript search pagination did not advance');
            return result();
        }
        // Released servers may omit hasMore. An empty following page establishes the end.
        if (page.hasMore === false || page.messages.length === 0) return result();
        afterSeq = next;
    }
}

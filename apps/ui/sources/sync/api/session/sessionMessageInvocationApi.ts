import { readSessionMessageByLocalId } from './readSessionMessageByLocalId';
import { persistSessionTranscriptMessage } from '@happier-dev/session-core/messages';
import { SessionMessageInvocationV1Schema, deriveSessionMessageInvocationLocalIdV1,
    readSessionMessageInvocationV1, type SessionMessageInvocationV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import type { ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import type { ServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import type { Encryption } from '@/sync/encryption/encryption';
import { normalizeSessionTargetV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

type SourceTranscriptScope = Readonly<{ scope: ServerAccountScope; sessionId: string; isCurrent: () => boolean }>;
type SourceTranscriptContext = Readonly<{
    authority: ServerAccountRequestAuthority; guard: ServerAccountScopeRequestGuard;
    mode: 'plain' | 'e2ee'; encryption: ReturnType<Encryption['getSessionEncryption']>;
}>;
async function withSourceTranscript<TResult>(input: SourceTranscriptScope, operation: (context: SourceTranscriptContext) => Promise<TResult>): Promise<TResult> {
    return runWithServerAccountScopeRequestGuard({ ...input, staleError: () => new Error('Composer submission retired') }, async guard =>
        runWithServerRequestAuthorityForServerAccountScope({ scope: input.scope,
            activeRequest: async () => { throw new Error('Source transcript requires captured Account authority'); },
        }, async authority => {
            guard.check();
            const { session } = await readSessionSnapshotForAuthority({ authority, sessionId: input.sessionId,
                includeTurns: false, signal: guard.signal, isCurrent: guard.isCurrent });
            guard.check();
            const encryption = authority.context.encryption?.getSessionEncryption(input.sessionId) ?? null;
            if (session.encryptionMode !== 'plain' && !encryption) throw new Error('Source transcript key unavailable');
            return operation({ authority, guard, encryption, mode: session.encryptionMode === 'plain' ? 'plain' : 'e2ee' });
        }));
}

/** Existing presentation history only. Never supplies executable target operands. */
async function readSourceInvocation(context: SourceTranscriptContext, sessionId: string, submitLocalId: string) {
    const { authority, guard, mode, encryption } = context;
    const localId = deriveSessionMessageInvocationLocalIdV1(submitLocalId);
    const response = await readSessionMessageByLocalId(authority.request, sessionId, localId, guard.signal);
    guard.check();
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Source invocation unavailable');
    const payload: unknown = await response.json();
    const row = payload && typeof payload === 'object' && 'message' in payload ? SessionMessageV1Schema.safeParse(payload.message) : null;
    if (!row?.success || row.data.localId !== localId) throw new Error('Source invocation identity unavailable');
    const opened = await readStoredSessionMessage({ message: row.data, sessionEncryptionMode: mode,
        ...(encryption ? { decryptMessage: (message: typeof row.data) => encryption.decryptMessage(message) } : {}) });
    guard.check();
    const raw = opened?.content;
    const event = raw?.role === 'agent' && raw.content.type === 'event' ? raw.content.data : null;
    const invocation = readSessionMessageInvocationV1(event);
    if (!invocation || invocation.localId !== submitLocalId || event?.type !== 'message') throw new Error('Source invocation content unavailable');
    return { invocation, text: event.message };
}

/** A transcript edit, never a user input: the existing event role cannot enter Pending admission. */
export async function persistSessionMessageInvocation(input: Readonly<{
    scope: ServerAccountScope; sessionId: string; text: string; invocation: SessionMessageInvocationV1;
    isCurrent: () => boolean;
}>) {
    const invocation = SessionMessageInvocationV1Schema.parse(input.invocation);
    const localId = deriveSessionMessageInvocationLocalIdV1(invocation.localId);
    return withSourceTranscript(input, async context => {
        const { authority, guard, encryption, mode } = context;
        const previous = await readSourceInvocation(context, input.sessionId, invocation.localId);
        if (previous && (previous.text !== input.text || previous.invocation.reply !== invocation.reply
            || JSON.stringify(normalizeSessionTargetV1(previous.invocation.target)) !== JSON.stringify(normalizeSessionTargetV1(invocation.target)))) {
            throw new Error('Source invocation identity changed');
        }
        const key = (row: SessionMessageInvocationV1['targets'][number]) => JSON.stringify([
            resolveServerProfileScopeIdForIdentifier(row.target.serverId), row.target.sessionId, row.localId,
        ]);
        const current = new Map(invocation.targets.map(row => [key(row), row]));
        const presentation = previous?.invocation.targets.length ? { ...previous.invocation,
            targets: previous.invocation.targets.map(row => {
                const next = current.get(key(row));
                return next && (row.immediate.status === 'rejected' || row.immediate.status === 'outcomeUnknown')
                    ? { ...row, immediate: next.immediate } : row;
            }) } : invocation;
        const persisted = await persistSessionTranscriptMessage({
            sessionEncryptionMode: mode,
            request: async (path, init) => {
                guard.check();
                const response = await authority.request(path, { ...init, signal: guard.signal }, { retry: 'none' });
                guard.check();
                return response;
            },
            ...(encryption ? { encryptRawRecord: async (raw: unknown) => {
                guard.check(); const sealed = await encryption.encryptRaw(raw); guard.check(); return sealed;
            } } : {}),
        }, { sessionId: input.sessionId, localId, createdAt: Date.now(), messageRole: 'event',
            rawRecord: { role: 'agent', content: { type: 'event', id: localId, data: {
                type: 'message', message: input.text, sessionMessageInvocationV1: presentation,
            } } } });
        guard.check();
        return persisted;
    });
}

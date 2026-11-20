import { isRecord } from '@happier-dev/protocol/actions/happierActionToolResult';
import {
    createSessionToolOutputBindingV1,
    readSessionToolOutputBindingV1,
    SessionToolOutputBodyV1Schema,
    type SessionToolOutputBodyV1,
} from '@happier-dev/protocol/sessions/messages/sessionToolOutputBindingV1';
import { fetchSessionMessagesPage } from '@happier-dev/sync-client';
import type { SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionToolOutputOpenResult } from '@/sync/encryption/sessionEncryption';
import { serverFetch } from '@/sync/http/client';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';

export type SessionToolOutputRead =
    | Readonly<{ status: 'available'; result: unknown }>
    | Readonly<{ status: 'expired'; days: number }>
    | Readonly<{ status: 'unavailable' | 'corrupt' }>;

export type SessionToolOutputReadTarget = Readonly<{
    scope: ServerAccountScope;
    messageId: string;
    toolUseId: string;
    signal: AbortSignal;
}>;

function openPlainToolOutput(sessionId: string, row: SessionMessageV1, shell: unknown): SessionToolOutputOpenResult {
    const binding = readSessionToolOutputBindingV1(shell);
    const availability = row.toolOutputAvailability;
    const part = row.toolOutputPart;
    if (part === undefined && availability === undefined && binding.status === 'absent') return { status: 'inline' };
    if (part === undefined && availability?.status === 'expired' && binding.status === 'bound') return availability;
    if (availability?.status !== 'available' || binding.status !== 'bound' || part?.t !== 'plain' || !row.localId ||
        createSessionToolOutputBindingV1(sessionId, row.localId, part).digest !== binding.binding.digest) {
        return { status: 'corrupt' };
    }
    const body = SessionToolOutputBodyV1Schema.safeParse(part.v);
    return body.success ? { status: 'available', body: body.data } : { status: 'corrupt' };
}

function restoreResult(
    output: Record<string, unknown>, body: SessionToolOutputBodyV1,
): Record<string, unknown> | null {
    const restored = { ...output, ...body.fields };
    if (!body.textBlocks.length) return restored;
    if (!Array.isArray(output.content)) return null;
    const blocks = [...output.content];
    for (const { index, text } of body.textBlocks) {
        const block: unknown = blocks[index];
        if (!isRecord(block) || block.type !== 'text' || block.text !== '') return null;
        blocks[index] = { ...block, text };
    }
    return { ...restored, content: blocks };
}

function readResult(shell: unknown, opened: SessionToolOutputOpenResult, toolUseId: string): SessionToolOutputRead {
    if (opened.status === 'unavailable' || opened.status === 'corrupt') return { status: opened.status };
    const record = isRecord(shell) && shell.role === 'agent' && isRecord(shell.content) && shell.content.type === 'acp'
        ? shell.content.data
        : null;
    if (!isRecord(record) || record.type !== 'tool-result' || record.callId !== toolUseId) return { status: 'corrupt' };
    if (opened.status === 'expired') return opened;
    if (opened.status === 'inline') return { status: 'available', result: record.output };
    if (opened.status !== 'available' || !isRecord(record.output)) return { status: 'corrupt' };
    const result = restoreResult(record.output, opened.body);
    return result ? { status: 'available', result } : { status: 'corrupt' };
}

/** Expanded details own this read and dispose of the opened body when the view retires. */
export async function readSessionToolOutput(
    input: SessionToolOutputReadTarget & Readonly<{ sessionId: string }>,
): Promise<SessionToolOutputRead> {
    const { scope, messageId, sessionId, toolUseId, signal } = input;
    const unavailable = { status: 'unavailable' } as const;
    try {
        return await runWithServerAccountScopeRequestGuard<SessionToolOutputRead>({ scope, signal,
            staleError: () => new Error('Tool output read retired'),
        }, async guard => runWithServerRequestAuthorityForServerAccountScope({ scope, activeRequest: serverFetch }, async authority => {
            guard.check();
            const { session } = await readSessionSnapshotForAuthority({ authority, sessionId,
                includeTurns: false, signal: guard.signal, isCurrent: guard.isCurrent });
            guard.check();
            if (session.access?.capabilities.readTranscript !== true) return unavailable;
            const page = await fetchSessionMessagesPage({ sessionId, messageId, scope: 'all', includeToolOutput: true,
                signal: guard.signal, requestJson: async (path, requestSignal) => {
                    const response = await authority.request(path, { signal: requestSignal }, { retry: 'none' });
                    if (!response.ok) throw new Error('Tool result row unavailable');
                    return response.json();
                } });
            guard.check();
            const row = page.messages.length === 1 ? page.messages[0] : undefined;
            if (row?.id !== messageId || page.publicationBlocked || page.hasMore !== false ||
                page.nextBeforeSeq != null || page.nextAfterSeq != null) return unavailable;
            if (session.encryptionMode === 'plain') {
                if (row.content.t !== 'plain') return { status: 'corrupt' };
                return readResult(row.content.v, openPlainToolOutput(sessionId, row, row.content.v), toolUseId);
            }
            const encryption = authority.context.encryption?.getSessionEncryption(sessionId);
            if (!encryption) return unavailable;
            const opened = await encryption.decryptMessage(row, { toolOutput: true, signal: guard.signal });
            guard.check();
            return opened ? readResult(opened.content, opened.toolOutput, toolUseId) : unavailable;
        }));
    } catch {
        return unavailable;
    }
}

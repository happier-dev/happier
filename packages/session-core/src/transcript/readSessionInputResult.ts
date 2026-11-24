import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PendingDeliveryBlockedReason } from '@happier-dev/protocol';
import { isPendingDeliveryProviderEffectPossibleV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { assertSessionInputAdmissionReceiptForAuthorityV1, readSessionInputAuthority,
    type SessionInputResultGetResultV1, type SessionInputResultV1,
    type SessionInputRefusalDispositionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import type { SessionMessageReplyReadResultV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import type { TranscriptMessageLookupResult } from './sessionInputOriginal.js';
import { readAssistantTurnOutcomeAfterCurrentUserTurn, resultFromAssistantTurnOutcome,
    type AssistantTurnTranscriptReader } from './assistantTurnOutcome.js';

type InputResultFailure = Extract<SessionInputResultGetResultV1, { ok: false }>;
type OriginalLookup =
    | Readonly<{ type: 'found'; message: TranscriptMessageLookupResult }>
    | Readonly<{ type: 'not_found'; inputDisposition?: SessionInputRefusalDispositionV1['result']; error?: unknown }>
    | Readonly<{ type: 'auth_failed' | 'unhealthy' | 'protocol_error'; error: unknown }>;

type InputResultReadPorts = Readonly<{
    resolveSession: (openTranscript: boolean) => Promise<InputResultFailure | Readonly<{
        ok: true; address: SessionMessageRefV1['session']; transcript?: AssistantTurnTranscriptReader;
    }>>;
    readOriginal: (sessionId: string, localId: string) => Promise<OriginalLookup>;
    readReply: (sessionId: string, localId: string) => Promise<SessionMessageReplyReadResultV1>;
}>;

export function formatBlockedPromptDeliveryFailure(reason: PendingDeliveryBlockedReason): string {
    if (reason === 'team_access_removed') return 'Team access was withdrawn before Home published the Turn. The native Agent may have acted on the input.';
    return `Current input delivery blocked (${reason})`;
}

export function projectBlockedInputResult(reason: PendingDeliveryBlockedReason, issue?: SessionRuntimeIssueV1): SessionInputResultV1 {
    return !issue && isPendingDeliveryProviderEffectPossibleV1({ status: 'blocked', reason })
        ? { kind: 'pending' }
        : { kind: 'failed', message: formatBlockedPromptDeliveryFailure(reason), ...(issue ? { runtimeIssueV1: issue } : {}) };
}

/** Read one admitted original. A Session grant alone supplies no proof of plugin authorship. */
export async function readSessionInputResult(params: Readonly<{
    localId: string; projection?: 'reply'; callerPluginId?: string; signal?: AbortSignal;
}>, ports: InputResultReadPorts): Promise<SessionInputResultGetResultV1> {
    const localId = readPendingLocalId(params.localId);
    if (!localId) return { ok: false, code: 'invalid_local_id' };
    try {
        const needsTranscript = params.projection !== 'reply' || Boolean(params.callerPluginId);
        const target = await ports.resolveSession(needsTranscript);
        if (!target.ok) return target;
        const { sessionId } = target.address;
        const readReply = async (): Promise<SessionInputResultGetResultV1> => {
            const reply = await ports.readReply(sessionId, localId);
            params.signal?.throwIfAborted();
            return { ok: true, sessionId, localId, projection: 'reply', reply };
        };
        if (!needsTranscript) return await readReply();
        if (!target.transcript) return { ok: false, code: 'encryption_material_unavailable' };
        const lookup = await ports.readOriginal(sessionId, localId);
        params.signal?.throwIfAborted();
        if (lookup.type === 'not_found') {
            if (!params.callerPluginId) {
                if (lookup.inputDisposition) return { ok: false, code: lookup.inputDisposition.code };
                if (lookup.error !== undefined) throw lookup.error;
            }
            return { ok: false, code: 'result_read_failed' };
        }
        if (lookup.type !== 'found') throw lookup.error;
        const message = lookup.message;
        if (message.localId !== localId || message.sidechainId !== null) return { ok: false, code: 'result_read_failed' };
        if (params.callerPluginId) {
            try {
                const opened = await target.transcript.openContent(message.content);
                const meta = opened && typeof opened === 'object' && 'meta' in opened ? opened.meta : null;
                const authority = readSessionInputAuthority(meta, 'stored');
                if (authority?.producer !== 'pluginSession' || authority.caller?.kind !== 'plugin'
                    || authority.caller.pluginId !== params.callerPluginId) return { ok: false, code: 'result_read_failed' };
                assertSessionInputAdmissionReceiptForAuthorityV1({ authority, inputAdmissionReceipt: message.inputAdmissionReceipt });
            } catch {
                // An unproven plugin caller receives no details about the stored original.
                return { ok: false, code: 'result_read_failed' };
            }
        }
        if (params.projection === 'reply') return await readReply();
        if (message.turn && message.turn.turnId !== message.turnStartWitnessId) return { ok: false, code: 'result_read_failed' };
        const outcome = message.turn ? await readAssistantTurnOutcomeAfterCurrentUserTurn({
            localId, materializedSeq: message.seq, materializedContent: message.content,
            hostTurn: message.turn, transcript: target.transcript, ...(params.signal ? { signal: params.signal } : {}),
        }) : { kind: 'missing' as const };
        params.signal?.throwIfAborted();
        return { ok: true, sessionId, localId,
            ...(message.acceptedTurnId ? { acceptedTurnId: message.acceptedTurnId } : {}),
            ...(message.turnStartWitnessId ? { turnStartWitnessId: message.turnStartWitnessId } : {}),
            ...(message.turn ? { turnStatus: message.turn.status } : {}),
            ...(message.followDeliveryProjection ? { followDeliveryProjection: message.followDeliveryProjection } : {}),
            result: message.inputDeliveryIssue && !message.turn ? projectBlockedInputResult('team_access_removed', message.inputDeliveryIssue)
                : resultFromAssistantTurnOutcome(outcome, target.address),
        };
    } catch (error) {
        if (params.signal?.aborted) return { ok: false, code: 'cancelled' };
        return { ok: false, code: 'result_read_failed', failureCause: projectActionFailureCauseV1(error, 'session.input.result.get') };
    }
}

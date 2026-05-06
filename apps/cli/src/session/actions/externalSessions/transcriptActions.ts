import {
    DirectTranscriptPageRequestSchema,
    DirectTranscriptReadAfterRequestSchema,
    type DirectTranscriptPageResponse,
    type DirectTranscriptReadAfterResponse,
} from '@happier-dev/protocol';

import { validateDirectMachineSource } from '@/api/session/external/security/validateDirectMachineSource';

import { resolveDefaultMaxBytes, resolveDefaultMaxItems } from './actionConfiguration';
import { getDirectSessionProviderOps } from './providerOpsResolution';
import { directSessionsError, internalErrorResponse } from './responseErrors';

export async function executeExternalSessionTranscriptPageAction(
    raw: unknown,
): Promise<DirectTranscriptPageResponse> {
    const parsed = DirectTranscriptPageRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectTranscriptPageResponse;
    let validatedSource: Awaited<ReturnType<typeof validateDirectMachineSource>>;
    try {
        validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        return internalErrorResponse(
            'direct_session_transcript_page.validate_source',
            error,
            'direct_session_transcript_page_failed',
        ) satisfies DirectTranscriptPageResponse;
    }
    if (!validatedSource.ok) {
        return directSessionsError('invalid_request', validatedSource.error) satisfies DirectTranscriptPageResponse;
    }
    const { providerId, remoteSessionId, direction, cursor } = parsed.data;
    const source = validatedSource.source;
    const maxBytes = parsed.data.maxBytes ?? resolveDefaultMaxBytes();
    const maxItems = parsed.data.maxItems ?? resolveDefaultMaxItems();

    try {
        const res = await (await getDirectSessionProviderOps(providerId)).pageTranscript({
            source,
            remoteSessionId,
            direction,
            cursor,
            maxBytes,
            maxItems,
        });
        return {
            ok: true,
            items: res.items,
            nextCursor: res.nextCursor,
            tailCursor: res.tailCursor,
            hasMore: res.hasMore,
            truncated: res.truncated,
        } satisfies DirectTranscriptPageResponse;
    } catch (error) {
        return internalErrorResponse(
            'direct_session_transcript_page',
            error,
            'direct_session_transcript_page_failed',
        ) satisfies DirectTranscriptPageResponse;
    }
}

export async function executeExternalSessionTranscriptReadAfterAction(
    raw: unknown,
): Promise<DirectTranscriptReadAfterResponse> {
    const parsed = DirectTranscriptReadAfterRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectTranscriptReadAfterResponse;
    let validatedSource: Awaited<ReturnType<typeof validateDirectMachineSource>>;
    try {
        validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        return internalErrorResponse(
            'direct_session_transcript_read_after.validate_source',
            error,
            'direct_session_transcript_read_after_failed',
        ) satisfies DirectTranscriptReadAfterResponse;
    }
    if (!validatedSource.ok) {
        return directSessionsError('invalid_request', validatedSource.error) satisfies DirectTranscriptReadAfterResponse;
    }
    const { providerId, remoteSessionId, cursor } = parsed.data;
    const source = validatedSource.source;

    const maxBytes = parsed.data.maxBytes ?? resolveDefaultMaxBytes();
    const maxItems = parsed.data.maxItems ?? resolveDefaultMaxItems();

    try {
        const res = await (await getDirectSessionProviderOps(providerId)).readAfterTranscript({
            source,
            remoteSessionId,
            cursor,
            maxBytes,
            maxItems,
        });
        return { ok: true, items: res.items, nextCursor: res.nextCursor, truncated: res.truncated } satisfies DirectTranscriptReadAfterResponse;
    } catch (error) {
        return internalErrorResponse(
            'direct_session_transcript_read_after',
            error,
            'direct_session_transcript_read_after_failed',
        ) satisfies DirectTranscriptReadAfterResponse;
    }
}

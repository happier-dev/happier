import {
    ExternalSessionTranscriptPageRequestSchema,
    ExternalSessionTranscriptReadAfterRequestSchema,
    type ExternalSessionTranscriptPageResponse,
    type ExternalSessionTranscriptReadAfterResponse,
} from '@happier-dev/protocol';

import { validateDirectMachineSource } from '@/api/session/external/security/validateDirectMachineSource';
import { collectTransientSessionMediaReadDirs } from '@/session/media/referencedPaths';

import { resolveDefaultMaxBytes, resolveDefaultMaxItems } from './actionConfiguration';
import { getExternalSessionProviderOps } from './providerOpsResolution';
import { externalSessionsError, internalErrorResponse } from './responseErrors';

export async function executeExternalSessionTranscriptPageAction(
    raw: unknown,
): Promise<ExternalSessionTranscriptPageResponse> {
    const parsed = ExternalSessionTranscriptPageRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionTranscriptPageResponse;
    let validatedSource: Awaited<ReturnType<typeof validateDirectMachineSource>>;
    try {
        validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        return internalErrorResponse(
            'external_session_transcript_page.validate_source',
            error,
            'external_session_transcript_page_failed',
        ) satisfies ExternalSessionTranscriptPageResponse;
    }
    if (!validatedSource.ok) {
        return externalSessionsError('invalid_request', validatedSource.error) satisfies ExternalSessionTranscriptPageResponse;
    }
    const { providerId, remoteSessionId, direction, cursor } = parsed.data;
    const source = validatedSource.source;
    const maxBytes = parsed.data.maxBytes ?? resolveDefaultMaxBytes();
    const maxItems = parsed.data.maxItems ?? resolveDefaultMaxItems();

    try {
        const res = await (await getExternalSessionProviderOps(providerId)).pageTranscript({
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
            transientMediaReadDirs: collectTransientSessionMediaReadDirs(res.items),
        } satisfies ExternalSessionTranscriptPageResponse;
    } catch (error) {
        return internalErrorResponse(
            'external_session_transcript_page',
            error,
            'external_session_transcript_page_failed',
        ) satisfies ExternalSessionTranscriptPageResponse;
    }
}

export async function executeExternalSessionTranscriptReadAfterAction(
    raw: unknown,
): Promise<ExternalSessionTranscriptReadAfterResponse> {
    const parsed = ExternalSessionTranscriptReadAfterRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionTranscriptReadAfterResponse;
    let validatedSource: Awaited<ReturnType<typeof validateDirectMachineSource>>;
    try {
        validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        return internalErrorResponse(
            'external_session_transcript_read_after.validate_source',
            error,
            'external_session_transcript_read_after_failed',
        ) satisfies ExternalSessionTranscriptReadAfterResponse;
    }
    if (!validatedSource.ok) {
        return externalSessionsError('invalid_request', validatedSource.error) satisfies ExternalSessionTranscriptReadAfterResponse;
    }
    const { providerId, remoteSessionId, cursor } = parsed.data;
    const source = validatedSource.source;

    const maxBytes = parsed.data.maxBytes ?? resolveDefaultMaxBytes();
    const maxItems = parsed.data.maxItems ?? resolveDefaultMaxItems();

    try {
        const res = await (await getExternalSessionProviderOps(providerId)).readAfterTranscript({
            source,
            remoteSessionId,
            cursor,
            maxBytes,
            maxItems,
        });
        return {
            ok: true,
            items: res.items,
            nextCursor: res.nextCursor,
            truncated: res.truncated,
            transientMediaReadDirs: collectTransientSessionMediaReadDirs(res.items),
        } satisfies ExternalSessionTranscriptReadAfterResponse;
    } catch (error) {
        return internalErrorResponse(
            'external_session_transcript_read_after',
            error,
            'external_session_transcript_read_after_failed',
        ) satisfies ExternalSessionTranscriptReadAfterResponse;
    }
}

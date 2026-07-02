import {
    ExternalSessionTranscriptPageRequestSchema,
    ExternalSessionTranscriptReadAfterRequestSchema,
    type ExternalSessionTranscriptPageResponse,
    type ExternalSessionTranscriptReadAfterResponse,
} from '@happier-dev/protocol';

import { validateDirectMachineSource } from '@/api/session/external/security/validateDirectMachineSource';
import { collectTransientSessionMediaReadFiles } from '@/session/media/referencedPaths';

import { resolveDefaultMaxBytes, resolveDefaultMaxItems } from './actionConfiguration';
import type { ExternalSessionActionContext } from './externalSessionActionContext';
import { resolveExternalSessionSurfaceOps } from './providerOpsResolution';
import { externalSessionsError, internalErrorResponse } from './responseErrors';

async function resolveTransientMediaAllowedRoots(input: Readonly<{
    providerOps: Awaited<ReturnType<typeof resolveExternalSessionSurfaceOps>>;
    source: unknown;
    remoteSessionId: string;
}>): Promise<readonly string[]> {
    if (!input.source || typeof input.source !== 'object' || Array.isArray(input.source)) return [];
    return input.providerOps.resolveTranscriptMediaReadRoots?.({
        source: input.source as Parameters<NonNullable<typeof input.providerOps.resolveTranscriptMediaReadRoots>>[0]['source'],
        remoteSessionId: input.remoteSessionId,
    }) ?? [];
}

export async function executeExternalSessionTranscriptPageAction(
    raw: unknown,
    context?: Pick<ExternalSessionActionContext, 'transientMediaReadAllowance'>,
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
        const providerOps = await resolveExternalSessionSurfaceOps(providerId);
        if (!providerOps.pageTranscript) {
            return externalSessionsError('provider_unavailable', 'transcript_page_not_supported') satisfies ExternalSessionTranscriptPageResponse;
        }
        const res = await providerOps.pageTranscript({
            source,
            remoteSessionId,
            direction,
            cursor,
            maxBytes,
            maxItems,
        });
        const allowedRoots = await resolveTransientMediaAllowedRoots({ providerOps, source, remoteSessionId });
        const transientMediaReadFiles = collectTransientSessionMediaReadFiles(res.items, {
            allowedRoots,
        });
        context?.transientMediaReadAllowance?.grantReadFiles(transientMediaReadFiles);
        return {
            ok: true,
            items: res.items,
            nextCursor: res.nextCursor,
            tailCursor: res.tailCursor,
            hasMore: res.hasMore,
            truncated: res.truncated,
            transientMediaReadFiles,
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
    context?: Pick<ExternalSessionActionContext, 'transientMediaReadAllowance'>,
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
        const providerOps = await resolveExternalSessionSurfaceOps(providerId);
        if (!providerOps.readAfterTranscript) {
            return externalSessionsError('provider_unavailable', 'transcript_read_after_not_supported') satisfies ExternalSessionTranscriptReadAfterResponse;
        }
        const res = await providerOps.readAfterTranscript({
            source,
            remoteSessionId,
            cursor,
            maxBytes,
            maxItems,
        });
        const allowedRoots = await resolveTransientMediaAllowedRoots({ providerOps, source, remoteSessionId });
        const transientMediaReadFiles = collectTransientSessionMediaReadFiles(res.items, {
            allowedRoots,
        });
        context?.transientMediaReadAllowance?.grantReadFiles(transientMediaReadFiles);
        return {
            ok: true,
            items: res.items,
            nextCursor: res.nextCursor,
            truncated: res.truncated,
            transientMediaReadFiles,
        } satisfies ExternalSessionTranscriptReadAfterResponse;
    } catch (error) {
        return internalErrorResponse(
            'external_session_transcript_read_after',
            error,
            'external_session_transcript_read_after_failed',
        ) satisfies ExternalSessionTranscriptReadAfterResponse;
    }
}

import {
    ExternalSessionTranscriptPageRequestSchema,
    ExternalSessionTranscriptRefreshReadAfterRequestV1Schema,
    ExternalSessionTranscriptRefreshReadAfterResponseV1Schema,
    ExternalSessionTranscriptReadAfterRequestSchema,
    externalSessionTranscriptRefreshBindingsEqualV1,
    type ExternalSessionTranscriptPageResponse,
    type ExternalSessionTranscriptReadAfterResponse,
    type ExternalSessionTranscriptRefreshReadAfterResponseV1,
} from '@happier-dev/protocol';

import { validateExternalMachineSource } from '@/api/session/external/security/validateExternalMachineSource';
import { collectTransientSessionMediaReadFiles } from '@/session/media/referencedPaths';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';

import type { ExternalSessionActionContext } from './externalSessionActionContext';
import { resolveExternalSessionSurfaceOps } from './providerOpsResolution';
import {
    externalSessionsError,
    internalErrorResponse,
    mapExternalSessionProviderFailureToExternalSessionsError,
} from './responseErrors';
import { resolveExternalSessionTranscriptRefreshBinding } from '@/api/session/external/secureRefresh/resolveExternalSessionTranscriptRefreshBinding';
import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readStoredCredentials } from '@/persistence';

export async function executeExternalSessionTranscriptPageAction(
    raw: unknown,
    context?: Pick<ExternalSessionActionContext, 'transientMediaReadAllowance'>,
): Promise<ExternalSessionTranscriptPageResponse> {
    const parsed = ExternalSessionTranscriptPageRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionTranscriptPageResponse;
    let validatedSource: Awaited<ReturnType<typeof validateExternalMachineSource>>;
    try {
        validatedSource = await validateExternalMachineSource({
            agentId: parsed.data.agentId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        const providerFailure = mapExternalSessionProviderFailureToExternalSessionsError(error);
        if (providerFailure) return providerFailure satisfies ExternalSessionTranscriptPageResponse;
        return internalErrorResponse(
            'external_session_transcript_page.validate_source',
            error,
            'external_session_transcript_page_failed',
        ) satisfies ExternalSessionTranscriptPageResponse;
    }
    if (!validatedSource.ok) {
        return externalSessionsError(validatedSource.errorCode ?? 'invalid_request', validatedSource.error) satisfies ExternalSessionTranscriptPageResponse;
    }
    const { agentId, remoteSessionId, direction, cursor } = parsed.data;
    const source = validatedSource.source;
    const maxBytes = parsed.data.maxBytes
        ?? EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes;
    const maxItems = parsed.data.maxItems
        ?? EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxItems;

    try {
        const providerOps = validatedSource.providerOps;
        if (!providerOps.pageTranscript) {
            return externalSessionsError('agent_unavailable', 'transcript_page_not_supported') satisfies ExternalSessionTranscriptPageResponse;
        }
        const res = await providerOps.pageTranscript({
            source,
            remoteSessionId,
            direction,
            cursor,
            maxBytes,
            maxItems,
        });
        const transientMediaReadFiles = collectTransientSessionMediaReadFiles(res.items, {
            allowedRoots: validatedSource.transcriptMediaReadRoots,
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
        const providerFailure = mapExternalSessionProviderFailureToExternalSessionsError(error);
        if (providerFailure) return providerFailure satisfies ExternalSessionTranscriptPageResponse;
        return internalErrorResponse(
            'external_session_transcript_page',
            error,
            'external_session_transcript_page_failed',
        ) satisfies ExternalSessionTranscriptPageResponse;
    }
}

export async function executeExternalSessionTranscriptReadAfterAction(
    raw: unknown,
    context?: Pick<
        ExternalSessionActionContext,
        'deviceLocalSecretStorage' | 'transientMediaReadAllowance'
    >,
): Promise<ExternalSessionTranscriptReadAfterResponse | ExternalSessionTranscriptRefreshReadAfterResponseV1> {
    const refreshRequest = ExternalSessionTranscriptRefreshReadAfterRequestV1Schema.safeParse(raw);
    if (refreshRequest.success) {
        const request = refreshRequest.data;
        const currentBinding = await resolveExternalSessionTranscriptRefreshBinding({
            sessionId: request.binding.sessionId,
            cursor: request.cursor,
            ...(context?.deviceLocalSecretStorage
                ? {
                    deviceLocalSecretStorage:
                        context.deviceLocalSecretStorage,
                }
                : {}),
        }).catch(() => null);
        if (!currentBinding) {
            return ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
                v: 1,
                binding: request.binding,
                result: { outcome: 'source_unavailable' },
            });
        }
        if (!externalSessionTranscriptRefreshBindingsEqualV1(request.binding, currentBinding)) {
            return ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
                v: 1,
                binding: request.binding,
                result: { outcome: 'source_replaced' },
            });
        }
        const credentials = await readStoredCredentials().catch(() => null);
        const loaded = credentials
            ? await loadLinkedExternalSession({
                credentials,
                sessionId: request.binding.sessionId,
                machineId: request.binding.machineId,
            }).catch(() => null)
            : null;
        if (!loaded?.ok) {
            return ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
                v: 1,
                binding: request.binding,
                result: { outcome: 'source_unavailable' },
            });
        }
        try {
            const providerOps = await resolveExternalSessionSurfaceOps(loaded.session.agentId);
            if (!providerOps.readAfterTranscript) {
                return ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
                    v: 1,
                    binding: request.binding,
                    result: { outcome: 'source_unavailable' },
                });
            }
            const res = await providerOps.readAfterTranscript({
                source: loaded.session.source,
                remoteSessionId: loaded.session.remoteSessionId,
                cursor: request.cursor,
                maxBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxSerializedBytes,
                maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxItems,
            });
            const bindingAfterRead = await resolveExternalSessionTranscriptRefreshBinding({
                sessionId: request.binding.sessionId,
                cursor: request.cursor,
                ...(context?.deviceLocalSecretStorage
                    ? {
                        deviceLocalSecretStorage:
                            context.deviceLocalSecretStorage,
                    }
                    : {}),
            }).catch(() => null);
            if (!bindingAfterRead) {
                return ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
                    v: 1,
                    binding: request.binding,
                    result: { outcome: 'source_unavailable' },
                });
            }
            if (!externalSessionTranscriptRefreshBindingsEqualV1(request.binding, bindingAfterRead)) {
                return ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
                    v: 1,
                    binding: request.binding,
                    result: { outcome: 'source_replaced' },
                });
            }
            if (res.outcome === 'advanced' && res.nextCursor === request.cursor) {
                return ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
                    v: 1,
                    binding: request.binding,
                    result: { outcome: 'gap_or_cursor_expired' },
                });
            }
            return ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
                v: 1,
                binding: request.binding,
                result: res.outcome === 'advanced'
                    ? {
                        ...res,
                    hasMore: res.hasMore,
                        ...(res.diagnostics ? { diagnostics: res.diagnostics } : {}),
                    }
                    : res,
            });
        } catch {
            return ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
                v: 1,
                binding: request.binding,
                result: { outcome: 'read_failed' },
            });
        }
    }
    const parsed = ExternalSessionTranscriptReadAfterRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionTranscriptReadAfterResponse;
    let validatedSource: Awaited<ReturnType<typeof validateExternalMachineSource>>;
    try {
        validatedSource = await validateExternalMachineSource({
            agentId: parsed.data.agentId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        const providerFailure = mapExternalSessionProviderFailureToExternalSessionsError(error);
        if (providerFailure) return providerFailure satisfies ExternalSessionTranscriptReadAfterResponse;
        return internalErrorResponse(
            'external_session_transcript_read_after.validate_source',
            error,
            'external_session_transcript_read_after_failed',
        ) satisfies ExternalSessionTranscriptReadAfterResponse;
    }
    if (!validatedSource.ok) {
        return externalSessionsError(validatedSource.errorCode ?? 'invalid_request', validatedSource.error) satisfies ExternalSessionTranscriptReadAfterResponse;
    }
    const { agentId, remoteSessionId, cursor } = parsed.data;
    const source = validatedSource.source;

    const maxBytes = parsed.data.maxBytes
        ?? EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxSerializedBytes;
    const maxItems = parsed.data.maxItems
        ?? EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxItems;

    try {
        const providerOps = validatedSource.providerOps;
        if (!providerOps.readAfterTranscript) {
            return externalSessionsError('agent_unavailable', 'transcript_read_after_not_supported') satisfies ExternalSessionTranscriptReadAfterResponse;
        }
        const res = await providerOps.readAfterTranscript({
            source,
            remoteSessionId,
            cursor,
            maxBytes,
            maxItems,
        });
        if (res.outcome === 'source_unavailable') {
            return externalSessionsError('agent_unavailable', 'transcript_source_unavailable') satisfies ExternalSessionTranscriptReadAfterResponse;
        }
        if (res.outcome === 'read_failed') {
            return externalSessionsError('agent_unavailable', 'transcript_read_failed') satisfies ExternalSessionTranscriptReadAfterResponse;
        }
        if (res.outcome === 'advanced') {
          if (res.nextCursor === cursor) {
            // The same stalled-advanced decision the secure refresh path
            // applies server-side: a read that makes no cursor progress is a
            // gap, not an applicable empty page.
            return {
              ok: true,
              items: [],
              nextCursor: null,
              truncated: true,
              transientMediaReadFiles: [],
            } satisfies ExternalSessionTranscriptReadAfterResponse;
          }
          const transientMediaReadFiles = collectTransientSessionMediaReadFiles(res.items, {
            allowedRoots: validatedSource.transcriptMediaReadRoots,
          });
          context?.transientMediaReadAllowance?.grantReadFiles(transientMediaReadFiles);
          return {
            ok: true,
            items: [...res.items],
            nextCursor: res.nextCursor,
            truncated: false,
            // Additive rich continuation facts on the released lossy shape
            // (open/drop for released readers); the current UI applies the
            // shared Protocol read-after decision to them.
            hasMore: res.hasMore,
            ...(res.diagnostics
              ? {
                  diagnostics: res.diagnostics.map((diagnostic) => ({
                    ...diagnostic,
                    positions: [...diagnostic.positions],
                  })),
                }
              : {}),
            transientMediaReadFiles,
          } satisfies ExternalSessionTranscriptReadAfterResponse;
        }
        if (res.outcome === 'already_current') {
          return {
            ok: true,
            items: [],
            nextCursor: cursor,
            truncated: false,
            transientMediaReadFiles: [],
          } satisfies ExternalSessionTranscriptReadAfterResponse;
        }
        return {
            ok: true,
            items: [],
            nextCursor: null,
            truncated: true,
            transientMediaReadFiles: [],
        } satisfies ExternalSessionTranscriptReadAfterResponse;
    } catch (error) {
        const providerFailure = mapExternalSessionProviderFailureToExternalSessionsError(error);
        if (providerFailure) return providerFailure satisfies ExternalSessionTranscriptReadAfterResponse;
        return internalErrorResponse(
            'external_session_transcript_read_after',
            error,
            'external_session_transcript_read_after_failed',
        ) satisfies ExternalSessionTranscriptReadAfterResponse;
    }
}

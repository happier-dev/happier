import type {
    AgentExternalSessionsContribution,
    AgentExternalSessionsResult,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    AgentExternalSessionSource,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
    AGENT_OWNED_SESSION_METADATA_KEYS_V1,
    PluginAgentExternalSessionLinkDataSchema,
    readRuntimeDescriptorV1FromMetadata,
    resolveLinkedExternalSessionMetadataV1,
    type ExternalSessionsSource,
    type PluginAgentExternalLinkedTakeoverWriterSafetyV1,
    type PluginAgentExternalSessionLinkData,
} from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime';
import { getLegacyProviderSessionIdMetadataKeys } from '@happier-dev/agents';

import {
    type BoundedAgentExternalSessionsContribution,
    EXTERNAL_SESSIONS_INVOCATION_POLICY,
} from '@/session/external/agentExternalSessionsInvocation';
import {
    ExternalSessionProviderFailureError,
    type ExternalSessionExecutionSurface,
} from '@/session/external/providerOps';

function invocation(
    maxSerializedBytes: number,
    signal?: AbortSignal,
    admissionDeadlineAtMs?: number,
): Readonly<{
    signal: AbortSignal;
    deadlineAtMs: number;
    maxSerializedBytes: number;
}> {
    return {
        signal: signal ?? new AbortController().signal,
        deadlineAtMs: Math.min(
            Date.now() + EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs,
            admissionDeadlineAtMs ?? Number.POSITIVE_INFINITY,
        ),
        maxSerializedBytes,
    };
}

function unwrap<T>(
    operation: keyof AgentExternalSessionsContribution,
    result: AgentExternalSessionsResult<T>,
): T {
    if (result.ok) return result.value;
    throw new ExternalSessionProviderFailureError({
        code: result.code,
        message: result.message ?? `Agent External Sessions ${operation} failed (${result.code})`,
        operation,
        retryable: result.retryable,
    });
}

function invalidInput(operation: keyof AgentExternalSessionsContribution): ExternalSessionProviderFailureError {
    return new ExternalSessionProviderFailureError({
        code: 'invalid_request',
        message: `Agent External Sessions ${operation} received a source or link identity that is not strict JSON`,
        operation,
        retryable: false,
    });
}

function toAgentSource(
    source: ExternalSessionsSource,
    operation: keyof AgentExternalSessionsContribution,
): AgentExternalSessionSource {
    const parsed = AgentRuntimeJsonValueV1Schema.safeParse(source);
    if (
        !parsed.success
        || parsed.data === null
        || typeof parsed.data !== 'object'
        || Array.isArray(parsed.data)
    ) {
        throw invalidInput(operation);
    }
    const kind = Reflect.get(parsed.data, 'kind');
    if (typeof kind !== 'string' || kind.length === 0) {
        throw invalidInput(operation);
    }
    // The strict-JSON schema snapshots every nested value before this
    // build-time legacy source union crosses into the runtime-extensible SDK.
    return Object.freeze({ ...parsed.data, kind }) as AgentExternalSessionSource;
}

function toLegacySource(source: AgentExternalSessionSource): ExternalSessionsSource {
    // The bounded contribution has already parsed and snapshotted this source.
    // Runtime plugin kinds cannot be enumerated by the build-time legacy union.
    return source as ExternalSessionsSource;
}

function readLinkData(
    metadata: Readonly<Record<string, unknown>> | undefined,
    operation: keyof AgentExternalSessionsContribution,
): PluginAgentExternalSessionLinkData | undefined {
    if (!metadata) return undefined;
    const resolution = resolveLinkedExternalSessionMetadataV1(metadata);
    if (!resolution.ok && resolution.error !== 'linked_session_not_found') {
        throw invalidInput(operation);
    }
    const linked = resolution.ok ? resolution.linkedSession : null;
    const value = linked?.linkData ?? metadata.linkData;
    if (value === undefined) return undefined;
    const parsed = PluginAgentExternalSessionLinkDataSchema.safeParse(value);
    if (!parsed.success) throw invalidInput(operation);
    return parsed.data;
}

/**
 * An Agent's `linkData` is an arbitrary vendor bag. Its keys collide with
 * host-owned identity and custody fields that both the owner-metadata
 * allow-list (`tag`, `path`, `host`, `machineId`, `flavor`, lifecycle, runtime,
 * connected services) and `LinkedExternalSessionV1` (`agentId`, `machineId`,
 * `remoteSessionId`, `source`, `linkedAtMs`) accept, so spreading the bag into
 * either carrier would let a contribution re-write host state with values no
 * schema can reject.
 *
 * The bag therefore travels verbatim on exactly one carrier —
 * `externalSessionV1.linkData`, which every read path already uses — while
 * session metadata receives only the Agent-owned native-session facts the
 * protocol enumerates, minus the resume identity the host writes itself from
 * the admitted remote session id. The runtime descriptor is deliberately
 * absent too: the host re-applies the validated descriptor it resolved.
 */
const AGENT_CONTRIBUTABLE_SESSION_METADATA_KEYS = Object.freeze(
    AGENT_OWNED_SESSION_METADATA_KEYS_V1.filter((key) =>
        !getLegacyProviderSessionIdMetadataKeys().includes(key)),
);

function projectAgentOwnedLinkDataFacts(
    linkData: PluginAgentExternalSessionLinkData,
): Record<string, unknown> {
    const projected: Record<string, unknown> = {};
    for (const key of AGENT_CONTRIBUTABLE_SESSION_METADATA_KEYS) {
        if (Object.hasOwn(linkData, key)) projected[key] = linkData[key];
    }
    return projected;
}

export function createAgentExternalSessionsExecutionSurface(
    contribution: BoundedAgentExternalSessionsContribution,
    externalLinkedTakeoverWriterSafety: PluginAgentExternalLinkedTakeoverWriterSafetyV1 = 'unsupported',
): ExternalSessionExecutionSurface {
    const surface: ExternalSessionExecutionSurface = {
        externalLinkedTakeoverWriterSafety,
        async validateSource(request) {
            const result = unwrap('resolveSource', await contribution.resolveSource({
                source: toAgentSource(request.source, 'resolveSource'),
                ...invocation(
                    EXTERNAL_SESSIONS_INVOCATION_POLICY.resolveSource.maxSerializedBytes,
                    request.signal,
                ),
            }));
            return {
                ok: true,
                source: toLegacySource(result.source),
                ...(result.transcriptMediaReadRoots === undefined
                    ? {}
                    : { transcriptMediaReadRoots: result.transcriptMediaReadRoots }),
            };
        },
        async listCandidates(request) {
            const result = unwrap('listCandidates', await contribution.listCandidates({
                source: toAgentSource(request.source, 'listCandidates'),
                maxItems: request.limit,
                ...invocation(
                    Math.min(
                        request.maxBytes ?? EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes,
                        EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes,
                    ),
                    request.signal,
                ),
                ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
                ...(request.searchTerm === undefined ? {} : { searchTerm: request.searchTerm }),
                ...(request.searchMode === undefined ? {} : { searchMode: request.searchMode }),
            }));
            return {
                candidates: result.candidates,
                nextCursor: result.nextCursor,
                ...(result.searchIncomplete === undefined
                    ? {}
                    : { searchIncomplete: result.searchIncomplete }),
                ...(result.preparation === undefined
                    ? {}
                    : { preparation: result.preparation }),
            };
        },
        async resolveLinkIdentity(request) {
            const linkData = readLinkData(request.metadata, 'resolveLinkIdentity');
            const result = unwrap('resolveLinkIdentity', await contribution.resolveLinkIdentity({
                source: toAgentSource(request.source, 'resolveLinkIdentity'),
                remoteSessionId: request.remoteSessionId,
                ...invocation(
                    EXTERNAL_SESSIONS_INVOCATION_POLICY.resolveLinkIdentity.maxSerializedBytes,
                    request.signal,
                ),
                ...(linkData === undefined ? {} : { linkData }),
            }));
            const runtimeDescriptor = readRuntimeDescriptorV1FromMetadata({
                runtimeDescriptorV1: result.linkData.runtimeDescriptorV1,
            });
            return {
                source: toLegacySource(result.source),
                remoteSessionId: result.remoteSessionId,
                runtimeDescriptor,
                vendorMetadata: projectAgentOwnedLinkDataFacts(result.linkData),
                externalSessionMetadata: { linkData: result.linkData },
                ...(result.transcriptMediaReadRoots === undefined
                    ? {}
                    : { transcriptMediaReadRoots: result.transcriptMediaReadRoots }),
            };
        },
        async canonicalizeLinkedSession(request) {
            const result = unwrap('resolveLinkedIdentity', await contribution.resolveLinkedIdentity({
                source: toAgentSource(request.source, 'resolveLinkedIdentity'),
                remoteSessionId: request.remoteSessionId,
                linkData: readLinkData(request.metadata, 'resolveLinkedIdentity') ?? {},
                ...invocation(
                    EXTERNAL_SESSIONS_INVOCATION_POLICY.resolveLinkedIdentity.maxSerializedBytes,
                    request.signal,
                ),
            }));
            const runtimeDescriptor = readRuntimeDescriptorV1FromMetadata({
                runtimeDescriptorV1: result.linkData.runtimeDescriptorV1,
            });
            return {
                source: toLegacySource(result.source),
                remoteSessionId: result.remoteSessionId,
                runtimeDescriptor,
                vendorMetadata: projectAgentOwnedLinkDataFacts(result.linkData),
                externalSessionMetadata: { linkData: result.linkData },
                ...(result.transcriptMediaReadRoots === undefined
                    ? {}
                    : { transcriptMediaReadRoots: result.transcriptMediaReadRoots }),
            };
        },
        async pageTranscript(request) {
            const result = unwrap('pageTranscript', await contribution.pageTranscript({
                source: toAgentSource(request.source, 'pageTranscript'),
                remoteSessionId: request.remoteSessionId,
                direction: request.direction,
                maxItems: request.maxItems,
                ...invocation(
                    Math.min(
                        request.maxBytes,
                        EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes,
                    ),
                    request.signal,
                    request.deadlineAtMs,
                ),
                ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            }));
            return {
                items: [...result.items],
                nextCursor: result.nextCursor,
                tailCursor: result.tailCursor ?? null,
                hasMore: result.hasMore === true,
                truncated: result.truncated === true,
            };
        },
        async readAfterTranscript(request) {
            const result = unwrap('readAfterTranscript', await contribution.readAfterTranscript({
                source: toAgentSource(request.source, 'readAfterTranscript'),
                remoteSessionId: request.remoteSessionId,
                cursor: request.cursor,
                maxItems: request.maxItems,
                ...invocation(
                    Math.min(
                        request.maxBytes,
                        EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxSerializedBytes,
                    ),
                    request.signal,
                    request.deadlineAtMs,
                ),
            }));
            return result.outcome === 'advanced'
                ? {
                    ...result,
                    items: [...result.items],
                    ...(result.diagnostics
                        ? {
                            diagnostics: result.diagnostics.map((diagnostic) => ({
                                ...diagnostic,
                                positions: [...diagnostic.positions],
                            })),
                        }
                        : {}),
                }
                : result;
        },
    };
    return Object.freeze(surface);
}

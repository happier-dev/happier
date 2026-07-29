import {
    ConnectedServiceUsageSourceV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    type ConnectedServiceId,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agent-runtime';

import {
    notifyDaemonProviderAccountUsageAdoption,
    notifyDaemonProviderAccountUsageSnapshot,
} from '@/daemon/controlClient';
import {
    ProviderAccountUsageAdoptionV1Schema,
    type ProviderAccountUsageAdoptionV1,
} from '@/daemon/connectedServices/accountUsage/adoption';
import {
    resolveConnectedServiceRuntimeAuthContextFromEnv,
    resolveConnectedServiceRuntimeAuthContextFromSessionMetadata,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import type { ApiSessionClient } from '@/api/session/sessionClient';

const MAX_PENDING_SNAPSHOTS = 64;
const MAX_AUTOMATIC_DELIVERY_ATTEMPTS = 5;
const AUTOMATIC_RETRY_DELAY_MS = 1_000;

type AgentAccountUsageService = AgentSessionHostServices['accountUsage'];

export type NativeAgentAccountUsageService = Readonly<{
    resolveSourceContext: AgentAccountUsageService['resolveSourceContext'];
    recordSnapshot(
        input: Parameters<AgentAccountUsageService['recordSnapshot']>[0] & Readonly<{
            sessionId: string;
        }>,
        options?: Parameters<AgentAccountUsageService['recordSnapshot']>[1],
    ): ReturnType<AgentAccountUsageService['recordSnapshot']>;
    adoptProvisionalRecord(
        input: Readonly<{
            sessionId: string;
            adoption: ProviderAccountUsageAdoptionV1;
        }>,
        options?: Parameters<AgentAccountUsageService['adoptProvisionalRecord']>[1],
    ): ReturnType<AgentAccountUsageService['adoptProvisionalRecord']>;
}>;

type RecordSnapshotResult = Awaited<
    ReturnType<AgentAccountUsageService['recordSnapshot']>
>;
type RecordedSnapshotResult = Extract<
    RecordSnapshotResult,
    Readonly<{ status: 'recorded' }>
>;
type SnapshotRequest = Readonly<{
    sessionId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
    source?: ConnectedServiceUsageSourceV1 | null;
    credentialFingerprint?: string | null;
    policyDisposition?: 'evidence_only';
}>;
type PendingSnapshot = Readonly<{
    request: SnapshotRequest;
    automaticDeliveryAttempts: number;
}>;
type SnapshotDeliveryResult =
    | Readonly<{ status: 'recorded'; result: RecordedSnapshotResult }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'rejected' }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error ? signal.reason : new Error(message);
}

function snapshotPendingKey(request: SnapshotRequest): string {
    const source = request.source;
    const sourceKey = source
        ? source.bindingKind === 'profile'
            ? `${source.serviceId}\u0001${source.profileId}\u0001profile`
            : `${source.serviceId}\u0001${source.profileId}\u0001group_member\u0001${source.groupId}\u0001${source.groupGeneration ?? ''}`
        : '';
    return `${request.sessionId}\u0000${request.snapshot.recordId}\u0000${sourceKey}\u0000${request.credentialFingerprint ?? ''}`;
}

export function createNativeAgentAccountUsageService(params: Readonly<{
    sessionId: string;
    session: Pick<ApiSessionClient, 'getMetadataSnapshot'>;
    signal: AbortSignal;
}>): NativeAgentAccountUsageService {
    const pendingSnapshots = new Map<string, PendingSnapshot>();
    let automaticRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const clearAutomaticRetryTimer = (): void => {
        if (!automaticRetryTimer) return;
        clearTimeout(automaticRetryTimer);
        automaticRetryTimer = null;
    };

    const enqueuePendingSnapshot = (
        request: SnapshotRequest,
        automaticDeliveryAttempts = 0,
    ): void => {
        const key = snapshotPendingKey(request);
        pendingSnapshots.delete(key);
        pendingSnapshots.set(key, { request, automaticDeliveryAttempts });
        while (pendingSnapshots.size > MAX_PENDING_SNAPSHOTS) {
            const oldestKey = pendingSnapshots.keys().next().value;
            if (typeof oldestKey !== 'string') break;
            pendingSnapshots.delete(oldestKey);
        }
    };

    async function deliverSnapshot(
        request: SnapshotRequest,
    ): Promise<SnapshotDeliveryResult> {
        try {
            const response = await notifyDaemonProviderAccountUsageSnapshot(request);
            const responseRecord = isRecord(response) ? response : null;
            if (responseRecord?.ok === true) {
                const resultRecord = isRecord(responseRecord.result)
                    ? responseRecord.result
                    : null;
                if (!resultRecord) return { status: 'rejected' };
                const status = typeof resultRecord.status === 'string'
                    ? resultRecord.status
                    : null;
                if (status === 'session_not_found') return { status: 'unavailable' };
                if (
                    status === 'recorded'
                    || status === 'snapshot_advanced'
                    || status === 'source_linked'
                    || status === 'duplicate'
                    || status === 'older'
                    || status === 'credential_fingerprint_mismatch'
                ) {
                    const recordId = typeof resultRecord.recordId === 'string'
                        ? resultRecord.recordId
                        : request.snapshot.recordId;
                    const persisted = typeof resultRecord.persisted === 'boolean'
                        ? resultRecord.persisted
                        : undefined;
                    return {
                        status: 'recorded',
                        result: {
                            status: 'recorded',
                            recordId,
                            ...(persisted === undefined ? {} : { persisted }),
                        },
                    };
                }
                return { status: 'rejected' };
            }
            return responseRecord?.error
                ? { status: 'unavailable' }
                : { status: 'rejected' };
        } catch {
            return { status: 'unavailable' };
        }
    }

    const scheduleAutomaticRetry = (): void => {
        if (
            disposed
            || automaticRetryTimer
            || ![...pendingSnapshots.values()].some(
                (pending) => pending.automaticDeliveryAttempts < MAX_AUTOMATIC_DELIVERY_ATTEMPTS,
            )
        ) {
            return;
        }
        automaticRetryTimer = setTimeout(() => {
            automaticRetryTimer = null;
            if (!disposed) void flushPendingSnapshots(undefined, { automatic: true });
        }, AUTOMATIC_RETRY_DELAY_MS);
        automaticRetryTimer.unref?.();
    };

    async function flushPendingSnapshots(
        observedKey?: string,
        options: Readonly<{ automatic?: boolean }> = {},
    ): Promise<SnapshotDeliveryResult | null> {
        if (!options.automatic) clearAutomaticRetryTimer();
        if (pendingSnapshots.size === 0) return null;
        let observedDelivery: SnapshotDeliveryResult | null = null;
        for (const [key, pending] of [...pendingSnapshots.entries()]) {
            if (pendingSnapshots.get(key) !== pending) continue;
            if (
                options.automatic
                && pending.automaticDeliveryAttempts >= MAX_AUTOMATIC_DELIVERY_ATTEMPTS
            ) {
                continue;
            }
            const delivery = await deliverSnapshot(pending.request);
            if (key === observedKey) observedDelivery = delivery;
            if (delivery.status === 'unavailable') {
                if (pendingSnapshots.get(key) === pending) {
                    pendingSnapshots.set(key, {
                        request: pending.request,
                        automaticDeliveryAttempts: Math.min(
                            pending.automaticDeliveryAttempts + 1,
                            MAX_AUTOMATIC_DELIVERY_ATTEMPTS,
                        ),
                    });
                }
                scheduleAutomaticRetry();
                return observedDelivery;
            }
            if (pendingSnapshots.get(key) === pending) pendingSnapshots.delete(key);
        }
        scheduleAutomaticRetry();
        return observedDelivery;
    }

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        clearAutomaticRetryTimer();
        pendingSnapshots.clear();
    };
    if (params.signal.aborted) dispose();
    else params.signal.addEventListener('abort', dispose, { once: true });

    return Object.freeze({
        async resolveSourceContext(
            input: Parameters<AgentAccountUsageService['resolveSourceContext']>[0],
            options?: Parameters<AgentAccountUsageService['resolveSourceContext']>[1],
        ): Promise<Awaited<ReturnType<AgentAccountUsageService['resolveSourceContext']>>> {
            throwIfAborted(
                options?.signal,
                'Provider account usage source-context resolution aborted',
            );
            const request: Readonly<Record<string, unknown>> = isRecord(input as unknown)
                ? input as unknown as Readonly<Record<string, unknown>>
                : {};
            const serviceId = readTrimmedString(request.serviceId);
            if (!serviceId) return null;
            const env = isRecord(request.env)
                ? Object.fromEntries(
                    Object.entries(request.env).filter(
                        (entry): entry is [string, string | undefined] => (
                            typeof entry[1] === 'string' || entry[1] === undefined
                        ),
                    ),
                )
                : null;
            const context = env
                ? resolveConnectedServiceRuntimeAuthContextFromEnv(
                    env,
                    serviceId as ConnectedServiceId,
                )
                : resolveConnectedServiceRuntimeAuthContextFromSessionMetadata(
                    params.session,
                    serviceId as ConnectedServiceId,
                );
            if (!context?.profileId) return null;
            return ConnectedServiceUsageSourceV1Schema.parse({
                serviceId: context.serviceId,
                profileId: context.profileId,
                bindingKind: context.groupId ? 'group_member' : 'profile',
                ...(context.groupId ? { groupId: context.groupId } : {}),
                ...(context.groupId
                    && context.groupGeneration !== null
                    && context.groupGeneration !== undefined
                    ? { groupGeneration: context.groupGeneration }
                    : {}),
            });
        },
        async recordSnapshot(
            input: Parameters<NativeAgentAccountUsageService['recordSnapshot']>[0],
            options?: Parameters<NativeAgentAccountUsageService['recordSnapshot']>[1],
        ): Promise<Awaited<ReturnType<NativeAgentAccountUsageService['recordSnapshot']>>> {
            throwIfAborted(options?.signal, 'Provider account usage recording aborted');
            params.signal.throwIfAborted();
            const request: Readonly<Record<string, unknown>> = isRecord(input as unknown)
                ? input as unknown as Readonly<Record<string, unknown>>
                : {};
            const requestedSessionId = readTrimmedString(request.sessionId);
            if (requestedSessionId && requestedSessionId !== params.sessionId) {
                return { status: 'rejected', reason: 'session_mismatch' };
            }
            const parsed = ProviderAccountUsageSnapshotV1Schema.safeParse(request.snapshot);
            if (!parsed.success) {
                return { status: 'rejected', reason: 'invalid_snapshot' };
            }
            if (
                request.policyDisposition !== undefined
                && request.policyDisposition !== 'evidence_only'
            ) {
                return { status: 'rejected', reason: 'invalid_snapshot' };
            }
            const appliedIdentity = isRecord(request.appliedIdentity)
                ? request.appliedIdentity
                : null;
            const appliedServiceId = readTrimmedString(appliedIdentity?.serviceId);
            const appliedProfileId = readTrimmedString(appliedIdentity?.profileId);
            const appliedProviderAccountId = readTrimmedString(
                appliedIdentity?.providerAccountId,
            );
            const appliedGroupId = readTrimmedString(appliedIdentity?.groupId);
            const appliedGeneration = appliedIdentity?.groupGeneration;
            const appliedObservedAtMs = appliedIdentity?.observedAtMs;
            const appliedFingerprint = appliedIdentity?.credentialFingerprint;
            const exactAppliedSource = appliedIdentity
                && appliedServiceId
                && appliedServiceId === parsed.data.providerId
                && appliedProfileId
                && appliedProviderAccountId
                && parsed.data.accountSubject.kind === 'providerSubject'
                && parsed.data.accountSubject.id === appliedProviderAccountId
                && typeof appliedObservedAtMs === 'number'
                && Number.isSafeInteger(appliedObservedAtMs)
                && appliedObservedAtMs >= 0
                && (
                    appliedFingerprint === null
                    || (
                        typeof appliedFingerprint === 'string'
                        && /^sha256:[a-f0-9]{8}$/u.test(appliedFingerprint)
                    )
                )
                && (
                    (
                        appliedGroupId
                        && typeof appliedGeneration === 'number'
                        && Number.isSafeInteger(appliedGeneration)
                        && appliedGeneration >= 0
                    )
                    || (!appliedGroupId && appliedGeneration === null)
                )
                ? ConnectedServiceUsageSourceV1Schema.safeParse({
                    serviceId: appliedServiceId,
                    profileId: appliedProfileId,
                    bindingKind: appliedGroupId ? 'group_member' : 'profile',
                    ...(appliedGroupId
                        ? {
                            groupId: appliedGroupId,
                            groupGeneration: appliedGeneration,
                        }
                        : {}),
                })
                : null;
            if (
                request.appliedIdentity != null
                && (!exactAppliedSource || !exactAppliedSource.success)
            ) {
                return { status: 'rejected', reason: 'invalid_snapshot' };
            }
            if (exactAppliedSource?.success && request.source != null) {
                const requestedSource = ConnectedServiceUsageSourceV1Schema.safeParse(
                    request.source,
                );
                const requested = requestedSource.success ? requestedSource.data : null;
                const applied = exactAppliedSource.data;
                const sameSource = requested !== null
                    && requested.serviceId === applied.serviceId
                    && requested.profileId === applied.profileId
                    && requested.bindingKind === applied.bindingKind
                    && (
                        requested.bindingKind === 'profile'
                            ? applied.bindingKind === 'profile'
                            : applied.bindingKind === 'group_member'
                                && requested.groupId === applied.groupId
                                && requested.groupGeneration === applied.groupGeneration
                    );
                if (!sameSource) {
                    return { status: 'rejected', reason: 'invalid_snapshot' };
                }
            }
            const parsedSource = exactAppliedSource?.success
                ? exactAppliedSource
                : request.source == null
                    ? { success: true as const, data: undefined }
                    : ConnectedServiceUsageSourceV1Schema.safeParse(request.source);
            if (!parsedSource.success) {
                return { status: 'rejected', reason: 'invalid_snapshot' };
            }
            const pendingSnapshot: SnapshotRequest = {
                sessionId: params.sessionId,
                snapshot: parsed.data,
                ...(parsedSource.data ? { source: parsedSource.data } : {}),
                ...(exactAppliedSource?.success && typeof appliedFingerprint === 'string'
                    ? { credentialFingerprint: appliedFingerprint }
                    : {}),
                ...(request.policyDisposition === 'evidence_only'
                    ? { policyDisposition: 'evidence_only' as const }
                    : {}),
            };
            const pendingKey = snapshotPendingKey(pendingSnapshot);
            if (pendingSnapshots.has(pendingKey)) {
                enqueuePendingSnapshot(pendingSnapshot);
                const flushedCurrent = await flushPendingSnapshots(pendingKey);
                if (flushedCurrent?.status === 'recorded') {
                    await flushPendingSnapshots();
                    return flushedCurrent.result;
                }
                return flushedCurrent?.status === 'rejected'
                    ? { status: 'rejected', reason: 'daemon_rejected' }
                    : { status: 'unavailable', reason: 'daemon_unavailable' };
            }
            await flushPendingSnapshots();
            const delivery = await deliverSnapshot(pendingSnapshot);
            if (delivery.status === 'recorded') {
                await flushPendingSnapshots();
                return delivery.result;
            }
            if (delivery.status === 'unavailable') {
                enqueuePendingSnapshot(pendingSnapshot, 1);
                scheduleAutomaticRetry();
                return { status: 'unavailable', reason: 'daemon_unavailable' };
            }
            return { status: 'rejected', reason: 'daemon_rejected' };
        },
        async adoptProvisionalRecord(
            input: Parameters<NativeAgentAccountUsageService['adoptProvisionalRecord']>[0],
            options?: Parameters<NativeAgentAccountUsageService['adoptProvisionalRecord']>[1],
        ): Promise<Awaited<ReturnType<NativeAgentAccountUsageService['adoptProvisionalRecord']>>> {
            throwIfAborted(options?.signal, 'Provider account usage adoption aborted');
            params.signal.throwIfAborted();
            const request: Readonly<Record<string, unknown>> = isRecord(input as unknown)
                ? input as unknown as Readonly<Record<string, unknown>>
                : {};
            const requestedSessionId = readTrimmedString(request.sessionId);
            if (requestedSessionId && requestedSessionId !== params.sessionId) {
                return { status: 'rejected', reason: 'session_mismatch' };
            }
            const parsed = ProviderAccountUsageAdoptionV1Schema.safeParse(request.adoption);
            if (!parsed.success) {
                return { status: 'rejected', reason: 'invalid_adoption' };
            }
            try {
                const response = await notifyDaemonProviderAccountUsageAdoption({
                    sessionId: params.sessionId,
                    adoption: parsed.data,
                });
                if (response?.ok === true) {
                    const result = response.result;
                    if (isRecord(result)) {
                        const fromRecordId = typeof result.fromRecordId === 'string'
                            ? result.fromRecordId
                            : parsed.data.fromRecordId;
                        const toRecordId = typeof result.toRecordId === 'string'
                            ? result.toRecordId
                            : parsed.data.toRecordId;
                        const status = result.status === 'already_adopted'
                            ? 'already_adopted'
                            : 'adopted';
                        const persisted = typeof result.persisted === 'boolean'
                            ? result.persisted
                            : undefined;
                        return {
                            status,
                            fromRecordId,
                            toRecordId,
                            ...(persisted === undefined ? {} : { persisted }),
                        };
                    }
                    return {
                        status: 'adopted',
                        fromRecordId: parsed.data.fromRecordId,
                        toRecordId: parsed.data.toRecordId,
                    };
                }
                return response?.error
                    ? { status: 'unavailable', reason: 'daemon_unavailable' }
                    : { status: 'rejected', reason: 'daemon_rejected' };
            } catch {
                return { status: 'unavailable', reason: 'daemon_unavailable' };
            }
        },
    });
}

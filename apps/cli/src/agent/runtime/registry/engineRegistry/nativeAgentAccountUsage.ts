import {
    buildProviderAccountUsageRecordId,
    ConnectedAccountServiceKeyIngressSchema,
    ConnectedServiceUsageSourceV1Schema,
    ProviderAccountUsageRecordKeyV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    type ConnectedAccountServiceKey,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agents/runtime';

import {
    notifyDaemonProviderAccountUsageAdoption,
    notifyDaemonProviderAccountUsageSnapshot,
} from '@/daemon/controlClient';
import {
    ProviderAccountUsageAdoptionV1Schema,
    type ProviderAccountUsageAdoptionV1,
} from '@/daemon/connectedServices/accountUsage/adoption';
import {
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
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
    deriveCredentialFingerprintFromSource?: true;
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

/**
 * Host-only authority for accepting the public Agent account-usage observation
 * and assigning its persisted record identity. Plugin callers never supply a
 * host `recordId` or parse the Protocol persistence schema themselves.
 */
export function canonicalizeAgentAccountUsageSnapshot(
    value: unknown,
): ProviderAccountUsageSnapshotV1 | null {
    const semanticSnapshot = isRecord(value) ? value : null;
    const semanticRecordKey = isRecord(semanticSnapshot?.recordKey)
        ? semanticSnapshot.recordKey
        : null;
    const parsedRecordKey = ProviderAccountUsageRecordKeyV1Schema.safeParse(
        semanticRecordKey,
    );
    const parsed = ProviderAccountUsageSnapshotV1Schema.safeParse(
        semanticSnapshot && parsedRecordKey.success
            ? {
                ...semanticSnapshot,
                recordId: buildProviderAccountUsageRecordId(parsedRecordKey.data),
            }
            : value,
    );
    return parsed.success ? parsed.data : null;
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
    return `${request.sessionId}\u0000${request.snapshot.recordId}\u0000${sourceKey}`;
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
                ) {
                    return {
                        status: 'recorded',
                        result: { status: 'recorded' },
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

    const parseSourceAddress = (value: unknown): Readonly<{
        serviceId: ConnectedAccountServiceKey;
        env: Readonly<Record<string, string | undefined>> | null;
    }> | null => {
        if (!isRecord(value)) return null;
        const serviceId = ConnectedAccountServiceKeyIngressSchema.safeParse(readTrimmedString(value.serviceId));
        if (!serviceId.success) return null;
        const serializedSelection = isRecord(value.env)
            ? readTrimmedString(value.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY])
            : null;
        const env = serializedSelection
            ? { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serializedSelection }
            : null;
        return { serviceId: serviceId.data, env };
    };

    const resolveSourceAddress = (address: Readonly<{
        serviceId: ConnectedAccountServiceKey;
        env: Readonly<Record<string, string | undefined>> | null;
    }>): Readonly<{
        publicSource: Awaited<ReturnType<AgentAccountUsageService['resolveSourceContext']>>;
        connectedServiceSource: ConnectedServiceUsageSourceV1 | null;
    }> | null => {
        const context = address.env
            ? resolveConnectedServiceRuntimeAuthContextFromEnv(
                address.env,
                address.serviceId,
            )
            : resolveConnectedServiceRuntimeAuthContextFromSessionMetadata(
                params.session,
                address.serviceId,
            );
        if (!context?.profileId) return null;
        const source = {
            serviceId: context.serviceId,
            profileId: context.profileId,
            bindingKind: context.groupId ? 'group_member' : 'profile',
            ...(context.groupId ? { groupId: context.groupId } : {}),
            ...(context.groupId
                && context.groupGeneration !== null
                && context.groupGeneration !== undefined
                ? { groupGeneration: context.groupGeneration }
                : {}),
        } as const;
        const connectedServiceSource = ConnectedServiceUsageSourceV1Schema.safeParse(source);
        return {
            publicSource: Object.freeze({
                serviceId: source.serviceId,
                profileId: source.profileId,
                bindingKind: source.bindingKind,
                ...(source.bindingKind === 'group_member' ? { groupId: source.groupId } : {}),
            }),
            connectedServiceSource: connectedServiceSource.success
                ? connectedServiceSource.data
                : null,
        };
    };

    return Object.freeze({
        async resolveSourceContext(
            input: Parameters<AgentAccountUsageService['resolveSourceContext']>[0],
            options?: Parameters<AgentAccountUsageService['resolveSourceContext']>[1],
        ): Promise<Awaited<ReturnType<AgentAccountUsageService['resolveSourceContext']>>> {
            throwIfAborted(
                options?.signal,
                'Provider account usage source-context resolution aborted',
            );
            const address = parseSourceAddress(input);
            return address ? resolveSourceAddress(address)?.publicSource ?? null : null;
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
            const parsed = canonicalizeAgentAccountUsageSnapshot(request.snapshot);
            if (!parsed) {
                return { status: 'rejected', reason: 'invalid_snapshot' };
            }
            if (
                request.policyDisposition !== undefined
                && request.policyDisposition !== 'evidence_only'
            ) {
                return { status: 'rejected', reason: 'invalid_snapshot' };
            }
            const sourceAddress = request.source == null
                ? null
                : parseSourceAddress(request.source);
            const resolvedSource = sourceAddress ? resolveSourceAddress(sourceAddress) : null;
            if (request.source != null && (!sourceAddress || !resolvedSource)) {
                return { status: 'rejected', reason: 'invalid_snapshot' };
            }
            const pendingSnapshot: SnapshotRequest = {
                sessionId: params.sessionId,
                snapshot: parsed,
                ...(resolvedSource?.connectedServiceSource
                    ? {
                        source: resolvedSource.connectedServiceSource,
                        deriveCredentialFingerprintFromSource: true as const,
                    }
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
                        const status = result.status === 'already_adopted'
                            ? 'already_adopted'
                            : 'adopted';
                        return { status };
                    }
                    return { status: 'adopted' };
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

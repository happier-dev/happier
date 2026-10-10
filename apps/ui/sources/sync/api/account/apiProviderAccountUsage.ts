import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    createServerFetchForActiveServer,
    type ExpectedActiveServerFetchBasis,
} from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';

import { ProviderAccountUsageRecordIdSchema, ProviderAccountUsageSnapshotV1Schema, type ProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
import { QualifiedProviderAccountUsageReadErrorV4Schema, QualifiedProviderAccountUsageRecordResponseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { z } from 'zod';
import { ConnectedServiceQuotaGetInputV1Schema, QualifiedProviderAccountUsageHistoryRequestV4Schema, QualifiedProviderAccountUsageHistoryResponseV4Schema, openProviderAccountUsageRecordV4, openProviderAccountUsageHistoryPageV4, projectProviderAccountUsageQuotaReadV1, ProviderAccountUsageReadErrorV1, type ConnectedServiceQuotaGetInputV1, type ConnectedServiceQuotaGetResultV1, type ProviderAccountUsageHistoryWitnessV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { QualifiedConnectedServiceUsageSourceResolveV4Schema, QualifiedConnectedServiceUsageSourceResolutionV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { encodeQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { UsagePacingTargetsV1 } from '@happier-dev/protocol/account/settings/usagePacingPreferencesV1';
import type { ServerFetch } from '@/sync/http/client';
import { PendingResetStartsReadInputV1Schema, PendingResetStartsReadResultV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { evaluatePendingResetStartReadinessV1 } from '@happier-dev/protocol/sessions/pending/pendingResetStartReadinessV1';
import type { ProviderAccountUsageWaitingWorkV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';

export type ProviderAccountUsageQuotaReadOptions = Readonly<{
    accountMode: 'plain' | 'e2ee'; request?: ServerFetch; assertCurrent?: () => void;
    material?: AccountScopedCryptoMaterial; signal?: AbortSignal; nowMs?: number;
    expectedActiveServer?: ExpectedActiveServerFetchBasis; targets?: UsagePacingTargetsV1;
    readEnteredMonthlyPrice?: () => Promise<import('@happier-dev/protocol/connect/accountSubscription').ProviderAccountSubscriptionMonthlyPriceV1 | undefined>;
}>;
export async function getProviderAccountUsageQuota(credentials: AuthCredentials, input: ConnectedServiceQuotaGetInputV1, options: ProviderAccountUsageQuotaReadOptions): Promise<ConnectedServiceQuotaGetResultV1> {
    const request = ConnectedServiceQuotaGetInputV1Schema.parse(input);
    const sourceJson = await requestProviderAccountUsageJson(credentials, `/v4/connect/qualified/provider-account-usage/sources/resolve?${new URLSearchParams({ source: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedServiceUsageSourceResolveV4Schema, request.source) }).toString()}`, options);
    const resolution = sourceJson === null ? null : QualifiedConnectedServiceUsageSourceResolutionV4Schema.parse(sourceJson);
    const material = options.accountMode === 'e2ee' ? options.material ?? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : undefined;
    const recordJson = resolution ? await requestProviderAccountUsageJson(credentials, `/v4/connect/qualified/provider-account-usage/record?recordId=${encodeURIComponent(resolution.recordId)}`, options) : null;
    const enteredMonthlyPrice = recordJson !== null ? await options.readEnteredMonthlyPrice?.() : undefined;
    options.assertCurrent?.();
    const current = resolution && recordJson !== null ? openProviderAccountUsageRecordV4({ recordId: resolution.recordId, enteredMonthlyPrice, accountMode: options.accountMode, material, record: QualifiedProviderAccountUsageRecordResponseV4Schema.parse(recordJson) }) : null;
    if (current && resolution && current.recordKey.accountSubjectId !== resolution.providerAccountId) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
    const page = request.history && resolution ? await requestProviderAccountUsageHistoryPage(credentials, { recordId: resolution.recordId, history: request.history }, options) : null;
    if (request.history && resolution && !page) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
    const { nowMs, waitingWork } = await readProviderAccountUsageWaitingWork(credentials, request, current, options);
    return projectProviderAccountUsageQuotaReadV1({ input: request, current, ...(request.history ? { history: page && resolution ? openProviderAccountUsageHistoryPageV4({ recordId: resolution.recordId, accountMode: options.accountMode, material, page }) : { entries: [], nextCursor: null } } : {}), nowMs, targets: options.targets, waitingWork });
}

async function readProviderAccountUsageWaitingWork(credentials: AuthCredentials, input: ConnectedServiceQuotaGetInputV1, current: ProviderAccountUsageSnapshotV1 | null, options: ProviderAccountUsageQuotaReadOptions): Promise<{ nowMs: number; waitingWork: ProviderAccountUsageWaitingWorkV1 }> {
    const finish = (waitingWork: ProviderAccountUsageWaitingWorkV1, nowMs = options.nowMs ?? Date.now()) => ({ nowMs, waitingWork });
    const body = PendingResetStartsReadInputV1Schema.parse({ source: input.source });
    options.assertCurrent?.();
    let response: Response;
    try {
        response = await (options.request ?? serverFetch)('/v2/pending/reset-starts/read', { method: 'POST', signal: options.signal, headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { includeAuth: false, ...(options.expectedActiveServer ? { expectedActiveServer: options.expectedActiveServer } : {}) });
    } catch (error) {
        if (options.signal?.aborted) throw error;
        options.assertCurrent?.();
        return finish({ status: 'unavailable', reason: 'read_failed' });
    }
    options.assertCurrent?.();
    if (response.status === 404 || response.status === 405) return finish({ status: 'unavailable', reason: 'unsupported' });
    if (response.status === 401 || response.status === 403) return finish({ status: 'unavailable', reason: 'authority_unavailable' });
    if (!response.ok) return finish({ status: 'unavailable', reason: 'read_failed' });
    let raw: unknown;
    try { raw = await response.json(); } catch (error) {
        if (options.signal?.aborted) throw error;
        options.assertCurrent?.();
        return finish({ status: 'unavailable', reason: 'read_failed' });
    }
    options.assertCurrent?.();
    const parsed = PendingResetStartsReadResultV1Schema.safeParse(raw);
    if (!parsed.success) return finish({ status: 'unavailable', reason: 'read_failed' });
    const witnessedEntries = await Promise.all(parsed.data.entries.map(async entry => {
        const witness = entry.authorityCurrent ? await getProviderAccountUsageHistoryWitness(credentials, { recordId: entry.reset.recordId, witness: entry.reset.witness }, options) : null;
        return { entry, witness };
    }));
    options.assertCurrent?.();
    // Freshness is evaluated after the last awaited read, at one shared instant
    // for waiting work and pace. Explicit caller as-of time stays deterministic.
    const nowMs = options.nowMs ?? Date.now();
    const entries = witnessedEntries.map(({ entry, witness }) => ({
        sessionId: entry.sessionId, localId: entry.localId,
        recordId: entry.reset.recordId, meterId: entry.reset.meterId,
        readiness: evaluatePendingResetStartReadinessV1({ reset: entry.reset, witness, current, nowMs, authorityCurrent: entry.authorityCurrent }),
    }));
    return finish({ status: 'available', entries }, nowMs);
}

async function requestProviderAccountUsageJson(credentials: AuthCredentials, path: string, options: ProviderAccountUsageQuotaReadOptions): Promise<unknown | null> {
    options.assertCurrent?.();
    const response = await (options.request ?? serverFetch)(path, { method: 'GET', signal: options.signal, headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' } }, { includeAuth: false, ...(options.expectedActiveServer ? { expectedActiveServer: options.expectedActiveServer } : {}) });
    options.assertCurrent?.();
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
        throw new HappyError('Provider account usage authority refused', false,
            { status: response.status, kind: 'auth', code: 'denied' });
    }
    const json: unknown = await response.json();
    options.assertCurrent?.();
    if (response.status === 409 && QualifiedProviderAccountUsageReadErrorV4Schema.safeParse(json).success) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_mode_mismatch');
    if (!response.ok) throw new HappyError(extractErrorCode(json) ?? 'Provider account usage read failed', false, { status: response.status, kind: 'server' });
    return json;
}

async function requestProviderAccountUsageHistoryPage(credentials: AuthCredentials, query: ReturnType<typeof QualifiedProviderAccountUsageHistoryRequestV4Schema.parse>, options: ProviderAccountUsageQuotaReadOptions) {
    const json = await requestProviderAccountUsageJson(credentials, `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({ query: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema, query) }).toString()}`, options);
    return json === null ? null : QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(json);
}

export async function getProviderAccountUsageHistoryWitness(credentials: AuthCredentials, input: Readonly<{ recordId: ProviderAccountUsageRecordId; witness: ProviderAccountUsageHistoryWitnessV1 }>, options: ProviderAccountUsageQuotaReadOptions) {
    const page = await requestProviderAccountUsageHistoryPage(credentials, input, options);
    if (!page) return null;
    const opened = openProviderAccountUsageHistoryPageV4({ recordId: input.recordId, accountMode: options.accountMode, material: options.accountMode === 'e2ee' ? options.material ?? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : undefined, page });
    const entry = opened.entries.find(entry => entry.id === input.witness.id && entry.observedAtMs === input.witness.observedAtMs);
    if (!entry && opened.entries.length) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
    return entry?.snapshot ?? null;
}

function extractErrorCode(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null;
    const obj = json as Record<string, unknown>;
    return typeof obj.error === 'string' ? obj.error : null;
}

type QualifiedProviderAccountUsageRecordResponse = z.infer<
    typeof QualifiedProviderAccountUsageRecordResponseV4Schema
>;
type EncryptedQualifiedProviderAccountUsageRecordResponse =
    QualifiedProviderAccountUsageRecordResponse & Readonly<{
        content: Extract<
            QualifiedProviderAccountUsageRecordResponse['content'],
            Readonly<{ t: 'encrypted' }>
        >;
    }>;

function hasEncryptedProviderAccountUsageContent(
    response: QualifiedProviderAccountUsageRecordResponse,
): response is EncryptedQualifiedProviderAccountUsageRecordResponse {
    return response.content.t === 'encrypted';
}

function parseRecordId(recordId: ProviderAccountUsageRecordId): ProviderAccountUsageRecordId {
    return ProviderAccountUsageRecordIdSchema.parse(recordId);
}

function parseQualifiedProviderAccountUsageRecordResponse(
    json: unknown,
    recordId: ProviderAccountUsageRecordId,
): QualifiedProviderAccountUsageRecordResponse {
    const parsed = QualifiedProviderAccountUsageRecordResponseV4Schema.safeParse(json);
    if (!parsed.success) {
        throw new Error(`Invalid provider account usage response for ${recordId}`);
    }
    return parsed.data;
}

function rejectContentModeMismatch(
    recordId: ProviderAccountUsageRecordId,
    status?: number,
): never {
    throw new HappyError(
        `Provider account usage content does not match the Account encryption mode for ${recordId}`,
        false,
        {
            kind: 'server',
            code: 'provider_account_usage_content_mode_mismatch',
            ...(status === undefined ? {} : { status }),
        },
    );
}

async function rejectQualifiedProviderAccountUsageReadFailure(
    response: Response,
    recordId: ProviderAccountUsageRecordId,
    fallbackMessage: string,
): Promise<never> {
    let json: unknown = null;
    try {
        json = await response.json();
    } catch {
        // The generic HTTP failure below remains the boundary for malformed
        // or unrelated error responses.
    }
    if (
        response.status === 409
        && QualifiedProviderAccountUsageReadErrorV4Schema.safeParse(json).success
    ) {
        return rejectContentModeMismatch(recordId, response.status);
    }
    throw new HappyError(
        extractErrorCode(json) ?? fallbackMessage,
        false,
        { status: response.status, kind: 'server' },
    );
}

export async function getProviderAccountUsageSnapshotPlain(
    credentials: AuthCredentials,
    params: Readonly<{ recordId: ProviderAccountUsageRecordId }>,
    opts?: Readonly<{
        signal?: AbortSignal;
        expectedActiveServer?: ExpectedActiveServerFetchBasis;
    }>,
): Promise<ProviderAccountUsageSnapshotV1 | null> {
    const recordId = parseRecordId(params.recordId);
    const request = createServerFetchForActiveServer(opts?.expectedActiveServer);
    return await backoff(async () => {
        const response = await request(
            `/v4/connect/qualified/provider-account-usage/record?recordId=${encodeURIComponent(recordId)}`,
            {
                method: 'GET',
                signal: opts?.signal,
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
            },
            {
                includeAuth: false,
                ...(opts?.expectedActiveServer
                    ? {
                        expectedActiveServer:
                            opts.expectedActiveServer,
                    }
                    : {}),
            },
        );

        if (response.status === 404) return null;

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                return await rejectQualifiedProviderAccountUsageReadFailure(
                    response,
                    recordId,
                    `Failed to load provider account usage for ${recordId}`,
                );
            }
            throw new Error(`Failed to load provider account usage for ${recordId}: ${response.status}`);
        }

        const parsed = parseQualifiedProviderAccountUsageRecordResponse(await response.json(), recordId);
        if (parsed.content.t !== 'plain') {
            return rejectContentModeMismatch(recordId);
        }

        const snapshot = ProviderAccountUsageSnapshotV1Schema.safeParse(parsed.content.v);
        if (!snapshot.success || snapshot.data.recordId !== recordId) {
            throw new Error(`Invalid provider account usage response for ${recordId}`);
        }
        return snapshot.data;
    });
}

export async function getProviderAccountUsageSnapshotSealed(
    credentials: AuthCredentials,
    params: Readonly<{ recordId: ProviderAccountUsageRecordId }>,
    opts?: Readonly<{
        signal?: AbortSignal;
        expectedActiveServer?: ExpectedActiveServerFetchBasis;
    }>,
): Promise<EncryptedQualifiedProviderAccountUsageRecordResponse | null> {
    const recordId = parseRecordId(params.recordId);
    const request = createServerFetchForActiveServer(opts?.expectedActiveServer);
    return await backoff(async () => {
        const response = await request(
            `/v4/connect/qualified/provider-account-usage/record?recordId=${encodeURIComponent(recordId)}`,
            {
                method: 'GET',
                signal: opts?.signal,
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
            },
            {
                includeAuth: false,
                ...(opts?.expectedActiveServer
                    ? {
                        expectedActiveServer:
                            opts.expectedActiveServer,
                    }
                    : {}),
            },
        );

        if (response.status === 404) return null;

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                return await rejectQualifiedProviderAccountUsageReadFailure(
                    response,
                    recordId,
                    `Failed to load sealed provider account usage for ${recordId}`,
                );
            }
            throw new Error(`Failed to load sealed provider account usage for ${recordId}: ${response.status}`);
        }

        const parsed = parseQualifiedProviderAccountUsageRecordResponse(await response.json(), recordId);
        if (!hasEncryptedProviderAccountUsageContent(parsed)) {
            return rejectContentModeMismatch(recordId);
        }
        return parsed;
    });
}

export async function requestProviderAccountUsageSnapshotRefresh(
    credentials: AuthCredentials,
    params: Readonly<{ recordId: ProviderAccountUsageRecordId }>,
    opts?: Readonly<{
        expectedActiveServer?: ExpectedActiveServerFetchBasis;
    }>,
): Promise<boolean> {
    const recordId = parseRecordId(params.recordId);
    const request = createServerFetchForActiveServer(opts?.expectedActiveServer);
    return await backoff(async () => {
        const response = await request(
            '/v4/connect/qualified/provider-account-usage/record/refresh',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ recordId }),
            },
            {
                includeAuth: false,
                ...(opts?.expectedActiveServer
                    ? {
                        expectedActiveServer:
                            opts?.expectedActiveServer,
                    }
                    : {}),
            },
        );

        if (response.status === 404) return false;
        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = `Failed to request provider account usage refresh for ${recordId}`;
                try {
                    const json = await response.json();
                    message = extractErrorCode(json) ?? message;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: response.status, kind: 'server' });
            }
            throw new Error(`Failed to request provider account usage refresh for ${recordId}: ${response.status}`);
        }

        return true;
    });
}

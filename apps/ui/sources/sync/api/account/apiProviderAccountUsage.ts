import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    serverFetch,
    type ExpectedActiveServerFetchBasis,
} from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';

import {
    ProviderAccountUsageRecordIdSchema,
    ProviderAccountUsageSnapshotV1Schema,
    QualifiedProviderAccountUsageRecordResponseV4Schema,
    type ProviderAccountUsageRecordId,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

function extractErrorCode(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null;
    const obj = json as Record<string, unknown>;
    return typeof obj.error === 'string' ? obj.error : null;
}

type QualifiedProviderAccountUsageRecordResponse = z.infer<
    typeof QualifiedProviderAccountUsageRecordResponseV4Schema
>;
type EncryptedQualifiedProviderAccountUsageRecordResponse = Extract<
    QualifiedProviderAccountUsageRecordResponse,
    Readonly<{ content: Readonly<{ t: 'encrypted'; c: string }> }>
>;

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
): never {
    throw new HappyError(
        `Provider account usage content does not match the Account encryption mode for ${recordId}`,
        false,
        {
            kind: 'server',
            code: 'provider_account_usage_content_mode_mismatch',
        },
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
    return await backoff(async () => {
        const response = await serverFetch(
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
                let message = `Failed to load provider account usage for ${recordId}`;
                try {
                    const json = await response.json();
                    message = extractErrorCode(json) ?? message;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: response.status, kind: 'server' });
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
    return await backoff(async () => {
        const response = await serverFetch(
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
                let message = `Failed to load sealed provider account usage for ${recordId}`;
                try {
                    const json = await response.json();
                    message = extractErrorCode(json) ?? message;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: response.status, kind: 'server' });
            }
            throw new Error(`Failed to load sealed provider account usage for ${recordId}: ${response.status}`);
        }

        const parsed = parseQualifiedProviderAccountUsageRecordResponse(await response.json(), recordId);
        if (parsed.content.t !== 'encrypted') {
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
    return await backoff(async () => {
        const response = await serverFetch(
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

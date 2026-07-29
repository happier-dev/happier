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
    SealedProviderAccountUsageSnapshotV1Schema,
    StoredJsonContentEnvelopeSchema,
    type ProviderAccountUsageRecordId,
    type ProviderAccountUsageSnapshotV1,
    type SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

function extractErrorCode(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null;
    const obj = json as Record<string, unknown>;
    return typeof obj.error === 'string' ? obj.error : null;
}

const ProviderAccountUsageMetadataSchema = z.object({
    fetchedAt: z.number().int().nonnegative(),
    staleAfterMs: z.number().int().nonnegative(),
    status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
    refreshRequestedAt: z.number().int().nonnegative().optional(),
});

const ProviderAccountUsagePlainResponseSchema = z.object({
    content: StoredJsonContentEnvelopeSchema,
    metadata: ProviderAccountUsageMetadataSchema,
});

const ProviderAccountUsageSealedResponseSchema = z.object({
    sealed: SealedProviderAccountUsageSnapshotV1Schema,
    metadata: ProviderAccountUsageMetadataSchema,
});

function parseRecordId(recordId: ProviderAccountUsageRecordId): ProviderAccountUsageRecordId {
    return ProviderAccountUsageRecordIdSchema.parse(recordId);
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
            `/v3/connect/provider-account-usage/${encodeURIComponent(recordId)}`,
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

        const json: unknown = await response.json();
        const parsed = ProviderAccountUsagePlainResponseSchema.safeParse(json);
        if (!parsed.success) {
            throw new Error(`Invalid provider account usage response for ${recordId}`);
        }
        if (parsed.data.content.t !== 'plain') return null;

        const snapshot = ProviderAccountUsageSnapshotV1Schema.safeParse(parsed.data.content.v);
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
): Promise<Readonly<{
    sealed: SealedProviderAccountUsageSnapshotV1;
    metadata: z.infer<typeof ProviderAccountUsageMetadataSchema>;
}> | null> {
    const recordId = parseRecordId(params.recordId);
    return await backoff(async () => {
        const response = await serverFetch(
            `/v2/connect/provider-account-usage/${encodeURIComponent(recordId)}`,
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

        const json: unknown = await response.json();
        const parsed = ProviderAccountUsageSealedResponseSchema.safeParse(json);
        if (!parsed.success) {
            throw new Error(`Invalid sealed provider account usage response for ${recordId}`);
        }
        return parsed.data;
    });
}

export async function requestProviderAccountUsageSnapshotRefresh(
    credentials: AuthCredentials,
    params: Readonly<{ recordId: ProviderAccountUsageRecordId }>,
    opts: Readonly<{
        mode: 'plain' | 'e2ee';
        expectedActiveServer?: ExpectedActiveServerFetchBasis;
    }>,
): Promise<boolean> {
    const recordId = parseRecordId(params.recordId);
    const routeVersion = opts.mode === 'plain' ? 'v3' : 'v2';
    return await backoff(async () => {
        const response = await serverFetch(
            `/${routeVersion}/connect/provider-account-usage/${encodeURIComponent(recordId)}/refresh`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({}),
            },
            {
                includeAuth: false,
                ...(opts.expectedActiveServer
                    ? {
                        expectedActiveServer:
                            opts.expectedActiveServer,
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

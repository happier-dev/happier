import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type {
    DaemonLocalServicePublicPreviewCopyUrlRequestV1,
    DaemonLocalServicePublicPreviewCopyUrlResponseV1,
    DaemonLocalServicePublicPreviewCreateRequestV1,
    DaemonLocalServicePublicPreviewCreateResponseV1,
    DaemonLocalServicePublicPreviewRevokeRequestV1,
    DaemonLocalServicePublicPreviewRevokeResponseV1,
    DaemonLocalServicePublicPreviewStatusRequestV1,
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';
import {
    DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema,
    DaemonLocalServicePublicPreviewCreateResponseV1Schema,
    DaemonLocalServicePublicPreviewRevokeResponseV1Schema,
    DaemonLocalServicePublicPreviewStatusResponseV1Schema,
    LocalServicePublicExposureV1Schema,
} from '@happier-dev/protocol';
import axios from 'axios';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export type LocalServicePublicPreviewRoutes = Readonly<{
    getStatus(request: DaemonLocalServicePublicPreviewStatusRequestV1): Promise<LocalServicePublicPreviewSnapshotV1>;
    createExposure(
        request: DaemonLocalServicePublicPreviewCreateRequestV1,
    ): Promise<DaemonLocalServicePublicPreviewCreateResponseV1>;
    revokeExposure(
        request: DaemonLocalServicePublicPreviewRevokeRequestV1,
    ): Promise<DaemonLocalServicePublicPreviewRevokeResponseV1>;
    copyUrl(
        request: DaemonLocalServicePublicPreviewCopyUrlRequestV1,
    ): Promise<DaemonLocalServicePublicPreviewCopyUrlResponseV1>;
}>;

type PublicPreviewHttpTransport = Readonly<{
    post(url: string, body: unknown, options: Readonly<{ headers: Readonly<Record<string, string>> }>): Promise<Readonly<{ data: unknown }>>;
    delete(
        url: string,
        options: Readonly<{
            headers: Readonly<Record<string, string>>;
            data?: unknown;
        }>,
    ): Promise<Readonly<{ data: unknown }>>;
}>;

export type CreateLocalServicePublicPreviewServerRoutesInput = Readonly<{
    token: string;
    serverBaseUrl?: string;
    http?: PublicPreviewHttpTransport;
}>;

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/u, '');
}

function endpoint(baseUrl: string, path: string): string {
    return `${trimTrailingSlash(baseUrl)}${path}`;
}

function authHeaders(token: string): Readonly<Record<string, string>> {
    return {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${token}`,
    };
}

function findBoundExposure(
    snapshot: LocalServicePublicPreviewSnapshotV1,
    request: Readonly<{
        machineId: string;
        sessionId: string;
        previewId: string;
        exposureId: string;
    }>,
): LocalServicePublicExposureV1 | null {
    return snapshot.exposures.find((candidate) => (
        candidate.machineId === request.machineId
        && candidate.sessionId === request.sessionId
        && candidate.previewId === request.previewId
        && candidate.exposureId === request.exposureId
    )) ?? null;
}

function snapshotMatchesStatusRequest(
    snapshot: LocalServicePublicPreviewSnapshotV1,
    request: DaemonLocalServicePublicPreviewStatusRequestV1,
): boolean {
    return snapshot.machineId === request.machineId
        && (!request.sessionId || snapshot.sessionId === request.sessionId)
        && (!request.previewId || snapshot.previewId === request.previewId)
        && (!request.exposureId || snapshot.exposures.every((exposure) => exposure.exposureId === request.exposureId));
}

function assertExposureBinding(
    exposure: LocalServicePublicExposureV1,
    request: Readonly<{
        machineId: string;
        sessionId: string;
        previewId: string;
    }>,
): void {
    if (
        exposure.machineId !== request.machineId
        || exposure.sessionId !== request.sessionId
        || exposure.previewId !== request.previewId
    ) {
        throw new Error('local_services_public_preview_binding_mismatch');
    }
}

function assertStatusSnapshotBinding(
    snapshot: LocalServicePublicPreviewSnapshotV1,
    request: DaemonLocalServicePublicPreviewStatusRequestV1,
): void {
    if (!snapshotMatchesStatusRequest(snapshot, request)) {
        throw new Error('local_services_public_preview_status_binding_mismatch');
    }
}

function isExposureSafeToCopy(
    snapshot: LocalServicePublicPreviewSnapshotV1,
    exposure: LocalServicePublicExposureV1,
): boolean {
    return snapshot.refreshState === 'idle'
        && exposure.state === 'active'
        && exposure.expiresAt > snapshot.generatedAt;
}

export function createLocalServicePublicPreviewServerRoutes(
    input: CreateLocalServicePublicPreviewServerRoutesInput,
): LocalServicePublicPreviewRoutes {
    const http = input.http ?? axios;
    const headers = authHeaders(input.token);
    const resolveBaseUrl = () => input.serverBaseUrl ?? resolveServerHttpBaseUrl();

    async function getStatus(
        request: DaemonLocalServicePublicPreviewStatusRequestV1,
    ): Promise<LocalServicePublicPreviewSnapshotV1> {
        const response = await http.post(
            endpoint(resolveBaseUrl(), '/v1/local-services/public/status'),
            request,
            { headers },
        );
        const snapshot = DaemonLocalServicePublicPreviewStatusResponseV1Schema.parse(response.data).snapshot;
        assertStatusSnapshotBinding(snapshot, request);
        return snapshot;
    }

    return {
        getStatus,
        async createExposure(request) {
            const response = await http.post(
                endpoint(resolveBaseUrl(), '/v1/local-services/public'),
                {
                    machineId: request.machineId,
                    sessionId: request.sessionId,
                    previewId: request.previewId,
                    mode: request.mode,
                    ttlMs: request.ttlMs,
                    ...(request.rateLimitProfileId ? { rateLimitProfileId: request.rateLimitProfileId } : {}),
                    ...(request.confirmation ? { confirmation: request.confirmation } : {}),
                },
                { headers },
            );
            const rawExposure = typeof response.data === 'object' && response.data !== null
                ? (response.data as { exposure?: unknown }).exposure
                : undefined;
            const exposure = LocalServicePublicExposureV1Schema.parse(rawExposure);
            assertExposureBinding(exposure, request);
            const snapshot = await getStatus({
                machineId: request.machineId,
                sessionId: request.sessionId,
                previewId: request.previewId,
            });
            return DaemonLocalServicePublicPreviewCreateResponseV1Schema.parse({
                protocolVersion: 1,
                exposure,
                snapshot,
            });
        },
        async revokeExposure(request) {
            await http.delete(
                endpoint(resolveBaseUrl(), `/v1/local-services/public/${encodeURIComponent(request.exposureId)}`),
                {
                    headers,
                    data: {
                        machineId: request.machineId,
                        sessionId: request.sessionId,
                        previewId: request.previewId,
                        exposureId: request.exposureId,
                    },
                },
            );
            const snapshot = await getStatus({
                machineId: request.machineId,
                sessionId: request.sessionId,
                previewId: request.previewId,
                exposureId: request.exposureId,
            });
            const exposure = findBoundExposure(snapshot, request);
            if (!exposure || exposure.state !== 'revoked' || typeof exposure.revokedAt !== 'number') {
                throw new Error('local_services_public_preview_revoke_not_confirmed');
            }
            return DaemonLocalServicePublicPreviewRevokeResponseV1Schema.parse({
                protocolVersion: 1,
                exposureId: request.exposureId,
                revokedAt: exposure.revokedAt,
                snapshot,
            });
        },
        async copyUrl(request) {
            const snapshot = await getStatus({
                machineId: request.machineId,
                sessionId: request.sessionId,
                previewId: request.previewId,
                exposureId: request.exposureId,
            });
            const exposure = findBoundExposure(snapshot, request);
            if (!exposure || !isExposureSafeToCopy(snapshot, exposure)) {
                throw new Error('local_services_public_preview_exposure_unavailable');
            }
            return DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema.parse({
                protocolVersion: 1,
                machineId: request.machineId,
                sessionId: request.sessionId,
                previewId: request.previewId,
                exposureId: request.exposureId,
                publicUrl: exposure.publicUrl,
            });
        },
    };
}

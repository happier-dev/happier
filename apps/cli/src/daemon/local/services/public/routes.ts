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
import { DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema, DaemonLocalServicePublicPreviewCreateResponseV1Schema, DaemonLocalServicePublicPreviewRevokeResponseV1Schema, DaemonLocalServicePublicPreviewStatusResponseV1Schema, LocalServicePublicExposureV1Schema } from '@happier-dev/protocol/local/services/public/v1';
import axios from 'axios';
import { isDeepStrictEqual } from 'node:util';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { assertLocalServiceCredentialAdmission } from '../credentialAdmission';

export type LocalServicePublicPreviewRoutes = Readonly<{
    getStatus(request: DaemonLocalServicePublicPreviewStatusRequestV1, context?: RpcHandlerContext): Promise<LocalServicePublicPreviewSnapshotV1>;
    createExposure(
        request: DaemonLocalServicePublicPreviewCreateRequestV1,
        context?: RpcHandlerContext,
    ): Promise<DaemonLocalServicePublicPreviewCreateResponseV1>;
    revokeExposure(
        request: DaemonLocalServicePublicPreviewRevokeRequestV1,
        context?: RpcHandlerContext,
    ): Promise<DaemonLocalServicePublicPreviewRevokeResponseV1>;
    copyUrl(
        request: DaemonLocalServicePublicPreviewCopyUrlRequestV1,
        context?: RpcHandlerContext,
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
    /** Account owning the same bound HTTP credential; never derived from caller input. */
    accountId?: string;
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
    request: DaemonLocalServicePublicPreviewCopyUrlRequestV1,
): LocalServicePublicExposureV1 | null {
    return snapshot.exposures.find((candidate) => (
        candidate.machineId === request.machineId
        && candidate.sessionId === request.sessionId
        && candidate.previewId === request.previewId
        && candidate.exposureId === request.exposureId
        && isDeepStrictEqual(candidate.serviceTarget, request.serviceTarget)
    )) ?? null;
}

function snapshotMatchesStatusRequest(
    snapshot: LocalServicePublicPreviewSnapshotV1,
    request: DaemonLocalServicePublicPreviewStatusRequestV1,
): boolean {
    return snapshot.machineId === request.machineId
        && (!request.sessionId || snapshot.sessionId === request.sessionId)
        && (!request.previewId || snapshot.previewId === request.previewId)
        && (!request.exposureId || snapshot.exposures.every((exposure) => exposure.exposureId === request.exposureId))
        && (!request.serviceTarget || !snapshot.sessionId && snapshot.exposures.every((exposure) =>
            isDeepStrictEqual(exposure.serviceTarget, request.serviceTarget)));
}

function assertExposureBinding(
    exposure: LocalServicePublicExposureV1,
    request: DaemonLocalServicePublicPreviewCreateRequestV1,
): void {
    if (
        exposure.machineId !== request.machineId
        || exposure.sessionId !== request.sessionId
        || exposure.previewId !== request.previewId
        || !isDeepStrictEqual(exposure.serviceTarget, request.serviceTarget)
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
    const assertCredentialAdmission = (machineId: string, context?: RpcHandlerContext) =>
        assertLocalServiceCredentialAdmission({ accountId: input.accountId, machineId, context });

    async function getStatus(
        request: DaemonLocalServicePublicPreviewStatusRequestV1,
        context?: RpcHandlerContext,
    ): Promise<LocalServicePublicPreviewSnapshotV1> {
        await assertCredentialAdmission(request.machineId, context);
        const response = await http.post(
            endpoint(resolveBaseUrl(), '/v1/local-services/public/status'),
            request,
            { headers },
        );
        const snapshot = DaemonLocalServicePublicPreviewStatusResponseV1Schema.parse(response.data).snapshot;
        await assertCredentialAdmission(request.machineId, context);
        assertStatusSnapshotBinding(snapshot, request);
        return snapshot;
    }

    return {
        getStatus,
        async createExposure(request, context) {
            await assertCredentialAdmission(request.machineId, context);
            const response = await http.post(
                endpoint(resolveBaseUrl(), '/v1/local-services/public'),
                {
                    machineId: request.machineId,
                    sessionId: request.sessionId,
                    ...(request.serviceTarget ? { serviceTarget: request.serviceTarget } : {}),
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
                ...(request.serviceTarget ? { serviceTarget: request.serviceTarget } : {}),
                previewId: request.previewId,
            }, context);
            return DaemonLocalServicePublicPreviewCreateResponseV1Schema.parse({
                protocolVersion: 1,
                exposure,
                snapshot,
            });
        },
        async revokeExposure(request, context) {
            await assertCredentialAdmission(request.machineId, context);
            await http.delete(
                endpoint(resolveBaseUrl(), `/v1/local-services/public/${encodeURIComponent(request.exposureId)}`),
                {
                    headers,
                    data: {
                        machineId: request.machineId,
                        sessionId: request.sessionId,
                        ...(request.serviceTarget ? { serviceTarget: request.serviceTarget } : {}),
                        previewId: request.previewId,
                        exposureId: request.exposureId,
                    },
                },
            );
            const snapshot = await getStatus({
                machineId: request.machineId,
                sessionId: request.sessionId,
                ...(request.serviceTarget ? { serviceTarget: request.serviceTarget } : {}),
                previewId: request.previewId,
                exposureId: request.exposureId,
            }, context);
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
        async copyUrl(request, context) {
            const snapshot = await getStatus({
                machineId: request.machineId,
                sessionId: request.sessionId,
                ...(request.serviceTarget ? { serviceTarget: request.serviceTarget } : {}),
                previewId: request.previewId,
                exposureId: request.exposureId,
            }, context);
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
                ...(exposure.serviceTarget ? { serviceTarget: exposure.serviceTarget } : {}),
            });
        },
    };
}

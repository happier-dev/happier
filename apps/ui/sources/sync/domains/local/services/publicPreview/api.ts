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

export type LocalServicePublicPreviewFailureReason =
    | 'unavailable'
    | 'request_failed'
    | 'invalid_response';

export type LocalServicePublicPreviewStatusClientInput = Readonly<{
    request: DaemonLocalServicePublicPreviewStatusRequestV1;
    serverId?: string | null;
    signal?: AbortSignal;
}>;

export type LocalServicePublicPreviewCreateClientInput = Readonly<{
    request: DaemonLocalServicePublicPreviewCreateRequestV1;
    serverId?: string | null;
    signal?: AbortSignal;
}>;

export type LocalServicePublicPreviewRevokeClientInput = Readonly<{
    request: DaemonLocalServicePublicPreviewRevokeRequestV1;
    serverId?: string | null;
    signal?: AbortSignal;
}>;

export type LocalServicePublicPreviewCopyUrlClientInput = Readonly<{
    request: DaemonLocalServicePublicPreviewCopyUrlRequestV1;
    serverId?: string | null;
    signal?: AbortSignal;
}>;

export type LocalServicePublicPreviewStatusClientResult =
    | Readonly<{ ok: true; snapshot: LocalServicePublicPreviewSnapshotV1 }>
    | Readonly<{ ok: false; reason: LocalServicePublicPreviewFailureReason }>;

export type LocalServicePublicPreviewCreateClientResult =
    | Readonly<{ ok: true; response: DaemonLocalServicePublicPreviewCreateResponseV1 }>
    | Readonly<{ ok: false; reason: LocalServicePublicPreviewFailureReason }>;

export type LocalServicePublicPreviewRevokeClientResult =
    | Readonly<{ ok: true; response: DaemonLocalServicePublicPreviewRevokeResponseV1 }>
    | Readonly<{ ok: false; reason: LocalServicePublicPreviewFailureReason }>;

export type LocalServicePublicPreviewCopyUrlClientResult =
    | Readonly<{ ok: true; response: DaemonLocalServicePublicPreviewCopyUrlResponseV1 }>
    | Readonly<{ ok: false; reason: LocalServicePublicPreviewFailureReason }>;

function exposureMatchesRequest(
    exposure: LocalServicePublicExposureV1,
    request: Readonly<{
        machineId: string;
        sessionId: string;
        previewId: string;
        exposureId?: string;
    }>,
): boolean {
    return exposure.machineId === request.machineId
        && exposure.sessionId === request.sessionId
        && exposure.previewId === request.previewId
        && (!request.exposureId || exposure.exposureId === request.exposureId);
}

function snapshotMatchesRequest(
    snapshot: LocalServicePublicPreviewSnapshotV1,
    request: DaemonLocalServicePublicPreviewStatusRequestV1,
): boolean {
    return snapshot.machineId === request.machineId
        && (!request.sessionId || snapshot.sessionId === request.sessionId)
        && (!request.previewId || snapshot.previewId === request.previewId)
        && (!request.exposureId || snapshot.exposures.every((exposure) => exposure.exposureId === request.exposureId));
}

export function isPublicPreviewSnapshotForRequest(
    snapshot: LocalServicePublicPreviewSnapshotV1,
    request: DaemonLocalServicePublicPreviewStatusRequestV1,
): boolean {
    return snapshotMatchesRequest(snapshot, request);
}

export function isPublicPreviewCreateResponseForRequest(
    response: DaemonLocalServicePublicPreviewCreateResponseV1,
    request: DaemonLocalServicePublicPreviewCreateRequestV1,
): boolean {
    return exposureMatchesRequest(response.exposure, request)
        && (!response.snapshot || snapshotMatchesRequest(response.snapshot, request));
}

export function isPublicPreviewRevokeResponseForRequest(
    response: DaemonLocalServicePublicPreviewRevokeResponseV1,
    request: DaemonLocalServicePublicPreviewRevokeRequestV1,
): boolean {
    return response.exposureId === request.exposureId
        && snapshotMatchesRequest(response.snapshot, request);
}

export function isPublicPreviewCopyUrlResponseForRequest(
    response: DaemonLocalServicePublicPreviewCopyUrlResponseV1,
    request: DaemonLocalServicePublicPreviewCopyUrlRequestV1,
): boolean {
    return response.machineId === request.machineId
        && response.sessionId === request.sessionId
        && response.previewId === request.previewId
        && response.exposureId === request.exposureId;
}

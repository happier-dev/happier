import { isDeepStrictEqual } from 'node:util';
import type { DaemonLocalServicePublicPreviewStatusRequestV1, LocalServicePublicPreviewSnapshotV1 } from '@happier-dev/protocol/local/services/public/v1';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { resolveMachineAdmission } from '@/app/machines/machineAccess';

type StatusResult = Readonly<{ ok: true; snapshot: LocalServicePublicPreviewSnapshotV1 }> | Readonly<{
    ok: false; statusCode: 403 | 404; error: string; reasonCode: string;
}>;

/** Status selection never grants access to the selected Machine, Session or service. */
export async function readLocalServicePublicStatus(input: Readonly<{
    request: DaemonLocalServicePublicPreviewStatusRequestV1;
    userId: string | undefined;
    getStatus: (request: DaemonLocalServicePublicPreviewStatusRequestV1) => LocalServicePublicPreviewSnapshotV1;
    resolvePreview: (previewId: string) => LocalServicePreviewResourceV1 | null | undefined;
    authorizePreview: (preview: LocalServicePreviewResourceV1) => Promise<boolean>;
    authorizeSession: (sessionId: string) => Promise<boolean>;
    /** The exposure owner's answer: is the caller this Service link's creator or Service owner. */
    isServiceLinkPerson: (exposureId: string) => boolean;
}>): Promise<StatusResult> {
    const { request } = input;
    const denied = (reasonCode: string): StatusResult => ({ ok: false, statusCode: 403, error: 'public_preview_denied', reasonCode });
    // A stopped or ended Service's links stay visible only to their own people.
    const ownLinks = (refusal: StatusResult): StatusResult => {
        const snapshot = input.getStatus(request);
        const exposures = snapshot.exposures.filter(exposure => input.isServiceLinkPerson(exposure.exposureId));
        return exposures.length > 0 ? { ok: true, snapshot: scopeSnapshot(snapshot, exposures) } : refusal;
    };
    let scopedPreview: LocalServicePreviewResourceV1 | null = null;
    if (request.previewId) {
        const preview = input.resolvePreview(request.previewId);
        if (!preview) return ownLinks({ ok: false, statusCode: 404, error: 'preview_not_found', reasonCode: 'preview_not_found' });
        if (preview.machineId !== request.machineId || preview.sessionId !== request.sessionId
            || request.serviceTarget && !isDeepStrictEqual(preview.serviceTarget, request.serviceTarget)) {
            return denied('preview_binding_mismatch');
        }
        scopedPreview = preview;
    }

    if (scopedPreview) {
        return await input.authorizePreview(scopedPreview) ? { ok: true, snapshot: input.getStatus(request) }
            : scopedPreview.serviceTarget ? ownLinks(denied('session_not_authorized')) : denied('session_not_authorized');
    }
    if (request.sessionId) {
        return await input.authorizeSession(request.sessionId) ? { ok: true, snapshot: input.getStatus(request) } : denied('session_not_authorized');
    }

    if (!input.userId) return denied('machine_not_authorized');
    const admission = await resolveMachineAdmission({ actorAccountId: input.userId, machineId: request.machineId,
        rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS });
    if (admission.kind !== 'admitted') return denied('machine_not_authorized');

    const snapshot = input.getStatus(request);
    const previewAuthorizations = new Map<string, Promise<boolean>>();
    const sessionAuthorizations = new Map<string, Promise<boolean>>();
    // Machine custody does not confer Session access or another starter's current service binding.
    const authorized = await Promise.all(snapshot.exposures.map(async exposure => {
        if (exposure.serviceTarget) {
            const preview = input.resolvePreview(exposure.previewId);
            if (!preview || preview.machineId !== exposure.machineId || preview.sessionId !== exposure.sessionId
                || !isDeepStrictEqual(preview.serviceTarget, exposure.serviceTarget)) return input.isServiceLinkPerson(exposure.exposureId);
            // Share admission only after each link matches its current canonical preview binding.
            let authorization = previewAuthorizations.get(preview.previewId);
            if (!authorization) {
                authorization = input.authorizePreview(preview);
                previewAuthorizations.set(preview.previewId, authorization);
            }
            return await authorization || input.isServiceLinkPerson(exposure.exposureId);
        }
        if (!exposure.sessionId) return false;
        let authorization = sessionAuthorizations.get(exposure.sessionId);
        if (!authorization) {
            authorization = input.authorizeSession(exposure.sessionId);
            sessionAuthorizations.set(exposure.sessionId, authorization);
        }
        return authorization;
    }));
    return { ok: true, snapshot: scopeSnapshot(snapshot, snapshot.exposures.filter((_, index) => authorized[index])) };
}

function scopeSnapshot(
    snapshot: LocalServicePublicPreviewSnapshotV1,
    exposures: LocalServicePublicPreviewSnapshotV1['exposures'],
): LocalServicePublicPreviewSnapshotV1 {
    const exposureIds = new Set(exposures.map(exposure => exposure.exposureId));
    return { ...snapshot, exposures,
        diagnostics: snapshot.diagnostics.filter(diagnostic => !diagnostic.publicExposureId || exposureIds.has(diagnostic.publicExposureId)),
    };
}

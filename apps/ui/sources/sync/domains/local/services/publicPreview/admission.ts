import {
    LocalServicePublicPreviewAdmissionFailureV1Schema,
    LocalServicePublicPreviewAdmissionResponseV1Schema,
} from '@happier-dev/protocol/local/services/public/v1';

import { serverFetch } from '@/sync/http/client';

/** What the people-share landing shows; the server decided the admission once. */
export type LocalServicePublicPreviewAdmission =
    | Readonly<{ kind: 'admitted'; admissionUrl: string }>
    | Readonly<{ kind: 'no_access' }>
    | Readonly<{ kind: 'ended' }>
    | Readonly<{ kind: 'unavailable' }>;

/**
 * Ask the signed-in Account's Home for a one-use admission URL to a people share. Opening that
 * URL on the preview's own origin sets the viewer cookie; the URL itself is never stored.
 */
export async function requestLocalServicePublicPreviewAdmission(exposureId: string): Promise<LocalServicePublicPreviewAdmission> {
    let response: Response;
    try {
        response = await serverFetch(`/v1/local-services/public-admission/${encodeURIComponent(exposureId)}`, { method: 'POST' });
    } catch {
        return { kind: 'unavailable' };
    }
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) {
        const admitted = LocalServicePublicPreviewAdmissionResponseV1Schema.safeParse(payload);
        return admitted.success ? { kind: 'admitted', admissionUrl: admitted.data.admissionUrl } : { kind: 'unavailable' };
    }
    const refusal = LocalServicePublicPreviewAdmissionFailureV1Schema.safeParse(payload);
    if (!refusal.success) return { kind: 'unavailable' };
    switch (refusal.data.reasonCode) {
        case 'not_in_audience':
        case 'not_people_share':
            return { kind: 'no_access' };
        case 'exposure_not_found':
        case 'expired':
        case 'revoked':
            return { kind: 'ended' };
        default:
            return { kind: 'unavailable' };
    }
}

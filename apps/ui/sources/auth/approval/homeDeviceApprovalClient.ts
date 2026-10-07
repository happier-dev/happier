import {
    HOME_LOGIN_APPROVALS_HTTP_PATH_V1,
    HomeDeviceApprovalListV1Schema,
    HomeDeviceApprovalDecisionRequestV1Schema,
    HomeDeviceApprovalDecisionResponseV1Schema,
    buildHomeLoginApprovalDecisionHttpPathV1,
    type HomeDeviceApprovalDecisionRequestV1,
    type HomeDeviceApprovalRequestV1,
} from '@happier-dev/protocol/auth/accountDirectory';

import type { HomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

export type HomeDeviceApprovalTarget = Readonly<{
    transport: HomeEnrollmentTransport;
    credentials: AuthCredentials;
}>;

export type HomeDeviceApprovalDecision = HomeDeviceApprovalDecisionRequestV1['decision'];

export type HomeDeviceApprovalListItem = HomeDeviceApprovalRequestV1;
export type HomeDeviceApprovalListResult =
    | Readonly<{ ok: true; items: readonly HomeDeviceApprovalListItem[] }>
    | Readonly<{ ok: false; reason: 'unauthorized' | 'malformed' | 'request_failed'; status: number }>;
export type HomeDeviceApprovalDecisionResult =
    | Readonly<{ ok: true; status: 'approved' | 'rejected' }>
    | Readonly<{ ok: false; reason: 'not_found' | 'unauthorized' | 'already_decided' | 'malformed' | 'request_failed'; status: number }>;

function createAuthenticatedHomeRequest(target: HomeDeviceApprovalTarget) {
    if (!target.credentials.token) return null;
    return target.transport.createRequest({ credentials: target.credentials });
}

export async function listHomeDeviceApprovals(
    target: HomeDeviceApprovalTarget,
): Promise<HomeDeviceApprovalListResult> {
    const request = createAuthenticatedHomeRequest(target);
    if (!request) return { ok: false, reason: 'unauthorized', status: 401 };
    try {
        const response = await request(HOME_LOGIN_APPROVALS_HTTP_PATH_V1, undefined, {
            includeAuth: true,
            retry: 'none',
        });
        if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: 'unauthorized', status: response.status };
        }
        if (!response.ok) return { ok: false, reason: 'request_failed', status: response.status };
        const parsed = HomeDeviceApprovalListV1Schema.safeParse(await response.json().catch(() => null));
        return parsed.success
            ? { ok: true, items: parsed.data }
            : { ok: false, reason: 'malformed', status: 502 };
    } catch {
        return { ok: false, reason: 'request_failed', status: 0 };
    }
}

export async function decideHomeDeviceApproval(
    target: HomeDeviceApprovalTarget,
    approvalId: string,
    decision: HomeDeviceApprovalDecision,
): Promise<HomeDeviceApprovalDecisionResult> {
    const normalizedApprovalId = approvalId.trim();
    if (!normalizedApprovalId || normalizedApprovalId.length > 256) {
        return { ok: false, reason: 'not_found', status: 404 };
    }
    const request = createAuthenticatedHomeRequest(target);
    if (!request) return { ok: false, reason: 'unauthorized', status: 401 };
    try {
        const response = await request(
            buildHomeLoginApprovalDecisionHttpPathV1(normalizedApprovalId),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(HomeDeviceApprovalDecisionRequestV1Schema.parse({ decision })),
            },
            { includeAuth: true, retry: 'none' },
        );
        if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: 'unauthorized', status: response.status };
        }
        if (response.status === 404) return { ok: false, reason: 'not_found', status: 404 };
        if (!response.ok) return { ok: false, reason: 'request_failed', status: response.status };
        const parsed = HomeDeviceApprovalDecisionResponseV1Schema.safeParse(await response.json().catch(() => null));
        if (!parsed.success) return { ok: false, reason: 'malformed', status: 502 };
        if (parsed.data.status === 'already_decided') {
            return { ok: false, reason: 'already_decided', status: 409 };
        }
        return { ok: true, status: parsed.data.status };
    } catch {
        return { ok: false, reason: 'request_failed', status: 0 };
    }
}

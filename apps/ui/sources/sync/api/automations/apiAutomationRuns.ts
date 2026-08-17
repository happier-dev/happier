import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import {
    AutomationV3RunListResponseSchema,
    type AutomationV3RunListItem,
} from '@happier-dev/protocol';

import { ApiAutomationRunsResponseSchema, type ApiAutomationRun } from './apiAutomationTypes';
import { getAutomationAuthHeaders, readAutomationJsonOrThrow } from './apiAutomationHttp';

export async function listAutomationRuns(params: {
    credentials: AuthCredentials;
    automationId: string;
    limit?: number;
    cursor?: string | null;
}): Promise<{ runs: ApiAutomationRun[]; nextCursor: string | null }> {
    const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
        ? Math.min(Math.max(Math.floor(params.limit), 1), 100)
        : 20;
    const cursorParam = params.cursor ? `&cursor=${encodeURIComponent(params.cursor)}` : '';
    const response = await serverFetch(
        `/v2/automations/${encodeURIComponent(params.automationId)}/runs?limit=${limit}${cursorParam}`,
        {
            headers: getAutomationAuthHeaders(params.credentials),
        },
        { includeAuth: false },
    );
    const raw = await readAutomationJsonOrThrow(response);
    return ApiAutomationRunsResponseSchema.parse(raw);
}

/** Current bounded Run summaries for every V3 Automation trigger kind. */
export async function listAutomationDefinitionRunsV3(params: {
    credentials: AuthCredentials;
    automationId: string;
    limit?: number;
    cursor?: string | null;
}): Promise<{ runs: AutomationV3RunListItem[]; nextCursor: string | null }> {
    const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
        ? Math.min(Math.max(Math.floor(params.limit), 1), 100)
        : 20;
    const cursorParam = params.cursor ? `&cursor=${encodeURIComponent(params.cursor)}` : '';
    const response = await serverFetch(
        `/v3/automations/${encodeURIComponent(params.automationId)}/runs?limit=${limit}${cursorParam}`,
        {
            headers: getAutomationAuthHeaders(params.credentials),
        },
        { includeAuth: false },
    );
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3RunListResponseSchema.parse(raw);
}

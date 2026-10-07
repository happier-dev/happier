import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import {
    AUTOMATION_V3_RUN_LIST_MAX_ITEMS,
    AutomationV3RunListResponseSchema,
    type AutomationV3RunListItem,
} from '@happier-dev/protocol/automations/automationApiV3';

import { getAutomationAuthHeaders, readAutomationJsonOrThrow } from './apiAutomationHttp';
import type { AutomationRequestContext } from './apiAutomations';

/** Current bounded Run summaries for every Automation trigger kind. */
export async function listAutomationDefinitionRuns(params: Readonly<{
    credentials?: AuthCredentials;
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
    requestContext?: AutomationRequestContext;
}> & ({ automationId: string; attention?: 'required' } | { automationId?: never; attention: 'required' })): Promise<{ runs: AutomationV3RunListItem[]; nextCursor: string | null }> {
    const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
        ? Math.min(Math.max(Math.floor(params.limit), 1), AUTOMATION_V3_RUN_LIST_MAX_ITEMS)
        : 20;
    const cursorParam = params.cursor ? `&cursor=${encodeURIComponent(params.cursor)}` : '';
    const attentionParam = params.attention ? '&attention=required' : '';
    const path = params.automationId === undefined
        ? '/v3/automations/runs'
        : `/v3/automations/${encodeURIComponent(params.automationId)}/runs`;
    const response = await (params.requestContext?.request ?? serverFetch)(
        `${path}?limit=${limit}${cursorParam}${attentionParam}`,
        {
            ...(params.credentials ? { headers: getAutomationAuthHeaders(params.credentials) } : {}),
            ...(params.signal ? { signal: params.signal } : {}),
        },
        { includeAuth: params.credentials === undefined },
    );
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3RunListResponseSchema.parse(raw);
}

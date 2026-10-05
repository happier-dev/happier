import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

import {
    resolveSessionOrganizationMutationScope,
    type SessionOrganizationMutationScope,
} from './sessionOrganizationMutationOwner';

/**
 * UI mutation boundary for an exact Home. The resolver keeps its typed result;
 * interactive callers use this adapter so an unavailable profile or credential
 * becomes one truthful, presentable failure instead of a swallowed null.
 */
export async function requireSessionOrganizationMutationScope(
    requestedServerId: string | null | undefined,
    options?: Readonly<{ expectedAccountId: string }>,
): Promise<SessionOrganizationMutationScope> {
    const result = await resolveSessionOrganizationMutationScope(requestedServerId, options);
    if (result.ok) return result.scope;

    const requestedHome = result.requestedServerId || String(requestedServerId ?? '').trim() || t('common.unavailable');
    throw new HappyError(
        `${t('homeGovernance.unavailableTitle')}: ${requestedHome}`,
        result.reason === 'credentialsUnavailable',
        { code: `session_organization_${result.reason}` },
    );
}

import { readSessionRuntimeIssueNativeAuthAgentId, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { t } from '@/text';

export type SessionAgentAuthRequiredPresentation = Readonly<{
    agentId: string;
    message: string;
}>;

/**
 * What a person is told when an Agent running on its own native sign-in was refused for authentication.
 *
 * The Agent's failure owner types the fact: Protocol's `provider_endpoint_auth_required` code carried by
 * an `auth_error` issue, or its closed startup authentication refusal. A Provider endpoint that needs a
 * credential reaches the same code from an Agent session error instead, so it keeps its Provider copy,
 * and a connected account's expired sign-in carries
 * its own code. The Agent's name comes from the Agent catalog, never from the Agent id.
 */
export function presentSessionAgentAuthRequired(
    issue: SessionRuntimeIssueV1 | null | undefined,
): SessionAgentAuthRequiredPresentation | null {
    const agentId = readSessionRuntimeIssueNativeAuthAgentId(issue);
    if (!agentId) return null;
    return {
        agentId,
        message: t('session.agentAuthRequired.message', { agent: resolveAgentCatalogTitle(agentId) }),
    };
}

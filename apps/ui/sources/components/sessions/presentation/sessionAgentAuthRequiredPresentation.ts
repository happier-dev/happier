import { readSessionRuntimeIssueNativeAuthAgentId, resolveSessionRuntimeIssueSignInRecovery, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { createAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
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

/**
 * Where Protocol's sign-in recovery (`resolveSessionRuntimeIssueSignInRecovery`) is carried out: the Agent's
 * own page on the Machine the Session runs on, where its sign-in and connected accounts live. The owner
 * decides whether the issue has that recovery; this only routes it. Null when there is none or the Home is
 * unknown, so no surface offers a step that cannot run.
 */
export function createSessionAgentSignInRoute(
    issue: SessionRuntimeIssueV1 | null | undefined,
    machineId: string | null | undefined,
    serverId: string | null | undefined,
): string | null {
    const recovery = resolveSessionRuntimeIssueSignInRecovery(issue, machineId);
    const serverIdentityId = serverId ? resolvePortableServerIdentityForRoutingId(serverId) : null;
    if (!recovery || !serverIdentityId) return null;
    return createAgentSettingsRoute({ agentId: recovery.agentId, identity: null,
        machine: { machineId: recovery.machineId, serverIdentityId } });
}

import type { AgentCore, AgentId, ConnectedServiceId } from '../types.js';
import { AGENTS_CORE } from '../manifest.js';

export type ConnectedServicePoolConsentPolicy = Readonly<{
    /** Provider-account features run only for accounts that are members of a pool of this service. */
    required: boolean;
    /** Provider page the one-time pool notice links to, when the provider declares one. */
    learnMoreUrl: string | null;
}>;

const NOT_REQUIRED: ConnectedServicePoolConsentPolicy = Object.freeze({ required: false, learnMoreUrl: null });

/**
 * The single owner of the pool-consent rule. A provider declares, in its manifest entry, which
 * connected services keep provider-account features (quota reads, onboarding, verification
 * lookups, automatic account switching) off by default; creating a pool is the consent that
 * enables them for that pool's members.
 */
export function resolveConnectedServicePoolConsentPolicy(serviceId: ConnectedServiceId): ConnectedServicePoolConsentPolicy {
    for (const agentCore of Object.values(AGENTS_CORE) as AgentCore[]) {
        const declared = agentCore.connectedServices?.poolConsentServices?.find((entry) => entry.serviceId === serviceId);
        if (declared) return { required: true, learnMoreUrl: declared.learnMoreUrl ?? null };
    }
    return NOT_REQUIRED;
}

export type AgentAccountStatusConsent = Readonly<{
    /** Connected services whose account reads the agent's account-status setting turns on. */
    serviceIds: ReadonlyArray<ConnectedServiceId>;
    learnMoreUrl: string | null;
}>;

/** The agent's account-status setting exists only when its manifest declares consent-gated services. */
export function resolveAgentAccountStatusConsent(agentId: AgentId): AgentAccountStatusConsent | null {
    const agentCore: AgentCore | undefined = AGENTS_CORE[agentId];
    const declared = agentCore?.connectedServices?.poolConsentServices ?? [];
    if (declared.length === 0) return null;
    return {
        serviceIds: declared.map((entry) => entry.serviceId),
        learnMoreUrl: declared.find((entry) => entry.learnMoreUrl)?.learnMoreUrl ?? null,
    };
}

/**
 * Whether Happier may read provider account status (usage, verification) for one account. Two
 * independent consents: the account is a member of one of the service's pools, or the person
 * turned on the account-status setting of an agent that declares the service. Automatic
 * switching needs a pool by construction, so pool membership alone governs it.
 */
export function isConnectedServiceProviderAccountAccessAllowed(input: Readonly<{
    serviceId: ConnectedServiceId;
    poolMember: boolean;
    accountStatusByAgentId?: Readonly<Record<string, boolean>> | null;
}>): boolean {
    if (input.poolMember || !resolveConnectedServicePoolConsentPolicy(input.serviceId).required) return true;
    const enabled = input.accountStatusByAgentId ?? {};
    return (Object.keys(AGENTS_CORE) as AgentId[]).some((agentId) =>
        enabled[agentId] === true && resolveAgentAccountStatusConsent(agentId)?.serviceIds.includes(input.serviceId) === true);
}

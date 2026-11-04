import { TeamCredentialAllowedRoutesV1Schema, TeamCredentialSessionUsePolicyV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { readTeamCredentialAllowedRoutes } from './resourceDeliveryRead';
import { type TeamCredentialUsageCapabilitiesV1 } from '@happier-dev/protocol/teams';

export type TeamCredentialUsageRouteCapability = Readonly<{
    id:
        | 'agent_runtime_session_turn'
        | 'agent_runtime_attached_execution_run'
        | 'agent_runtime_detached_execution_run'
        | 'external_provider_terminal'
        | 'resource_test';
    /** `not_applicable` marks a non-inference route that never consumes a
     * token or cost ceiling and therefore cannot withhold one. */
    tokenObservation: 'complete' | 'unavailable' | 'not_applicable';
    exactPrice: boolean;
    /**
     * The route carries no Team Session context, so the canonical admission
     * owners admit it only for a `personal_allowed` resource: a detached Run is
     * validated as a planned Session with no primary Team and no Team
     * visibility (`sessionBinding.ts#admitTeamCredentialOperationBindingInTx`),
     * and an external API key exists and authorizes only under that policy
     * (`externalApiKey.ts`). A Team-context or Team-visibility resource can
     * therefore never be used through it.
     */
    personalUseOnly: boolean;
}>;

export type TeamCredentialUsageRouteId = TeamCredentialUsageRouteCapability['id'];

/**
 * The sole resource-wide usage-limit availability decision.
 *
 * Every currently enabled route must prove terminal token observation before
 * the next admission. Cost additionally requires exact canonical pricing for
 * every route. Missing routes and unknown facts deliberately fail closed; an
 * unknown value is never interpreted as zero usage.
 */
export function resolveTeamCredentialUsageCapabilities(input: Readonly<{
    routes: readonly TeamCredentialUsageRouteCapability[];
}>): TeamCredentialUsageCapabilitiesV1 {
    if (input.routes.length === 0) {
        return Object.freeze({
            inferenceRequests: 'unavailable',
            totalTokens: 'unavailable',
            costUsd: 'unavailable',
            limitCoverage: 'unavailable',
        });
    }
    const inferenceRoutes = input.routes.filter((route) => route.tokenObservation !== 'not_applicable');
    const tokensComplete = inferenceRoutes.length > 0
        && inferenceRoutes.every((route) => route.tokenObservation === 'complete');
    const pricesComplete = tokensComplete && inferenceRoutes.every((route) => route.exactPrice);
    return Object.freeze({
        inferenceRequests: 'available',
        totalTokens: tokensComplete ? 'available' : 'unavailable',
        costUsd: pricesComplete ? 'available' : 'unavailable',
        limitCoverage: 'brokered_only',
    });
}

/**
 * Installed terminal producers consumed by the server usage writer.
 *
 * Ordinary Session observations enter through the Agent runtime Session-turn
 * route. The writer resolves their immutable turn witness before recording Team
 * attribution, so broker admission remains request-count-only and cannot
 * duplicate the terminal token fact.
 *
 * The ordinary Session producer is also consumed by an attached
 * Session-derived Execution Run. Two paths remain explicit fail-closed entries,
 * each for its own exact reason:
 *
 * - `agent_runtime_detached_execution_run`: a detached Run has no Happier
 *   Session, so it has no Agent usage publisher, and the Agent Run runtime
 *   contract deliberately keeps usage outside the finite Run event union
 *   (`packages/plugin-sdk/src/agentRuntime/executionRun.ts`). No provider
 *   observation reaches the host at all, so nothing can be attributed.
 * - `external_provider_terminal`: the broker now observes the admitted public
 *   response once and reports the Provider's own terminal tokens, but the
 *   OpenAI Chat Completions route emits `usage` in a stream only when the
 *   caller sends `stream_options.include_usage`, which this broker does not add
 *   to a caller's request
 *   (`apps/cli/src/providers/broker/externalProviderTerminalTokens.ts`). One
 *   route mode that can legitimately report nothing is enough to make a
 *   resource-wide token ceiling dishonest, so the row stays closed while the
 *   per-request `measurement` stays truthful.
 *
 * The resource test is a bounded probe, not inference: it never draws on a
 * token or cost ceiling, so it neither proves nor withholds one.
 * Claude and Codex have Agent-local pricing estimators, but their runtime
 * owners deliberately withhold those estimates for arbitrary Provider-bound
 * models. They therefore do not establish complete exact price coverage for a
 * Team resource's model/protocol set.
 */
export const CURRENT_TEAM_CREDENTIAL_USAGE_ROUTES = Object.freeze([
    Object.freeze({
        id: 'agent_runtime_session_turn',
        tokenObservation: 'complete',
        exactPrice: false,
        personalUseOnly: false,
    }),
    Object.freeze({
        id: 'agent_runtime_attached_execution_run',
        tokenObservation: 'complete',
        exactPrice: false,
        personalUseOnly: false,
    }),
    Object.freeze({
        id: 'agent_runtime_detached_execution_run',
        tokenObservation: 'unavailable',
        exactPrice: false,
        personalUseOnly: true,
    }),
    Object.freeze({
        id: 'external_provider_terminal',
        tokenObservation: 'unavailable',
        exactPrice: false,
        personalUseOnly: true,
    }),
    Object.freeze({
        id: 'resource_test',
        tokenObservation: 'not_applicable',
        exactPrice: false,
        personalUseOnly: false,
    }),
] satisfies readonly TeamCredentialUsageRouteCapability[]);

export function resolveCurrentTeamCredentialUsageCapabilitiesForRoute(
    routeId: TeamCredentialUsageRouteId,
): TeamCredentialUsageCapabilitiesV1 {
    const route = CURRENT_TEAM_CREDENTIAL_USAGE_ROUTES.find((candidate) => candidate.id === routeId);
    return resolveTeamCredentialUsageCapabilities({ routes: route ? [route] : [] });
}

export const CURRENT_TEAM_CREDENTIAL_USAGE_CAPABILITIES = resolveTeamCredentialUsageCapabilities({
    // This projection describes the whole enabled product surface. Filtering
    // to the routes that already observe tokens would advertise a partial
    // ceiling as complete and let administration create a limit that later
    // fails when a detached Run, external request, or resource test uses it.
    routes: CURRENT_TEAM_CREDENTIAL_USAGE_ROUTES,
});

type ResourceUsageRouteFacts = Readonly<{
    allMembersDeliveryMode: unknown;
    groupGrants: readonly Readonly<{ deliveryMode: unknown }>[];
    memberGrants: readonly Readonly<{ deliveryMode: unknown }>[];
    sessionUsePolicy: unknown;
}>;

/** Derives the advertised limit contract from the routes this resource's
 * canonical audience and Session-use policy can actually admit (plan 10.07
 * §12.5: token limits require observation on every ALLOWED use path). A
 * Team-context or Team-visibility resource is reachable only through Happier
 * Sessions and their attached Runs, whose Agent observations are complete, so
 * its token ceiling covers every path; a `personal_allowed` resource can also
 * be spent by a detached Run or the external API and stays request-count-only
 * (§11.3). Missing or malformed facts fail closed; a direct-only resource never
 * inherits broker capabilities from an unrelated resource. */
export function resolveCurrentTeamCredentialUsageCapabilitiesForResource(
    resource: ResourceUsageRouteFacts,
): TeamCredentialUsageCapabilitiesV1 {
    const values = [
        ...(resource.allMembersDeliveryMode === null ? [] : [resource.allMembersDeliveryMode]),
        ...resource.groupGrants.map((grant) => grant.deliveryMode),
        ...resource.memberGrants.map((grant) => grant.deliveryMode),
    ];
    const modes = values.map(value => typeof value === 'string'
        ? readTeamCredentialAllowedRoutes(value) : TeamCredentialAllowedRoutesV1Schema.safeParse(value));
    const sessionUsePolicy = TeamCredentialSessionUsePolicyV1Schema.safeParse(resource.sessionUsePolicy);
    if (modes.some((mode) => !mode.success) || !sessionUsePolicy.success) {
        return resolveTeamCredentialUsageCapabilities({ routes: [] });
    }
    const hasBrokeredRoute = modes.some((mode) => mode.success
        && mode.data.includes('brokered'));
    return resolveTeamCredentialUsageCapabilities({
        routes: hasBrokeredRoute
            ? CURRENT_TEAM_CREDENTIAL_USAGE_ROUTES.filter((route) => (
                !route.personalUseOnly || sessionUsePolicy.data === 'personal_allowed'
            ))
            : [],
    });
}

/**
 * Plan 10.07 §12.5: "Existing limits fail closed before enabling a newly
 * unsupported path; they do not silently become partial." A brokered resource
 * may not keep an enabled token or cost limit once its reachable routes can no
 * longer observe that metric — for example a Session-use policy change that
 * lets detached Runs and the external API spend it. A resource with no brokered
 * route has no use path for a limit to cover, so it refuses nothing.
 */
export function findTeamCredentialUsageLimitCapabilityRefusal(
    limits: readonly Readonly<{ metric: string; enabled: boolean }>[],
    capabilities: TeamCredentialUsageCapabilitiesV1,
): 'token_limit_unavailable' | 'cost_limit_unavailable' | null {
    if (capabilities.limitCoverage !== 'brokered_only') return null;
    const enabled = limits.filter((limit) => limit.enabled);
    if (capabilities.totalTokens !== 'available' && enabled.some((limit) => limit.metric === 'total_tokens')) {
        return 'token_limit_unavailable';
    }
    if (capabilities.costUsd !== 'available' && enabled.some((limit) => limit.metric === 'cost_usd')) {
        return 'cost_limit_unavailable';
    }
    return null;
}

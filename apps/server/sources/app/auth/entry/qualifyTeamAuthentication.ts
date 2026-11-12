import { normalizeAuthMethodId } from '@happier-dev/protocol/auth/providers';
import type { AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';
import type { TeamAcceptedAuthenticationV1 } from '@happier-dev/protocol/auth/entry';

import { resolveCurrentAuthenticationEvidenceForTeamQualificationInTx } from "@/app/auth/authenticationEvidence";
import { captureHomeAuthenticationAvailabilityInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveAuthMethodRegistry } from "@/app/auth/methods/registry";
import { readTeamAuthenticationConnectionDescriptorsInTx } from "@/app/auth/providers/identityProviderCatalog";
import { readIdentityProviderInstancePresentationsByIdsInTx } from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import { teamIdentityConnectionReferenceKey } from "@/app/teams/identity/teamIdentityConnectionLifecycle";
import type { Tx } from "@/storage/inTx";
import type { TeamAuthenticationReadCapture } from './teamAuthenticationReadCapture';

import {
    reduceTeamAcceptedChoiceAvailabilities,
    resolveTeamAcceptedChoiceAvailability,
    resolveTeamAuthenticationPolicy,
} from "./resolveTeamAuthenticationPolicy";

export type TeamAuthenticationQualificationV1 =
    | Readonly<{ status: "satisfied"; matched: TeamAcceptedAuthenticationV1 | null }>
    | Readonly<{ status: "authentication_required"; accepted: readonly TeamAcceptedAuthenticationV1[] }>
    | Readonly<{ status: "unavailable" }>;

export type TeamAuthenticationOperationContext = Readonly<{
    kind: "present_user" | "account_automation";
}>;

type TeamAuthenticationTeam = Readonly<{
    id: string;
    authenticationPolicy: unknown;
}>;

function hasCurrentProviderEvidence(
    input: Readonly<{
        currentEvidence: readonly AuthTokenAuthenticationEvidenceV1[];
        evidence: AuthTokenAuthenticationEvidenceV1;
        providerId: string;
        runtimeFingerprint: string;
        teamConnectionId?: string;
    }>,
): boolean {
    if (input.evidence.kind !== "provider"
        || normalizeAuthMethodId(input.evidence.providerId) !== normalizeAuthMethodId(input.providerId)
        || input.evidence.runtimeFingerprint !== input.runtimeFingerprint
        || input.evidence.teamConnectionId !== input.teamConnectionId) return false;
    return input.currentEvidence.includes(input.evidence);
}

/**
 * Qualify one verified credential against one Team's current accepted-method policy.
 *
 * Structural membership is deliberately absent from this owner. Callers first establish a
 * Team-derived entitlement through its native owner, then layer this decision over only that
 * authority arm. Owner/direct/Home alternatives therefore remain independently usable.
 *
 * Result vocabulary — the same "currently usable" decision the Team entry projection and
 * policy administration read through `resolveTeamAcceptedChoiceAvailability`:
 * - `satisfied`: the credential currently proves one accepted reference;
 * - `authentication_required`: the Home currently offers at least one accepted reference and
 *   the credential proves none of them, so the caller can go and authenticate (consumers
 *   answer `team_authentication_required`, 403, carrying the offered references);
 * - `unavailable`: the policy is malformed, no accepted reference is currently offered,
 *   or none is offered and a fact could not be read — nothing the caller could present
 *   would satisfy it (consumers answer `team_authentication_unavailable` /
 *   `authentication_unavailable`).
 * An accepted reference the Home does not currently offer is not a way in, but it never
 * hides the Team's other accepted alternatives — including a reference whose own catalog
 * row is unreadable, which `reduceTeamAcceptedChoiceAvailabilities` only lets decide the
 * policy when no alternative is usable.
 */
export async function qualifyTeamAuthenticationInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        team: TeamAuthenticationTeam;
        accountId: string;
        verifiedCredentialEvidence: readonly AuthTokenAuthenticationEvidenceV1[] | undefined;
        operationContext: TeamAuthenticationOperationContext;
    }>,
): Promise<TeamAuthenticationQualificationV1> {
    const results = await qualifyTeamAuthenticationsInTx(tx, {
        ...input,
        teams: [input.team],
    });
    return results.get(input.team.id) ?? { status: "unavailable" };
}

/**
 * Qualifies one credential against a bounded set of Team policies from one
 * transaction-scoped fact snapshot. This is the same canonical decision as
 * the scalar entry point: batching changes only how current facts are loaded,
 * never how policy, connection, evidence, or exact-Team binding is evaluated.
 */
export async function qualifyTeamAuthenticationsInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        teams: readonly TeamAuthenticationTeam[];
        accountId: string;
        verifiedCredentialEvidence: readonly AuthTokenAuthenticationEvidenceV1[] | undefined;
        operationContext: TeamAuthenticationOperationContext;
    }>,
    readCapture?: TeamAuthenticationReadCapture,
): Promise<ReadonlyMap<string, TeamAuthenticationQualificationV1>> {
    // Both admitted principal kinds use this exact credential's evidence;
    // automation never falls back to Account links.
    void input.operationContext;
    const teams = [...new Map(input.teams.map((team) => [team.id, team])).values()];
    const structural = new Map(teams.map((team) => [team.id, resolveTeamAuthenticationPolicy({
        policy: team.authenticationPolicy,
        homeMethods: [],
        teamConnections: [],
    })] as const));
    const results = new Map<string, TeamAuthenticationQualificationV1>();
    const restrictedTeams = teams.filter((team) => {
        const policy = structural.get(team.id);
        if (policy?.status === "inherit") {
            results.set(team.id, { status: "satisfied", matched: null });
            return false;
        }
        if (policy?.status !== "restricted") {
            results.set(team.id, { status: "unavailable" });
            return false;
        }
        return true;
    });
    if (restrictedTeams.length === 0) return results;

    const acceptedHomeMethodIds = [...new Set(restrictedTeams.flatMap((team) => {
        const policy = structural.get(team.id);
        return policy?.status === "restricted" ? policy.choices.flatMap((choice) =>
            choice.reference.kind === "home_method" ? [normalizeAuthMethodId(choice.reference.methodId)] : []) : [];
    }))];
    const connectionReferences = restrictedTeams.flatMap((team) => {
        const policy = structural.get(team.id);
        return policy?.status === "restricted" ? policy.choices.flatMap((choice) =>
            choice.reference.kind === "team_connection"
                ? [{ teamId: team.id, id: choice.reference.connectionId }]
                : []) : [];
    });

    try {
        const [homeAvailability, homeInstances, connections] = await Promise.all([
            captureHomeAuthenticationAvailabilityInTx(tx, { env: input.env }, readCapture),
            readIdentityProviderInstancePresentationsByIdsInTx(tx, { ids: acceptedHomeMethodIds }, readCapture),
            readTeamAuthenticationConnectionDescriptorsInTx(tx, {
                env: input.env,
                references: connectionReferences,
            }, readCapture),
        ]);
        const { effectiveHome, providerDescriptors: homeDescriptors } = homeAvailability;
        const currentEvidence = await resolveCurrentAuthenticationEvidenceForTeamQualificationInTx(tx, {
            env: input.env,
            accountId: input.accountId,
            evidence: input.verifiedCredentialEvidence,
            teamConnectionDescriptors: connections,
            effectiveHomeMethods: effectiveHome,
            homeProviderDescriptors: homeDescriptors,
        }, readCapture);
        if (effectiveHome.status !== "ready") {
            for (const team of restrictedTeams) results.set(team.id, { status: "unavailable" });
            return results;
        }
        const nativeMethodIds = new Set(resolveAuthMethodRegistry(input.env).map((method) => normalizeAuthMethodId(method.id)));
        const effectiveHomeById = new Map(effectiveHome.decisions.map((decision) => [normalizeAuthMethodId(decision.id), decision]));
        const homeDescriptorById = new Map(homeDescriptors.map((descriptor) => [
            normalizeAuthMethodId(descriptor.reference.id),
            descriptor.reference,
        ]));

        for (const team of restrictedTeams) {
            const policy = structural.get(team.id);
            if (policy?.status !== "restricted") continue;
            const availability = policy.choices.map((choice) => {
                const reference = choice.reference;
                if (reference.kind === "team_connection") {
                    const read = connections.get(teamIdentityConnectionReferenceKey({
                        teamId: team.id,
                        id: reference.connectionId,
                    }));
                    return [choice, resolveTeamAcceptedChoiceAvailability({
                        kind: "team_connection",
                        connectionUnreadable: read?.status === "unreadable",
                        connected: read?.status === "ready" && read.connection.state === "connected",
                        descriptorOffered: read?.status === "ready" && read.descriptor !== null,
                    })] as const;
                }
                const methodId = normalizeAuthMethodId(reference.methodId);
                return [choice, resolveTeamAcceptedChoiceAvailability({
                    kind: "home_method",
                    native: nativeMethodIds.has(methodId),
                    offered: effectiveHomeById.get(methodId)?.actions.some((action) => action.enabled) === true,
                    instanceUnreadable: homeInstances.get(methodId)?.status === "unreadable",
                    descriptorOffered: homeDescriptorById.has(methodId),
                })] as const;
            });
            const reduced = reduceTeamAcceptedChoiceAvailabilities(availability);
            if (reduced.status === "unreadable" || reduced.usable.length === 0) {
                results.set(team.id, { status: "unavailable" });
                continue;
            }
            const usable = reduced.usable;

            let matched: TeamAcceptedAuthenticationV1 | null = null;
            for (const choice of usable) {
                const reference = choice.reference;
                if (reference.kind === "home_method") {
                    const methodId = normalizeAuthMethodId(reference.methodId);
                    if (nativeMethodIds.has(methodId) && currentEvidence.some((evidence) =>
                        evidence.kind === "home_method" && normalizeAuthMethodId(evidence.methodId) === methodId)) {
                        matched = reference;
                        break;
                    }
                    const descriptor = homeDescriptorById.get(methodId);
                    if (descriptor && currentEvidence.some((evidence) => hasCurrentProviderEvidence({
                        currentEvidence,
                        evidence,
                        providerId: descriptor.id,
                        runtimeFingerprint: descriptor.runtimeFingerprint,
                    }))) {
                        matched = reference;
                        break;
                    }
                    continue;
                }
                const read = connections.get(teamIdentityConnectionReferenceKey({
                    teamId: team.id,
                    id: reference.connectionId,
                }));
                if (read?.status !== "ready" || read.descriptor === null) continue;
                const descriptor = read.descriptor;
                if (currentEvidence.some((evidence) => hasCurrentProviderEvidence({
                    currentEvidence,
                    evidence,
                    providerId: read.connection.providerInstanceId,
                    runtimeFingerprint: descriptor.reference.runtimeFingerprint,
                    teamConnectionId: read.connection.id,
                }))) {
                    matched = reference;
                    break;
                }
            }
            results.set(team.id, matched
                ? { status: "satisfied", matched }
                : { status: "authentication_required", accepted: usable.map((choice) => choice.reference) });
        }
    } catch {
        for (const team of restrictedTeams) results.set(team.id, { status: "unavailable" });
    }
    return results;
}

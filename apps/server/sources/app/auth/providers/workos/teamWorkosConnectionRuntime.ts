import { computeCanonicalDomainSeparatedDigest } from "@happier-dev/protocol/crypto/canonicalDigest";

import {
    resolveIdentityProviderInstanceRuntimeInTx,
    type IdentityProviderInstanceView,
} from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import type { TeamIdentityConnectionDocuments } from "@/app/auth/providers/managed/identityProviderDocuments";
import { readTeamIdentityConnectionInTx } from "@/app/teams/identity/teamIdentityConnectionLifecycle";
import type {
    WorkosPlatformConfigResolution,
    WorkosPlatformRequestPolicy,
} from "@/app/integrations/workos/workosPlatform";
import { resolveWorkosPlatformConfig } from "@/app/integrations/workos/workosPlatform";
import type { Tx } from "@/storage/inTx";

type ConfiguredWorkosExternalReference = Omit<
    Extract<TeamIdentityConnectionDocuments["externalReference"], { kind: "workos_sso" }>,
    "organizationId" | "connectionId"
> & Readonly<{ organizationId: string; connectionId: string }>;

type WorkosOrganizationExternalReference = Omit<
    Extract<TeamIdentityConnectionDocuments["externalReference"], { kind: "workos_sso" }>,
    "organizationId"
> & Readonly<{ organizationId: string }>;

type TeamWorkosRuntimeUnavailableResult =
    Readonly<{
        status: "connection_not_found" | "connection_disabled" | "provider_unavailable" | "unreadable" | "not_configured" | "platform_unavailable";
    }>;

type TeamWorkosRuntimeReadyResult<
    TPurpose extends "sso" | "directory",
    TExternalReference extends WorkosOrganizationExternalReference,
    TeamId extends string | null = string,
> =
    | Readonly<{
        status: "ready";
        purpose: TPurpose;
        provider: IdentityProviderInstanceView;
        connection: Readonly<{
            id: string;
            teamId: TeamId;
            providerInstanceId: string;
            enabled: boolean;
            revision: number;
            externalReference: TExternalReference;
            settings: Extract<TeamIdentityConnectionDocuments["settings"], { kind: "workos_sso" }>;
        }>;
        platform: Extract<WorkosPlatformConfigResolution, { available: true }>;
        runtimeFingerprint: string;
    }>;

export type TeamWorkosConnectionRuntimeResult<TeamId extends string | null = string> =
    | TeamWorkosRuntimeReadyResult<"sso", ConfiguredWorkosExternalReference, TeamId>
    | TeamWorkosRuntimeUnavailableResult;

export type TeamWorkosDirectoryRuntimeResult =
    | TeamWorkosRuntimeReadyResult<"directory", WorkosOrganizationExternalReference>
    | TeamWorkosRuntimeUnavailableResult;

type TeamWorkosRuntimeInput = Readonly<{
    env: NodeJS.ProcessEnv;
    teamId: string | null;
    connectionId: string;
    includeDisabled?: boolean;
    purpose?: "sso" | "directory";
    requestPolicy?: WorkosPlatformRequestPolicy;
}>;

type TeamWorkosRuntimeDependencies = Readonly<{
    resolvePlatform?: (
        env: NodeJS.ProcessEnv,
        requestPolicy?: WorkosPlatformRequestPolicy,
    ) => WorkosPlatformConfigResolution;
}>;

export function computeTeamWorkosConnectionRuntimeFingerprint(input: Readonly<{
    teamId: string | null;
    connectionId: string;
    providerInstanceId: string;
    providerSecurityRevision: number;
    connectionRevision: number;
    platformRuntimeFingerprint: string;
    externalReference: Readonly<{ organizationId: string; connectionId: string | null }>;
}>): string {
    const digest = computeCanonicalDomainSeparatedDigest(
        "happier.team-workos-connection.runtime.v1",
        [
            input.teamId === null ? "home" : "team",
            input.teamId ?? "",
            input.connectionId,
            input.providerInstanceId,
            input.platformRuntimeFingerprint,
            input.externalReference.organizationId,
            input.externalReference.connectionId ?? "",
        ],
    );
    return `team-workos:v1:${input.providerSecurityRevision}:${input.connectionRevision}:${digest}`;
}

/** Current provider authority shared by network reads and directory effect commits. */
export async function resolveTeamWorkosProviderInstanceInTx(
    tx: Tx,
    input: Readonly<{ teamId: string | null; providerInstanceId: string; includeDisabled?: boolean }>,
): Promise<
    | Readonly<{ status: "ready"; instance: IdentityProviderInstanceView }>
    | Readonly<{ status: "unreadable" | "provider_unavailable" }>
> {
    const teamProvider = input.teamId === null ? { status: "not_found" as const } : await resolveIdentityProviderInstanceRuntimeInTx(tx, {
        id: input.providerInstanceId,
        owner: { kind: "team", teamId: input.teamId },
        includeDisabled: input.includeDisabled,
    });
    const resolvedProvider = teamProvider.status === "not_found"
        ? await resolveIdentityProviderInstanceRuntimeInTx(tx, {
            id: input.providerInstanceId,
            owner: { kind: "home" },
            includeDisabled: input.includeDisabled,
        })
        : teamProvider;
    if (resolvedProvider.status === "unreadable") return { status: "unreadable" };
    if (
        resolvedProvider.status !== "ready"
        || resolvedProvider.instance.kind !== "workos_sso"
        || resolvedProvider.instance.config.kind !== "workos_sso"
        || resolvedProvider.secrets !== null
    ) return { status: "provider_unavailable" };
    return { status: "ready", instance: resolvedProvider.instance };
}

export function resolveTeamWorkosConnectionRuntimeInTx(
    tx: Tx,
    input: TeamWorkosRuntimeInput & Readonly<{ purpose: "directory"; teamId: string }>,
    dependencies?: TeamWorkosRuntimeDependencies,
): Promise<TeamWorkosDirectoryRuntimeResult>;
export function resolveTeamWorkosConnectionRuntimeInTx<TeamId extends string | null>(
    tx: Tx,
    input: TeamWorkosRuntimeInput & Readonly<{ purpose?: "sso"; teamId: TeamId }>,
    dependencies?: TeamWorkosRuntimeDependencies,
): Promise<TeamWorkosConnectionRuntimeResult<TeamId>>;
export async function resolveTeamWorkosConnectionRuntimeInTx(
    tx: Tx,
    input: TeamWorkosRuntimeInput,
    dependencies: TeamWorkosRuntimeDependencies = {},
): Promise<TeamWorkosConnectionRuntimeResult<string | null> | TeamWorkosDirectoryRuntimeResult> {
    const purpose = input.purpose ?? "sso";
    if (purpose === "directory" && input.teamId === null) return { status: "connection_not_found" };
    const current = await readTeamIdentityConnectionInTx(tx, {
        id: input.connectionId, teamId: input.teamId,
    });
    if (current.status === "not_found") return { status: "connection_not_found" };
    if (current.status !== "ready") return { status: "unreadable" };
    const row = current.connection;
    if (!row.enabled && purpose === "sso" && input.includeDisabled !== true) {
        return { status: "connection_disabled" };
    }

    const resolvedProvider = await resolveTeamWorkosProviderInstanceInTx(tx, {
        providerInstanceId: row.providerInstanceId,
        teamId: input.teamId,
        includeDisabled: input.includeDisabled,
    });
    if (resolvedProvider.status !== "ready") return resolvedProvider;

    if (row.externalReference.kind !== "workos_sso" || row.settings.kind !== "workos_sso") {
        return { status: "unreadable" };
    }
    const organizationId = row.externalReference.organizationId;
    const connectionId = row.externalReference.connectionId;
    if (organizationId === null || (purpose === "sso" && connectionId === null)) {
        return { status: "not_configured" };
    }

    const platform = dependencies.resolvePlatform
        ? dependencies.resolvePlatform(input.env, input.requestPolicy)
        : resolveWorkosPlatformConfig(input.env, {}, input.requestPolicy);
    if (!platform.available) return { status: "platform_unavailable" };
    const runtimeFingerprint = computeTeamWorkosConnectionRuntimeFingerprint({
        teamId: input.teamId,
        connectionId: row.id,
        providerInstanceId: row.providerInstanceId,
        providerSecurityRevision: resolvedProvider.instance.securityRevision,
        connectionRevision: row.revision,
        platformRuntimeFingerprint: platform.runtimeFingerprint,
        externalReference: { organizationId, connectionId },
    });
    const connection = {
        id: row.id,
        teamId: row.teamId,
        providerInstanceId: row.providerInstanceId,
        enabled: row.enabled,
        revision: row.revision,
        settings: row.settings,
    };
    if (purpose === "directory") {
        return {
            status: "ready",
            purpose,
            provider: resolvedProvider.instance,
            connection: {
                ...connection,
                teamId: input.teamId!,
                externalReference: {
                    ...row.externalReference,
                    organizationId,
                },
            },
            platform,
            runtimeFingerprint,
        };
    }
    return {
        status: "ready",
        purpose,
        provider: resolvedProvider.instance,
        connection: {
            ...connection,
            externalReference: {
                ...row.externalReference,
                organizationId,
                connectionId: connectionId!,
            },
        },
        platform,
        runtimeFingerprint,
    };
}

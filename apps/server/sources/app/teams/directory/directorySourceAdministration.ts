import type {
    TeamDirectoryGroupPageV1,
    TeamDirectoryGroupsListInputV1,
    TeamDirectoryPeopleListInputV1,
    TeamDirectoryPeoplePageV1,
    TeamDirectorySafeErrorCodeV1,
    TeamDirectorySourceCreateInputV1,
    TeamDirectorySourcePageV1,
    TeamDirectorySourceRemovalPreflightV1,
    TeamDirectorySourceRemoveResultV1,
    TeamDirectorySourceSetupListInputV1,
    TeamDirectorySourceSetupOptionsV1,
    TeamDirectorySourceSummaryV1,
    TeamDirectorySourceSyncResultV1,
    TeamDirectorySourcesListInputV1,
    TeamErrorCodeV1,
    TeamIdentityErrorCodeV1,
} from "@happier-dev/protocol/teams";
import { resolveStoredGitHubDirectoryReadiness } from "@/app/integrations/github/githubManagedDirectory";
import { readHomeGovernancePolicyInTx } from "@/app/home/governance/governancePolicy";
import {
    decodeTeamKeysetCursorV1,
    encodeTeamKeysetCursorV1,
    readTeamKeysetIdV1,
    readTeamKeysetTextV1,
    readTeamKeysetTimeV1,
} from "@happier-dev/protocol/teams";

import { inTx, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv, prismaRuntime } from "@/storage/prisma";
import { resolveTeamWorkosConnectionRuntimeInTx } from "@/app/auth/providers/workos/teamWorkosConnectionRuntime";
import {
    resolveWorkosPlatformRequestPolicy,
    type WorkosPlatformConfigResolution,
    type WorkosPlatformRequestPolicy,
} from "@/app/integrations/workos/workosPlatform";
import type { TeamOperationAuthenticationContext } from "../actorContext";
import { authorizeTeamIdentityAdministrationInTx } from "../identity/teamIdentityAdministrationAuthority";
import { publishTeamChangedInTx } from "../teamChanges";
import { projectTeamDirectorySourceSummary } from "./directorySourceProjection";
import {
    createDirectorySourceInTx,
    readDirectorySourceRepairRefusalInTx,
    removeDirectorySourceInTx,
    requestDirectorySourceSyncInTx,
} from "./directorySourceService";
import { deriveWorkosDirectoryExternalSourceKey } from "./directorySourceBinding";
import { requestEnterpriseIdentitySyncNudge } from "./runtime/directorySyncWake";
import { isDirectorySourceKindAllowedInTx, isDirectorySourceProjectionComplete } from "./directorySourcePolicy";

type WorkosSetupDirectory = Readonly<{
    id: string;
    name: string;
    organizationId?: string;
    state: string;
}>;

type WorkosSetupDirectoryPage = Readonly<{
    data: readonly WorkosSetupDirectory[];
    listMetadata: Readonly<{ after?: string | null }>;
}>;

type DirectorySourceSetupCursor =
    | Readonly<{ phase: "workos"; connectionId: string; after: string | null }>
    | Readonly<{ phase: "github"; organizationLogin: string | null; installationId: string | null }>;

type WorkosSetupConnectionRuntime = Readonly<{
    connectionId: string;
    organizationId: string;
    listDirectories: (input: Readonly<{
        organizationId: string;
        limit: number;
        after?: string;
    }>) => Promise<unknown>;
}>;

function isWorkosSetupDirectoryPage(value: unknown): value is WorkosSetupDirectoryPage {
    if (typeof value !== "object" || value === null || !("data" in value) || !("listMetadata" in value)) return false;
    if (!Array.isArray(value.data) || typeof value.listMetadata !== "object" || value.listMetadata === null) return false;
    if (
        "after" in value.listMetadata
        && value.listMetadata.after !== undefined
        && value.listMetadata.after !== null
        && typeof value.listMetadata.after !== "string"
    ) return false;
    return value.data.every((entry) => (
        typeof entry === "object"
        && entry !== null
        && "id" in entry && typeof entry.id === "string" && entry.id.length > 0
        && "name" in entry && typeof entry.name === "string" && entry.name.trim().length > 0
        && "state" in entry && typeof entry.state === "string"
        && (!("organizationId" in entry) || entry.organizationId === undefined || typeof entry.organizationId === "string")
    ));
}

function decodeDirectorySourceSetupCursor(
    value: string,
    queryKey: string,
): DirectorySourceSetupCursor | null {
    const decoded = decodeTeamKeysetCursorV1(value, queryKey);
    if (decoded.status !== "ok") return null;
    const phase = readTeamKeysetTextV1(decoded.parts[0]);
    if (phase === "workos" && decoded.parts.length === 3) {
        const connectionId = readTeamKeysetIdV1(decoded.parts[1]);
        const after = readTeamKeysetTextV1(decoded.parts[2]);
        return connectionId !== null && after !== null
            ? { phase, connectionId, after: after.length > 0 ? after : null }
            : null;
    }
    if (phase === "github") {
        if (decoded.parts.length === 1) {
            return { phase, organizationLogin: null, installationId: null };
        }
        if (decoded.parts.length === 3) {
            const organizationLogin = readTeamKeysetTextV1(decoded.parts[1]);
            const installationId = readTeamKeysetIdV1(decoded.parts[2]);
            return organizationLogin !== null && installationId !== null
                ? { phase, organizationLogin, installationId }
                : null;
        }
    }
    return null;
}

function encodeWorkosSetupCursor(input: Readonly<{
    queryKey: string;
    connectionId: string;
    after: string | null;
}>): string {
    return encodeTeamKeysetCursorV1({
        queryKey: input.queryKey,
        parts: ["workos", input.connectionId, input.after ?? ""],
    });
}

function encodeGitHubSetupCursor(input: Readonly<{
    queryKey: string;
    organizationLogin?: string;
    installationId?: string;
}>): string {
    return encodeTeamKeysetCursorV1({
        queryKey: input.queryKey,
        parts: input.organizationLogin !== undefined && input.installationId !== undefined
            ? ["github", input.organizationLogin, input.installationId]
            : ["github"],
    });
}

/**
 * Lists server-verified source choices for setup without exposing organization
 * ids or accepting client-entered provider ids. Eligibility remains owned by
 * the existing Home policy, Team authority, WorkOS runtime, and GitHub owner
 * predicates that the create path also consumes.
 */
export async function listDirectorySourceSetupOptionsForActor(
    input: TeamDirectorySourceSetupListInputV1 & Partial<TeamOperationAuthenticationContext> & Readonly<{
        actorAccountId: string;
        env: NodeJS.ProcessEnv;
    }>,
    dependencies: Readonly<{
        resolveWorkosPlatform?: (
            env: NodeJS.ProcessEnv,
            requestPolicy?: WorkosPlatformRequestPolicy,
        ) => WorkosPlatformConfigResolution;
    }> = {},
): Promise<DirectoryAdministrationResult<TeamDirectorySourceSetupOptionsV1>> {
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const query = input.query?.trim().toLowerCase() ?? "";
    const queryKey = `directory-source-setup:${input.teamId}:${query}`;
    const preflight = await inTx(async (tx) => {
        const authorized = await authorizeDirectoryAdministrationInTx(tx, input);
        if (!authorized.ok) return authorized;
        const [workosAllowed, githubAllowed] = await Promise.all([
            isDirectorySourceKindAllowedInTx(tx, "workos_directory"),
            isDirectorySourceKindAllowedInTx(tx, "github_organization"),
        ]);
        const [connections, home] = await Promise.all([
            // The connection's own `enabled` flag governs SSO sign-in only. The
            // directory purpose needs the same-Team WorkOS organization carrier
            // and an enabled provider instance; `resolveTeamWorkosConnectionRuntimeInTx`
            // remains the owner of that decision and rejects anything else.
            workosAllowed ? tx.teamIdentityConnection.findMany({
                where: {
                    teamId: input.teamId,
                    providerInstance: { kind: "workos_sso", enabled: true },
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                select: { id: true },
            }) : Promise.resolve([]),
            readHomeGovernancePolicyInTx(tx),
        ]);
        return {
            ok: true as const,
            value: { workosAllowed, githubAllowed, connections, home },
        };
    });
    if (!preflight.ok) return preflight;
    const cursor = input.cursor
        ? decodeDirectorySourceSetupCursor(input.cursor, queryKey)
        : null;
    if (input.cursor && cursor === null) {
        return { ok: false, error: "invalid_team_cursor" };
    }
    if (cursor?.phase === "workos" && !preflight.value.workosAllowed) {
        return { ok: false, error: "invalid_team_cursor" };
    }
    if (cursor?.phase === "github" && !preflight.value.githubAllowed) {
        return { ok: false, error: "invalid_team_cursor" };
    }

    if (cursor?.phase !== "github" && preflight.value.workosAllowed) {
        // One organization is represented by its first stable Team connection.
        // This keeps the provider's directory identity canonical even when two
        // connection rows refer to the same WorkOS organization.
        const runtimesByOrganization = new Map<string, WorkosSetupConnectionRuntime>();
        for (const connection of preflight.value.connections) {
            const runtime = await inTx(async (tx) => await resolveTeamWorkosConnectionRuntimeInTx(tx, {
                env: input.env,
                teamId: input.teamId,
                connectionId: connection.id,
                purpose: "directory",
                requestPolicy: resolveWorkosPlatformRequestPolicy(),
            }, dependencies.resolveWorkosPlatform
                ? { resolvePlatform: dependencies.resolveWorkosPlatform }
                : undefined));
            if (runtime.status === "not_configured") continue;
            if (runtime.status !== "ready") return { ok: false, error: "directory_sync_unavailable" };
            const organizationId = runtime.connection.externalReference.organizationId;
            if (!runtimesByOrganization.has(organizationId)) {
                runtimesByOrganization.set(organizationId, {
                    connectionId: connection.id,
                    organizationId,
                    listDirectories: async (request) => (
                        await runtime.platform.client.directorySync.listDirectories(request)
                    ),
                });
            }
        }
        const workosRuntimes = [...runtimesByOrganization.values()];
        const runtimeIndex = cursor?.phase === "workos"
            ? workosRuntimes.findIndex((runtime) => runtime.connectionId === cursor.connectionId)
            : 0;
        if (cursor?.phase === "workos" && runtimeIndex < 0) {
            return { ok: false, error: "invalid_team_cursor" };
        }
        const runtime = workosRuntimes[runtimeIndex];
        if (runtime) {
            const after = cursor?.phase === "workos" ? cursor.after : null;
            let page: unknown;
            try {
                page = await runtime.listDirectories({
                    organizationId: runtime.organizationId,
                    limit,
                    ...(after ? { after } : {}),
                });
            } catch {
                return { ok: false, error: "directory_sync_unavailable" };
            }
            if (!isWorkosSetupDirectoryPage(page) || page.data.length > limit) {
                return { ok: false, error: "directory_sync_unavailable" };
            }
            const nextAfter = page.listMetadata.after ?? null;
            if (nextAfter !== null && nextAfter === after) {
                return { ok: false, error: "directory_sync_unavailable" };
            }
            const candidatesByExternalSourceKey = new Map<
                string,
                TeamDirectorySourceSetupOptionsV1["items"][number]
            >();
            for (const directory of page.data) {
                if (
                    directory.state !== "active"
                    || directory.organizationId !== runtime.organizationId
                    || (query.length > 0 && !directory.name.toLowerCase().includes(query))
                ) continue;
                const externalSourceKey = deriveWorkosDirectoryExternalSourceKey({
                    organizationId: runtime.organizationId,
                    directoryId: directory.id,
                });
                if (!candidatesByExternalSourceKey.has(externalSourceKey)) {
                    candidatesByExternalSourceKey.set(externalSourceKey, {
                        kind: "workos_directory",
                        displayName: directory.name.trim(),
                        teamIdentityConnectionId: runtime.connectionId,
                        workosDirectoryId: directory.id,
                    });
                }
            }
            const candidateKeys = [...candidatesByExternalSourceKey.keys()];
            const existingKeys = candidateKeys.length > 0
                ? new Set((await inTx(async (tx) => await tx.teamDirectorySource.findMany({
                    where: {
                        teamId: input.teamId,
                        kind: "workos_directory",
                        externalSourceKey: { in: candidateKeys },
                    },
                    select: { externalSourceKey: true },
                }))).map((source) => source.externalSourceKey))
                : new Set<string>();
            const items = [...candidatesByExternalSourceKey.entries()]
                .filter(([externalSourceKey]) => !existingKeys.has(externalSourceKey))
                .map(([, option]) => option);
            const nextRuntime = workosRuntimes[runtimeIndex + 1];
            const nextCursor = nextAfter !== null
                ? encodeWorkosSetupCursor({ queryKey, connectionId: runtime.connectionId, after: nextAfter })
                : nextRuntime
                    ? encodeWorkosSetupCursor({ queryKey, connectionId: nextRuntime.connectionId, after: null })
                    : preflight.value.githubAllowed
                        ? encodeGitHubSetupCursor({ queryKey })
                        : null;
            return {
                ok: true,
                value: { v: 1, items, nextCursor, complete: nextCursor === null },
            };
        }
    }

    if (!preflight.value.githubAllowed) {
        return { ok: true, value: { v: 1, items: [], nextCursor: null, complete: true } };
    }
    const githubCursor = cursor?.phase === "github" ? cursor : null;
    const githubRows = await inTx(async (tx) => await tx.gitHubAppInstallation.findMany({
        where: {
            state: "verified",
            suspendedAt: null,
            registration: {
                state: "verified",
                OR: [{ ownerTeamId: null }, { ownerTeamId: input.teamId }],
            },
            directorySources: { none: {} },
            ...(githubCursor?.organizationLogin && githubCursor.installationId ? {
                OR: [
                    { githubOrganizationLogin: { gt: githubCursor.organizationLogin } },
                    {
                        githubOrganizationLogin: githubCursor.organizationLogin,
                        id: { gt: githubCursor.installationId },
                    },
                ],
            } : {}),
        },
        orderBy: [{ githubOrganizationLogin: "asc" }, { id: "asc" }],
        take: limit + 1,
        select: {
            id: true,
            state: true,
            suspendedAt: true,
            verifiedPermissions: true,
            githubOrganizationLogin: true,
            registration: { select: {
                id: true,
                ownerTeamId: true,
                state: true,
                githubHost: true,
                config: true,
                encryptedSecrets: true,
            } },
        },
    }));
    const scannedRows = githubRows.slice(0, limit);
    const items = scannedRows.flatMap((installation) => {
        if (!resolveStoredGitHubDirectoryReadiness({
            teamId: input.teamId,
            home: preflight.value.home,
            installation: {
                ...installation,
                registration: {
                    ...installation.registration,
                    encryptedSecrets: Uint8Array.from(installation.registration.encryptedSecrets),
                },
            },
        }).ok || (query.length > 0 && !installation.githubOrganizationLogin.toLowerCase().includes(query))) {
            return [];
        }
        return [{
            kind: "github_organization" as const,
            displayName: installation.githubOrganizationLogin,
            githubAppInstallationId: installation.id,
        }];
    });
    const lastScanned = scannedRows.at(-1);
    const nextCursor = githubRows.length > limit && lastScanned
        ? encodeGitHubSetupCursor({
            queryKey,
            organizationLogin: lastScanned.githubOrganizationLogin,
            installationId: lastScanned.id,
        })
        : null;
    return {
        ok: true,
        value: { v: 1, items, nextCursor, complete: nextCursor === null },
    };
}

const DEFAULT_PAGE_LIMIT = 50;

type DirectoryAdministrationError =
    | TeamErrorCodeV1
    | TeamDirectorySafeErrorCodeV1
    | Extract<TeamIdentityErrorCodeV1, "team_identity_not_allowed">;
type DirectoryAdministrationResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: DirectoryAdministrationError }>;

const sourceProjectionSelect = {
    id: true,
    teamId: true,
    kind: true,
    state: true,
    displayName: true,
    teamIdentityConnectionId: true,
    activeReconcileRunId: true,
    activeReconcileStartedAt: true,
    lastAttemptAt: true,
    lastSuccessAt: true,
    lastFullReconcileAt: true,
    lastErrorCode: true,
    consecutiveFailureCount: true,
    retryNotBefore: true,
} as const;

async function authorizeDirectoryAdministrationInTx(
    tx: Tx,
    input: Partial<TeamOperationAuthenticationContext> & Readonly<{ teamId: string; actorAccountId: string }>,
): Promise<DirectoryAdministrationResult<null>> {
    const authority = await authorizeTeamIdentityAdministrationInTx(tx, input);
    return authority.ok ? { ok: true, value: null } : authority;
}

function projectSource(source: Parameters<typeof projectTeamDirectorySourceSummary>[0]["source"], now?: Date) {
    return projectTeamDirectorySourceSummary({ source, now });
}

async function readDirectorySourceRemovalImpactInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; sourceId: string }>,
): Promise<TeamDirectorySourceRemoveResultV1["impact"]> {
    const [ownedMemberships, directoryCreatedGroupsRetained, nativeMembershipsPreserved] =
        await Promise.all([
            tx.teamProvisionedIdentity.findMany({
                where: { directorySourceId: input.sourceId, teamMembershipId: { not: null } },
                select: { teamMembershipId: true },
            }),
            tx.teamExternalGroupBinding.count({
                where: { directorySourceId: input.sourceId, bindingMode: "directory_created" },
            }),
            tx.teamProvisionedIdentity.count({
                where: {
                    directorySourceId: input.sourceId,
                    boundAccountId: { not: null },
                    teamMembershipId: null,
                    boundAccount: { teamMemberships: { some: { teamId: input.teamId } } },
                },
            }),
        ]);
    const ownedMembershipIds = ownedMemberships.flatMap(({ teamMembershipId }) =>
        teamMembershipId === null ? [] : [teamMembershipId]
    );
    const groupContributionsRemoved = await tx.teamGroupMembershipExternalContribution.count({
        where: {
            OR: [
                { binding: { directorySourceId: input.sourceId } },
                ...(ownedMembershipIds.length > 0
                    ? [{ membership: { teamMembershipId: { in: ownedMembershipIds } } }]
                    : []),
            ],
        },
    });
    const [ownedParentGroupMembershipsRemoved, sourceContributions] = await Promise.all([
        ownedMembershipIds.length > 0
            ? tx.teamGroupMembership.count({ where: { teamMembershipId: { in: ownedMembershipIds } } })
            : Promise.resolve(0),
        tx.teamGroupMembershipExternalContribution.findMany({
            where: {
                binding: { directorySourceId: input.sourceId },
                ...(ownedMembershipIds.length > 0
                    ? { teamMembershipId: { notIn: ownedMembershipIds } }
                    : {}),
            },
            select: {
                teamGroupId: true,
                teamMembershipId: true,
                membership: {
                    select: {
                        nativeContribution: true,
                        externalContributions: {
                            select: { binding: { select: { directorySourceId: true } } },
                        },
                    },
                },
            },
        }),
    ]);
    const sourceOnlyEffectiveMemberships = new Set(
        sourceContributions
            .filter(({ membership }) =>
                !membership.nativeContribution
                && membership.externalContributions.every(({ binding }) =>
                    binding.directorySourceId === input.sourceId
                )
            )
            .map(({ teamGroupId, teamMembershipId }) => `${teamGroupId}\0${teamMembershipId}`),
    );
    const preservedNativeMembershipRows = await tx.teamGroupMembershipExternalContribution.findMany({
        where: {
            binding: { directorySourceId: input.sourceId },
            membership: {
                nativeContribution: true,
                ...(ownedMembershipIds.length > 0
                    ? { teamMembershipId: { notIn: ownedMembershipIds } }
                    : {}),
            },
        },
        select: { teamGroupId: true, teamMembershipId: true },
    });
    const nativeGroupContributionsPreserved = new Set(
        preservedNativeMembershipRows.map(({ teamGroupId, teamMembershipId }) =>
            `${teamGroupId}\0${teamMembershipId}`
        ),
    ).size;
    return {
        teamMembershipsRemoved: ownedMembershipIds.length,
        groupMembershipsRemoved: ownedParentGroupMembershipsRemoved + sourceOnlyEffectiveMemberships.size,
        groupContributionsRemoved,
        directoryCreatedGroupsRetained,
        nativeMembershipsPreserved,
        nativeGroupContributionsPreserved,
    };
}

export async function listDirectorySourcesForActor(
    input: TeamDirectorySourcesListInputV1 & Partial<TeamOperationAuthenticationContext> & Readonly<{ actorAccountId: string; now?: Date }>,
): Promise<DirectoryAdministrationResult<TeamDirectorySourcePageV1>> {
    return await inTx(async (tx) => {
        const authorized = await authorizeDirectoryAdministrationInTx(tx, input);
        if (!authorized.ok) return authorized;
        const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
        const queryKey = `directory-sources:${input.teamId}`;
        let cursor: Readonly<{ createdAt: Date; id: string }> | null = null;
        if (input.cursor) {
            const decoded = decodeTeamKeysetCursorV1(input.cursor, queryKey);
            const time = decoded.status === "ok" ? readTeamKeysetTimeV1(decoded.parts[0]) : null;
            const id = decoded.status === "ok" ? readTeamKeysetIdV1(decoded.parts[1]) : null;
            if (time === null || id === null) return { ok: false, error: "invalid_team_cursor" };
            cursor = { createdAt: new Date(time), id };
        }
        const rows = await tx.teamDirectorySource.findMany({
            where: {
                teamId: input.teamId,
                ...(cursor ? {
                    OR: [
                        { createdAt: { gt: cursor.createdAt } },
                        { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                    ],
                } : {}),
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: limit + 1,
            select: { ...sourceProjectionSelect, createdAt: true },
        });
        const pageRows = rows.slice(0, limit);
        const last = pageRows.at(-1);
        return {
            ok: true,
            value: {
                items: pageRows.map((source) => projectSource(source, input.now)),
                nextCursor: rows.length > limit && last
                    ? encodeTeamKeysetCursorV1({ queryKey, parts: [last.createdAt.getTime(), last.id] })
                    : null,
            },
        };
    });
}

export async function getDirectorySourceForActor(input: Partial<TeamOperationAuthenticationContext> & Readonly<{
    teamId: string;
    sourceId: string;
    actorAccountId: string;
    now?: Date;
}>): Promise<DirectoryAdministrationResult<TeamDirectorySourceSummaryV1>> {
    return await inTx(async (tx) => {
        const authorized = await authorizeDirectoryAdministrationInTx(tx, input);
        if (!authorized.ok) return authorized;
        const source = await tx.teamDirectorySource.findFirst({
            where: { id: input.sourceId, teamId: input.teamId },
            select: sourceProjectionSelect,
        });
        return source
            ? { ok: true, value: projectSource(source, input.now) }
            : { ok: false, error: "directory_source_not_found" };
    });
}

export async function listDirectoryPeopleForActor(
    input: TeamDirectoryPeopleListInputV1 & Partial<TeamOperationAuthenticationContext> & Readonly<{ actorAccountId: string }>,
): Promise<DirectoryAdministrationResult<TeamDirectoryPeoplePageV1>> {
    return await inTx(async (tx) => {
        const authorized = await authorizeDirectoryAdministrationInTx(tx, input);
        if (!authorized.ok) return authorized;
        const source = await tx.teamDirectorySource.findFirst({
            where: { id: input.sourceId, teamId: input.teamId },
            select: { id: true, displayName: true },
        });
        if (!source) return { ok: false, error: "directory_source_not_found" } as const;
        const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
        const queryKey = `directory-people:${input.teamId}:${input.sourceId}`;
        let cursor: Readonly<{ createdAt: Date; id: string }> | null = null;
        if (input.cursor) {
            const decoded = decodeTeamKeysetCursorV1(input.cursor, queryKey);
            const time = decoded.status === "ok" ? readTeamKeysetTimeV1(decoded.parts[0]) : null;
            const id = decoded.status === "ok" ? readTeamKeysetIdV1(decoded.parts[1]) : null;
            if (time === null || id === null) return { ok: false, error: "invalid_team_cursor" };
            cursor = { createdAt: new Date(time), id };
        }
        const rows = await tx.teamProvisionedIdentity.findMany({
            where: {
                directorySourceId: source.id,
                ...(cursor ? {
                    OR: [
                        { createdAt: { gt: cursor.createdAt } },
                        { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                    ],
                } : {}),
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: limit + 1,
            select: {
                id: true,
                externalUserId: true,
                displayName: true,
                normalizedEmail: true,
                externalLogin: true,
                state: true,
                boundAccountId: true,
                createdAt: true,
            },
        });
        const pageRows = rows.slice(0, limit);
        const boundAccountIds = [...new Set(pageRows.flatMap((row) => row.boundAccountId ?? []))];
        const memberships = boundAccountIds.length === 0 ? [] : await tx.teamMembership.findMany({
            where: { teamId: input.teamId, accountId: { in: boundAccountIds } },
            select: { id: true, accountId: true },
        });
        const membershipByAccountId = new Map(memberships.map((membership) => [membership.accountId, membership.id]));
        const last = pageRows.at(-1);
        return {
            ok: true,
            value: {
                items: pageRows.map((row) => ({
                    v: 1,
                    id: row.id,
                    sourceId: source.id,
                    externalUserId: row.externalUserId,
                    displayName: row.displayName,
                    email: row.normalizedEmail,
                    externalLogin: row.externalLogin,
                    state: row.state,
                    accountBinding: row.boundAccountId === null
                        ? { state: "unbound" as const }
                        : {
                            state: "bound" as const,
                            accountId: row.boundAccountId,
                            teamMembershipId: membershipByAccountId.get(row.boundAccountId) ?? null,
                        },
                    sourceLabel: source.displayName,
                })),
                nextCursor: rows.length > limit && last
                    ? encodeTeamKeysetCursorV1({ queryKey, parts: [last.createdAt.getTime(), last.id] })
                    : null,
            },
        };
    });
}

export async function listDirectoryGroupsForActor(
    input: TeamDirectoryGroupsListInputV1 & Partial<TeamOperationAuthenticationContext> & Readonly<{ actorAccountId: string }>,
): Promise<DirectoryAdministrationResult<TeamDirectoryGroupPageV1>> {
    return await inTx(async (tx) => {
        const authorized = await authorizeDirectoryAdministrationInTx(tx, input);
        if (!authorized.ok) return authorized;
        const source = await tx.teamDirectorySource.findFirst({
            where: { id: input.sourceId, teamId: input.teamId },
            select: {
                id: true,
                displayName: true,
                state: true,
                activeReconcileRunId: true,
                lastFullReconcileAt: true,
            },
        });
        if (!source) return { ok: false, error: "directory_source_not_found" } as const;
        const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
        const query = input.query?.trim() ?? "";
        const queryKey = `directory-groups:${input.teamId}:${input.sourceId}:${query}`;
        let cursor: Readonly<{ displayName: string; id: string }> | null = null;
        if (input.cursor) {
            const decoded = decodeTeamKeysetCursorV1(input.cursor, queryKey);
            const displayName = decoded.status === "ok" ? readTeamKeysetTextV1(decoded.parts[0]) : null;
            const id = decoded.status === "ok" ? readTeamKeysetIdV1(decoded.parts[1]) : null;
            if (displayName === null || id === null) return { ok: false, error: "invalid_team_cursor" };
            cursor = { displayName, id };
        }
        const rows = await tx.teamDirectoryGroup.findMany({
            where: {
                directorySourceId: source.id,
                ...(query.length > 0 ? { externalDisplayName: { contains: query } } : {}),
                ...(cursor ? {
                    OR: [
                        { externalDisplayName: { gt: cursor.displayName } },
                        { externalDisplayName: cursor.displayName, id: { gt: cursor.id } },
                    ],
                } : {}),
            },
            orderBy: [{ externalDisplayName: "asc" }, { id: "asc" }],
            take: limit + 1,
            select: {
                id: true,
                externalGroupId: true,
                externalDisplayName: true,
                state: true,
            },
        });
        const pageRows = rows.slice(0, limit);
        const externalGroupIds = pageRows.map((row) => row.externalGroupId);
        const bindings = pageRows.length === 0 ? [] : await tx.teamExternalGroupBinding.findMany({
            where: {
                directorySourceId: source.id,
                externalGroupId: { in: externalGroupIds },
            },
            select: { id: true, externalGroupId: true, bindingMode: true, teamGroupId: true },
        });
        const bindingByExternalGroupId = new Map(bindings.map((binding) => [binding.externalGroupId, binding]));
        const complete = source.lastFullReconcileAt !== null && isDirectorySourceProjectionComplete(source);
        // Count in the database across this bounded Group page: several people
        // can bind the same Account, and loading their full rosters is unbounded.
        const quote = getDbProviderFromEnv(process.env, "postgres") === "mysql" ? "`" : '"';
        const identifier = (name: string) => prismaRuntime.raw(`${quote}${name}${quote}`);
        const counts = complete && pageRows.length > 0 ? await tx.$queryRaw<Array<{
            externalGroupId: string;
            memberCount: bigint | number;
            boundAccountCount: bigint | number;
            unboundPeopleCount: bigint | number;
        }>>(prismaRuntime.sql`
            SELECT directory_member.${identifier("externalGroupId")} AS ${identifier("externalGroupId")},
                COUNT(*) AS ${identifier("memberCount")},
                COUNT(DISTINCT person.${identifier("boundAccountId")}) AS ${identifier("boundAccountCount")},
                COUNT(CASE WHEN person.${identifier("boundAccountId")} IS NULL THEN 1 END) AS ${identifier("unboundPeopleCount")}
            FROM ${identifier("TeamDirectoryGroupMember")} directory_member
            JOIN ${identifier("TeamProvisionedIdentity")} person
                ON person.${identifier("directorySourceId")} = directory_member.${identifier("directorySourceId")}
                AND person.${identifier("externalUserId")} = directory_member.${identifier("externalUserId")}
            WHERE directory_member.${identifier("directorySourceId")} = ${source.id}
                AND directory_member.${identifier("externalGroupId")} IN (${prismaRuntime.join(externalGroupIds)})
            GROUP BY directory_member.${identifier("externalGroupId")}
        `) : [];
        const countsByExternalGroupId = new Map(counts.map((row) => [row.externalGroupId, row]));
        const last = pageRows.at(-1);
        return {
            ok: true,
            value: {
                items: pageRows.map((row) => {
                    const binding = bindingByExternalGroupId.get(row.externalGroupId);
                    const count = countsByExternalGroupId.get(row.externalGroupId);
                    return {
                        v: 1,
                        id: row.id,
                        sourceId: source.id,
                        externalGroupId: row.externalGroupId,
                        displayName: row.externalDisplayName,
                        state: row.state,
                        memberCount: complete ? Number(count?.memberCount ?? 0) : null,
                        boundAccountCount: complete ? Number(count?.boundAccountCount ?? 0) : null,
                        unboundPeopleCount: complete ? Number(count?.unboundPeopleCount ?? 0) : null,
                        mapping: binding
                            ? {
                                state: "bound" as const,
                                bindingId: binding.id,
                                mode: binding.bindingMode,
                                teamGroupId: binding.teamGroupId,
                            }
                            : { state: "unbound" as const },
                        lastCompleteObservationAt: source.lastFullReconcileAt?.toISOString() ?? null,
                        sourceLabel: source.displayName,
                    };
                }),
                nextCursor: rows.length > limit && last
                    ? encodeTeamKeysetCursorV1({ queryKey, parts: [last.externalDisplayName, last.id] })
                    : null,
            },
        };
    });
}

export async function createDirectorySourceForActor(
    input: TeamDirectorySourceCreateInputV1 & Partial<TeamOperationAuthenticationContext> & Readonly<{ actorAccountId: string; now?: Date }>,
): Promise<DirectoryAdministrationResult<TeamDirectorySourceSummaryV1>> {
    const result = await inTx(async (tx) => {
        const authorized = await authorizeDirectoryAdministrationInTx(tx, input);
        if (!authorized.ok) return authorized;
        const created = await createDirectorySourceInTx(tx, input.kind === "workos_directory"
            ? { ...input, now: input.now }
            : input);
        if (!created.ok) {
            return { ok: false, error: "directory_source_identity_mismatch" } as const;
        }
        const source = await tx.teamDirectorySource.findUniqueOrThrow({
            where: { id: created.sourceId },
            select: sourceProjectionSelect,
        });
        await publishTeamChangedInTx(tx, { teamId: input.teamId });
        return { ok: true, value: projectSource(source, input.now) } as const;
    });
    // Initial creation enters `initializing` with a durable run token. Wake the
    // local worker only after that transaction commits; other worker processes
    // discover the same source through the durable due predicate.
    if (result.ok) requestEnterpriseIdentitySyncNudge();
    return result;
}

export async function syncDirectorySourceForActor(input: Partial<TeamOperationAuthenticationContext> & Readonly<{
    teamId: string;
    sourceId: string;
    actorAccountId: string;
    now?: Date;
}>): Promise<DirectoryAdministrationResult<TeamDirectorySourceSyncResultV1>> {
    const result = await inTx(async (tx) => {
        const authorized = await authorizeDirectoryAdministrationInTx(tx, input);
        if (!authorized.ok) return authorized;
        const source = await tx.teamDirectorySource.findFirst({
            where: { id: input.sourceId, teamId: input.teamId },
            select: sourceProjectionSelect,
        });
        if (!source) return { ok: false, error: "directory_source_not_found" } as const;
        const requested = await requestDirectorySourceSyncInTx(tx, {
            sourceId: source.id,
            now: input.now,
        });
        if (!requested.ok) return { ok: false, error: requested.code } as const;
        return {
            ok: true,
            value: { v: 1, status: requested.status, source: projectSource(source, input.now) },
        } as const;
    });
    if (result.ok) requestEnterpriseIdentitySyncNudge();
    return result;
}

export async function setDirectorySourcePausedForActor(input: Partial<TeamOperationAuthenticationContext> & Readonly<{
    teamId: string;
    sourceId: string;
    actorAccountId: string;
    paused: boolean;
    now?: Date;
}>): Promise<DirectoryAdministrationResult<TeamDirectorySourceSummaryV1>> {
    const result = await inTx(async (tx) => {
        const authorized = await authorizeDirectoryAdministrationInTx(tx, input);
        if (!authorized.ok) return authorized;
        const source = await tx.teamDirectorySource.findFirst({
            where: { id: input.sourceId, teamId: input.teamId },
            select: sourceProjectionSelect,
        });
        if (!source) return { ok: false, error: "directory_source_not_found" } as const;
        if (input.paused) {
            await tx.teamDirectorySource.update({
                where: { id: source.id },
                data: {
                    state: "paused",
                    activeReconcileRunId: null,
                    activeReconcileStartedAt: null,
                    manualSyncRequestedAt: null,
                },
            });
        } else {
            // child 05 §10.1/:498: Resume clears the pause and ATOMICALLY
            // records the full-scan request. A source the request owner would
            // refuse is refused here, before anything is written, with the
            // same typed reason — never an `ok` that advertises a repair the
            // worker can never start.
            const refusal = await readDirectorySourceRepairRefusalInTx(
                tx,
                await tx.teamDirectorySource.findUniqueOrThrow({
                    where: { id: source.id },
                    select: { kind: true, bindingConfig: true },
                }),
            );
            if (refusal !== null) return { ok: false, error: refusal } as const;
            // Resume owns the lifecycle reset — the parked failure, its backoff
            // and any abandoned run token are what pausing suspended.
            await tx.teamDirectorySource.update({
                where: { id: source.id },
                data: {
                    state: "initializing",
                    activeReconcileRunId: null,
                    activeReconcileStartedAt: null,
                    lastErrorCode: null,
                    consecutiveFailureCount: 0,
                    retryNotBefore: null,
                },
            });
            const requested = await requestDirectorySourceSyncInTx(tx, {
                sourceId: source.id,
                now: input.now,
            });
            // The refusal check above ran in this transaction on the same row.
            if (!requested.ok) {
                throw new Error(`directory Resume lost its full-scan request: ${requested.code}`);
            }
        }
        const committed = await tx.teamDirectorySource.findUniqueOrThrow({
            where: { id: source.id },
            select: sourceProjectionSelect,
        });
        await publishTeamChangedInTx(tx, { teamId: input.teamId });
        return { ok: true, value: projectSource(committed, input.now) } as const;
    });
    // Resume records a durable repair request in the transaction above. Wake
    // the local worker after commit so an in-process worker observes it
    // immediately; another process still discovers the same request through
    // the durable source row on its normal poll.
    if (result.ok && !input.paused) requestEnterpriseIdentitySyncNudge();
    return result;
}

/**
 * Reads the current source-owned removal consequences for human confirmation.
 * Removal repeats this owner-local read in its deciding transaction, so this
 * projection explains the current impact without becoming removal authority.
 */
export async function preflightDirectorySourceRemovalForActor(input: Partial<TeamOperationAuthenticationContext> & Readonly<{
    teamId: string;
    sourceId: string;
    actorAccountId: string;
}>): Promise<DirectoryAdministrationResult<TeamDirectorySourceRemovalPreflightV1>> {
    return await inTx(async (tx) => {
        const authorized = await authorizeDirectoryAdministrationInTx(tx, input);
        if (!authorized.ok) return authorized;
        const source = await tx.teamDirectorySource.findFirst({
            where: { id: input.sourceId, teamId: input.teamId },
            select: { id: true, displayName: true },
        });
        if (!source) return { ok: false, error: "directory_source_not_found" };
        return {
            ok: true,
            value: {
                v: 1,
                status: "allowed",
                sourceId: source.id,
                sourceLabel: source.displayName,
                impact: await readDirectorySourceRemovalImpactInTx(tx, {
                    teamId: input.teamId,
                    sourceId: source.id,
                }),
            },
        };
    });
}

export async function removeDirectorySourceForActor(input: Partial<TeamOperationAuthenticationContext> & Readonly<{
    teamId: string;
    sourceId: string;
    actorAccountId: string;
}>): Promise<DirectoryAdministrationResult<TeamDirectorySourceRemoveResultV1>> {
    return await inTx(async (tx) => {
        const authorized = await authorizeDirectoryAdministrationInTx(tx, input);
        if (!authorized.ok) return authorized;
        const source = await tx.teamDirectorySource.findFirst({
            where: { id: input.sourceId, teamId: input.teamId },
            select: { id: true },
        });
        const emptyImpact = {
            teamMembershipsRemoved: 0,
            groupMembershipsRemoved: 0,
            groupContributionsRemoved: 0,
            directoryCreatedGroupsRetained: 0,
            nativeMembershipsPreserved: 0,
            nativeGroupContributionsPreserved: 0,
        };
        if (!source) {
            return { ok: true, value: { v: 1, status: "already_absent", impact: emptyImpact } };
        }

        const impactBeforeRemoval = await readDirectorySourceRemovalImpactInTx(tx, {
            teamId: input.teamId,
            sourceId: source.id,
        });
        const revoked = await removeDirectorySourceInTx(tx, {
            teamId: input.teamId,
            sourceId: source.id,
        });
        return {
            ok: true,
            value: {
                v: 1,
                status: "removed",
                impact: {
                    teamMembershipsRemoved: revoked.membershipsRemoved,
                    groupMembershipsRemoved: impactBeforeRemoval.groupMembershipsRemoved,
                    groupContributionsRemoved: impactBeforeRemoval.groupContributionsRemoved,
                    directoryCreatedGroupsRetained: impactBeforeRemoval.directoryCreatedGroupsRetained,
                    nativeMembershipsPreserved: impactBeforeRemoval.nativeMembershipsPreserved,
                    nativeGroupContributionsPreserved: impactBeforeRemoval.nativeGroupContributionsPreserved,
                },
            },
        };
    });
}

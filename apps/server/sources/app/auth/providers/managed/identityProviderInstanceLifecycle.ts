import { randomUUID } from "node:crypto";
import {
    normalizeTeamAuthenticationPolicyV1,
    TeamAuthenticationPolicyV1Schema,
} from "@happier-dev/protocol";

import type { ProviderCatalogContext } from "@/app/auth/providers/providerReference";
import { resolveDeploymentProviderSnapshot } from "@/app/auth/providers/providerModules";
import { resolveAuthMethodRegistry } from "@/app/auth/methods/registry";
import type { Tx } from "@/storage/inTx";

import {
    parseIdentityProviderConfig,
    parseIdentityProviderSecrets,
    type IdentityProviderConfig,
    type IdentityProviderSecrets,
    type ManagedIdentityProviderKind,
} from "./identityProviderDocuments";
import { decryptIdentityProviderSecrets, encryptIdentityProviderSecrets } from "./identityProviderSecretCipher";
import { isGitHubAppInstallationEligibleForOwnerInTx } from "@/app/integrations/github/githubAppInstallationEligibility";
import { publishProviderLinkedIdentityChangesInTx } from "@/app/auth/providers/accountIdentityLifecycle";
import { applyTeamSessionAuthenticationContextEffectsInTx } from "@/app/teams/memberships/sessionAccessEffects";

export type IdentityProviderInstanceView = Readonly<{
    id: string;
    owner: ProviderCatalogContext;
    kind: ManagedIdentityProviderKind;
    displayName: string;
    enabled: boolean;
    firstEnabledAt: Date | null;
    securityRevision: number;
    revision: number;
    lastSuccessfulTest: Readonly<{
        testedAt: Date;
        runtimeFingerprint: string;
        securityRevision: number;
    }> | null;
    config: IdentityProviderConfig;
    githubAppInstallationId: string | null;
    createdByAccountId: string | null;
    createdAt: Date;
    updatedAt: Date;
}>;

type IdentityProviderInstanceRow = Readonly<{
    id: string;
    ownerTeamId: string | null;
    kind: string;
    displayName: string;
    enabled: boolean;
    firstEnabledAt: Date | null;
    securityRevision: number;
    revision: number;
    lastSuccessfulTestAt: Date | null;
    lastSuccessfulTestRuntimeFingerprint: string | null;
    lastSuccessfulTestSecurityRevision: number | null;
    config: unknown;
    githubAppInstallationId: string | null;
    encryptedSecrets: Uint8Array<ArrayBufferLike> | null;
    createdByAccountId: string | null;
    createdAt: Date;
    updatedAt: Date;
}>;

type IdentityProviderInstanceSafeRow = Omit<IdentityProviderInstanceRow, "encryptedSecrets">;

const instanceSafeSelect = {
    id: true,
    ownerTeamId: true,
    kind: true,
    displayName: true,
    enabled: true,
    firstEnabledAt: true,
    securityRevision: true,
    revision: true,
    lastSuccessfulTestAt: true,
    lastSuccessfulTestRuntimeFingerprint: true,
    lastSuccessfulTestSecurityRevision: true,
    config: true,
    githubAppInstallationId: true,
    createdByAccountId: true,
    createdAt: true,
    updatedAt: true,
} as const;

const instanceRuntimeSelect = {
    ...instanceSafeSelect,
    encryptedSecrets: true,
} as const;

const instanceSecretHealthSelect = {
    id: true,
    kind: true,
    config: true,
    encryptedSecrets: true,
} as const;

function ownerTeamId(owner: ProviderCatalogContext): string | null {
    return owner.kind === "home" ? null : owner.teamId;
}

function sameOwner(row: Pick<IdentityProviderInstanceRow, "ownerTeamId">, owner: ProviderCatalogContext): boolean {
    return row.ownerTeamId === ownerTeamId(owner);
}

async function applyProviderAuthenticationContextEffectsInTx(
    tx: Tx,
    providerInstanceId: string,
): Promise<void> {
    const [connections, teams] = await Promise.all([
        tx.teamIdentityConnection.findMany({
            where: { providerInstanceId },
            select: { id: true, teamId: true },
        }),
        tx.team.findMany({ select: { id: true, authenticationPolicy: true } }),
    ]);
    const connectionIdsByTeam = new Map<string, Set<string>>();
    for (const connection of connections) {
        if (connection.teamId === null) continue;
        const ids = connectionIdsByTeam.get(connection.teamId) ?? new Set<string>();
        ids.add(connection.id);
        connectionIdsByTeam.set(connection.teamId, ids);
    }
    const normalizedProviderId = providerInstanceId.trim().toLowerCase();
    const affectedTeamIds = teams.flatMap((team) => {
        const parsed = TeamAuthenticationPolicyV1Schema.safeParse(team.authenticationPolicy);
        const policy = parsed.success ? normalizeTeamAuthenticationPolicyV1(parsed.data) : null;
        if (policy?.mode !== "restricted") return [];
        const connectionIds = connectionIdsByTeam.get(team.id);
        return policy.accepted.some((reference) => reference.kind === "home_method"
            ? reference.methodId.trim().toLowerCase() === normalizedProviderId
            : connectionIds?.has(reference.connectionId) === true)
            ? [team.id]
            : [];
    });
    await applyTeamSessionAuthenticationContextEffectsInTx(tx, { teamIds: affectedTeamIds });
}

function projectInstance(row: IdentityProviderInstanceSafeRow): IdentityProviderInstanceView | null {
    const parsed = parseIdentityProviderConfig(row.kind, row.config);
    if (!parsed.ok) return null;
    const testFields = [
        row.lastSuccessfulTestAt,
        row.lastSuccessfulTestRuntimeFingerprint,
        row.lastSuccessfulTestSecurityRevision,
    ];
    if (testFields.some((value) => value === null) && testFields.some((value) => value !== null)) {
        return null;
    }
    return Object.freeze({
        id: row.id,
        owner: row.ownerTeamId === null
            ? Object.freeze({ kind: "home" as const })
            : Object.freeze({ kind: "team" as const, teamId: row.ownerTeamId }),
        kind: parsed.value.kind,
        displayName: row.displayName,
        enabled: row.enabled,
        firstEnabledAt: row.firstEnabledAt,
        securityRevision: row.securityRevision,
        revision: row.revision,
        lastSuccessfulTest: row.lastSuccessfulTestAt === null
            ? null
            : Object.freeze({
                testedAt: row.lastSuccessfulTestAt,
                runtimeFingerprint: row.lastSuccessfulTestRuntimeFingerprint!,
                securityRevision: row.lastSuccessfulTestSecurityRevision!,
            }),
        config: parsed.value,
        githubAppInstallationId: row.githubAppInstallationId,
        createdByAccountId: row.createdByAccountId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    });
}

function readSecrets(
    row: Pick<IdentityProviderInstanceRow, "id" | "kind" | "config" | "encryptedSecrets">,
): IdentityProviderSecrets | null | undefined {
    const config = parseIdentityProviderConfig(row.kind, row.config);
    if (!config.ok) return undefined;
    const parsed = decryptIdentityProviderSecrets({
        id: row.id,
        kind: config.value.kind,
        encryptedSecrets: row.encryptedSecrets === null
            ? null
            : Uint8Array.from(row.encryptedSecrets),
    });
    return parsed.ok ? parsed.value : undefined;
}

function securityEffectiveConfig(config: IdentityProviderConfig): unknown {
    if (config.kind !== "oidc") return config;
    const { ui: _presentation, ...securityConfig } = config;
    return securityConfig;
}

export type IdentityProviderInstanceReadResult =
    | Readonly<{ status: "ready"; instance: IdentityProviderInstanceView }>
    | Readonly<{ status: "not_found" | "unreadable" }>;

export async function readIdentityProviderInstanceInTx(
    tx: Tx,
    input: Readonly<{ id: string; owner: ProviderCatalogContext }>,
): Promise<IdentityProviderInstanceReadResult> {
    const row = await tx.identityProviderInstance.findUnique({ where: { id: input.id }, select: instanceSafeSelect });
    if (!row || !sameOwner(row, input.owner)) return { status: "not_found" };
    const instance = projectInstance(row);
    return instance ? { status: "ready", instance } : { status: "unreadable" };
}

/**
 * Reads one exact provider instance through the non-secret presentation projection.
 *
 * Account identity presentation starts from an already-linked immutable provider ID. It must not
 * enumerate owner scopes or enter the runtime path, because runtime resolution decrypts credentials.
 */
export async function readIdentityProviderInstancePresentationByIdInTx(
    tx: Tx,
    input: Readonly<{ id: string }>,
): Promise<IdentityProviderInstanceReadResult> {
    const row = await tx.identityProviderInstance.findUnique({ where: { id: input.id }, select: instanceSafeSelect });
    if (!row) return { status: "not_found" };
    const instance = projectInstance(row);
    return instance ? { status: "ready", instance } : { status: "unreadable" };
}

export async function readIdentityProviderInstancePresentationsByIdsInTx(
    tx: Tx,
    input: Readonly<{ ids: readonly string[] }>,
): Promise<ReadonlyMap<string, IdentityProviderInstanceReadResult>> {
    const ids = [...new Set(input.ids.map((id) => id.trim().toLowerCase()).filter(Boolean))];
    if (ids.length === 0) return new Map();
    const rows = await tx.identityProviderInstance.findMany({
        where: { id: { in: ids } },
        select: instanceSafeSelect,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const entries: Array<readonly [string, IdentityProviderInstanceReadResult]> = ids.map((id) => {
        const row = byId.get(id);
        if (!row) return [id, { status: "not_found" as const }];
        const instance = projectInstance(row);
        return [id, instance
            ? { status: "ready" as const, instance }
            : { status: "unreadable" as const }];
    });
    return new Map(entries);
}

export async function listIdentityProviderInstancesInTx(
    tx: Tx,
    input: Readonly<{ owner: ProviderCatalogContext; enabled?: boolean }>,
): Promise<readonly IdentityProviderInstanceReadResult[]> {
    const rows = await tx.identityProviderInstance.findMany({
        where: {
            ownerTeamId: ownerTeamId(input.owner),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: instanceSafeSelect,
    });
    return rows.map((row) => {
        const instance = projectInstance(row);
        return instance ? { status: "ready" as const, instance } : { status: "unreadable" as const };
    });
}

export type IdentityProviderSecretHealth = "configured" | "not_configured" | "unreadable";

/**
 * Reads only redacted secret health for an already-authorized owner-scoped administration view.
 * Secret bytes and parsed secret values remain inside the lifecycle owner.
 */
export async function readIdentityProviderSecretHealthByIdsInTx(
    tx: Tx,
    input: Readonly<{ ids: readonly string[]; owner: ProviderCatalogContext }>,
): Promise<ReadonlyMap<string, IdentityProviderSecretHealth>> {
    const ids = [...new Set(input.ids)];
    if (ids.length === 0) return new Map();
    const rows = await tx.identityProviderInstance.findMany({
        where: {
            id: { in: ids },
            ownerTeamId: ownerTeamId(input.owner),
        },
        select: instanceSecretHealthSelect,
    });
    return new Map(rows.map((row) => {
        const health: IdentityProviderSecretHealth = row.encryptedSecrets === null
            ? "not_configured"
            : readSecrets(row) === undefined
                ? "unreadable"
                : "configured";
        return [row.id, health] as const;
    }));
}

export type IdentityProviderInstanceRuntimeResult =
    | Readonly<{ status: "ready"; instance: IdentityProviderInstanceView; secrets: IdentityProviderSecrets | null }>
    | Readonly<{ status: "not_found" | "disabled" | "unreadable" }>;

export async function resolveIdentityProviderInstanceRuntimeInTx(
    tx: Tx,
    input: Readonly<{ id: string; owner: ProviderCatalogContext; includeDisabled?: boolean }>,
): Promise<IdentityProviderInstanceRuntimeResult> {
    const row = await tx.identityProviderInstance.findUnique({ where: { id: input.id }, select: instanceRuntimeSelect });
    if (!row || !sameOwner(row, input.owner)) return { status: "not_found" };
    if (!row.enabled && input.includeDisabled !== true) return { status: "disabled" };
    const instance = projectInstance(row);
    const secrets = readSecrets(row);
    if (!instance || secrets === undefined) return { status: "unreadable" };
    return { status: "ready", instance, secrets };
}

export type RecordIdentityProviderInstanceSuccessfulTestResult =
    | Readonly<{ status: "applied"; instance: IdentityProviderInstanceView }>
    | Readonly<{ status: "configuration_changed" | "not_found" }>;

export async function recordIdentityProviderInstanceSuccessfulTestInTx(
    tx: Tx,
    input: Readonly<{
        id: string;
        owner: ProviderCatalogContext;
        securityRevision: number;
        runtimeFingerprint: string;
        testedAt: Date;
    }>,
): Promise<RecordIdentityProviderInstanceSuccessfulTestResult> {
    const row = await tx.identityProviderInstance.findUnique({
        where: { id: input.id },
        select: instanceSafeSelect,
    });
    if (!row || !sameOwner(row, input.owner)) return { status: "not_found" };
    if (row.securityRevision !== input.securityRevision) return { status: "configuration_changed" };
    const updated = await tx.identityProviderInstance.updateMany({
        where: {
            id: input.id,
            ownerTeamId: ownerTeamId(input.owner),
            securityRevision: input.securityRevision,
        },
        data: {
            lastSuccessfulTestAt: input.testedAt,
            lastSuccessfulTestRuntimeFingerprint: input.runtimeFingerprint,
            lastSuccessfulTestSecurityRevision: input.securityRevision,
        },
    });
    if (updated.count === 0) return { status: "configuration_changed" };
    const latest = await tx.identityProviderInstance.findUnique({
        where: { id: input.id },
        select: instanceSafeSelect,
    });
    const instance = latest ? projectInstance(latest) : null;
    return instance
        ? { status: "applied", instance }
        : { status: "configuration_changed" };
}

export type CreateIdentityProviderInstanceResult =
    | Readonly<{ status: "created"; instance: IdentityProviderInstanceView }>
    | Readonly<{ status: "invalid_document" }>;

export async function createIdentityProviderInstanceInTx(tx: Tx, input: Readonly<{
    env?: NodeJS.ProcessEnv;
    owner: ProviderCatalogContext;
    kind: ManagedIdentityProviderKind;
    displayName: string;
    config: unknown;
    secrets: unknown;
    githubAppInstallationId?: string;
    createdByAccountId: string | null;
}>): Promise<CreateIdentityProviderInstanceResult> {
    const config = parseIdentityProviderConfig(input.kind, input.config);
    const secrets = parseIdentityProviderSecrets(input.kind, input.secrets);
    const displayName = input.displayName.trim();
    if (!config.ok || !secrets.ok || !displayName || displayName.length > 256) {
        return { status: "invalid_document" };
    }

    const githubAppInstallationId = input.githubAppInstallationId?.trim();
    if ((input.kind === "github_app_identity") !== Boolean(githubAppInstallationId)) {
        return { status: "invalid_document" };
    }
    if (githubAppInstallationId && !await isGitHubAppInstallationEligibleForOwnerInTx(tx, {
        installationId: githubAppInstallationId,
        owner: input.owner,
    })) return { status: "invalid_document" };

    const env = input.env ?? process.env;
    const reservedIds = new Set([
        ...resolveDeploymentProviderSnapshot(env).modules.map((module) => module.id.trim().toLowerCase()),
        ...resolveAuthMethodRegistry(env).map((method) => method.id.trim().toLowerCase()),
        "anonymous",
    ]);
    let id = randomUUID();
    while (reservedIds.has(id) || await tx.identityProviderInstance.findUnique({ where: { id }, select: { id: true } })) {
        id = randomUUID();
    }
    const row = await tx.identityProviderInstance.create({
        data: {
            id,
            ownerTeamId: ownerTeamId(input.owner),
            kind: input.kind,
            displayName,
            config: config.value,
            encryptedSecrets: secrets.value === null
                ? null
                : encryptIdentityProviderSecrets({ id, kind: input.kind, secrets: secrets.value }),
            ...(githubAppInstallationId ? { githubAppInstallationId } : {}),
            createdByAccountId: input.createdByAccountId,
        },
        select: instanceRuntimeSelect,
    });
    return { status: "created", instance: projectInstance(row)! };
}

type InstanceMutationResult =
    | Readonly<{ status: "applied"; instance: IdentityProviderInstanceView }>
    | Readonly<{ status: "not_found" | "invalid_document" | "immutable_issuer" }>
    | Readonly<{ status: "revision_conflict"; instance: IdentityProviderInstanceView | null }>;

export async function updateIdentityProviderInstanceInTx(tx: Tx, input: Readonly<{
    id: string;
    owner: ProviderCatalogContext;
    expectedRevision: number;
    displayName?: string;
    config?: unknown;
}>): Promise<InstanceMutationResult> {
    const current = await tx.identityProviderInstance.findUnique({ where: { id: input.id }, select: instanceRuntimeSelect });
    if (!current || !sameOwner(current, input.owner)) return { status: "not_found" };
    const currentView = projectInstance(current);
    if (current.revision !== input.expectedRevision) return { status: "revision_conflict", instance: currentView };
    if (!currentView) return { status: "invalid_document" };

    let config: IdentityProviderConfig = currentView.config;
    if (input.config !== undefined) {
        const parsed = parseIdentityProviderConfig(currentView.kind, input.config);
        if (!parsed.ok) return { status: "invalid_document" };
        config = parsed.value;
    }
    if (
        currentView.config.kind === "oidc"
        && config.kind === "oidc"
        && config.issuer !== currentView.config.issuer
        && (current.firstEnabledAt !== null || await tx.accountIdentity.count({ where: { provider: current.id } }) > 0)
    ) return { status: "immutable_issuer" };

    const displayName = input.displayName === undefined ? current.displayName : input.displayName.trim();
    if (!displayName || displayName.length > 256) return { status: "invalid_document" };
    const securityEffective = input.config !== undefined
        && JSON.stringify(securityEffectiveConfig(config))
            !== JSON.stringify(securityEffectiveConfig(currentView.config));
    const updated = await tx.identityProviderInstance.updateMany({
        where: { id: input.id, ownerTeamId: ownerTeamId(input.owner), revision: input.expectedRevision },
        data: {
            revision: { increment: 1 },
            ...(securityEffective ? { securityRevision: { increment: 1 } } : {}),
            displayName,
            config,
        },
    });
    const latest = await tx.identityProviderInstance.findUnique({ where: { id: input.id }, select: instanceSafeSelect });
    const projected = latest ? projectInstance(latest) : null;
    if (updated.count > 0) {
        // A rename changes what an already-linked member sees, so the linked-provider projection
        // is republished. It is not security-effective, so it must not invalidate authentication.
        await publishProviderLinkedIdentityChangesInTx(tx, input.id);
        if (securityEffective) await applyProviderAuthenticationContextEffectsInTx(tx, input.id);
    }
    return updated.count === 0
        ? { status: "revision_conflict", instance: projected }
        : projected ? { status: "applied", instance: projected } : { status: "invalid_document" };
}

export async function replaceIdentityProviderSecretsInTx(tx: Tx, input: Readonly<{
    id: string;
    owner: ProviderCatalogContext;
    expectedRevision: number;
    secrets: unknown;
}>): Promise<InstanceMutationResult> {
    const current = await tx.identityProviderInstance.findUnique({ where: { id: input.id }, select: instanceRuntimeSelect });
    if (!current || !sameOwner(current, input.owner)) return { status: "not_found" };
    const currentView = projectInstance(current);
    if (current.revision !== input.expectedRevision) return { status: "revision_conflict", instance: currentView };
    if (!currentView) return { status: "invalid_document" };
    const secrets = parseIdentityProviderSecrets(currentView.kind, input.secrets);
    if (!secrets.ok) return { status: "invalid_document" };
    const updated = await tx.identityProviderInstance.updateMany({
        where: { id: input.id, ownerTeamId: ownerTeamId(input.owner), revision: input.expectedRevision },
        data: {
            revision: { increment: 1 },
            securityRevision: { increment: 1 },
            encryptedSecrets: secrets.value === null
                ? null
                : encryptIdentityProviderSecrets({ id: input.id, kind: currentView.kind, secrets: secrets.value }),
        },
    });
    const latest = await tx.identityProviderInstance.findUnique({ where: { id: input.id }, select: instanceSafeSelect });
    const projected = latest ? projectInstance(latest) : null;
    if (updated.count > 0) {
        await publishProviderLinkedIdentityChangesInTx(tx, input.id);
        await applyProviderAuthenticationContextEffectsInTx(tx, input.id);
    }
    return updated.count === 0
        ? { status: "revision_conflict", instance: projected }
        : projected ? { status: "applied", instance: projected } : { status: "invalid_document" };
}

export async function setIdentityProviderInstanceEnabledInTx(tx: Tx, input: Readonly<{
    id: string;
    owner: ProviderCatalogContext;
    expectedRevision: number;
    expectedSecurityRevision: number;
    enabled: boolean;
    now?: Date;
}>): Promise<InstanceMutationResult> {
    const current = await tx.identityProviderInstance.findUnique({ where: { id: input.id }, select: instanceRuntimeSelect });
    if (!current || !sameOwner(current, input.owner)) return { status: "not_found" };
    const currentView = projectInstance(current);
    if (current.revision !== input.expectedRevision || current.securityRevision !== input.expectedSecurityRevision) {
        return { status: "revision_conflict", instance: currentView };
    }
    if (!currentView || readSecrets(current) === undefined) return { status: "invalid_document" };
    const updated = await tx.identityProviderInstance.updateMany({
        where: {
            id: input.id,
            ownerTeamId: ownerTeamId(input.owner),
            revision: input.expectedRevision,
            securityRevision: input.expectedSecurityRevision,
        },
        data: {
            revision: { increment: 1 },
            securityRevision: { increment: 1 },
            enabled: input.enabled,
            ...(input.enabled && current.firstEnabledAt === null ? { firstEnabledAt: input.now ?? new Date() } : {}),
        },
    });
    const latest = await tx.identityProviderInstance.findUnique({ where: { id: input.id }, select: instanceSafeSelect });
    const projected = latest ? projectInstance(latest) : null;
    if (updated.count > 0) {
        await publishProviderLinkedIdentityChangesInTx(tx, input.id);
        await applyProviderAuthenticationContextEffectsInTx(tx, input.id);
    }
    return updated.count === 0
        ? { status: "revision_conflict", instance: projected }
        : projected ? { status: "applied", instance: projected } : { status: "invalid_document" };
}

export type DeleteIdentityProviderInstanceResult =
    | Readonly<{ status: "deleted" }>
    | Readonly<{ status: "not_found" }>
    | Readonly<{ status: "revision_conflict"; instance: IdentityProviderInstanceView | null }>
    | Readonly<{ status: "blocked"; identityCount: number; connectionCount: number }>;

export type IdentityProviderInstanceRemovalPreflightResult =
    | Readonly<{
        status: "ready";
        instance: IdentityProviderInstanceView;
        identityCount: number;
        connectionCount: number;
        affectedAccountIds: readonly string[];
    }>
    | Readonly<{ status: "not_found" | "unreadable" }>
    | Readonly<{ status: "revision_conflict"; instance: IdentityProviderInstanceView | null }>;

async function readIdentityProviderInstanceRemovalBlockersInTx(
    tx: Tx,
    providerInstanceId: string,
): Promise<Readonly<{
    identityCount: number;
    connectionCount: number;
    affectedAccountIds: readonly string[];
}>> {
    const [identities, connectionCount] = await Promise.all([
        tx.accountIdentity.findMany({
            where: { provider: providerInstanceId },
            select: { accountId: true },
            orderBy: { accountId: "asc" },
        }),
        tx.teamIdentityConnection.count({ where: { providerInstanceId } }),
    ]);
    const affectedAccountIds = [...new Set(identities.map(({ accountId }) => accountId))];
    return {
        identityCount: identities.length,
        connectionCount,
        affectedAccountIds,
    };
}

/**
 * Reads the exact current removal impact without mutating the provider. Delete
 * repeats this owner-local query in its deciding transaction, so a preflight is
 * useful administrator context rather than stale authority to remove.
 */
export async function preflightDeleteIdentityProviderInstanceInTx(tx: Tx, input: Readonly<{
    id: string;
    owner: ProviderCatalogContext;
    expectedRevision: number;
}>): Promise<IdentityProviderInstanceRemovalPreflightResult> {
    const current = await tx.identityProviderInstance.findUnique({ where: { id: input.id }, select: instanceSafeSelect });
    if (!current || !sameOwner(current, input.owner)) return { status: "not_found" };
    const instance = projectInstance(current);
    if (current.revision !== input.expectedRevision) return { status: "revision_conflict", instance };
    if (!instance) return { status: "unreadable" };
    return {
        status: "ready",
        instance,
        ...await readIdentityProviderInstanceRemovalBlockersInTx(tx, current.id),
    };
}

export async function deleteIdentityProviderInstanceInTx(tx: Tx, input: Readonly<{
    id: string;
    owner: ProviderCatalogContext;
    expectedRevision: number;
}>): Promise<DeleteIdentityProviderInstanceResult> {
    const current = await tx.identityProviderInstance.findUnique({ where: { id: input.id }, select: instanceSafeSelect });
    if (!current || !sameOwner(current, input.owner)) return { status: "not_found" };
    if (current.revision !== input.expectedRevision) {
        return { status: "revision_conflict", instance: projectInstance(current) };
    }
    const { identityCount, connectionCount } = await readIdentityProviderInstanceRemovalBlockersInTx(tx, current.id);
    if (identityCount > 0 || connectionCount > 0) return { status: "blocked", identityCount, connectionCount };
    const deleted = await tx.identityProviderInstance.deleteMany({
        where: { id: input.id, ownerTeamId: ownerTeamId(input.owner), revision: input.expectedRevision },
    });
    if (deleted.count === 1) return { status: "deleted" };
    const latest = await tx.identityProviderInstance.findUnique({ where: { id: input.id }, select: instanceSafeSelect });
    return latest ? { status: "revision_conflict", instance: projectInstance(latest) } : { status: "not_found" };
}

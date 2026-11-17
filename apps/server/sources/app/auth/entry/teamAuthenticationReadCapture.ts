import type { Account, AccountIdentity, Prisma } from '@prisma/client';
import type { IdentityProviderInstanceRow } from '@/app/auth/providers/managed/identityProviderInstanceLifecycle';
import type { ConnectionRow } from '@/app/teams/identity/teamIdentityConnectionLifecycle';
import { projectHomeGovernancePolicyRow, type HomeGovernancePolicyRecord, type HomeGovernancePolicyRow } from '@/app/home/governance/governancePolicy';
import * as privacyKit from 'privacy-kit';
import { prismaRuntime } from '@/storage/prisma';
import { resolveDeploymentProviderSnapshot } from '@/app/auth/providers/providerModules';

/** Current database facts captured by the enclosing statement, never a cache or an authority decision. */
export interface TeamAuthenticationReadCapture {
    readonly home: HomeGovernancePolicyRecord;
    readonly providers: readonly IdentityProviderInstanceRow[];
    /** Includes every carrier of the selected WorkOS namespaces, as required by their canonical owner. */
    readonly connections: readonly ConnectionRow<string | null>[];
    readonly installations: readonly Prisma.GitHubAppInstallationGetPayload<{ include: { registration: true } }>[];
    readonly account: Pick<Account, 'id' | 'status' | 'publicKey' | 'encryptionMode'> | null;
    readonly hasPasswordCredential: boolean;
    readonly identities: readonly Pick<AccountIdentity, 'id' | 'accountId' | 'provider' | 'eligibilityStatus'>[];
}

export type JsonSnapshot<T> = T extends Date ? number : T extends bigint | Uint8Array ? string
    : T extends readonly (infer Item)[] ? JsonSnapshot<Item>[]
        : T extends object ? { [Key in keyof T]: JsonSnapshot<T[Key]> } : T;

/** Database encoding of the authentication owner's current facts. */
export interface TeamAuthenticationSqlCapture {
    readonly actor: Pick<Account, 'id' | 'status' | 'homeRole' | 'publicKey' | 'encryptionMode'> | null;
    readonly home: HomeGovernancePolicyRow | null;
    readonly providers: readonly JsonSnapshot<TeamAuthenticationReadCapture['providers'][number]>[];
    readonly connections: readonly JsonSnapshot<TeamAuthenticationReadCapture['connections'][number]>[];
    readonly installations: readonly JsonSnapshot<TeamAuthenticationReadCapture['installations'][number]>[];
    readonly hasPasswordCredential: boolean;
    readonly identities: TeamAuthenticationReadCapture['identities'];
}

/** Prisma DateTime is UTC without a PostgreSQL timezone. JSON dates must carry their UTC identity. */
export function capturedPostgresRowJson(alias: string, dates: readonly string[], bytes: readonly string[] = [], bigints: readonly string[] = []): Prisma.Sql {
    const column = (key: string) => prismaRuntime.raw(`${alias}."${key}"`);
    // Driver parameters arrive untyped; jsonb_build_object's variadic "any" cannot infer a key's type.
    const name = (key: string) => prismaRuntime.sql`${key}::text`;
    const fields = [
        ...dates.flatMap(key => [name(key), prismaRuntime.sql`EXTRACT(EPOCH FROM ${column(key)}) * 1000`]),
        ...bytes.flatMap(key => [name(key), prismaRuntime.sql`replace(encode(${column(key)}, 'base64'), chr(10), '')`]),
        ...bigints.flatMap(key => [name(key), prismaRuntime.sql`${column(key)}::text`]),
    ];
    return prismaRuntime.sql`to_jsonb(${prismaRuntime.raw(alias)}) || jsonb_build_object(${prismaRuntime.join(fields)})`;
}

/** Captures authentication facts inside the caller's existing PostgreSQL statement. */
export function teamAuthenticationReadCaptureSql(input: Readonly<{
    actorAccountId: Prisma.Sql;
    teams: Prisma.Sql;
    env?: NodeJS.ProcessEnv;
}>): Prisma.Sql {
    const deploymentIds = [...resolveDeploymentProviderSnapshot(input.env ?? process.env).references.keys()];
    const providers = capturedPostgresRowJson('p', ['firstEnabledAt', 'lastSuccessfulTestAt', 'createdAt', 'updatedAt'], ['encryptedSecrets']);
    const connections = capturedPostgresRowJson('c', ['firstEnabledAt', 'lastSuccessfulTestAt', 'createdAt', 'updatedAt']);
    const installations = capturedPostgresRowJson('i', ['suspendedAt', 'lastVerifiedAt', 'createdAt', 'updatedAt'], [], ['githubInstallationId', 'githubOrganizationId']);
    const registrations = capturedPostgresRowJson('r', ['lastVerifiedAt', 'createdAt', 'updatedAt'], ['encryptedSecrets'], ['githubAppId', 'githubOwnerId']);
    return prismaRuntime.sql`(
        WITH capture_auth_teams AS MATERIALIZED (${input.teams}), capture_auth_team_ids AS MATERIALIZED (
            SELECT "id" AS id FROM capture_auth_teams
        ), capture_actor AS MATERIALIZED (
            SELECT a."id", a."status", a."homeRole", a."publicKey", a."encryptionMode"
            FROM "Account" a WHERE a."id" = ${input.actorAccountId}
        ), capture_identities AS MATERIALIZED (
            SELECT i."id", i."accountId", i."provider", i."eligibilityStatus"
            FROM "AccountIdentity" i WHERE i."accountId" = ${input.actorAccountId}
                AND EXISTS (SELECT 1 FROM capture_auth_teams WHERE "authenticationPolicy" IS NOT NULL)
        ), capture_provider_ids AS MATERIALIZED (
            SELECT p."id" FROM "IdentityProviderInstance" p WHERE p."ownerTeamId" IS NULL
            UNION SELECT p."id" FROM "IdentityProviderInstance" p WHERE p."ownerTeamId" IN (SELECT id FROM capture_auth_team_ids)
            UNION SELECT p."id" FROM "IdentityProviderInstance" p WHERE p."id" IN (SELECT lower(trim("provider")) FROM capture_identities)
            UNION SELECT p."id" FROM "IdentityProviderInstance" p WHERE p."id" IN (
                SELECT lower(trim(value #>> '{}')) FROM capture_auth_teams t,
                    LATERAL jsonb_path_query(t."authenticationPolicy", '$.accepted[*].methodId') value)
            UNION SELECT p."id" FROM "IdentityProviderInstance" p WHERE p."id" IN (
                SELECT jsonb_array_elements_text(${JSON.stringify(deploymentIds)}::jsonb))
        ), capture_providers AS MATERIALIZED (
            SELECT p.* FROM "IdentityProviderInstance" p WHERE p."id" IN (SELECT id FROM capture_provider_ids)
                AND EXISTS (SELECT 1 FROM capture_auth_teams WHERE "authenticationPolicy" IS NOT NULL)
        ), capture_connection_ids AS MATERIALIZED (
            SELECT c."id" FROM "TeamIdentityConnection" c WHERE c."teamId" IS NULL
                AND c."providerInstanceId" IN (SELECT "id" FROM capture_providers)
            UNION SELECT c."id" FROM "TeamIdentityConnection" c WHERE c."teamId" IN (SELECT id FROM capture_auth_team_ids)
                AND c."providerInstanceId" IN (SELECT "id" FROM capture_providers)
            UNION SELECT c."id" FROM "TeamIdentityConnection" c
                WHERE c."providerInstanceId" IN (SELECT "id" FROM capture_providers WHERE "kind" = 'workos_sso')
        ), capture_connections AS MATERIALIZED (
            SELECT c.* FROM "TeamIdentityConnection" c WHERE c."id" IN (SELECT id FROM capture_connection_ids)
        )
        SELECT jsonb_build_object(
            'actor', (SELECT to_jsonb(a) FROM capture_actor a),
            'home', (SELECT to_jsonb(h) FROM "HomeGovernancePolicy" h WHERE h."id" = 'home'),
            'providers', COALESCE((SELECT jsonb_agg(${providers} ORDER BY p."createdAt", p."id")
                FROM capture_providers p), '[]'::jsonb),
            'connections', COALESCE((SELECT jsonb_agg(${connections} ORDER BY c."createdAt", c."id") FROM capture_connections c), '[]'::jsonb),
            'installations', COALESCE((SELECT jsonb_agg(${installations} || jsonb_build_object('registration', ${registrations}))
                FROM "GitHubAppInstallation" i JOIN "GitHubAppRegistration" r ON r."id" = i."registrationId"
                WHERE i."id" IN (SELECT "githubAppInstallationId" FROM capture_providers)), '[]'::jsonb),
            'hasPasswordCredential', EXISTS (SELECT 1 FROM "AccountPasswordCredential" p WHERE p."accountId" = ${input.actorAccountId}),
            'identities', COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM capture_identities i), '[]'::jsonb)
        )
    )`;
}

const date = (value: number | null) => value === null ? null : new Date(value);

/** Restores native database values without IO or an authentication decision. */
export function materializeTeamAuthenticationReadCapture(capture: TeamAuthenticationSqlCapture): TeamAuthenticationReadCapture {
    return {
        home: projectHomeGovernancePolicyRow(capture.home), account: capture.actor,
        hasPasswordCredential: capture.hasPasswordCredential, identities: capture.identities,
        providers: capture.providers.map(row => ({ ...row, firstEnabledAt: date(row.firstEnabledAt),
            lastSuccessfulTestAt: date(row.lastSuccessfulTestAt), createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt),
            encryptedSecrets: row.encryptedSecrets === null ? null : privacyKit.decodeBase64(row.encryptedSecrets) })),
        connections: capture.connections.map(row => ({ ...row, firstEnabledAt: date(row.firstEnabledAt),
            lastSuccessfulTestAt: date(row.lastSuccessfulTestAt), createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) })),
        installations: capture.installations.map(row => ({ ...row,
            githubInstallationId: BigInt(row.githubInstallationId), githubOrganizationId: BigInt(row.githubOrganizationId),
            suspendedAt: date(row.suspendedAt), lastVerifiedAt: date(row.lastVerifiedAt),
            createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt),
            registration: { ...row.registration, githubAppId: BigInt(row.registration.githubAppId),
                githubOwnerId: row.registration.githubOwnerId === null ? null : BigInt(row.registration.githubOwnerId),
                lastVerifiedAt: date(row.registration.lastVerifiedAt), createdAt: new Date(row.registration.createdAt),
                updatedAt: new Date(row.registration.updatedAt), encryptedSecrets: privacyKit.decodeBase64(row.registration.encryptedSecrets) } })),
    };
}

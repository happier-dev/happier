import type { QualifiedConnectedAccountServiceRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { computeTeamCredentialConnectedAccountSourceVersionV1, computeTeamCredentialPoolMemberSourceVersionV1, computeTeamCredentialSourceMemberKeyV1, parseTeamCredentialSourceVersionV1, type TeamCredentialSourceMemberV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';

import type { Tx } from "@/storage/inTx";
import {
    readQualifiedConnectedAccountSourceIdentitiesInTx,
    readQualifiedConnectedAccountSourceIdentityInTx,
    type QualifiedConnectedAccountSourceIdentity,
} from "@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository";
import {
    readQualifiedConnectedAccountGroupSourceSnapshotInTx,
    readQualifiedConnectedAccountGroupSourceSnapshotsInTx,
    type QualifiedConnectedAccountGroupSourceSnapshot,
} from "@/app/api/routes/connect/qualifiedConnectedAccounts/groupRepository";

import { projectConnectedAccountSourceResolution, projectConnectedPoolSourceResolution, projectProviderConnectionSourceResolution,
    type TeamCredentialResourceSourceResolution } from './sourceResolution';
export type { TeamCredentialResourceSourceResolution, TeamCredentialResourceSourceCurrentness } from './sourceResolution';


function directContributionContractVersion(
    source: Pick<QualifiedConnectedAccountSourceIdentity, "directExportContract" | "contributionContractVersion">,
): string | null {
    return source.directExportContract === null || source.contributionContractVersion === null
        ? null
        : computeCanonicalDomainSeparatedDigest(
            source.directExportContract,
            [source.contributionContractVersion],
        );
}


export function parsePublishedTeamCredentialSourceVersions(value: string | null): Record<string, string> | null {
    if (value === null) return {};
    try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        const entries = Object.entries(parsed);
        if (entries.some(([key, version]) => key.length < 1 || typeof version !== "string" || version.length < 1)) {
            return null;
        }
        for (const [, version] of entries) parseTeamCredentialSourceVersionV1(version as string);
        return Object.fromEntries(entries) as Record<string, string>;
    } catch {
        return null;
    }
}


/**
 * Resolves all source lifetimes for one bounded page. Connected Accounts and
 * Pools each use their canonical repository batch once; Provider Connection
 * bindings remain content-free and need no persistence lookup here.
 */
export async function resolveTeamCredentialResourceSourcesInTx(
    tx: Tx,
    params: readonly Readonly<{
        custodianAccountId: string;
        source: unknown;
    }>[],
): Promise<readonly TeamCredentialResourceSourceResolution[]> {
    const parsed = params.map((input) => ({
        input,
        source: TeamCredentialSourceBindingV1Schema.safeParse(input.source),
    }));
    const accountRequests = parsed.flatMap(({ input, source }, index) => (
        source.success && source.data.kind === "connected_account"
            ? [{ index, accountId: input.custodianAccountId, ref: source.data.target.account }]
            : []
    ));
    const poolRequests = parsed.flatMap(({ input, source }, index) => (
        source.success && source.data.kind === "connected_pool"
            ? [{
                index,
                accountId: input.custodianAccountId,
                service: source.data.target.service,
                groupId: source.data.target.groupId,
            }]
            : []
    ));
    const [accountSources, poolSources] = await Promise.all([
        readQualifiedConnectedAccountSourceIdentitiesInTx(
            tx,
            accountRequests.map(({ accountId, ref }) => ({ accountId, ref })),
        ),
        readQualifiedConnectedAccountGroupSourceSnapshotsInTx(
            tx,
            poolRequests.map(({ accountId, service, groupId }) => ({
                accountId,
                service,
                groupId,
            })),
        ),
    ]);
    const accountSourceByIndex = new Map(accountRequests.map((request, index) => [
        request.index,
        accountSources[index] ?? null,
    ]));
    const poolSourceByIndex = new Map(poolRequests.map((request, index) => [
        request.index,
        poolSources[index] ?? null,
    ]));
    return parsed.map(({ source }, index) => {
        if (!source.success) {
            return { status: "unavailable", reason: "invalid_source_binding" };
        }
        if (source.data.kind === "provider_connection") {
            return projectProviderConnectionSourceResolution(source.data);
        }
        if (source.data.kind === "connected_account") {
            return projectConnectedAccountSourceResolution(
                source.data,
                accountSourceByIndex.get(index) ?? null,
            );
        }
        return projectConnectedPoolSourceResolution(
            source.data,
            poolSourceByIndex.get(index) ?? null,
        );
    });
}

/**
 * Resolves the resource's pinned lifetime under its stored source custodian.
 * The resource service separately admits that custodian and the actual caller.
 * Current identity does not establish runtime usability. Persisted source-owned
 * authentication failure is carried independently, without replacing lifetime
 * currentness or invalidating previously disclosed Direct material.
 */
export async function resolveTeamCredentialResourceSourceInTx(
    tx: Tx,
    params: Readonly<{ custodianAccountId: string; source: unknown }>,
): Promise<TeamCredentialResourceSourceResolution> {
    const parsed = TeamCredentialSourceBindingV1Schema.safeParse(params.source);
    if (!parsed.success) return { status: "unavailable", reason: "invalid_source_binding" };
    const source = parsed.data;
    if (source.kind === "provider_connection") {
        return projectProviderConnectionSourceResolution(source);
    }
    if (source.kind === "connected_account") {
        const current = await readQualifiedConnectedAccountSourceIdentityInTx(tx, {
            accountId: params.custodianAccountId,
            ref: source.target.account,
        });
        return projectConnectedAccountSourceResolution(source, current);
    }
    const current = await readQualifiedConnectedAccountGroupSourceSnapshotInTx(tx, {
            accountId: params.custodianAccountId,
            service: source.target.service,
            groupId: source.target.groupId,
    });
    return projectConnectedPoolSourceResolution(source, current);
}

export type TeamCredentialSourceMemberCurrentness =
    | Readonly<{
        status: "current";
        sourceMember: TeamCredentialSourceMemberV1;
        sourceCredentialIncarnation: string | null;
        sourceVersion: string | null;
        directExportSupport: "supported" | "unsupported";
    }>
    | Readonly<{ status: "unavailable"; reason: "invalid_source_binding" | "source_missing" | "source_changed" | "unsupported_direct_source" }>;

/** Projects direct-member currentness from the already batched source snapshot. */
export function projectTeamCredentialDirectSourceCurrentnesses(
    source: unknown,
    resolution: TeamCredentialResourceSourceResolution | null,
): readonly (Extract<TeamCredentialSourceMemberCurrentness, { status: 'current' }> & { directExportSupport: 'supported' })[] {
    const parsed = TeamCredentialSourceBindingV1Schema.safeParse(source);
    if (!parsed.success || resolution?.status !== 'current') return [];
    const binding = parsed.data;
    const currentness = resolution.requestPolicyCurrentness;
    if (binding.kind === 'provider_connection' && currentness.kind === 'provider_connection') {
        return [{ status: 'current', sourceMember: {
            kind: 'provider_credential_slot', connectionId: binding.connectionId,
            credentialSlotId: binding.credentialSlotId,
        }, sourceCredentialIncarnation: null, sourceVersion: null, directExportSupport: 'supported' }];
    }
    const projectAccount = (identity: QualifiedConnectedAccountSourceIdentity, ref: Readonly<{ service: QualifiedConnectedAccountServiceRef; accountId: string }>, poolIncarnation?: string) => {
        const sourceMember = { kind: 'connected_account' as const, service: ref.service, connectedAccountId: ref.accountId };
        const contributionContractVersion = directContributionContractVersion(identity);
        if (contributionContractVersion === null) return null;
        const connectedAccountSourceVersion = computeTeamCredentialConnectedAccountSourceVersionV1({
            sourceAccountId: ref.accountId, credentialIncarnation: identity.incarnation,
            sourceMember, credentialRevision: identity.credentialRevision,
            configurationRevision: identity.configurationRevision,
            authenticationModeId: identity.authenticationModeId, contributionContractVersion,
        });
        return { status: 'current' as const, sourceMember, sourceCredentialIncarnation: identity.incarnation,
            sourceVersion: poolIncarnation ? computeTeamCredentialPoolMemberSourceVersionV1({
                connectedAccountSourceVersion, poolIncarnation, memberEnabled: true,
            }) : connectedAccountSourceVersion, directExportSupport: 'supported' as const };
    };
    if (binding.kind === 'connected_account' && currentness.kind === 'connected_account') {
        return [projectAccount(currentness.identity, binding.target.account)].filter((value): value is NonNullable<typeof value> => value !== null);
    }
    if (binding.kind !== 'connected_pool' || currentness.kind !== 'connected_pool') return [];
    return currentness.snapshot.members.flatMap(member => {
        if (!member.enabled || member.credentialRevision === null) return [];
        const projected = projectAccount({
            incarnation: member.credentialIncarnation,
            credentialRevision: member.credentialRevision, configurationRevision: member.configurationRevision,
            authenticationModeId: member.authenticationModeId, directExportContract: member.directExportContract,
            status: member.status,
            contributionContractVersion: member.contributionContractVersion,
        }, member.account, currentness.snapshot.incarnation);
        return projected ? [projected] : [];
    });
}

/** Lists only source members that are current under the source owner's stored lifetime. */
export async function listTeamCredentialDirectSourceMembersInTx(
    tx: Tx,
    params: Readonly<{ custodianAccountId: string; source: unknown }>,
): Promise<readonly TeamCredentialSourceMemberV1[] | null> {
    const parsed = TeamCredentialSourceBindingV1Schema.safeParse(params.source);
    if (!parsed.success) return null;
    const source = parsed.data;
    if (source.kind === "provider_connection") {
        return [{ kind: "provider_credential_slot", connectionId: source.connectionId, credentialSlotId: source.credentialSlotId }];
    }
    if (source.kind === "connected_account") {
        const current = await readQualifiedConnectedAccountSourceIdentityInTx(tx, {
            accountId: params.custodianAccountId,
            ref: source.target.account,
        });
        if (!current || current.incarnation !== source.credentialIncarnation) return null;
        if (
            current.directExportContract === null
            || current.contributionContractVersion === null
        ) return [];
        return [{
            kind: "connected_account",
            service: source.target.account.service,
            connectedAccountId: source.target.account.accountId,
        }];
    }
    const pool = await readQualifiedConnectedAccountGroupSourceSnapshotInTx(tx, {
        accountId: params.custodianAccountId,
        service: source.target.service,
        groupId: source.target.groupId,
    });
    if (!pool || pool.incarnation !== source.poolIncarnation) return null;
    return pool.members.filter((member) => (
        member.enabled
        && member.credentialRevision !== null
        && member.directExportContract !== null
        && member.contributionContractVersion !== null
    )).map((member) => ({
        kind: "connected_account" as const,
        service: member.account.service,
        connectedAccountId: member.account.accountId,
    }));
}

/**
 * Home-owned currentness for source facts it already persists. The caller
 * supplies only the opaque member incarnation; it never supplies revisions or
 * an authoritative version. Provider Settings remain E2EE and therefore need
 * their separate published-currentness owner rather than being guessed here.
 * Brokered use requires current membership, not permission to export secrets.
 */
export async function resolveTeamCredentialSourceMemberCurrentnessInTx(
    tx: Tx,
    params: Readonly<{
        custodianAccountId: string;
        source: unknown;
        sourceMemberKey: string;
        deliveryMode: 'direct' | 'brokered';
    }>,
): Promise<TeamCredentialSourceMemberCurrentness> {
    const parsed = TeamCredentialSourceBindingV1Schema.safeParse(params.source);
    if (!parsed.success) return { status: "unavailable", reason: "invalid_source_binding" };
    const source = parsed.data;
    if (source.kind === "provider_connection") {
        const sourceMember = {
            kind: "provider_credential_slot" as const,
            connectionId: source.connectionId,
            credentialSlotId: source.credentialSlotId,
        };
        if (computeTeamCredentialSourceMemberKeyV1(sourceMember) !== params.sourceMemberKey) {
            return { status: "unavailable", reason: "source_changed" };
        }
        return {
            status: "current",
            sourceMember,
            sourceCredentialIncarnation: null,
            sourceVersion: null,
            directExportSupport: "supported",
        };
    }
    if (source.kind === "connected_account") {
        const current = await readQualifiedConnectedAccountSourceIdentityInTx(tx, {
            accountId: params.custodianAccountId,
            ref: source.target.account,
        });
        if (!current) return { status: "unavailable", reason: "source_missing" };
        if (current.incarnation !== source.credentialIncarnation) {
            return { status: "unavailable", reason: "source_changed" };
        }
        const sourceMember = {
            kind: "connected_account" as const,
            service: source.target.account.service,
            connectedAccountId: source.target.account.accountId,
        };
        if (computeTeamCredentialSourceMemberKeyV1(sourceMember) !== params.sourceMemberKey) {
            return { status: "unavailable", reason: "source_changed" };
        }
        const contributionContractVersion = directContributionContractVersion(current);
        if (contributionContractVersion === null) {
            if (params.deliveryMode === 'brokered') return {
                status: "current", sourceMember, sourceCredentialIncarnation: current.incarnation,
                sourceVersion: null, directExportSupport: "unsupported",
            };
            return { status: "unavailable", reason: "unsupported_direct_source" };
        }
        return {
            status: "current",
            sourceMember,
            sourceCredentialIncarnation: current.incarnation,
            sourceVersion: computeTeamCredentialConnectedAccountSourceVersionV1({
                sourceAccountId: source.target.account.accountId,
                credentialIncarnation: current.incarnation,
                sourceMember,
                credentialRevision: current.credentialRevision,
                configurationRevision: current.configurationRevision,
                authenticationModeId: current.authenticationModeId,
                contributionContractVersion,
            }),
            directExportSupport: "supported",
        };
    }
    const pool = await readQualifiedConnectedAccountGroupSourceSnapshotInTx(tx, {
        accountId: params.custodianAccountId,
        service: source.target.service,
        groupId: source.target.groupId,
    });
    if (!pool) return { status: "unavailable", reason: "source_missing" };
    if (pool.incarnation !== source.poolIncarnation) {
        return { status: "unavailable", reason: "source_changed" };
    }
    const member = pool.members.find((candidate) => computeTeamCredentialSourceMemberKeyV1({
        kind: "connected_account",
        service: candidate.account.service,
        connectedAccountId: candidate.account.accountId,
    }) === params.sourceMemberKey && candidate.enabled);
    if (!member) return { status: "unavailable", reason: "source_changed" };
    const ref = {
        service: source.target.service,
        accountId: member.account.accountId,
    };
    const current = await readQualifiedConnectedAccountSourceIdentityInTx(tx, {
        accountId: params.custodianAccountId,
        ref,
    });
    if (!current) return { status: "unavailable", reason: "source_missing" };
    if (current.incarnation !== member.credentialIncarnation) {
        return { status: "unavailable", reason: "source_changed" };
    }
    const contributionContractVersion = directContributionContractVersion(current);
    const sourceMember = {
        kind: "connected_account" as const,
        service: ref.service,
        connectedAccountId: ref.accountId,
    };
    if (contributionContractVersion === null) {
        if (params.deliveryMode === 'brokered') return {
            status: "current", sourceMember, sourceCredentialIncarnation: current.incarnation,
            sourceVersion: null, directExportSupport: "unsupported",
        };
        return { status: "unavailable", reason: "unsupported_direct_source" };
    }
    return {
        status: "current",
        sourceMember,
        sourceCredentialIncarnation: current.incarnation,
        sourceVersion: computeTeamCredentialPoolMemberSourceVersionV1({
            connectedAccountSourceVersion:
                computeTeamCredentialConnectedAccountSourceVersionV1({
                    sourceAccountId: ref.accountId,
                    credentialIncarnation: current.incarnation,
                    sourceMember,
                    credentialRevision: current.credentialRevision,
                    configurationRevision: current.configurationRevision,
                    authenticationModeId: current.authenticationModeId,
                    contributionContractVersion,
                }),
            poolIncarnation: pool.incarnation,
            memberEnabled: member.enabled,
        }),
        directExportSupport: "supported",
    };
}

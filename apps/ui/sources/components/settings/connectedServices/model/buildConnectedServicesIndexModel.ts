import {
    buildQualifiedPluginContributionKey,
    isConnectedServiceCredentialHealthStatusUsable,
    normalizeConnectedServiceCredentialHealthStatus,
    type ConnectedServiceId,
    type PluginContributionIdentityV1,
    type QualifiedConnectedAccountGroupV4,
    type QualifiedConnectedAccountPurposeBindingTargetV1,
    type QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';

import { canExecuteConnectedServiceAction, type ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
    compareAccountHealthSeverity,
    deriveAccountHealth,
    worstAccountHealth,
    type AccountHealth,
} from '@/sync/domains/connectedServices/deriveAccountHealth';
import {
    resolveConnectedServiceDefaultProfileId,
    resolveQualifiedConnectedAccountDefaultId,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import type { ConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';

/** A released V2 service record as the profile projection carries it. */
export type ConnectedServicesIndexLegacyService = Readonly<{
    serviceId: string;
    profiles?: ReadonlyArray<Readonly<{
        profileId: string;
        status?: unknown;
        kind?: unknown;
        providerEmail?: string | null;
        providerAccountId?: string | null;
    }>>;
}>;

export type ConnectedServicesIndexAccount =
    | Readonly<{
        kind: 'qualified';
        accountId: string;
        status: unknown;
        profile: QualifiedConnectedAccountProfileV4;
    }>
    | Readonly<{
        kind: 'legacy';
        accountId: string;
        status: unknown;
        legacyServiceId: ConnectedServiceId;
        identityLabel: string | null;
        /** The released producer field selected above; ids need not look different from emails. */
        identityLabelKind: 'email' | 'accountId' | null;
    }>;

/**
 * One agent that signs in through connected services: its name, the services its purposes declare,
 * and its current default targets (from the one purpose-default owner).
 */
export type ConnectedServicesIndexAgentUse = Readonly<{
    /** The agent's catalog id (its mark); absent only in callers that name agents by title alone. */
    agentId?: string;
    title: string;
    services: readonly PluginContributionIdentityV1[];
    defaults: readonly QualifiedConnectedAccountPurposeBindingTargetV1[];
}>;

/** Where a service sits on the page: with the agents' accounts, or with code hosts and tools. */
export type ConnectedServicesIndexSection = 'agents' | 'tools';

/** What one account does: the pools it is in (and whether each uses it now) and the agents it is the default for. */
export type ConnectedServicesIndexAccountRoles = Readonly<{
    pools: readonly Readonly<{ groupId: string; inUse: boolean }>[];
    defaultFor: readonly string[];
}>;

/** A pool of the service, with the agents that use it by default. */
export type ConnectedServicesIndexPool = QualifiedConnectedAccountGroupV4 & Readonly<{ defaultFor: readonly string[] }>;

/** One service on the index: its identity, its accounts and its state. */
export type ConnectedServicesIndexSheet = Readonly<{
    serviceKey: string;
    service: PluginContributionIdentityV1;
    /** The descriptor, or the generated built-in fallback while no machine publishes one. */
    entry: ConnectedServiceRegistryEntry | null;
    legacyServiceId: ConnectedServiceId | null;
    label: string;
    /** Known identity keeps its read-only page reachable even while execution is unavailable. */
    canOpen: boolean;
    /** Action admission from the executable projection or the released built-in legacy ingress. */
    canAdd: boolean;
    /** Worst health first, then a stable id order. */
    accounts: readonly ConnectedServicesIndexAccount[];
    connectedCount: number;
    groupCount: number;
    defaultAccountId: string | null;
    health: AccountHealth;
    /** The first account whose credential needs a new sign-in. */
    attentionAccountId: string | null;
    /** Bounded, product-safe state copy (blocked, unavailable, loading) or null when healthy. */
    statusLine: string | null;
    supportDetails: string | null;
    /** The agents that sign in with this service, in catalog order; empty while that is unknown. */
    usedBy: readonly string[];
    /** The same agents' catalog ids, in the same order (their marks). */
    usedByAgentIds: readonly string[];
    section: ConnectedServicesIndexSection;
    pools: readonly ConnectedServicesIndexPool[];
    rolesByAccountId: Readonly<Record<string, ConnectedServicesIndexAccountRoles>>;
}>;

/** A service the user can add a first account to. */
export type ConnectedServicesIndexConnectable = Readonly<{
    serviceKey: string;
    service: PluginContributionIdentityV1;
    entry: ConnectedServiceRegistryEntry;
    label: string;
    /** The agents that would sign in with it (G3: what your agents accept but you have not connected). */
    usedBy: readonly string[];
    /** The same agents' catalog ids, in the same order (their marks). */
    usedByAgentIds: readonly string[];
    section: ConnectedServicesIndexSection;
}>;

export type ConnectedServicesIndexModel = Readonly<{
    sheets: readonly ConnectedServicesIndexSheet[];
    connectable: readonly ConnectedServicesIndexConnectable[];
}>;

function sameService(
    left: Readonly<{ pluginId: string; localId: string }>,
    right: Readonly<{ pluginId: string; localId: string }>,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function healthOf(status: unknown): AccountHealth {
    return deriveAccountHealth({
        status: normalizeConnectedServiceCredentialHealthStatus(status),
        capacityPct: null,
    });
}

function isUsable(status: unknown): boolean {
    return isConnectedServiceCredentialHealthStatusUsable(
        normalizeConnectedServiceCredentialHealthStatus(status),
    );
}

function sortAccounts(
    accounts: readonly ConnectedServicesIndexAccount[],
): readonly ConnectedServicesIndexAccount[] {
    return [...accounts].sort((left, right) => {
        const rank = compareAccountHealthSeverity(healthOf(left.status), healthOf(right.status));
        return rank !== 0 ? rank : left.accountId.localeCompare(right.accountId);
    });
}

/**
 * Projects the Connected services index: one sheet per service that has accounts (or a state worth
 * showing), and the services a first account can still be added to.
 *
 * Accounts and pools are Account-level data, so a service with accounts is listed even when no
 * machine currently publishes its descriptor (an offline machine must not make accounts vanish); its
 * name then comes from the generated built-in fallback. Services without accounts come only from the
 * published descriptors, because only an online machine can add an account.
 */
export function buildConnectedServicesIndexModel(input: Readonly<{
    transport: ConnectedAccountUiNegotiation;
    entries: readonly ConnectedServiceRegistryEntry[];
    qualifiedAccounts: readonly QualifiedConnectedAccountProfileV4[];
    qualifiedGroups: readonly QualifiedConnectedAccountGroupV4[];
    legacyServices: readonly ConnectedServicesIndexLegacyService[];
    defaultAccountByServiceKey: Readonly<Record<string, string | undefined>>;
    resolveLabel: (entry: ConnectedServiceRegistryEntry | null) => string;
    /** Generated built-in entry for a qualified service no machine publishes, or null. */
    resolveFallbackEntry: (service: PluginContributionIdentityV1) => ConnectedServiceRegistryEntry | null;
    presentDiagnostics: (entry: ConnectedServiceRegistryEntry) => Readonly<{ primary: string | null; supportDetails: string | null }>;
    loadingLabel: string;
    /**
     * Which agents sign in with which services, and their defaults; `null` while unknown (no agent
     * projection yet), in which case every service stays with the agent accounts.
     */
    agentUses?: readonly ConnectedServicesIndexAgentUse[] | null;
}>): ConnectedServicesIndexModel {
    const sheets: ConnectedServicesIndexSheet[] = [];
    const connectable: ConnectedServicesIndexConnectable[] = [];
    const seen = new Set<string>();
    const agentUses = input.agentUses ?? null;

    const agentsUsing = (service: PluginContributionIdentityV1) => (agentUses ?? [])
        .filter((agent) => agent.services.some((candidate) => sameService(candidate, service)));
    const usedByOf = (service: PluginContributionIdentityV1): readonly string[] => agentsUsing(service).map((agent) => agent.title);
    const usedByAgentIdsOf = (service: PluginContributionIdentityV1): readonly string[] => agentsUsing(service)
        .flatMap((agent) => agent.agentId ? [agent.agentId] : []);
    const sectionOf = (usedBy: readonly string[]): ConnectedServicesIndexSection => (
        agentUses === null || usedBy.length > 0 ? 'agents' : 'tools'
    );
    const defaultsFor = (matches: (target: QualifiedConnectedAccountPurposeBindingTargetV1) => boolean): string[] => (agentUses ?? [])
        .filter((agent) => agent.defaults.some(matches))
        .map((agent) => agent.title);

    const buildSheet = (
        service: PluginContributionIdentityV1,
        entry: ConnectedServiceRegistryEntry | null,
        published: boolean,
    ): ConnectedServicesIndexSheet | 'connectable' => {
        const serviceKey = buildQualifiedPluginContributionKey(service);
        const legacyServiceId = entry?.legacyServiceId ?? null;
        let accounts: ConnectedServicesIndexAccount[] = [];
        if (input.transport === 'advertised-v4') {
            accounts = input.qualifiedAccounts
                .filter((account) => sameService(account.ref.service, service))
                .map((profile) => ({
                    kind: 'qualified' as const,
                    accountId: profile.ref.accountId,
                    status: profile.status,
                    profile,
                }));
        } else if (input.transport === 'legacy' && legacyServiceId) {
            const legacy = input.legacyServices.find((candidate) => candidate.serviceId === legacyServiceId);
            accounts = (legacy?.profiles ?? []).map((profile) => ({
                kind: 'legacy' as const,
                accountId: profile.profileId,
                status: profile.status,
                legacyServiceId,
                identityLabel: profile.providerEmail ?? profile.providerAccountId ?? null,
                identityLabelKind: profile.providerEmail != null ? 'email' as const
                    : profile.providerAccountId != null ? 'accountId' as const : null,
            }));
        }
        const serviceGroups = input.transport === 'advertised-v4'
            ? input.qualifiedGroups.filter((group) => sameService(group.ref.service, service))
            : [];
        const groupCount = serviceGroups.length;
        const diagnostics = entry && published
            ? input.presentDiagnostics(entry)
            : { primary: null, supportDetails: null };
        const canOpen = entry !== null;
        const canAdd = entry !== null && canExecuteConnectedServiceAction(entry, input.transport);

        if (
            published
            && input.transport !== 'indeterminate'
            && accounts.length === 0
            && groupCount === 0
            && canAdd
            && diagnostics.primary === null
        ) {
            return 'connectable';
        }

        const connectedIds = accounts
            .filter((account) => isUsable(account.status))
            .map((account) => account.accountId);
        const defaultAccountId = input.transport === 'advertised-v4'
            ? resolveQualifiedConnectedAccountDefaultId({
                service,
                legacyServiceId,
                connectedAccountIds: connectedIds,
                defaultAccountByServiceKey: input.defaultAccountByServiceKey,
            })
            : legacyServiceId
                ? resolveConnectedServiceDefaultProfileId({
                    serviceId: legacyServiceId,
                    connectedProfileIds: connectedIds,
                    defaultProfileByServiceId: input.defaultAccountByServiceKey,
                })
                : null;
        const sorted = sortAccounts(accounts);
        const usedBy = usedByOf(service);
        const pools = serviceGroups.map((group): ConnectedServicesIndexPool => ({
            ...group,
            defaultFor: defaultsFor((target) => target.kind === 'group'
                && sameService(target.service, service)
                && target.groupId === group.ref.groupId),
        }));
        const rolesByAccountId: Record<string, ConnectedServicesIndexAccountRoles> = {};
        for (const account of sorted) {
            rolesByAccountId[account.accountId] = {
                pools: serviceGroups
                    .filter((group) => group.members.some((member) => member.connectedAccountId === account.accountId))
                    .map((group) => ({
                        groupId: group.ref.groupId,
                        inUse: group.activeConnectedAccountId === account.accountId,
                    })),
                defaultFor: defaultsFor((target) => target.kind === 'account'
                    && sameService(target.account.service, service)
                    && target.account.accountId === account.accountId),
            };
        }
        return {
            serviceKey,
            service,
            entry,
            legacyServiceId,
            label: input.resolveLabel(entry),
            canOpen,
            canAdd,
            accounts: sorted,
            connectedCount: connectedIds.length,
            groupCount,
            defaultAccountId,
            health: worstAccountHealth(sorted.map((account) => healthOf(account.status))),
            attentionAccountId: sorted.find(
                (account) => normalizeConnectedServiceCredentialHealthStatus(account.status) === 'needs_reauth',
            )?.accountId ?? null,
            statusLine: diagnostics.primary
                ?? (input.transport === 'indeterminate' ? input.loadingLabel : null),
            supportDetails: diagnostics.supportDetails,
            usedBy,
            usedByAgentIds: usedByAgentIdsOf(service),
            section: sectionOf(usedBy),
            pools,
            rolesByAccountId,
        };
    };

    for (const entry of input.entries) {
        if (!entry.service) continue;
        const serviceKey = buildQualifiedPluginContributionKey(entry.service);
        if (seen.has(serviceKey)) continue;
        seen.add(serviceKey);
        const result = buildSheet(entry.service, entry, true);
        if (result === 'connectable') {
            const usedBy = usedByOf(entry.service);
            connectable.push({
                serviceKey,
                service: entry.service,
                entry,
                label: input.resolveLabel(entry),
                usedBy,
                usedByAgentIds: usedByAgentIdsOf(entry.service),
                section: sectionOf(usedBy),
            });
        } else {
            sheets.push(result);
        }
    }

    if (input.transport === 'advertised-v4') {
        const orphanServices = [
            ...input.qualifiedAccounts.map((account) => account.ref.service),
            ...input.qualifiedGroups.map((group) => group.ref.service),
        ];
        for (const service of orphanServices) {
            const serviceKey = buildQualifiedPluginContributionKey(service);
            if (seen.has(serviceKey)) continue;
            seen.add(serviceKey);
            const sheet = buildSheet(service, input.resolveFallbackEntry(service), false);
            if (sheet !== 'connectable') sheets.push(sheet);
        }
    }

    sheets.sort((left, right) => {
        const rank = compareAccountHealthSeverity(left.health, right.health);
        return rank !== 0 ? rank : left.label.localeCompare(right.label);
    });
    connectable.sort((left, right) => left.label.localeCompare(right.label));
    return { sheets, connectable };
}

import { applyProjectedCredentialKindRestrictions } from '@happier-dev/agents';
import { ConnectedServiceCredentialKindSchema, type ConnectedServiceCredentialKind } from '@happier-dev/protocol/connect/connectedServiceCredentialKind';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { isConnectedAccountSignedOut } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
import { isConnectedServiceCredentialHealthStatusUsable, normalizeConnectedServiceCredentialHealthStatus } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';

import { canExecuteConnectedServiceAction, type ConnectedServiceRegistryEntry, type ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
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
        credentialKind?: ConnectedServiceCredentialKind;
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
    services: readonly (PluginContributionIdentityV1 & { credentialKinds?: readonly ConnectedServiceCredentialKind[] })[];
    defaults: readonly QualifiedConnectedAccountPurposeBindingTargetV1[];
}>;

/** Where a service sits on the page: with the agents' accounts, or with code hosts and tools. */
export type ConnectedServicesIndexSection = 'agents' | 'tools' | 'unknown';

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
    /** Descriptor absence alone never establishes that a plugin is not installed. */
    installationState: 'unknown' | 'installed' | 'not-installed' | 'disabled';
    /** Stable identity order; health updates do not move the account being read. */
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
    /** Compatibility comes from the same declaration owner as Session account selection. */
    usedByByAccountId?: Readonly<Record<string, Readonly<{ usedBy: readonly string[]; usedByAgentIds: readonly string[] }>>>;
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
    return [...accounts].sort((left, right) => left.accountId.localeCompare(right.accountId));
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
    /** Registry-backed callers carry the read owner's verdict even for an absent descriptor. */
    registryStatus?: ConnectedServiceRegistrySnapshot['status'];
    qualifiedAccounts: readonly QualifiedConnectedAccountProfileV4[];
    qualifiedGroups: readonly QualifiedConnectedAccountGroupV4[];
    legacyServices: readonly ConnectedServicesIndexLegacyService[];
    defaultAccountByServiceKey: Readonly<Record<string, string | undefined>>;
    resolveLabel: (entry: ConnectedServiceRegistryEntry | null, service: PluginContributionIdentityV1) => string;
    /** Generated built-in entry for a qualified service no machine publishes, or null. */
    resolveFallbackEntry: (service: PluginContributionIdentityV1) => ConnectedServiceRegistryEntry | null;
    presentDiagnostics: (entry: ConnectedServiceRegistryEntry) => Readonly<{ primary: string | null; supportDetails: string | null }>;
    loadingLabel: string;
    /** Held Account installation census; incomplete absence is not an uninstall fact. */
    pluginInstallationCensus?: Readonly<{ pluginIds: ReadonlySet<string>; complete: boolean }> | null;
    /**
     * Which agents sign in with which services, and their defaults; `null` while unknown (no agent
     * projection yet). Unknown usage never establishes Agent or tool classification.
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
        agentUses === null ? 'unknown' : usedBy.length > 0 ? 'agents' : 'tools'
    );
    const defaultsFor = (matches: (target: QualifiedConnectedAccountPurposeBindingTargetV1) => boolean): string[] => (agentUses ?? [])
        .filter((agent) => agent.defaults.some(matches))
        .map((agent) => agent.title);

    const buildSheet = (
        service: PluginContributionIdentityV1,
        entry: ConnectedServiceRegistryEntry | null,
        published: boolean,
    ): ConnectedServicesIndexSheet | 'connectable' | 'empty' => {
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
            accounts = (legacy?.profiles ?? []).map((profile) => {
                const credentialKind = ConnectedServiceCredentialKindSchema.safeParse(profile.kind);
                return {
                    ...(credentialKind.success ? { credentialKind: credentialKind.data } : {}),
                    kind: 'legacy' as const,
                    accountId: profile.profileId,
                    status: profile.status,
                    legacyServiceId,
                    identityLabel: profile.providerEmail ?? profile.providerAccountId ?? null,
                    identityLabelKind: profile.providerEmail != null ? 'email' as const
                        : profile.providerAccountId != null ? 'accountId' as const : null,
                };
            });
        }
        const serviceGroups = input.transport === 'advertised-v4'
            ? input.qualifiedGroups.filter((group) => sameService(group.ref.service, service))
            : [];
        const groupCount = serviceGroups.length;
        // Pending inputs cannot establish an unavailable verdict from retained
        // descriptor diagnostics. This model owns the state every index surface uses.
        const pending = input.transport === 'indeterminate' || entry?.projectionStatus === 'loading'
            || (!published && input.registryStatus === 'loading');
        const installationState: ConnectedServicesIndexSheet['installationState'] = pending ? 'unknown'
            : published && entry?.availability?.state === 'disabled' ? 'disabled'
            : published && entry?.availability?.state === 'available' ? 'installed'
            : input.pluginInstallationCensus?.pluginIds.has(service.pluginId) ? 'installed'
            : input.pluginInstallationCensus?.complete ? 'not-installed' : 'unknown';
        const diagnostics = pending
            ? { primary: input.loadingLabel, supportDetails: null }
            : entry && published
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
        // A known service with no accounts, no pools, no problem to report and nothing the user can
        // do yet (its machines have not answered) has nothing to show: it returns as something to
        // connect once a machine answers. Unknown accounts (indeterminate) still keep their sheet.
        if (
            published
            && input.transport !== 'indeterminate'
            && accounts.length === 0
            && groupCount === 0
            && !canAdd
            && diagnostics.primary === null
        ) {
            return 'empty';
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
        const declaredAgents = agentsUsing(service);
        const compatibleIds = new Map(declaredAgents.map(agent => [agent, new Set(applyProjectedCredentialKindRestrictions({
            connectedAccounts: agent.services.map(candidate => ({ service: candidate, credentialKinds: candidate.credentialKinds })),
            optionsByServiceId: { [serviceKey]: accounts.map(account => ({
                profileId: account.accountId, status: 'connected',
                kind: account.kind === 'qualified' ? account.profile.kind : account.credentialKind ?? null,
            })) },
        })[serviceKey].filter(option => option.status !== 'unsupported_kind').map(option => option.profileId))]));
        const compatibleAgents = accounts.length === 0 ? declaredAgents
            : declaredAgents.filter(agent => compatibleIds.get(agent)!.size > 0);
        const usedBy = compatibleAgents.map(agent => agent.title);
        const usedByByAccountId = Object.fromEntries(accounts.map(account => {
            const consumers = declaredAgents.filter(agent => compatibleIds.get(agent)!.has(account.accountId));
            return [account.accountId, { usedBy: consumers.map(agent => agent.title),
                usedByAgentIds: consumers.flatMap(agent => agent.agentId ? [agent.agentId] : []) }];
        }));
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
            label: input.resolveLabel(entry, service),
            canOpen,
            canAdd,
            installationState,
            accounts: sorted,
            connectedCount: connectedIds.length,
            groupCount,
            defaultAccountId,
            health: worstAccountHealth(sorted.map((account) => healthOf(account.status))),
            attentionAccountId: sorted.find(
                (account) => isConnectedAccountSignedOut(normalizeConnectedServiceCredentialHealthStatus(account.status)),
            )?.accountId ?? null,
            statusLine: diagnostics.primary,
            supportDetails: diagnostics.supportDetails,
            usedBy,
            usedByAgentIds: compatibleAgents.flatMap(agent => agent.agentId ? [agent.agentId] : []),
            usedByByAccountId,
            section: sectionOf(usedByOf(service)),
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
        if (result === 'empty') continue;
        if (result === 'connectable') {
            const usedBy = usedByOf(entry.service);
            connectable.push({
                serviceKey,
                service: entry.service,
                entry,
                label: input.resolveLabel(entry, entry.service),
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
            if (sheet !== 'connectable' && sheet !== 'empty') sheets.push(sheet);
        }
    }

    // Descriptors, localized names and credential health arrive independently.
    // Identity orders services; health still orders accounts inside their sheet.
    sheets.sort((left, right) => left.serviceKey.localeCompare(right.serviceKey));
    connectable.sort((left, right) => left.serviceKey.localeCompare(right.serviceKey));
    return { sheets, connectable };
}

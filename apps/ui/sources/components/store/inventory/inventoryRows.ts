import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { getResolvedAgentCatalogEntries, resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { createAgentSettingsRoute, createCustomAcpAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { mcpServerDisplayName, mcpServerRoute } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { skillDisplayName, skillHref } from '@/components/settings/skills/skillsCollectionModel';
import { skillStatus } from '@/components/settings/skills/status/skillStatus';
import { skillSourceId } from '@/components/settings/skills/skillSource';
import { buildPluginDetailRoute, buildStoreBrowserProfileRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { isPluginIncludedWithHappier, projectAccountInstalledPlugin } from '@/components/settings/plugins/model/pluginMarketplaceModel';
import { providerConnectionDetailRoute } from '@/components/settings/providers/collection/providerCollectionModel';
import { presentProviderConnection } from '@/providers/connection/presentation';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '@/components/settings/shell/settingsCollectionAdapter';
import type { StoreInstalledInput } from '../catalog/storeKinds';
import type { ManagedInventoryRow as InstalledRow } from './useManagedInventory';
import { t } from '@/text';
import type { ManagedInventoryAttention } from './inventoryAttention';
import { machinePageHref } from '@/components/machines/page/machinePageHref';

export const inventoryColumnAdapter = defineSettingsCollectionAdapter(['kind', 'status', 'machine', 'project']);
export type ManagedInventoryField = typeof inventoryColumnAdapter.fields[number];
type OperationalKind = 'watchedService' | 'setup' | 'configuredCheck';
function operationalKindWord(kind: InstalledRow['kind']): string | null {
    switch (kind) {
        case 'watchedService': return t('machineServices.groups.watched');
        case 'setup': return t('capabilities.store.setupFamilyTitle');
        case 'configuredCheck': return t('capabilities.store.checksFamilyTitle');
        default: return null;
    }
}
export function inventoryKindTitle(kind: InstalledRow['kind']): string {
    return operationalKindWord(kind) ?? t(`capabilities.store.kinds.${kind as Exclude<InstalledRow['kind'], OperationalKind>}.title`);
}
export function inventoryKindWord(kind: InstalledRow['kind']): string {
    return operationalKindWord(kind) ?? t(`capabilities.store.kindWord.${kind as Exclude<InstalledRow['kind'], OperationalKind>}`);
}
export type ManagedInventoryRowPresentation = Readonly<{
    row: InstalledRow;
    facts: SettingsCollectionRowFacts<ManagedInventoryField>;
    /** A route is display/navigation context, never an execution target or an admission grant. */
    home: Readonly<{ href: string | ReturnType<typeof buildPluginDetailRoute> | null; scope: ServerAccountScope }>;
    machines: readonly MachineAdministrationTargetV1[] | null;
    projects: readonly string[] | null;
    /**
     * Ships inside Happier, never something the person added (S50 §1, kind-independent): decided here once from each
     * domain's own fact — bundled plugins, first-party skills. Kinds without such a fact are always added.
     */
    included: boolean;
}>;

export function inventoryMachineKey(scope: ServerAccountScope, machine: MachineAdministrationTargetV1): string {
    return serverAccountScopedResourceKey({ serverId: machine.serverIdentityId, accountId: scope.accountId }, 'machine', machine.machineId);
}

/** The Account's Machine display names, by membership key and by id (the Reach presentation owner's). */
export type InventoryMachineNames = Readonly<{
    byKey: ReadonlyMap<string, string>;
    byId: ReadonlyMap<string, string>;
}>;

/**
 * Where a row runs, in words: the one Machine by name, "Every machine", or how many. A list of Machine names is
 * never the answer (it reads as ids at fleet size); the Machine grouping and the row's page name them.
 * Unknown placement says nothing rather than "nowhere".
 */
export function inventoryWhereWords(presentation: ManagedInventoryRowPresentation | undefined, input: StoreInstalledInput,
    names: InventoryMachineNames): string | null {
    // On this Machine's page, or with one Machine in the fleet, where says nothing new: quiet.
    if (!presentation || input.machine || names.byId.size < 2) return null;
    const machines = presentation.machines;
    if (machines === null) return null;
    if (machines.length === 0) return presentation.row.kind === 'agent' ? null : t('storeInstalled.accountGroup');
    const memberships = new Set(machines.map(machine => inventoryMachineKey(presentation.row.scope, machine)));
    if (memberships.size === names.byKey.size && [...memberships].every(key => names.byKey.has(key))) return t('storeInstalled.everyMachine');
    if (memberships.size === 1) return names.byId.get(machines[0]!.machineId) ?? t('storeInstalled.machineFallback');
    return t('allMachines.machinesCount', { count: memberships.size });
}

/** The Collection's local text lens; the mounted condition owner consumes the same searched facts. */
export function matchesInventoryQuery(facts: SettingsCollectionRowFacts<ManagedInventoryField>, query: string): boolean {
    const normalized = query.trim().toLocaleLowerCase();
    return !normalized || `${facts.title} ${facts.context ?? ''}`.toLocaleLowerCase().includes(normalized);
}

/** Native attention supplies status words; this join never reclassifies a condition. */
export function presentInventoryRows(rows: readonly InstalledRow[], input: StoreInstalledInput,
    attention: readonly ManagedInventoryAttention[]): ReadonlyMap<string, ManagedInventoryRowPresentation> {
    const statuses = new Map<string, string[]>();
    for (const entry of attention) {
        if (entry.kind !== 'capability' || !entry.row) continue;
        const native = entry.native;
        const status = native.kind === 'provider' ? native.status : native.kind === 'agent' ? native.value.status : native.kind;
        const values = statuses.get(entry.row.key);
        if (values) values.push(status); else statuses.set(entry.row.key, [status]);
    }
    return new Map(rows.map(row => {
        const presentation = presentInventoryRow(row, input);
        const held = statuses.get(row.key);
        if (!held) return [row.key, presentation];
        const values = [...new Set([...held, ...(presentation.facts.fields.status ?? [])])];
        return [row.key, { ...presentation, facts: { ...presentation.facts, status: values[0] ?? null,
            fields: { ...presentation.facts.fields, status: values } } }];
    }));
}

/** What the person added versus what ships with Happier; the two are shown and counted apart, never as one total. */
export function partitionIncludedRows(rows: readonly InstalledRow[],
    presentations: ReadonlyMap<string, ManagedInventoryRowPresentation>): Readonly<{ added: readonly InstalledRow[]; included: readonly InstalledRow[] }> {
    const added: InstalledRow[] = [];
    const included: InstalledRow[] = [];
    for (const row of rows) (presentations.get(row.key)?.included ? included : added).push(row);
    return { added, included };
}

/** Context facts for a source-owned condition without a managed capability row. */
export function presentInventoryAttention(entry: ManagedInventoryAttention, input: StoreInstalledInput): SettingsCollectionRowFacts<ManagedInventoryField> {
    const healthPage = entry.kind === 'notice' && entry.native.header.source.kind === 'host'
        && entry.native.header.source.topic === 'service_health' && entry.native.header.page
        && 'kind' in entry.native.header.page && entry.native.header.page.page === 'machine_service'
        ? entry.native.header.page : null;
    const machineId = entry.kind === 'machine' ? entry.native.machineId
        : healthPage ? healthPage.machine.machineId
            : entry.kind === 'notice' && entry.native.header.notice?.topic === 'resource_limit' ? entry.native.header.notice.machineId : null;
    const serverId = entry.kind === 'machine' ? entry.native.serverId : healthPage?.machine.serverId ?? input.scope?.serverId;
    const identity = serverId ? getServerProfileById(serverId)?.serverIdentityId : null;
    const machine = input.scope && machineId && identity
        ? inventoryMachineKey(input.scope, { serverIdentityId: identity, machineId }) : null;
    const title = entry.kind === 'machine' ? entry.native.title : entry.kind === 'notice' ? entry.native.header.title
        : 'unavailable' in entry.native ? entry.native.unavailable.title ?? '' : '';
    return { key: entry.key, title, context: null, status: entry.kind === 'capability' ? entry.native.kind : null,
        fields: { kind: entry.kind === 'capability' && 'unavailable' in entry.native ? ['skill'] : null,
            status: entry.kind === 'capability' ? [entry.native.kind] : null,
            machine: machine ? [machine] : null, project: input.projectKey ? [input.projectKey] : null } };
}

/** Placement comes only from the adapter's admitted reach/materializations, never a catalog or checkout join. */
export function presentInventoryRow(row: InstalledRow, input: StoreInstalledInput): ManagedInventoryRowPresentation {
    const serverIdentityId = getServerProfileById(row.scope.serverId)?.serverIdentityId;
    const portable = (machineId: string): MachineAdministrationTargetV1 | null => serverIdentityId ? { serverIdentityId, machineId } : null;
    let title: string;
    let context: string | null = null;
    let href: ManagedInventoryRowPresentation['home']['href'];
    let statuses: readonly string[] | null = null;
    let included = false;
    let machines: readonly MachineAdministrationTargetV1[] | null = input.machine ? [input.machine] : null;
    // A scoped row was admitted by the native Project/reach owner. All does not infer Projects from checkouts.
    const projects = row.kind === 'app' ? row.projectKeys : input.projectKey ? [input.projectKey] : row.kind === 'provider' || row.kind === 'plugin'
        || row.kind === 'agent' && row.subject === 'definition' ? [] : null;
    switch (row.kind) {
        case 'browserExtension':
            title = row.subject === 'extension' ? row.native.extension.name
                // A saved profile without a display name reads by its id, as its own page titles it.
                : row.native.displayName ?? row.native.profileId;
            context = row.subject === 'extension' ? row.native.extension.version : t('storeInstalled.browserProfileEmpty');
            // Its saved profile's Extensions (on/off, remove, add) inside Store.
            href = buildStoreBrowserProfileRoute({ serverId: row.scope.serverId, machineId: row.machineId }, row.native.profileId);
            machines = portable(row.machineId) ? [portable(row.machineId)!] : null;
            break;
        case 'app':
            title = row.native.title;
            href = row.home;
            if (!input.machine) machines = serverIdentityId && row.native.runtimeTargetLink
                ? row.native.runtimeTargetLink.machines.flatMap(machineId => portable(machineId) ?? []) : null;
            break;
        case 'watchedService':
            title = row.native.name;
            href = machinePageHref({ door: 'rail', target: { serverId: row.scope.serverId, machineId: row.machineId },
                tab: { id: 'services', page: 'service', service: row.native.watchId } });
            machines = portable(row.machineId) ? [portable(row.machineId)!] : null;
            break;
        case 'setup':
            title = row.name;
            context = row.itemCount > 0 ? t('machinePresets.setup.itemCount', { count: row.itemCount }) : null;
            href = machinePageHref({ door: 'rail', target: { serverId: row.scope.serverId, machineId: row.machineId }, tab: { id: 'setup' } });
            machines = portable(row.machineId) ? [portable(row.machineId)!] : null;
            break;
        case 'configuredCheck':
            title = row.native.name;
            context = row.native.description ?? null;
            // A switched-off Check files under the same Off every other kind uses; never-run says nothing and stays listed.
            statuses = row.native.enabled ? null : ['off'];
            href = `/automations/${row.automationId}`;
            break;
        case 'software':
            title = row.subject === 'recipe' ? row.native.ref.recipeId : row.native.adapterId;
            href = machinePageHref({ door: 'rail', target: { serverId: row.scope.serverId,
                machineId: input.machine?.machineId ?? row.installations[0]!.machineId } });
            machines = serverIdentityId ? row.installations.flatMap(installation => portable(installation.machineId) ?? []) : null;
            break;
        case 'mcpServer':
            title = mcpServerDisplayName(row.native); context = row.native.description ?? null; href = mcpServerRoute(row.native.id);
            if (!input.machine) machines = serverIdentityId ? row.reach.filter(place => place.agents.some(agent => agent.enabled))
                .flatMap(place => portable(place.machineId) ?? []) : null;
            break;
        case 'skill':
            title = skillDisplayName(row.native.name, row.native.skillId); context = row.native.description ?? null;
            href = skillHref(row.native.skillId); statuses = skillStatus(row.native).map(status => status.kind);
            included = skillSourceId(row.native) === 'happier';
            if (!input.machine) machines = serverIdentityId ? row.reach.filter(place => place.agents.some(agent => agent.enabled))
                .flatMap(place => portable(place.machineId) ?? []) : null;
            break;
        case 'provider': {
            const native = presentProviderConnection(row.view);
            title = native.title; context = native.subtitle || null;
            // A switched-off connection is the same Off every other kind files under, so the filter offers one Off.
            statuses = [native.status === 'disabled' ? 'off' : native.status];
            href = providerConnectionDetailRoute(row.native.id);
            if (!input.machine) machines = serverIdentityId ? row.view.grants.enabledMachineIds.flatMap(id => portable(id) ?? []) : null;
            break;
        }
        case 'plugin': {
            const native = row.detail ?? projectAccountInstalledPlugin(row.native);
            title = native.title; context = native.description; href = buildPluginDetailRoute('settings', row.native.pluginId);
            included = isPluginIncludedWithHappier({ installed: native });
            machines = row.installations.map(installation => ({ serverIdentityId: installation.materialization.serverIdentityId,
                machineId: installation.materialization.machineId }));
            // Recorded Account compatibility is unknown; it cannot become an incompatibility or review status.
            break;
        }
        case 'agent':
            if (row.subject === 'definition') {
                title = row.native.title || row.native.name; href = createCustomAcpAgentSettingsRoute(row.native.id);
                machines = [];
            } else {
                title = resolveAgentCatalogTitle(row.native);
                const entry = getResolvedAgentCatalogEntries({ enabledAgentIds: [] }).find(candidate => candidate.agentId === row.native);
                href = createAgentSettingsRoute({ agentId: row.native, identity: entry?.identity ?? null,
                    ...(input.machine ? { machine: input.machine } : {}) });
                machines = serverIdentityId ? row.machineIds.flatMap(id => portable(id) ?? []) : null;
            }
            break;
    }
    return { row, home: { href, scope: row.scope }, machines, projects, included,
        facts: { key: row.key, title, context, status: statuses?.[0] ?? null, fields: {
            kind: [row.kind], status: statuses, machine: machines?.map(machine => inventoryMachineKey(row.scope, machine)) ?? null,
            project: projects,
        } } };
}

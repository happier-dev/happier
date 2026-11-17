import { countMachineFleet } from '@/sync/domains/machines/identity/filterVisibleMachines';
import type { ActiveSelectionMachineGroup } from '../hooks/useActiveSelectionMachineGroups';
import { describeMachineRuntimePresence, projectMachineManagedPresence, type MachineManagedPresence } from '@/utils/sessions/machinePresenceLine';
import { resolveMachineFleetPresence, partitionMachineFleetPresence, type MachineFleetPresence } from '@/sync/domains/machines/reachability/machineReachability';
import { describeMachineLockedReason, formatMachineDisplayNameParts, getMachineDisplayName, isMachineDisplayHydrating, resolveMachineDisplayNameParts } from '@/utils/sessions/machineDisplayNames';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import { buildMachineOwnershipGroups, describeMachineSharedOwnership, describeMachineSharedGroupTitle } from '@/sync/domains/machines/machineOwnershipGroups';
import { t } from '@/text';
import { reconcileStableRows } from '@/hooks/session/reconcileStableRows';
import { linkMachineActivity, readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { compareMachineListOrder } from '@/sync/domains/machines/machineListOrder';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedMachinePresetListEntryV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { describeManagedCreation, isManagedMachineListArchived, managedMachineEnrolledDetailId } from '../managed/managedCreationPresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { MachinesDoor } from '@/components/machines/page/machinesDoor';
import { isMachineSubPageId } from '@/components/machines/page/machineSubPages';
import { MACHINES_COLLECTION_ROOT, MACHINES_RAIL_ROOT, machinesIndexHref, machinePageHref } from '@/components/machines/page/machinePageHref';
import type { MachineAddRoutePath } from '@/components/machines/add/machineAddPaths';
import { projectHostMachineSandboxCounts, readHostMachineSandboxCount } from '../managed/hostMachineSandboxes';
export { MACHINES_COLLECTION_ROOT, MACHINES_RAIL_ROOT, machinesIndexHref, machinePageHref, type MachinePageTarget } from '@/components/machines/page/machinePageHref';

export const MACHINES_THIS_COMPUTER_ROUTE = '/settings/machines/this-computer';
export const MACHINES_ADD_ROUTE = '/settings/machines/add';
export const MACHINE_PRESETS_ROUTE = `${MACHINES_COLLECTION_ROOT}/presets`;

/**
 * The ways the add-a-machine form offers (`useMachineAddPaths` decides which this device can run), plus
 * `create`: Create one (in the cloud), open from the start.
 */
export type { MachineAddRoutePath };

/**
 * Add a machine: the Machines collection's draft (lab `add-flows` M4). `path` opens that way first when
 * this device offers it — "set up this computer" entry points ask for `thisComputer`.
 */
export function buildMachineAddHref(options: Readonly<{ path?: MachineAddRoutePath; serverId?: string }> = {}): typeof MACHINES_ADD_ROUTE | `${typeof MACHINES_ADD_ROUTE}?${string}` {
    const query = [options.path ? `path=${encodeURIComponent(options.path)}` : null,
        options.serverId ? `serverId=${encodeURIComponent(options.serverId)}` : null].filter(Boolean).join('&');
    return query ? `${MACHINES_ADD_ROUTE}?${query}` : MACHINES_ADD_ROUTE;
}

type MachineCollectionRowPresentation = Readonly<{
    serverId: string;
    /** The existing activity owner backs each row's independently subscribed presence. */
    presenceSource?: Readonly<{
        machine: Parameters<typeof describeMachineRuntimePresence>[0] & Parameters<typeof resolveMachineFleetPresence>[1];
        managedPresence: MachineManagedPresence | null;
        scope?: Parameters<typeof describeMachineRuntimePresence>[3];
    }>;
    /** Absent for a creation without an enrolled Machine; history is retained with member=false. */
    fleetPresence?: MachineFleetPresence;
    /** The name the user gave the machine, else its host; told apart when two share it. */
    title: string;
    /** Reserve this Machine's row while its display metadata is being decrypted. */
    hydrating?: true;
    /**
     * The title in its two parts, for a one-line row that shortens the name and keeps what tells it apart
     * whole: `name` and the suffix `hint` (`null` when the name is already unique).
     */
    titleParts: Readonly<{ name: string; hint: string | null }>;
    /** The host, when the title is a different display name. */
    host: string | null;
    platformLabel: string;
    /** The published OS platform (`metadata.platform`), for the machine's kind glyph; `null` when unknown. */
    platform: string | null;
    online: boolean;
    status: 'online' | 'offline' | 'unknown';
    /** "Online", or "Offline · last seen …", from the shared presence owner. */
    presence: string;
    /** Compact native lifecycle word from the same presence projection. */
    presenceWord?: string;
    /** Why this device cannot read the machine, when it is locked. */
    reason: string | null;
    ownership: string | null;
    /** Whose machine it is, when someone shared it with you (their display name). */
    ownerName: string | null;
    /** Nonarchived resource-bound sandboxes hosted by this exact Machine installation. */
    sandboxCount?: number;
}>;

export type MachineCollectionRow = MachineCollectionRowPresentation & (
    | Readonly<{ kind: 'machine'; machineId: string; managedId?: never }>
    | Readonly<{ kind: 'managed'; managedId: string; machineId?: never; enrolledMachineId?: string;
    }>
);

export type MachineCollectionTarget = Readonly<{ serverId: string }> & (
    | Readonly<{ machineId: string; kind?: 'machine' }>
    | Readonly<{ managedId: string; kind: 'managed'; enrolledMachineId?: string }>
    | Readonly<{ presetId: string; kind: 'preset' }>
);

export type MachinePresetCollectionRow = Readonly<{
    kind: 'preset';
    presetId: string;
    serverId: string;
    title: string;
    preset: ManagedMachinePresetListEntryV1;
    audience: string;
    teamName?: string;
}>;

export type MachinePresetCollectionSection = Omit<MachineCollectionSection, 'rows'> & Readonly<{
    rows: readonly MachinePresetCollectionRow[];
    /** Archived presets, folded under the section's Archive as retired Machines are (TH D-G). */
    archivedRows: readonly MachinePresetCollectionRow[];
}>;

export type MachineCollectionSection = Readonly<{
    key: string;
    serverId: string;
    /** The Home's name when several Homes are listed; `null` for the single, ungrouped list. */
    title: string | null;
    status: ActiveSelectionMachineGroup['status'];
    archived?: boolean;
    rows: readonly MachineCollectionRow[];
}>;

export type MachineCollection = Readonly<{
    /** Every row the search can match: machines, retired created machines and presets. */
    count: number;
    /** The machines the header counts: yours, shared and created ones; never presets or retired creations. */
    machineCount: number;
    /** Membership has not answered or no Machine name is readable; unread arrivals reserve only their own row. */
    firstAnswerPending: boolean;
    sections: readonly MachineCollectionSection[];
    presetSections: readonly MachinePresetCollectionSection[];
}>;

/**
 * Collection surfaces fold offline rows within each ownership/Home section; short rails keep them inline. A row whose name
 * is still being read already knows its presence, so its reserved slot sits in its final group and never moves.
 */
export function partitionMachineCollectionRailRows<Row extends MachineCollectionRow>(rows: readonly Row[], foldOffline: boolean): Readonly<{
    inline: readonly Row[];
    offline: readonly Row[];
}> {
    if (!foldOffline) return { inline: rows, offline: [] };
    const { offline } = partitionMachineFleetPresence(rows, row => row.presenceSource?.managedPresence?.offline ? null : row.fleetPresence);
    if (offline.length === 0) return { inline: rows, offline: [] };
    const folded = new Set(offline);
    return { inline: rows.filter(row => !folded.has(row)), offline };
}

export function managedMachineConsentKey(serverId: string, managedId: string): string {
    return JSON.stringify([serverId, managedId]);
}

/**
 * The machines of the Homes the app shows, as the collection lists them: one list for a single
 * Home, one section per Home otherwise (a Home without machines keeps its section and its status),
 * each sorted by the name the user sees.
 */
export function buildMachineCollection(input: Readonly<{
    groups: readonly ActiveSelectionMachineGroup[];
    groupedByHome: boolean;
    query?: string;
    nowMs?: number;
    managedByServerId?: Readonly<Record<string, readonly ManagedMachineV1[]>>;
    /** The managed inventory has not answered with the membership needed to partition enrolled rows. */
    managedFirstAnswerPending?: boolean;
    presetsByServerId?: Readonly<Record<string, readonly ManagedMachinePresetListEntryV1[]>>;
    teamNamesByServerId?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    /** Managed creations whose installer is waiting on the user's consent, as `managedMachineConsentKey`. */
    awaitingConsent?: ReadonlySet<string>;
    /**
     * Observed creation operations by `managedMachineConsentKey`, so a row reads its creation the way the machine's
     * page does (the lifecycle owner decides; without one, an unconfirmed resource stays "May exist").
     */
    creationOperations?: ReadonlyMap<string, ActionOperationProjection>;
}>): MachineCollection {
    // An enrolled roster alone cannot decide "Your machines" versus "Created
    // by Happier" or their count. Every collection surface reserves that first
    // answer rather than publishing a group it will immediately replace.
    if (input.managedFirstAnswerPending) {
        return { count: 0, machineCount: 0, firstAnswerPending: true, sections: [], presetSections: [] };
    }
    const query = normalizeMachineCollectionQuery(input.query);
    const nowMs = input.nowMs ?? Date.now();
    let count = 0;
    let machineCount = 0;
    const sections = input.groups.flatMap((sourceGroup): MachineCollectionSection[] => {
        const inventory = input.managedByServerId?.[sourceGroup.serverId] ?? [];
        const sandboxCounts = projectHostMachineSandboxCounts(inventory);
        const visibleManaged: ManagedMachineV1[] = [];
        const sandboxEnrollments = new Set<string>();
        for (const machine of inventory) {
            // Admitted resource-bound sandboxes belong to their host, including kept and archived records.
            // Historical enrolled Computer creations without this provenance stay in the fleet.
            if (machine.acquisitionMode === 'resource-bound' || machine.creationScopeRetention) {
                if (machine.enrolledMachineId) sandboxEnrollments.add(machine.enrolledMachineId);
            } else visibleManaged.push(machine);
        }
        const group = sandboxEnrollments.size > 0 ? { ...sourceGroup,
            machines: sourceGroup.machines.filter(machine => !sandboxEnrollments.has(machine.id)) } : sourceGroup;
        machineCount += countMachineFleet([group]);
        const enrolledIds = new Set(group.machines.map(machine => machine.id));
        const managedByMachineId = new Map(visibleManaged
            .flatMap(machine => machine.archivedAt === undefined && machine.enrolledMachineId ? [[machine.enrolledMachineId, machine] as const] : []));
        // An ended created machine is listed once, by its record in Archive; its former Machine is not a live row.
        const endedMachineIds = new Set(visibleManaged.flatMap(machine =>
            machine.enrolledMachineId && isManagedMachineListArchived(machine) ? [machine.enrolledMachineId] : []));
        for (const machineId of endedMachineIds) managedByMachineId.delete(machineId);
        const managedMachines = visibleManaged
            .filter(machine => isManagedMachineListArchived(machine) || !machine.enrolledMachineId || !enrolledIds.has(machine.enrolledMachineId));
        const names = resolveMachineDisplayNameParts([
            ...group.machines.filter(machine => !endedMachineIds.has(machine.id)).map(machine => ({ ...machine,
                managedName: managedByMachineId.get(machine.id)?.launch?.name })),
            ...managedMachines.map(machine => ({ id: machine.id, managedName: machine.launch?.name })),
        ]);
        // Your machines, then the ones Happier created for you, then each Home member's shared machines (lab `R`);
        // retired created machines close the list.
        const classified = buildMachineOwnershipGroups(group.machines.filter(machine => !endedMachineIds.has(machine.id)));
        // Managed provenance never overrides shared custody. Partition only the ownership owner's own-Machine group.
        const joinedCreations = classified.flatMap(ownershipGroup => ownershipGroup.key === 'owned'
            ? ownershipGroup.machines.filter(machine => managedByMachineId.has(machine.id)) : []);
        const ownership = classified.map(ownershipGroup => ownershipGroup.key === 'owned'
            ? { ...ownershipGroup, machines: ownershipGroup.machines.filter(machine => !managedByMachineId.has(machine.id)) } : ownershipGroup)
            .filter(ownershipGroup => managedMachines.length === 0 && joinedCreations.length === 0 || ownershipGroup.machines.length > 0);
        const created = (key: 'managed' | 'managedArchived') => managedMachines.some(machine =>
            isManagedMachineListArchived(machine) === (key === 'managedArchived')) || key === 'managed' && joinedCreations.length > 0
            ? [{ key, custodian: null, machines: key === 'managed' ? joinedCreations : [] }] : [];
        const ownershipGroups = [
            ...ownership.filter(ownershipGroup => !ownershipGroup.key.startsWith('shared:')),
            ...created('managed'),
            ...ownership.filter(ownershipGroup => ownershipGroup.key.startsWith('shared:')),
            ...created('managedArchived'),
        ];
        return ownershipGroups.map((ownershipGroup): MachineCollectionSection => {
            const rows = ownershipGroup.machines
                .map((machine): MachineCollectionRow => {
                const host = machine.metadata?.host?.trim() || null;
                const name = getMachineDisplayName(machine) ?? machine.id;
                const managedMachine = managedByMachineId.get(machine.id);
                const managedPresence = projectMachineManagedPresence(machine, managedMachine);
                const fleetPresence = resolveMachineFleetPresence(group.accountScope, machine, nowMs);
                const presence = describeMachineRuntimePresence(machine, nowMs, managedPresence, group.accountScope, fleetPresence.reachability);
                // A daemon publication must not become part of this presentation row's equality.
                // Retain only the facts this leaf renders, linked to the existing activity owner.
                const presenceMachine = {
                    id: machine.id,
                    ...readMachineActivity(machine),
                    revokedAt: machine.revokedAt,
                    kind: machine.kind,
                    replacedByMachineId: machine.replacedByMachineId,
                    replacedAt: machine.replacedAt,
                    presenceProtocolVersion: machine.presenceProtocolVersion,
                    managedInputRuntime: machine.managedInputRuntime,
                    ...('presence' in machine && machine.presence === null ? { presence: null } : {}),
                };
                linkMachineActivity(machine, presenceMachine);
                const titleParts = names.get(machine.id) ?? { name, hint: null };
                return {
                    ...(managedMachine && !managedMachineEnrolledDetailId(managedMachine, true)
                        ? { kind: 'managed' as const, managedId: managedMachine.id }
                        : { kind: 'machine' as const, machineId: machine.id }),
                    serverId: group.serverId,
                    presenceSource: { machine: presenceMachine, managedPresence, scope: group.accountScope },
                    fleetPresence,
                    ...(presence.showStatus ? { presenceWord: presence.label } : {}),
                    ...(isMachineDisplayHydrating(machine) ? { hydrating: true as const } : {}),
                    title: formatMachineDisplayNameParts(titleParts),
                    titleParts,
                    host: !managedMachine && host && host !== name ? host : null,
                    platformLabel: formatOSPlatform(machine.metadata?.platform),
                    platform: machine.metadata?.platform ?? null,
                    online: presence.online,
                    status: presence.status,
                    presence: presence.label,
                    reason: describeMachineLockedReason(machine),
                    ownership: describeMachineSharedOwnership(machine),
                    ownerName: machine.isShared ? machine.access?.custodian?.displayName ?? null : null,
                    ...(machine.installationId ? { sandboxCount: readHostMachineSandboxCount(sandboxCounts,
                        { machineId: machine.id, installationId: machine.installationId }) } : {}),
                };
                })
                .filter((row) => matchesMachineCollectionQuery(query, row.title, row.host))
                .sort(compareMachineCollectionRows);
            if (ownershipGroup.key === 'managed' || ownershipGroup.key === 'managedArchived') {
                const managedRows = managedMachines
                    .filter(machine => isManagedMachineListArchived(machine) === (ownershipGroup.key === 'managedArchived'))
                    .map((machine): MachineCollectionRow => {
                        const awaitingConsent = input.awaitingConsent?.has(managedMachineConsentKey(group.serverId, machine.id)) === true;
                        const creation = describeManagedCreation(machine, {
                            operation: input.creationOperations?.get(managedMachineConsentKey(group.serverId, machine.id)) ?? null });
                        const enrolledMachineId = managedMachineEnrolledDetailId(machine, enrolledIds.has(machine.enrolledMachineId ?? ''));
                        const titleParts = names.get(machine.id)!;
                        return { kind: 'managed', managedId: machine.id,
                        serverId: group.serverId, title: formatMachineDisplayNameParts(titleParts), titleParts, host: null, platformLabel: '', platform: null, online: false, status: 'offline',
                        // A row's status cell holds the state's one word; its sentence stays on the machine's page (TH D3).
                        presence: awaitingConsent ? t('approvals.waitingForYou') : creation.word ?? creation.line,
                        ...(!awaitingConsent && creation.word ? { presenceWord: creation.word } : {}), reason: null, ownership: null, ownerName: null,
                        ...(enrolledMachineId ? { enrolledMachineId } : {}) };
                    })
                    .filter(row => matchesMachineCollectionQuery(query, row.title));
                rows.push(...managedRows);
                rows.sort(compareMachineCollectionRows);
            }
            count += rows.length;
            const ownershipTitle = ownershipGroup.key.startsWith('shared:')
                ? describeMachineSharedGroupTitle(ownershipGroup.custodian)
                : ownershipGroup.key === 'managed' ? t('machines.destinations.created')
                // Labelled even alone (lab R): the list opens under Defaults, so its machines say whose they are.
                // Grouped by Home, a Home's own machines are already named by the Home.
                : ownershipGroup.key === 'owned' && (!input.groupedByHome
                    || ownershipGroups.some(group => group.key.startsWith('shared:') || group.key === 'managed'))
                    ? t('machines.destinations.yours') : null;
            return {
                key: JSON.stringify([group.serverId, ownershipGroup.key]),
                serverId: group.serverId,
                title: input.groupedByHome
                    ? [group.serverName, ownershipTitle].filter(Boolean).join(' · ')
                    : ownershipTitle,
                status: group.status,
                ...(ownershipGroup.key === 'managedArchived' ? { archived: true } : {}),
                rows,
            };
        });
    });
    const presetSections = input.groups.map((group): MachinePresetCollectionSection => {
        const rows = (input.presetsByServerId?.[group.serverId] ?? [])
            .filter(preset => matchesMachineCollectionQuery(query, preset.name ?? t('common.machine')))
            .map((preset): MachinePresetCollectionRow => ({ kind: 'preset', presetId: preset.id,
                serverId: group.serverId, title: preset.name ?? t('common.machine'), preset,
                audience: preset.owner.kind === 'account' ? t('machinePresets.ownerPersonal')
                    : input.teamNamesByServerId?.[group.serverId]?.[preset.owner.teamId] ?? t('common.loading'),
                ...(preset.owner.kind === 'team' ? { teamName: input.teamNamesByServerId?.[group.serverId]?.[preset.owner.teamId] } : {}) }))
            .sort((a, b) => a.title.localeCompare(b.title) || machinePresetCollectionRowKey(a).localeCompare(machinePresetCollectionRowKey(b)));
        count += rows.length;
        return { key: JSON.stringify([group.serverId, 'presets']), serverId: group.serverId,
            title: input.groupedByHome ? group.serverName : null, status: group.status,
            rows: rows.filter(row => row.preset.archivedAt === undefined),
            archivedRows: rows.filter(row => row.preset.archivedAt !== undefined) };
    });
    // A typed query lists what matched: a group it left empty has nothing to say (its empty line is for a Home with no
    // machines). With no match anywhere the groups stay, so the list can say "No matches".
    const shownSections = query && count > 0 ? sections.filter(section => section.rows.length > 0) : sections;
    // Pending only while there are machine rows and none can be read yet: a search that matched only presets (or nothing)
    // has its answer, never a reserved first read (TH MB-1).
    const shownRows = shownSections.flatMap(section => section.rows);
    const firstAnswerPending = machineCount > 0 && shownRows.length > 0 && shownRows.every(row => row.hydrating);
    return { count, machineCount, firstAnswerPending, sections: shownSections, presetSections };
}

/**
 * Carry the previous collection's row, section and preset identities into `next` wherever a key's content
 * is unchanged, so a one-Machine change replaces one row object and every other consumer row stays quiet.
 * Returns `previous` itself when nothing differs.
 */
export function reconcileMachineCollection(previous: MachineCollection | null, next: MachineCollection): MachineCollection {
    if (!previous) return next;
    const sections = reconcileStableRows(previous.sections, next.sections.map(section => {
        const before = previous.sections.find(candidate => candidate.key === section.key);
        if (!before) return section;
        const beforeByKey = new Map(before.rows.map(row => [machineCollectionRowKey(row), row]));
        const presentationRows = section.rows.map(row => {
            const held = beforeByKey.get(machineCollectionRowKey(row));
            if (!held?.presenceSource || !row.presenceSource) return row;
            // The leaf reads current activity from its linked owner. Clock-only arrivals
            // must not replace its presentation row; status and wording still compare normally.
            const machine = { ...row.presenceSource.machine,
                active: held.presenceSource.machine.active, activeAt: held.presenceSource.machine.activeAt };
            linkMachineActivity(row.presenceSource.machine, machine);
            return { ...row, presenceSource: { ...row.presenceSource, machine } };
        });
        const rows = reconcileStableRows(before.rows, presentationRows, machineCollectionRowKey);
        rows.forEach((row, index) => {
            const current = section.rows[index]!;
            if (row !== current && row.presenceSource && current.presenceSource) {
                linkMachineActivity(current.presenceSource.machine, row.presenceSource.machine);
            }
        });
        return { ...section, rows };
    }), section => section.key);
    const presetSections = reconcileStableRows(previous.presetSections, next.presetSections.map(section => {
        const before = previous.presetSections.find(candidate => candidate.key === section.key);
        return before ? { ...section, rows: reconcileStableRows(before.rows, section.rows, machinePresetCollectionRowKey),
            archivedRows: reconcileStableRows(before.archivedRows, section.archivedRows, machinePresetCollectionRowKey) } : section;
    }), section => section.key);
    return sections === previous.sections && presetSections === previous.presetSections
        && previous.count === next.count && previous.machineCount === next.machineCount && previous.firstAnswerPending === next.firstAnswerPending
        ? previous : { ...next, sections, presetSections };
}

/**
 * Online machines first, then the ones that are not, each by the name the user sees (lab `R`): a fleet
 * with dozens of retired or sleeping machines still opens on the ones that can work. A live Machine whose
 * presence is still resolving keeps its place among them, so nothing moves when the answer lands.
 */
function compareMachineCollectionRows(a: MachineCollectionRow, b: MachineCollectionRow): number {
    return compareMachineListOrder(a.status !== 'offline', a.title, b.status !== 'offline', b.title)
        || machineCollectionRowKey(a).localeCompare(machineCollectionRowKey(b));
}

/**
 * A collection row's page, scoped to the Home it belongs to, in `door`. Rows outside Settings pass
 * `'rail'`; presets are configuration and always open in Settings.
 */
export function machineCollectionHref(row: MachineCollectionTarget, door: MachinesDoor = 'settings'): `/settings/machines/${string}` | `/machines/${string}` {
    if (row.kind === 'preset') return machinePresetCollectionHref(row);
    if (row.kind === 'managed') {
        return row.enrolledMachineId
            ? machinePageHref({ door, target: { machineId: row.enrolledMachineId, serverId: row.serverId } })
            : `${machinesIndexHref(door)}/managed/${encodeURIComponent(row.managedId)}?serverId=${encodeURIComponent(row.serverId)}`;
    }
    return machinePageHref({ door, target: { machineId: row.machineId, serverId: row.serverId } });
}

export function machinePresetCollectionHref(row: Readonly<{ serverId: string; presetId: string }>): `/settings/machines/presets/${string}` {
    return `${MACHINE_PRESETS_ROUTE}/${encodeURIComponent(row.presetId)}?serverId=${encodeURIComponent(row.serverId)}`;
}

export function machinePresetCollectionRowKey(row: Readonly<{ serverId: string; presetId: string }>): string {
    return `preset:${row.serverId}:${row.presetId}`;
}

/** The collection's search as typed, trimmed and case-folded once: machines, presets and pools all match against it. */
export function normalizeMachineCollectionQuery(raw: string | null | undefined): string {
    return raw?.trim().toLocaleLowerCase() ?? '';
}

/** The collection's one query match (machines, presets, pools): an empty search keeps everything. */
export function matchesMachineCollectionQuery(query: string, ...texts: ReadonlyArray<string | null | undefined>): boolean {
    return !query || texts.some(text => text?.toLocaleLowerCase().includes(query) ?? false);
}

/** A machine pool's detail inside the collection, scoped to the Home it belongs to. */
export function machinePoolCollectionHref(pool: Readonly<{ poolId: string; serverId: string }>): string {
    return `${MACHINES_COLLECTION_ROOT}/pools/${encodeURIComponent(pool.poolId)}?serverId=${encodeURIComponent(pool.serverId)}`;
}

/**
 * The collection row the route selects, in either door: `allMachines` on the index,
 * `machine:<serverId>:<id>` (the Home may be absent) on a machine's page or sub-page,
 * `thisComputer`, `defaults` (Machine defaults), `pool:<serverId>:<poolId>`, `poolDraft:<serverId>` for a pool being added, or
 * `machineDraft` for the machine being added.
 */
export function resolveSelectedMachineCollectionKey(
    pathname: string,
    params: Readonly<{ serverId?: string | null }>,
): string | null {
    const normalized = pathname.replace(/\/+$/, '');
    const root = [MACHINES_COLLECTION_ROOT, MACHINES_RAIL_ROOT].find(candidate => normalized === candidate || normalized.startsWith(`${candidate}/`));
    if (!root) return null;
    if (normalized === root) return 'allMachines';
    const segments = normalized.slice(root.length + 1).split('/').map(decodeSegment);
    const serverId = params.serverId?.trim() ?? '';
    if (segments[0] === 'presets') {
        if (segments[1] === 'new') return `presetDraft:${serverId}`;
        return segments.length === 2 && segments[1] ? `preset:${serverId}:${segments[1]}` : null;
    }
    if (segments[0] === 'pools') {
        if (segments[1] === 'new') return `poolDraft:${serverId}`;
        return segments[1] ? `pool:${serverId}:${segments[1]}` : null;
    }
    if (segments[0] === 'managed') return segments.length === 2 && segments[1] ? `managed:${serverId}:${segments[1]}` : null;
    if (segments.length === 2 && segments[0] && isMachineSubPageId(segments[1])) return `machine:${serverId}:${segments[0]}`;
    if (segments.length !== 1 || !segments[0]) return null;
    if (segments[0] === 'this-computer') return 'thisComputer';
    if (segments[0] === 'defaults') return 'defaults';
    if (segments[0] === 'updates') return 'updates';
    if (segments[0] === 'activity') return 'activity';
    if (segments[0] === 'add') return 'machineDraft';
    return `machine:${serverId}:${segments[0]}`;
}

export function machineCollectionRowKey(row: MachineCollectionTarget): string {
    if (row.kind === 'preset') return machinePresetCollectionRowKey(row);
    if (row.kind === 'managed') return `managed:${row.serverId}:${row.managedId}`;
    return `machine:${row.serverId}:${row.machineId}`;
}

/** A route without a Home selects the machine by id alone. */
export function isMachineCollectionRowSelected(selectedKey: string | null, row: MachineCollectionTarget): boolean {
    if (row.kind === 'preset') return selectedKey === machinePresetCollectionRowKey(row) || selectedKey === `preset::${row.presetId}`;
    if (row.kind === 'managed') return selectedKey === machineCollectionRowKey(row);
    return selectedKey === machineCollectionRowKey(row) || selectedKey === `machine::${row.machineId}`;
}

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

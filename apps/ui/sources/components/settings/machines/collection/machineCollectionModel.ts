import type { ActiveSelectionMachineGroup } from '../hooks/useActiveSelectionMachineGroups';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { describeMachineLockedReason, getMachineDisplayName, isMachineDisplayHydrating, resolveMachineDisplayNameParts } from '@/utils/sessions/machineDisplayNames';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import { buildMachineOwnershipGroups, describeMachineSharedOwnership, describeMachineSharedGroupTitle } from '@/sync/domains/machines/machineOwnershipGroups';
import { t } from '@/text';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { describeManagedCreation } from '../managed/managedCreationPresentation';
import type { MachinesDoor } from '@/components/machines/page/machinesDoor';
import { isMachineSubPageId } from '@/components/machines/page/machineSubPages';
import { MACHINES_COLLECTION_ROOT, MACHINES_RAIL_ROOT, machinesIndexHref, machinePageHref } from '@/components/machines/page/machinePageHref';
export { MACHINES_COLLECTION_ROOT, MACHINES_RAIL_ROOT, machinesIndexHref, machinePageHref, type MachinePageTarget } from '@/components/machines/page/machinePageHref';

export const MACHINES_THIS_COMPUTER_ROUTE = '/settings/machines/this-computer';
export const MACHINES_ADD_ROUTE = '/settings/machines/add';
export const MACHINE_PRESETS_ROUTE = `${MACHINES_COLLECTION_ROOT}/presets`;

/** The ways the add-a-machine form offers (`useMachineAddPaths` decides which this device can run). */
export type MachineAddRoutePath = 'thisComputer' | 'ssh' | 'anotherComputer';

/**
 * Add a machine: the Machines collection's draft (lab `add-flows` M4). `path` opens that way first when
 * this device offers it — "set up this computer" entry points ask for `thisComputer`.
 */
export function buildMachineAddHref(options: Readonly<{ path?: MachineAddRoutePath }> = {}): typeof MACHINES_ADD_ROUTE | `${typeof MACHINES_ADD_ROUTE}?${string}` {
    return options.path ? `${MACHINES_ADD_ROUTE}?path=${encodeURIComponent(options.path)}` : MACHINES_ADD_ROUTE;
}

type MachineCollectionRowPresentation = Readonly<{
    serverId: string;
    /** The name the user gave the machine, else its host; told apart when two share it. */
    title: string;
    /**
     * The title in its two parts, for a one-line row that shortens the name and keeps what tells it apart
     * whole: `name` and the suffix `hint` (`null` when the name is already unique).
     */
    titleParts: Readonly<{ name: string; hint: string | null }>;
    /** The host, when the title is a different display name. */
    host: string | null;
    platformLabel: string;
    online: boolean;
    status: 'online' | 'offline' | 'unknown';
    /** "Online", or "Offline · last seen …", from the shared presence owner. */
    presence: string;
    /** Why this device cannot read the machine, when it is locked. */
    reason: string | null;
    ownership: string | null;
    /** Whose machine it is, when someone shared it with you (their display name). */
    ownerName: string | null;
}>;

export type MachineCollectionRow = MachineCollectionRowPresentation & (
    | Readonly<{ kind: 'machine'; machineId: string; managedId?: never }>
    | Readonly<{ kind: 'managed'; managedId: string; machineId?: never; enrolledMachineId?: string;
        /** The rail's one word for its state ("Ended"), where `presence` would truncate beside the name. */
        presenceWord?: string }>
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
    preset: ManagedMachinePresetV1;
    audience: string;
    teamName?: string;
}>;

export type MachinePresetCollectionSection = Omit<MachineCollectionSection, 'rows'> & Readonly<{
    rows: readonly MachinePresetCollectionRow[];
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
    /** Every row the search can match: machines, retired created machines and recipes. */
    count: number;
    /** The machines the header counts: yours, shared and created ones; never recipes or retired creations. */
    machineCount: number;
    /** Managed membership or a listed Machine name has not answered yet. */
    firstAnswerPending: boolean;
    sections: readonly MachineCollectionSection[];
    presetSections: readonly MachinePresetCollectionSection[];
}>;

/** Long rails fold offline rows within each ownership/Home section; short rails keep them inline. */
export function partitionMachineCollectionRailRows(rows: readonly MachineCollectionRow[], foldOffline: boolean): Readonly<{
    inline: readonly MachineCollectionRow[];
    offline: readonly MachineCollectionRow[];
}> {
    const offline = foldOffline ? rows.filter(row => row.status === 'offline') : [];
    if (offline.length === 0) return { inline: rows, offline: [] };
    return { inline: rows.filter(row => row.status !== 'offline'), offline };
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
    presetsByServerId?: Readonly<Record<string, readonly ManagedMachinePresetV1[]>>;
    teamNamesByServerId?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    /** Managed creations whose installer is waiting on the user's consent, as `managedMachineConsentKey`. */
    awaitingConsent?: ReadonlySet<string>;
}>): MachineCollection {
    // An enrolled roster cannot partition Your machines and Created by Happier until membership answers.
    if (input.managedFirstAnswerPending) {
        return { count: 0, machineCount: 0, firstAnswerPending: true, sections: [], presetSections: [] };
    }
    const query = input.query?.trim().toLocaleLowerCase() ?? '';
    const nowMs = input.nowMs ?? Date.now();
    let count = 0;
    let machineCount = 0;
    const firstAnswerPending = input.groups.some(group => group.machines.some(isMachineDisplayHydrating));
    const sections = input.groups.flatMap((group): MachineCollectionSection[] => {
        const enrolledIds = new Set(group.machines.map(machine => machine.id));
        const managedByMachineId = new Map((input.managedByServerId?.[group.serverId] ?? [])
            .flatMap(machine => machine.archivedAt === undefined && machine.enrolledMachineId ? [[machine.enrolledMachineId, machine] as const] : []));
        const names = resolveMachineDisplayNameParts(group.machines.map(machine => ({ ...machine,
            managedName: managedByMachineId.get(machine.id)?.launch.name })));
        const managedMachines = (input.managedByServerId?.[group.serverId] ?? [])
            .filter(machine => machine.archivedAt !== undefined || !machine.enrolledMachineId || !enrolledIds.has(machine.enrolledMachineId));
        // Your machines, then the ones Happier created for you, then each Home member's shared machines (lab `R`);
        // retired created machines close the list.
        const joinedCreations = group.machines.filter(machine => managedByMachineId.has(machine.id));
        const ownership = buildMachineOwnershipGroups(group.machines.filter(machine => !managedByMachineId.has(machine.id)))
            .filter(ownershipGroup => managedMachines.length === 0 && joinedCreations.length === 0 || ownershipGroup.machines.length > 0);
        const created = (key: 'managed' | 'managedArchived') => managedMachines.some(machine =>
            (machine.archivedAt !== undefined) === (key === 'managedArchived')) || key === 'managed' && joinedCreations.length > 0
            ? [{ key, custodian: null, machines: key === 'managed' ? joinedCreations : [] }] : [];
        const ownershipGroups = [
            ...ownership.filter(ownershipGroup => !ownershipGroup.key.startsWith('shared:')),
            ...created('managed'),
            ...ownership.filter(ownershipGroup => ownershipGroup.key.startsWith('shared:')),
            ...created('managedArchived'),
        ];
        return ownershipGroups.map((ownershipGroup) => {
            const rows = ownershipGroup.machines
                .map((machine): MachineCollectionRow => {
                const host = machine.metadata?.host?.trim() || null;
                const name = getMachineDisplayName(machine) ?? machine.id;
                const presence = describeMachinePresenceLine(machine, nowMs, managedByMachineId.get(machine.id), group.accountScope);
                const titleParts = names.get(machine.id) ?? { name, hint: null };
                return {
                    kind: 'machine',
                    machineId: machine.id,
                    serverId: group.serverId,
                    title: titleParts.hint ? `${titleParts.name} · ${titleParts.hint}` : titleParts.name,
                    titleParts,
                    host: !managedByMachineId.has(machine.id) && host && host !== name ? host : null,
                    platformLabel: formatOSPlatform(machine.metadata?.platform),
                    online: presence.online,
                    status: presence.status,
                    presence: presence.label,
                    reason: describeMachineLockedReason(machine),
                    ownership: describeMachineSharedOwnership(machine),
                    ownerName: machine.isShared ? machine.access?.custodian?.displayName ?? null : null,
                };
                })
                .filter((row) => !query
                    || row.title.toLocaleLowerCase().includes(query)
                    || (row.host?.toLocaleLowerCase().includes(query) ?? false))
                .sort(compareMachineCollectionRows);
            if (ownershipGroup.key === 'managed' || ownershipGroup.key === 'managedArchived') {
                const managedRows = managedMachines
                    .filter(machine => (machine.archivedAt !== undefined) === (ownershipGroup.key === 'managedArchived'))
                    .map((machine): MachineCollectionRow => {
                        const awaitingConsent = input.awaitingConsent?.has(managedMachineConsentKey(group.serverId, machine.id)) === true;
                        const creation = describeManagedCreation(machine);
                        return { kind: 'managed', managedId: machine.id,
                        serverId: group.serverId, title: machine.launch.name, titleParts: { name: machine.launch.name, hint: null }, host: null, platformLabel: '', online: false, status: 'offline',
                        presence: awaitingConsent ? t('approvals.waitingForYou') : creation.line,
                        ...(!awaitingConsent && creation.word ? { presenceWord: creation.word } : {}), reason: null, ownership: null, ownerName: null,
                        ...(machine.enrolledMachineId && machine.archivedAt === undefined ? { enrolledMachineId: machine.enrolledMachineId } : {}) };
                    })
                    .filter(row => !query || row.title.toLocaleLowerCase().includes(query));
                rows.push(...managedRows);
                rows.sort(compareMachineCollectionRows);
            }
            count += rows.length;
            if (ownershipGroup.key !== 'managedArchived') machineCount += rows.length;
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
            .filter(preset => !query || preset.name.toLocaleLowerCase().includes(query))
            .map((preset): MachinePresetCollectionRow => ({ kind: 'preset', presetId: preset.id,
                serverId: group.serverId, title: preset.name, preset,
                audience: preset.owner.kind === 'account' ? t('machinePresets.ownerPersonal')
                    : input.teamNamesByServerId?.[group.serverId]?.[preset.owner.teamId] ?? t('common.loading'),
                ...(preset.owner.kind === 'team' ? { teamName: input.teamNamesByServerId?.[group.serverId]?.[preset.owner.teamId] } : {}) }))
            .sort((a, b) => Number(a.preset.archivedAt !== undefined) - Number(b.preset.archivedAt !== undefined)
                || a.title.localeCompare(b.title) || machinePresetCollectionRowKey(a).localeCompare(machinePresetCollectionRowKey(b)));
        count += rows.length;
        return { key: JSON.stringify([group.serverId, 'presets']), serverId: group.serverId,
            title: input.groupedByHome ? group.serverName : null, status: group.status, rows };
    });
    return { count, machineCount, firstAnswerPending, sections, presetSections };
}

/**
 * Online machines first, then the ones that are not, each by the name the user sees (lab `R`): a fleet
 * with dozens of retired or sleeping machines still opens on the ones that can work.
 */
function compareMachineCollectionRows(a: MachineCollectionRow, b: MachineCollectionRow): number {
    return Number(b.online) - Number(a.online)
        || a.title.localeCompare(b.title)
        || machineCollectionRowKey(a).localeCompare(machineCollectionRowKey(b));
}

/**
 * A collection row's page, scoped to the Home it belongs to, in `door`. Rows outside Settings pass
 * `'rail'`; recipes are configuration and always open in Settings.
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

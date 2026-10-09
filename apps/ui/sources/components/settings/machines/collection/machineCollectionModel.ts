import type { ActiveSelectionMachineGroup } from '../hooks/useActiveSelectionMachineGroups';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { describeMachineLockedReason, getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import { resolveHappierCollectionInitialKey } from '@happier-dev/plugin-ui/presentation';
import { buildMachineOwnershipGroups, describeMachineSharedOwnership } from '@/sync/domains/machines/machineOwnershipGroups';
import { t } from '@/text';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { describeManagedCreation } from '../managed/managedCreationPresentation';

export const MACHINES_COLLECTION_ROOT = '/settings/machines';
export const MACHINES_THIS_COMPUTER_ROUTE = '/settings/machines/this-computer';
export const MACHINES_ADD_ROUTE = '/settings/machines/add';
export const MACHINE_PRESETS_ROUTE = `${MACHINES_COLLECTION_ROOT}/presets`;

/** The ways the add-a-machine form offers (`useMachineAddPaths` decides which this device can run). */
export type MachineAddRoutePath = 'thisComputer' | 'ssh' | 'anotherComputer';

/**
 * Add a machine: the Machines collection's draft (lab `add-flows` M4). `path` opens that way first when
 * this device offers it — "set up this computer" entry points ask for `thisComputer`.
 */
export function buildMachineAddHref(options: Readonly<{ path?: MachineAddRoutePath }> = {}): string {
    return options.path ? `${MACHINES_ADD_ROUTE}?path=${encodeURIComponent(options.path)}` : MACHINES_ADD_ROUTE;
}

type MachineCollectionRowPresentation = Readonly<{
    serverId: string;
    /** The name the user gave the machine, else its host; told apart when two share it. */
    title: string;
    /** The host, when the title is a different display name. */
    host: string | null;
    platformLabel: string;
    online: boolean;
    /** "Online", or "Offline · last seen …", from the shared presence owner. */
    presence: string;
    /** Why this device cannot read the machine, when it is locked. */
    reason: string | null;
    ownership: string | null;
}>;

export type MachineCollectionRow = MachineCollectionRowPresentation & (
    | Readonly<{ kind: 'machine'; machineId: string; managedId?: never }>
    | Readonly<{ kind: 'managed'; managedId: string; machineId?: never; enrolledMachineId?: string }>
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
    rows: readonly MachineCollectionRow[];
}>;

export type MachineCollection = Readonly<{
    count: number;
    sections: readonly MachineCollectionSection[];
    presetSections: readonly MachinePresetCollectionSection[];
}>;

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
    presetsByServerId?: Readonly<Record<string, readonly ManagedMachinePresetV1[]>>;
}>): MachineCollection {
    const query = input.query?.trim().toLocaleLowerCase() ?? '';
    const nowMs = input.nowMs ?? Date.now();
    let count = 0;
    const sections = input.groups.flatMap((group): MachineCollectionSection[] => {
        const names = resolveMachineDisplayNames(group.machines);
        const enrolledIds = new Set(group.machines.map(machine => machine.id));
        const managedMachines = (input.managedByServerId?.[group.serverId] ?? [])
            .filter(machine => !machine.enrolledMachineId || !enrolledIds.has(machine.enrolledMachineId));
        const ownershipGroups = [
            ...buildMachineOwnershipGroups(group.machines).filter(ownershipGroup => managedMachines.length === 0 || ownershipGroup.machines.length > 0),
            ...(managedMachines.length > 0 ? [{ key: 'managed', custodian: null, machines: [] }] : []),
        ];
        return ownershipGroups.map((ownershipGroup) => {
            const rows = ownershipGroup.machines
                .map((machine): MachineCollectionRow => {
                const host = machine.metadata?.host?.trim() || null;
                const name = getMachineDisplayName(machine) ?? machine.id;
                const presence = describeMachinePresenceLine(machine, nowMs);
                return {
                    kind: 'machine',
                    machineId: machine.id,
                    serverId: group.serverId,
                    title: names.get(machine.id) ?? name,
                    host: host && host !== name ? host : null,
                    platformLabel: formatOSPlatform(machine.metadata?.platform),
                    online: presence.online,
                    presence: presence.label,
                    reason: describeMachineLockedReason(machine),
                    ownership: describeMachineSharedOwnership(machine),
                };
                })
                .filter((row) => !query
                    || row.title.toLocaleLowerCase().includes(query)
                    || (row.host?.toLocaleLowerCase().includes(query) ?? false))
                .sort((a, b) => a.title.localeCompare(b.title) || machineCollectionRowKey(a).localeCompare(machineCollectionRowKey(b)));
            if (ownershipGroup.key === 'managed') {
                const managedRows = managedMachines
                    .map((machine): MachineCollectionRow => ({ kind: 'managed', managedId: machine.id,
                        serverId: group.serverId, title: machine.launch.name, host: null, platformLabel: '', online: false,
                        presence: describeManagedCreation(machine).line, reason: null, ownership: null,
                        ...(machine.enrolledMachineId ? { enrolledMachineId: machine.enrolledMachineId } : {}) }))
                    .filter(row => !query || row.title.toLocaleLowerCase().includes(query));
                rows.push(...managedRows);
                rows.sort((a, b) => a.title.localeCompare(b.title) || machineCollectionRowKey(a).localeCompare(machineCollectionRowKey(b)));
            }
            count += rows.length;
            const ownershipTitle = ownershipGroup.key.startsWith('shared:')
                ? t('machines.destinations.shared', { team: ownershipGroup.custodian?.displayName || t('common.unknown') })
                : ownershipGroup.key === 'owned' && ownershipGroups.some(group => group.key.startsWith('shared:')) ? t('machines.destinations.yours') : null;
            return {
                key: JSON.stringify([group.serverId, ownershipGroup.key]),
                serverId: group.serverId,
                title: input.groupedByHome
                    ? [group.serverName, ownershipTitle].filter(Boolean).join(' · ')
                    : ownershipTitle,
                status: group.status,
                rows,
            };
        });
    });
    const presetSections = input.groups.map((group): MachinePresetCollectionSection => {
        const rows = (input.presetsByServerId?.[group.serverId] ?? [])
            .filter(preset => !query || preset.name.toLocaleLowerCase().includes(query))
            .map((preset): MachinePresetCollectionRow => ({ kind: 'preset', presetId: preset.id,
                serverId: group.serverId, title: preset.name, preset }))
            .sort((a, b) => Number(a.preset.archivedAt !== undefined) - Number(b.preset.archivedAt !== undefined)
                || a.title.localeCompare(b.title) || machinePresetCollectionRowKey(a).localeCompare(machinePresetCollectionRowKey(b)));
        count += rows.length;
        return { key: JSON.stringify([group.serverId, 'presets']), serverId: group.serverId,
            title: input.groupedByHome ? group.serverName : null, status: group.status, rows };
    });
    return { count, sections, presetSections };
}

/** A machine's detail inside the collection, scoped to the Home it belongs to. */
export function machineCollectionHref(row: MachineCollectionTarget): string {
    if (row.kind === 'preset') return machinePresetCollectionHref(row);
    if (row.kind === 'managed') {
        return row.enrolledMachineId
            ? `${MACHINES_COLLECTION_ROOT}/${encodeURIComponent(row.enrolledMachineId)}?serverId=${encodeURIComponent(row.serverId)}`
            : `${MACHINES_COLLECTION_ROOT}/managed/${encodeURIComponent(row.managedId)}?serverId=${encodeURIComponent(row.serverId)}`;
    }
    return `${MACHINES_COLLECTION_ROOT}/${encodeURIComponent(row.machineId)}?serverId=${encodeURIComponent(row.serverId)}`;
}

export function machinePresetCollectionHref(row: Readonly<{ serverId: string; presetId: string }>): string {
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
 * Where a wide collection lands when its route names nothing: the machine last opened, the first
 * machine, this computer (desktop), or adding a machine.
 */
export function resolveMachineCollectionLandingHref(input: Readonly<{
    collection: MachineCollection;
    lastVisited: MachineCollectionTarget | null;
    isDesktop: boolean;
}>): string {
    const rows = [...input.collection.sections.flatMap((section) => section.rows),
        ...input.collection.presetSections.flatMap(section => section.rows)];
    const keyOf = machineCollectionRowKey;
    const landingKey = resolveHappierCollectionInitialKey({
        keys: rows.map(keyOf),
        lastVisited: input.lastVisited ? keyOf(input.lastVisited) : null,
    });
    const landing = rows.find((row) => keyOf(row) === landingKey);
    if (landing) return machineCollectionHref(landing);
    return input.isDesktop ? MACHINES_THIS_COMPUTER_ROUTE : MACHINES_ADD_ROUTE;
}

/**
 * The collection row the route selects: `machine:<serverId>:<id>` (the Home may be absent),
 * `thisComputer`, `defaults` (Machine defaults), `pool:<serverId>:<poolId>`, `poolDraft:<serverId>` for a pool being added, or
 * `machineDraft` for the machine being added.
 */
export function resolveSelectedMachineCollectionKey(
    pathname: string,
    params: Readonly<{ serverId?: string | null }>,
): string | null {
    const normalized = pathname.replace(/\/+$/, '');
    if (!normalized.startsWith(`${MACHINES_COLLECTION_ROOT}/`)) return null;
    const segments = normalized.slice(MACHINES_COLLECTION_ROOT.length + 1).split('/').map(decodeSegment);
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

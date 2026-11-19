export type MachineNameMetadata = Readonly<{ displayName?: string | null; host?: string | null }>;

/** The authored name, else the host; presentation adapters own unreadable/unnamed placeholders. */
export function readMachineName(metadata: MachineNameMetadata | null | undefined): string | null {
    const displayName = typeof metadata?.displayName === 'string' ? metadata.displayName.trim() : '';
    const host = typeof metadata?.host === 'string' ? metadata.host.trim() : '';
    return displayName || host || null;
}

type MachineNameSource = Readonly<{
    id: string;
    name: string;
    host?: string | null;
    /** Loading text is not an identity and must not gain an id suffix. */
    disambiguate?: boolean;
}>;

const MACHINE_ID_HINT_MIN_LENGTH = 4;

function sharedPrefixLength(left: string, right: string): number {
    const limit = Math.min(left.length, right.length);
    let length = 0;
    while (length < limit && left.charCodeAt(length) === right.charCodeAt(length)) length += 1;
    return length;
}

/**
 * Each id's shortest prefix (never under the minimum) that no other id in the group starts with. In code-unit
 * order an id shares its longest prefix with a neighbour, so one sort replaces comparing every pair.
 */
function uniqueIdHints(ids: readonly string[]): ReadonlyMap<string, string> {
    const sorted = [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const hints = new Map<string, string>();
    sorted.forEach((id, index) => {
        const shared = Math.max(
            index > 0 ? sharedPrefixLength(id, sorted[index - 1]!) : 0,
            index + 1 < sorted.length ? sharedPrefixLength(id, sorted[index + 1]!) : 0,
        );
        const length = Math.max(Math.min(MACHINE_ID_HINT_MIN_LENGTH, id.length), shared + 1);
        hints.set(id, length < id.length ? id.slice(0, length) : id);
    });
    return hints;
}

type NamedMachine = Readonly<{ name: string; host: string; machine: MachineNameSource }>;

/**
 * Same-name machines use a distinct host, otherwise the shortest unique stable id prefix. Machines are grouped by
 * name once and compared only within their group, so a fleet of same-named Machines costs one pass, not one per pair.
 */
export function resolveMachineDisplayNameParts(machines: readonly MachineNameSource[]): ReadonlyMap<string, Readonly<{ name: string; hint: string | null }>> {
    const groups = new Map<string, NamedMachine[]>();
    for (const machine of machines) {
        const name = machine.name;
        const entry: NamedMachine = { name, host: machine.host?.trim() ?? '', machine };
        const key = name.toLocaleLowerCase();
        const group = groups.get(key);
        if (group) group.push(entry);
        else groups.set(key, [entry]);
    }
    const resolved = new Map<string, Readonly<{ name: string; hint: string | null }>>();
    for (const [key, group] of groups) {
        const hostCounts = new Map<string, number>();
        if (group.length > 1) for (const { host } of group) {
            const hostKey = host.toLocaleLowerCase();
            hostCounts.set(hostKey, (hostCounts.get(hostKey) ?? 0) + 1);
        }
        let idHints: ReadonlyMap<string, string> | null = null;
        for (const { name, host, machine } of group) {
            if (group.length < 2 || machine.disambiguate === false) {
                resolved.set(machine.id, { name, hint: null });
                continue;
            }
            const hostKey = host.toLocaleLowerCase();
            if (host.length > 0 && hostKey !== key && hostCounts.get(hostKey) === 1) {
                resolved.set(machine.id, { name, hint: host });
                continue;
            }
            idHints ??= uniqueIdHints(group.map((entry) => entry.machine.id));
            resolved.set(machine.id, { name, hint: idHints.get(machine.id) ?? machine.id });
        }
    }
    // Callers read names in inventory order.
    const names = new Map<string, Readonly<{ name: string; hint: string | null }>>();
    for (const machine of machines) names.set(machine.id, resolved.get(machine.id)!);
    return names;
}

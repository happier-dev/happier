import { t } from '@/text';

/**
 * How the app names machines. `getMachineDisplayName` names one machine; `resolveMachineDisplayNames`
 * names a set shown together and tells same-named machines apart. Every list, picker and detail
 * title reads these, never its own `displayName || host || id`. A machine is never shown by its raw
 * id: without a name or host it is "Unnamed machine", a machine whose details cannot be read is
 * "Locked machine", a machine a list refers to but no longer holds is named by what happened to it
 * (`absence`), and the short id appears only as the suffix that tells such machines apart. Keys,
 * dedupe and agent-facing data use `readMachineName` with their own id fallback.
 */
type MachineNameMetadata = Readonly<{ displayName?: string | null; host?: string | null }> | null;
type MachineNameAvailability = Readonly<{ kind: string; reason?: string }> | null;
/**
 * Why a referenced machine is not in the inventory: removed (revoked), replaced, a temporary
 * computer, or simply not listed here.
 */
export type MachineAbsence = 'removed' | 'replaced' | 'temporary' | 'unlisted';
type MachineNameInput = Readonly<{
    id?: string | null;
    metadata?: MachineNameMetadata;
    availability?: MachineNameAvailability;
    absence?: MachineAbsence | null;
}>;

const ABSENT_MACHINE_NAME_KEYS = {
    removed: 'machine.removedMachine',
    replaced: 'machine.replacedMachine',
    temporary: 'newSession.temporaryComputer.title',
    unlisted: 'machine.unlistedMachine',
} as const satisfies Record<MachineAbsence, string>;

const LOCKED_REASON_KEYS = {
    // Sync found no Account key material on this device to open the Machine's key.
    encryption_material_unavailable: 'machine.lockedReason.missingKey',
    // The Machine's key envelope is present but this device could not open it.
    decryption_failed: 'machine.lockedReason.unopenable',
    // A plaintext Machine whose content could not be parsed.
    content_unreadable: 'machine.lockedReason.unreadable',
    recipient_key_pending: 'machines.destinations.pendingKey',
    recipient_access_refused: 'common.unavailable',
} as const;

/**
 * A machine whose details this device cannot read: sync explicitly projects a locked availability
 * state. `metadata: null` alone is also used while encrypted metadata is still hydrating.
 */
function isMachineLocked(machine: MachineNameInput): boolean {
    return machine.availability?.kind === 'locked';
}

function isMachineDisplayHydrating(machine: MachineNameInput): boolean {
    return machine.metadata === null && machine.availability === undefined;
}

/**
 * Why this device cannot read a locked machine, as the row's reason line; `null` for a readable one.
 * The wording follows the reason sync recorded when it locked the Machine.
 */
export function describeMachineLockedReason(machine: MachineNameInput | null | undefined): string | null {
    if (!machine || machine.absence || !isMachineLocked(machine)) return null;
    const reason = machine.availability?.reason;
    const key = reason && reason in LOCKED_REASON_KEYS
        ? LOCKED_REASON_KEYS[reason as keyof typeof LOCKED_REASON_KEYS]
        : LOCKED_REASON_KEYS.content_unreadable;
    return t(key);
}

/** The name a person gave the machine, else its host; `null` when it has neither or is locked. */
export function readMachineName(machine: MachineNameInput | null | undefined): string | null {
    if (machine && (machine.absence || isMachineLocked(machine))) return null;
    const displayName = typeof machine?.metadata?.displayName === 'string' ? machine.metadata.displayName.trim() : '';
    if (displayName) return displayName;
    const host = typeof machine?.metadata?.host === 'string' ? machine.metadata.host.trim() : '';
    return host || null;
}

/** What a machine whose details cannot be read is called on screen. */
export function lockedMachineName(): string {
    return t('machine.lockedMachine');
}

/** What an unnamed machine is called on screen. */
export function unnamedMachineName(): string {
    return t('machine.unnamedMachine');
}

export function getMachineDisplayName(machine: MachineNameInput): string;
export function getMachineDisplayName(machine: MachineNameInput | null | undefined): string | null;
export function getMachineDisplayName(machine: MachineNameInput | null | undefined): string | null {
    if (!machine) return null;
    if (machine.absence) return t(ABSENT_MACHINE_NAME_KEYS[machine.absence]);
    if (isMachineLocked(machine)) return lockedMachineName();
    if (isMachineDisplayHydrating(machine)) return t('common.loading');
    return readMachineName(machine) ?? unnamedMachineName();
}

type MachineNameSource = MachineNameInput & Readonly<{ id: string }>;

const MACHINE_ID_HINT_MIN_LENGTH = 4;

function uniqueIdHint(id: string, others: readonly string[]): string {
    for (let length = Math.min(MACHINE_ID_HINT_MIN_LENGTH, id.length); length < id.length; length += 1) {
        const prefix = id.slice(0, length);
        if (others.every((other) => !other.startsWith(prefix))) return prefix;
    }
    return id;
}

/**
 * The names of machines shown together (a list, a picker, the home hub): each machine's
 * `getMachineDisplayName`, and only where two share a name (ignoring case, unnamed machines
 * included), a suffix that tells them apart: the host when it differs from the name and is unique
 * among them, else the shortest unique prefix of the machine id. Presence is not used: it changes,
 * and a name must stay stable.
 */
export function resolveMachineDisplayNames(machines: readonly MachineNameSource[]): ReadonlyMap<string, string> {
    const baseById = new Map(machines.map((machine) => [machine.id, getMachineDisplayName(machine)]));
    const idsByName = new Map<string, string[]>();
    for (const machine of machines) {
        const key = baseById.get(machine.id)!.toLocaleLowerCase();
        idsByName.set(key, [...(idsByName.get(key) ?? []), machine.id]);
    }
    const byId = new Map(machines.map((machine) => [machine.id, machine]));
    const names = new Map<string, string>();
    for (const machine of machines) {
        const base = baseById.get(machine.id)!;
        const collidingIds = idsByName.get(base.toLocaleLowerCase()) ?? [];
        if (collidingIds.length < 2) {
            names.set(machine.id, base);
            continue;
        }
        const others = collidingIds.filter((id) => id !== machine.id);
        const host = machine.absence || isMachineLocked(machine) ? '' : machine.metadata?.host?.trim() ?? '';
        const hostDistinct = host.length > 0
            && host.toLocaleLowerCase() !== base.toLocaleLowerCase()
            && others.every((id) => (byId.get(id)?.metadata?.host?.trim() ?? '').toLocaleLowerCase() !== host.toLocaleLowerCase());
        names.set(machine.id, `${base} · ${hostDistinct ? host : uniqueIdHint(machine.id, others)}`);
    }
    return names;
}

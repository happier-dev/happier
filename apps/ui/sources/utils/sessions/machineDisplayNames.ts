import { t } from '@/text';
import { readMachineName as readPublishedMachineName, resolveMachineDisplayNameParts as resolvePublishedMachineNameParts, type MachineNameMetadata as PublishedMachineNameMetadata } from '@happier-dev/protocol/machines/machineDisplayNames';

/**
 * How the app names machines. `getMachineDisplayName` names one machine, optionally in its inventory;
 * `resolveMachineDisplayNames`
 * names a set shown together and tells same-named machines apart. Every list, picker and detail
 * title reads these, never its own `displayName || host || id`. A machine is never shown by its raw
 * id: without a name or host it is "Unnamed machine", a machine whose details cannot be read is
 * "Locked machine", a machine a list refers to but no longer holds is named by what happened to it
 * (`absence`), and the short id appears only as the suffix that tells such machines apart. Keys,
 * dedupe and agent-facing data use `readMachineName` with their own id fallback.
 */
type MachineNameMetadata = PublishedMachineNameMetadata | null;
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

export function isMachineDisplayHydrating(machine: MachineNameInput): boolean {
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
    return readPublishedMachineName(machine?.metadata);
}

/** What a machine whose details cannot be read is called on screen. */
export function lockedMachineName(): string {
    return t('machine.lockedMachine');
}

/**
 * The machine's name as copy uses it inside a sentence ("Can't list processes on {machine}",
 * "Sign in on {machine}"). A machine whose details are locked or still loading has a placeholder
 * title, not a name, so the sentence says "this machine" rather than "Locked machine" or "Loading…".
 * Pass `displayName` when the title was already resolved among sibling machines (same-name
 * disambiguation); otherwise it is the machine's own display name.
 */
export function getMachineSentenceName(machine: MachineNameInput | null | undefined, displayName?: string): string {
    if (!machine || (!machine.absence && (isMachineLocked(machine) || isMachineDisplayHydrating(machine)))) {
        return t('machine.thisMachineInSentence');
    }
    return keepHyphenatedNameTogether(displayName ?? getMachineDisplayName(machine));
}

/**
 * A line may break after a hyphen, which splits a host name like "NLDW3-5-36-33" mid-name. A word
 * joiner (zero width, no glyph) after each hyphen leaves the break opportunity only at the spaces
 * around the name, so a sentence wraps before the name rather than inside it.
 */
export function keepHyphenatedNameTogether(name: string): string {
    return name.replace(/-(?=[^\s-])/g, '-\u2060');
}

/** What an unnamed machine is called on screen. */
export function unnamedMachineName(): string {
    return t('machine.unnamedMachine');
}

export function getMachineDisplayName(machine: MachineNameInput, inventory?: readonly MachineNameSource[]): string;
export function getMachineDisplayName(machine: MachineNameInput | null | undefined, inventory?: readonly MachineNameSource[]): string | null;
export function getMachineDisplayName(machine: MachineNameInput | null | undefined, inventory?: readonly MachineNameSource[]): string | null {
    if (!machine) return null;
    const name = machineBaseDisplayName(machine);
    // Qualify just this chip through the same resolver that names its picker.
    if (inventory && machine.id) {
        const peers = selectMachineDisplayNamePeers(machine, inventory);
        return resolveMachineDisplayNames(peers).get(machine.id) ?? name;
    }
    return name;
}

/**
 * The machine's name only once it has been read; `null` while its details are still hydrating. A row that
 * names a machine inside a line of facts (a subtitle, a request's source) never prints the
 * "Loading…" placeholder as if it were the name: a machine on another Home or one that is offline may
 * never hydrate, and the placeholder would then sit there for good. The caller falls back to what it
 * knows (the Session's own host) or leaves the machine out.
 */
export function getSettledMachineDisplayName(machine: MachineNameInput | null | undefined, inventory?: readonly MachineNameSource[]): string | null {
    if (!machine || (!machine.absence && isMachineDisplayHydrating(machine))) return null;
    return getMachineDisplayName(machine, inventory);
}

function machineBaseDisplayName(machine: MachineNameInput): string {
    if (machine.absence) return t(ABSENT_MACHINE_NAME_KEYS[machine.absence]);
    if (isMachineLocked(machine)) return lockedMachineName();
    if (isMachineDisplayHydrating(machine)) return t('common.loading');
    return readMachineName(machine) ?? unnamedMachineName();
}

/** Only same-name peers can affect a selected label's inventory qualification. */
export function selectMachineDisplayNamePeers(
    machine: MachineNameInput | null | undefined,
    inventory: readonly MachineNameSource[],
): readonly MachineNameSource[] {
    if (!machine?.id || machine.absence || isMachineLocked(machine) || isMachineDisplayHydrating(machine)) return [];
    const listed = inventory.find(candidate => candidate.id === machine.id);
    if (!listed) return [];
    const name = machineBaseDisplayName(listed).toLocaleLowerCase();
    return inventory.filter(candidate => machineBaseDisplayName(candidate).toLocaleLowerCase() === name)
        .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * The machine a session runs on, as its Info page, header and offline-delete copy name it: the
 * inventory's display name when the machine is listed. A machine the inventory no longer lists, or
 * lists with details that are still locked or loading, keeps the host its own session published (only
 * when it is that session's machine), so the page never names one machine two ways; without that host
 * it reads as its placeholder or as unlisted. It is never named by its raw id.
 */
export function getSessionMachineLabel(input: Readonly<{
    machineId: string;
    machine: MachineNameInput | null | undefined;
    session: Readonly<{ machineId?: string | null; host?: string | null }>;
}>): string {
    const host = input.machineId === input.session.machineId ? input.session.host?.trim() : '';
    const unreadable = Boolean(input.machine && !input.machine.absence
        && (isMachineLocked(input.machine) || isMachineDisplayHydrating(input.machine)));
    if (unreadable && host) return host;
    const listed = getMachineDisplayName(input.machine);
    if (listed) return listed;
    return host || getMachineDisplayName({ id: input.machineId, absence: 'unlisted' });
}

type MachineNameSource = MachineNameInput & Readonly<{ id: string }>;

/**
 * The names of machines shown together (a list, a picker, the home hub): each machine's
 * `getMachineDisplayName`, and only where two share a name (ignoring case, unnamed machines
 * included), a suffix that tells them apart: the host when it differs from the name and is unique
 * among them, else the shortest unique prefix of the machine id. Presence is not used: it changes,
 * and a name must stay stable.
 */
export function resolveMachineDisplayNames(machines: readonly MachineNameSource[]): ReadonlyMap<string, string> {
    return new Map([...resolveMachineDisplayNameParts(machines)].map(([id, parts]) => [id, formatMachineDisplayNameParts(parts)]));
}

/** A machine's name and telling suffix as the one-string name ("Build box · 3ca2"). */
export function formatMachineDisplayNameParts(parts: Readonly<{ name: string; hint: string | null }>): string {
    return parts.hint ? `${parts.name} · ${parts.hint}` : parts.name;
}

/**
 * The same names as {@link resolveMachineDisplayNames}, kept in their two parts: the machine's own
 * name and the suffix that tells it apart (`null` when its name is already unique). A one-line row
 * shortens the name and keeps the suffix whole.
 */
export function resolveMachineDisplayNameParts(machines: readonly MachineNameSource[]): ReadonlyMap<string, Readonly<{ name: string; hint: string | null }>> {
    return resolvePublishedMachineNameParts(machines.map(machine => ({
        id: machine.id, name: getMachineDisplayName(machine),
        host: machine.absence || isMachineLocked(machine) ? null : machine.metadata?.host,
        // An absent machine's null metadata is final, not hydrating: it is told apart by its short id.
        disambiguate: Boolean(machine.absence) || !isMachineDisplayHydrating(machine),
    })));
}

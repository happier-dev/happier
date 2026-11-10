import { MachinePresenceTransitionsV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';

/**
 * A due-time consumer must not mistake a later reconnect for on-time presence.
 * The presence owner retains only the latest transition of each kind, so it
 * cannot reconstruct an instant before multiple later disconnect/reconnects.
 * An erased history is unavailable, so a due-time consumer can visibly miss
 * uncertain work rather than execute a possibly late occurrence.
 */
export function classifyMachinePresenceAtInstant(machine: Readonly<{
    active: boolean; presenceTransitions: string | null;
}>, instant: number): "present" | "offline" | "unavailable" {
    const transitions = machine.presenceTransitions === null ? null
        : MachinePresenceTransitionsV1Schema.parse(JSON.parse(machine.presenceTransitions));
    if (!transitions) return machine.active ? "present" : "offline";
    const offline = transitions.offline?.occurredAt;
    const online = transitions.online?.occurredAt;
    if (online !== undefined && online > instant) {
        return offline !== undefined && offline <= instant ? "offline" : "unavailable";
    }
    if (offline !== undefined && offline <= instant && (online === undefined || offline > online)) return "offline";
    // A later disconnect does not retroactively make an on-time target offline.
    return machine.active || (offline !== undefined && offline > instant) ? "present" : "offline";
}

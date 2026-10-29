import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

/**
 * First character of the machine's display name (alias, else host, else id), uppercased — the
 * letter shown inside the strip's avatar circles. Machines with no derivable name get `?`.
 */
export function getMachineAvatarInitial(
    machine: Parameters<typeof getMachineDisplayName>[0],
): string {
    const displayName = getMachineDisplayName(machine) ?? '';
    const firstCharacter = Array.from(displayName.trim())[0];
    return firstCharacter ? firstCharacter.toUpperCase() : '?';
}

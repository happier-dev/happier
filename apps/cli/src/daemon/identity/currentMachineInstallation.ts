import type {
    MachineInstallationIdentityV1,
    PluginPermissionGrantAuthoritySourceV1,
} from '@happier-dev/protocol';

import { readSettings } from '@/persistence';

import { readOrCreateInstallationIdentity } from './store';

/**
 * The registered machine and the installation keypair currently running on it.
 * This is the one local answer to "which machine installation is acting", used
 * both to sign publisher proofs and to decide which persisted approvals were
 * granted to this exact installation.
 */
export type CurrentMachineInstallation = Readonly<{
    machineId: string;
    identity: MachineInstallationIdentityV1;
}>;

export async function readCurrentMachineInstallation(): Promise<CurrentMachineInstallation | null> {
    const settings = await readSettings().catch(() => null);
    const machineId = typeof settings?.machineId === 'string' ? settings.machineId.trim() : '';
    if (!machineId) return null;
    const identity = await readOrCreateInstallationIdentity().catch(() => null);
    if (!identity) return null;
    return Object.freeze({ machineId, identity });
}

/**
 * Projects the current machine installation onto the authority a persisted
 * plugin permission grant records. An unresolvable installation yields `null`,
 * which every evaluator treats as unauthorized rather than as "any authority".
 */
export async function resolveCurrentPluginPermissionGrantAuthoritySource(): Promise<
    PluginPermissionGrantAuthoritySourceV1 | null
> {
    const current = await readCurrentMachineInstallation();
    if (!current) return null;
    return Object.freeze({
        kind: 'machine_installation' as const,
        machineId: current.machineId,
        installationId: current.identity.installationId,
    });
}

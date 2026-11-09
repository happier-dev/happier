import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { classifyManagedMachineAllocationV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';

import { DOCKER_SANDBOXES_PLUGIN_ID, DOCKER_SANDBOXES_PROVISIONER_ID } from '../machine/provider.js';

type ManagedMachine = PluginActionResultById['machines.managed.list']['machines'][number];
type ProvisionerCheck = PluginActionResultById['machines.provisioners.check'];

/**
 * What a sandbox row can truthfully say. Power comes only from the provisioner's native observation:
 * a sandbox Happier is still creating is `creating`, one the native inventory no longer has is `gone`,
 * and an unanswered or unqualified read is `unknown`, never `stopped`.
 */
export type SandboxState = 'running' | 'stopped' | 'creating' | 'waiting' | 'mayExist' | 'gone' | 'unknown';

export type SandboxRow = Readonly<{
    managedId: string;
    /** The native sandbox name `sbx` addresses (the reviewed name until the resource is bound). */
    name: string;
    templateId?: string;
    state: SandboxState;
    /** The Machine the sandbox enrolled as, once Happier runs inside it. */
    enrolledMachineId?: string;
}>;

function readLaunchChoice(machine: ManagedMachine, key: 'name' | 'templateId'): string | undefined {
    const choices = machine.launch.choices;
    if (!choices || typeof choices !== 'object' || Array.isArray(choices)) return undefined;
    const value = (choices as Readonly<Record<string, unknown>>)[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readSandboxName(machine: ManagedMachine): string {
    const value = machine.resource?.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const name = (value as Readonly<Record<string, unknown>>).sandboxName;
        if (typeof name === 'string' && name.length > 0) return name;
    }
    return readLaunchChoice(machine, 'name') ?? machine.launch.name;
}

function readState(machine: ManagedMachine): SandboxState {
    const allocation = classifyManagedMachineAllocationV1(machine);
    if (allocation === 'unsubmitted') return 'waiting';
    if (allocation === 'may-exist') return 'mayExist';
    if (allocation === 'creating') return 'creating';
    const observation = machine.observation;
    if (machine.allocation === 'confirmed-absent' || observation?.availability === 'absent') return 'gone';
    if (!observation || observation.availability !== 'present') return 'unknown';
    if (observation.power === 'running') return 'running';
    if (observation.power === 'stopped' || observation.power === 'suspended') return 'stopped';
    return 'unknown';
}

const STATE_ORDER: Readonly<Record<SandboxState, number>> = { running: 0, creating: 1, waiting: 2, mayExist: 3, unknown: 4, stopped: 5, gone: 6 };

/**
 * The sandboxes this Machine runs: the Account's managed Machines this plugin's provisioner created with this
 * Machine as their controller, still active. Running work first, then by name.
 */
export function selectMachineSandboxes(machines: readonly ManagedMachine[], machineId: string): readonly SandboxRow[] {
    return machines
        .filter(machine => machine.launch.provider.pluginId === DOCKER_SANDBOXES_PLUGIN_ID
            && machine.launch.provider.localId === DOCKER_SANDBOXES_PROVISIONER_ID
            && machine.controller?.machineId === machineId
            && machine.creationState === 'active'
            && machine.archivedAt === undefined)
        .map((machine): SandboxRow => {
            const templateId = readLaunchChoice(machine, 'templateId');
            return {
                managedId: machine.id, name: readSandboxName(machine), state: readState(machine),
                ...(templateId ? { templateId } : {}),
                ...(machine.enrolledMachineId ? { enrolledMachineId: machine.enrolledMachineId } : {}),
            };
        })
        .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
}

/** Whether this Machine can run sandboxes, in the words the provisioner's own check owns. */
export type SandboxAvailability =
    | Readonly<{ kind: 'ready' }>
    | Readonly<{ kind: 'notInstalled' }>
    | Readonly<{ kind: 'unavailable'; code?: string }>;

export function readSandboxAvailability(check: ProvisionerCheck): SandboxAvailability {
    if (check.available) return { kind: 'ready' };
    if (check.code === 'docker_sandbox_unavailable') return { kind: 'notInstalled' };
    return { kind: 'unavailable', ...(check.code ? { code: check.code } : {}) };
}

/** What the page needs from its Machine to read Account Machine Actions: the Home and this Machine as a controller. */
export type SandboxPageScope = Readonly<{ homeId: string; controller: Readonly<{ machineId: string; installationId: string }> }>;

/**
 * The host stamps the mounted Machine's verified Home and current installation when it knows them (an older or
 * not yet enrolled record omits them); without both the page cannot address this Machine as a controller.
 */
export function readSandboxPageScope(target: SurfaceContext['target']): SandboxPageScope | null {
    if (target.kind !== 'machine' || !target.homeId || !target.installationId) return null;
    return { homeId: target.homeId, controller: { machineId: target.machineId, installationId: target.installationId } };
}

/**
 * "New sandbox": the host's managed-Machine configuration (draft and review) with this provisioner, and this Machine as
 * controller from the mount. It creates nothing itself. A host that cannot open it (no method in `version().methods`)
 * gets no button rather than a dead one.
 */
export function readSandboxCreateRequest(hostMethods: readonly string[]): Readonly<{ provisioner: Readonly<{ pluginId: string; localId: string }> }> | null {
    return hostMethods.includes('openManagedMachineConfiguration')
        ? { provisioner: { pluginId: DOCKER_SANDBOXES_PLUGIN_ID, localId: DOCKER_SANDBOXES_PROVISIONER_ID } }
        : null;
}

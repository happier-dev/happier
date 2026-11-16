import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import type { MachineServicesListResultV1 } from '@happier-dev/protocol/actions/specs/machine/services';
import { isMap, parseDocument } from 'yaml';

type Writer = Readonly<{ machineId: string; serviceId: string; expectedGeneration: string }>;
type Stopped = Readonly<{ machineId: string; serviceId: string; composeService: string }>;
export type DatabaseMoveWritersPreparation = Readonly<{ kind: 'ready'; writers: Writer[];
    runningServices: string[]; stopped: Stopped[] }>
    | Readonly<{ kind: 'unavailable'; reason: 'writer_review_required' | 'noRunningWriter' }>;

/** Review the native source inventory before authoring effects. Data operations already select one runtime Machine. */
export function prepareDatabaseMoveWriters(content: DeploymentEnvironmentContentV1, environmentId: string,
    sourceService: string, inventories: readonly Readonly<{ machineId: string; installationId: string;
        deploymentId: string; result: MachineServicesListResultV1 }>[]): DatabaseMoveWritersPreparation {
    const unavailable = { kind: 'unavailable', reason: 'writer_review_required' } as const;
    if (content.definition.kind !== 'stored') return unavailable;
    const document = parseDocument(content.definition.document, { merge: true });
    const services = document.get('services', true);
    if (document.errors.length || !isMap(services)) return unavailable;
    const dataServices = new Set([sourceService, ...(content.template?.data?.map(data => data.service) ?? [])]);
    const declared = content.definition.services.length ? content.definition.services : services.items.map(item => String(item.key));
    const applications = declared.filter(service => !dataServices.has(service));
    const writers: Writer[] = [];
    const stopped: Stopped[] = [];
    const runningServices = new Set<string>();
    for (const inventory of inventories) {
        if (inventory.result.kind !== 'snapshot') return unavailable;
        const candidates = inventory.result.services.filter(row => {
            const identity = row.deployment?.service;
            return row.authority === 'project' && row.lifecyclePurpose === 'deployment'
                && row.environmentId === environmentId && row.deployment?.deploymentId === inventory.deploymentId
                && row.deployment.installationId === inventory.installationId && identity?.machineId === inventory.machineId
                && identity.environmentId === environmentId && identity.serviceId === row.serviceId;
        });
        if (applications.some(name => !candidates.some(row => row.deployment?.service.composeService === name))) return unavailable;
        // Include dependency services the native runtime actually serves, even when Compose selected only the app.
        for (const row of candidates) {
            const composeService = row.deployment!.service.composeService;
            if (dataServices.has(composeService)) continue;
            if (row.native?.phase === 'stopped') {
                stopped.push({ machineId: inventory.machineId, serviceId: row.serviceId, composeService });
            } else if (row.native?.phase === 'running' && row.generation && row.capabilities.stop) {
                writers.push({ machineId: inventory.machineId, serviceId: row.serviceId, expectedGeneration: row.generation });
                runningServices.add(composeService);
            } else return unavailable;
        }
    }
    return writers.length ? { kind: 'ready', writers, runningServices: [...runningServices], stopped }
        : { kind: 'unavailable', reason: 'noRunningWriter' };
}

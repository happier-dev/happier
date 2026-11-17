import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries/registryActionsV1';
import { DeploymentTemplateInstantiateResultV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptResultV1Schema,
    DeploymentDomainMutationResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentAppMachineAssociationV1Schema } from '@happier-dev/protocol/machines/enrollmentV1';
import { DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1, MachineRolesGetResultV1Schema } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { createEnrollMachineFlowExecutorFromHappierJsonExecutor } from '../../../../packages/cli-common/src/systemTasks/executors/enrollMachineFlowExecutor';
import { createHappierJsonExecutorFromTextRunner } from '../../../../packages/cli-common/src/systemTasks/executors/happierJsonExecutorFromTextRunner';
import { resolveRemoteInstalledFirstPartyBinaryPath } from '../../../../packages/cli-common/src/systemTasks/ssh/remoteFirstPartyInstallPath';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { resolveOwnServerDeploymentIdentityForHost } from './targets/ownServer/paths';
import type { ProductionTelemetryCollectorAppJourney } from './deploymentTelemetryJourney.testkit';

const ListedMachines = z.looseObject({ items: z.array(z.looseObject({ machineId: z.string(),
    deploymentApp: z.optional(z.nullable(DeploymentAppMachineAssociationV1Schema)) })) });
const ComposeDocument = z.looseObject({ services: z.record(z.string(), z.looseObject({
    environment: z.record(z.string(), z.unknown()), volumes: z.optional(z.array(z.unknown())),
})) });

/** Shares the incumbent real Home, Accounts and native Docker boundary. */
export const runCollectorAppJourney: ProductionTelemetryCollectorAppJourney = async context => {
    const { home, initiator, nativeDocker } = context;
    const catalog = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list'].parse(
        await initiator.accepted('registries.sources.list', { kind: 'app' })).sources
        .find(source => 'packageContent' in source && source.origin.pluginId === 'happier.deployment.templates');
    if (!catalog) throw new Error('The enrolled host must publish its bundled App catalog');
    const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await initiator.accepted(
        'registries.items.read', { kind: 'app', sourceId: catalog.id, itemId: 'telemetry-collector' })).item;
    if (selected.payload.kind !== 'app' || selected.payload.state !== 'ready' || !selected.summary.version) {
        throw new Error('The catalog must produce the ready collector App');
    }
    const applied = DeploymentTemplateInstantiateResultV1Schema.parse(await initiator.accepted('deployments.templates.instantiate', {
        mode: 'apply', serverId: home.serverId, machineId: home.machineId, projectSourceId: initiator.projectSourceId,
        templateRef: { sourceId: catalog.id, itemId: selected.summary.itemId, version: selected.summary.version, ref: selected.payload.ref },
        environment: { kind: 'create', name: 'F14 collector App', requestKey: randomUUID(), protection: 'nonProduction',
            purpose: 'standard', deployerMode: 'managers', controllerMachineId: home.machineId },
        target: { kind: 'new', installationId: home.installationId }, destination: { kind: 'stored' },
        bindings: [{ purpose: 'variable', phase: 'runtime', name: 'HAPPIER_SERVER_URL', source: { kind: 'value', value: home.baseUrl } }],
    }));
    if (applied.kind !== 'applied') throw new Error(`Collector template did not apply: ${applied.kind}`);
    const environmentId = applied.environmentId;
    const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
        serverId: home.serverId, environmentId });
    const projectFilter = `label=com.docker.compose.project=${identity.projectName}`;
    context.cleanup.push(async () => {
        for (const [kind, args] of [['container', ['ps', '--all']], ['network', ['network', 'ls']], ['volume', ['volume', 'ls']]] as const) {
            const listed = await nativeDocker([...args, '--filter', projectFilter, '--quiet']);
            for (const id of listed.stdout.trim().split('\n').filter(Boolean)) {
                await nativeDocker(kind === 'container' ? ['rm', '--force', '--volumes', id] : [kind, 'rm', id]);
            }
        }
    });
    const readCollector = async () => {
        const detail = DeploymentEnvironmentGetResultV1Schema.parse(await initiator.accepted('deployments.environments.get', {
            serverId: home.serverId, environmentId }));
        if (!detail.ok) throw new Error(detail.error);
        return detail;
    };
    const detail = await readCollector();
    if (detail.content.definition.kind !== 'stored') throw new Error('The collector template must create a stored definition');
    const document = ComposeDocument.parse(JSON.parse(detail.content.definition.document));
    const serviceName = selected.payload.app.compose.primaryService;
    const service = serviceName ? document.services[serviceName] : undefined;
    if (!serviceName || !service) throw new Error('The collector template must select its native service');
    const homeDir = z.string().parse(service.environment.HAPPIER_HOME_DIR);
    const binaryPath = resolveRemoteInstalledFirstPartyBinaryPath({ componentId: 'happier-cli', channel: 'stable', remoteHomeDir: homeDir });
    // Establish the fixture's real HTTPS trust through ordinary authored Compose
    // configuration. The image and enrollment transport remain unchanged.
    const caPath = process.env.NODE_EXTRA_CA_CERTS;
    if (!caPath) throw new Error('The native Home fixture must publish its public CA certificate path');
    const guestCaPath = '/home/happier/home-fixture-ca.pem';
    service.environment.NODE_EXTRA_CA_CERTS = guestCaPath;
    service.volumes = [...service.volumes ?? [], { type: 'bind', source: caPath, target: guestCaPath, read_only: true }];
    await initiator.accepted('deployments.environments.update', { serverId: home.serverId, environmentId,
        expectedRevision: detail.environment.revision, contentArtifactId: detail.environment.contentArtifactId,
        contentHeaderVersion: detail.environment.contentHeaderVersion, contentBodyVersion: detail.environment.contentBodyVersion,
        patch: { definition: { from: 'compose', document: JSON.stringify(document),
            profiles: detail.content.definition.profiles, services: detail.content.definition.services } } });
    const receipt = DeploymentReceiptResultV1Schema.parse(await initiator.accepted('deployments.deploy', {
        serverId: home.serverId, environmentId, targetLinkId: applied.targetLinkId, requestKey: randomUUID() }));
    if (!receipt.ok || receipt.state !== 'succeeded') throw new Error('The collector App deployment must settle successfully');
    const machines = ListedMachines.parse(await initiator.accepted('machines.list', { serverId: home.serverId, refresh: true })).items
        .filter(machine => machine.deploymentApp?.environmentId === environmentId);
    if (machines.length !== 1) throw new Error('The deployed App must publish exactly one enrolled child Machine');
    const machineId = machines[0].machineId;
    const api = await ApiClient.create(initiator.credentials);
    const machine = await runWithServerHttpBaseUrl(home.baseUrl, () => api.getMachine(machineId));
    if (!machine || machine.deploymentApp?.deploymentId !== receipt.deploymentId) throw new Error('The child must retain its accepted deployment association');
    const roles = MachineRolesGetResultV1Schema.parse(await initiator.accepted('machines.roles.get', { serverId: home.serverId, machineId }));
    if (roles.status !== 'ready' || !roles.policy.active.includes(DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1)) {
        throw new Error('The enrolled App must activate the canonical Telemetry role');
    }
    await initiator.accepted('machines.access.grant.set', { serverId: home.serverId, machineId,
        principal: { kind: 'team', teamId: initiator.teamId }, level: 'view' });
    await initiator.accepted('machines.access.prepareKeys', { serverId: home.serverId, machineId });
    const containers = await nativeDocker(['ps', '--all', '--filter', projectFilter,
        '--filter', `label=com.docker.compose.service=${serviceName}`, '--format', '{{.ID}}']);
    const ids = containers.stdout.trim().split('\n').filter(Boolean);
    if (ids.length !== 1) throw new Error('The collector must run in its admitted native container');
    const containerId = ids[0];
    const assertReady = async () => {
        const executor = createHappierJsonExecutorFromTextRunner(async args => ({ status: 0,
            ...await nativeDocker(['exec', containerId, binaryPath, ...args]) }));
        const ready = await createEnrollMachineFlowExecutorFromHappierJsonExecutor({ executor }).waitForReadyDaemon!({
            signal: context.signal, requireServiceInstalled: false, requireMachineControlReady: true });
        if (ready.machineId !== machineId) throw new Error('The restarted App must retain its registered Machine');
        await nativeDocker(['exec', containerId, 'sh', '-c',
            `test "$(readlink /proc/1/exe)" = "$(readlink -f ${safeBashSingleQuote(binaryPath)})"`]);
    };
    await assertReady();
    const domains = new Map<string, Readonly<{ id: string; revision: number; hostname: string }>>();
    return { machineId, environmentId,
        restart: async () => { await nativeDocker(['restart', containerId]); await assertReady(); },
        stop: async () => { await nativeDocker(['stop', containerId]); },
        start: async () => { await nativeDocker(['start', containerId]); await assertReady(); },
        prepareEnvironment: async monitoredId => {
            const current = await context.readEnvironment(monitoredId);
            const link = current.targetLinks.find(item => item.targetLink.id === current.environment.runtimeTargetLinkId)?.targetLink;
            if (!link) throw new Error('The monitored Environment must retain its runtime target');
            const existing = domains.get(monitoredId);
            const id = existing?.id ?? randomUUID();
            const hostname = existing?.hostname ?? `f14-telemetry-${id}.localhost`;
            const domain = DeploymentDomainMutationResultV1Schema.parse(await context.accepted('deployments.domains.add', {
                serverId: home.serverId, environmentId: monitoredId, targetLinkId: link.id,
                expectedRevision: current.environment.revision, expectedTargetLinkRevision: link.revision,
                domainId: id, ...(existing ? { expectedDomainRevision: existing.revision } : {}), requestKey: randomUUID(),
                content: { hostname, target: { kind: 'telemetry' } } }));
            if (!domain.ok || domain.domain.state === 'failed') throw new Error('The selected collector must expose the normal telemetry Domain');
            domains.set(monitoredId, { id, hostname, revision: domain.domain.revision });
        },
    };
};

import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { prepareDeploymentTargetEnablementRetention } from './targetEnablementRetention';
import { requiresOriginalAccountMachineActionProof } from '@/api/externalActionExecutionAuthorization';

const machine = ManagedMachineV1Schema.parse({ id: 'allocation', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'server', choices: {} },
    allocation: 'bound', creationState: 'active', enrolledMachineId: 'machine',
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
    desired: 'start', desiredWhen: 'now', intentRevision: 4,
    retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: true });

function opaquePresetRead(row: typeof machine) {
    const { launch, resource, ...structural } = row;
    if (!resource) throw new Error('opaque_fixture_requires_resource');
    return {
        machine: { ...structural, preset: { id: 'preset-allocation', revision: 1, contentEncryptionMode: 'plain' as const } },
        presetContent: { content: { t: 'plain' as const, v: {
            v: 1 as const, name: launch.name, launch,
            nativeResult: { kind: 'bound' as const, resource },
        } }, recipientEnvelope: null },
    };
}
const reference = { contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 };
type Request = Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0];
const create: Request = { actionId: 'deployments.environments.create', context: {}, input: {
    serverId: 'home', projectSourceId: 'source', requestKey: 'create', protection: 'nonProduction',
    purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'machine', ...reference,
    firstTargetLink: { machines: [{ machineId: 'machine', installationId: 'installation' }], ...reference },
} };
const link: Request = { actionId: 'deployments.targets.link', context: {}, input: {
    serverId: 'home', environmentId: 'environment', expectedRevision: 1, requestKey: 'link',
    targetId: 'own-server', role: 'runtime', machines: [{ machineId: 'machine', installationId: 'installation' }], ...reference,
} };
const template: Request = { actionId: 'deployments.templates.instantiate', context: {}, input: {
    mode: 'apply', serverId: 'home', machineId: 'machine', projectSourceId: 'source',
    templateRef: { sourceId: 'catalog', itemId: 'app', version: '1',
        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
    environment: { kind: 'create', name: 'App', requestKey: 'template', protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'machine' },
    target: { kind: 'new', installationId: 'installation' }, destination: { kind: 'stored' }, bindings: [],
} };

describe('target enablement retention offer', () => {
    for (const request of [create, link]) {
        it(`retains the CLI review surface through signed admission for ${request.actionId}`, () => {
            expect(requiresOriginalAccountMachineActionProof(request.actionId, request.input)).toBe(true);
            // Keeping the finite policy removes only the retention edit. A Machine-placed
            // link still declares its review demand, which needs the original requester
            // proof whatever the retention choice (7be7c10ad6f); Account-placed create does not.
            expect(requiresOriginalAccountMachineActionProof(request.actionId,
                { ...(request.input as Record<string, unknown>), managedRetention: 'keep' }))
                .toBe(request.actionId === 'deployments.targets.link');
        });
    }
    const cleanup: (() => void | Promise<void>)[] = [];
    afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
    async function boundary(machines: readonly unknown[] = [machine]) {
        const app = fastify();
        cleanup.push(() => app.close());
        app.post(managedMachineActionEndpointPathV1('machines.managed.list'), request => {
            expect(request.body).toEqual({ homeId: 'home', enrolledMachineId: 'machine' });
            return { machines };
        });
        // The HTTP adapter is the only substituted boundary; the real managed
        // Action transport and its schemas run beneath target preparation.
        cleanup.push(installAxiosFastifyAdapter({ app, origin: 'http://home.test' }));
        return { homeId: 'home', managedMachineAction: createAccountServerActionDeps({ token: 'fixture', serverId: 'home',
            serverIdentityId: 'home', serverHttpBaseUrl: 'http://home.test' }).managedMachineAction };
    }
    for (const request of [create, link, template]) {
        it(`offers the exact allocation edit without applying it for ${request.actionId}`, async () => {
            const wakeOnAcceptedMessage = request.actionId !== 'deployments.targets.link';
            const prepared = await prepareDeploymentTargetEnablementRetention(request,
                await boundary([{ ...machine, wakeOnAcceptedMessage }]), null);
            expect(prepared).toMatchObject({ children: [{ action: 'machines.managed.retention.update',
                role: 'target-retention:machine', input: { homeId: 'home', managedId: 'allocation',
                    expectedIntentRevision: 4, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage } }] });
            expect(machine.retention.kind).toBe('unused');
        });
        it(`keeps the chosen finite policy without requiring provider support for ${request.actionId}`, async () => {
            expect(await prepareDeploymentTargetEnablementRetention({ ...request,
                input: { ...(request.input as Record<string, unknown>), managedRetention: 'keep' } }, { homeId: 'home', managedMachineAction: undefined }, null)).toBeNull();
        });
    }
    it('leaves unmanaged targets unchanged', async () => {
        expect(await prepareDeploymentTargetEnablementRetention(create, await boundary([]), null)).toBeNull();
    });
    it('leaves existing until-delete allocations unchanged', async () => {
        expect(await prepareDeploymentTargetEnablementRetention(create,
            await boundary([{ ...machine, retention: { kind: 'until-delete' } }]), null)).toBeNull();
    });
    it('offers the retention edit from an opaque preset list row', async () => {
        expect(await prepareDeploymentTargetEnablementRetention(create, await boundary([opaquePresetRead(machine)]), null))
            .toMatchObject({ children: [{ action: 'machines.managed.retention.update', input: {
                homeId: 'home', managedId: 'allocation', expectedIntentRevision: 4,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
            } }] });
    });
    it('uses the composition Home identity when the caller uses a local profile id', async () => {
        expect(await prepareDeploymentTargetEnablementRetention({ ...link,
            input: { ...(link.input as Record<string, unknown>), serverId: 'local-profile' } }, await boundary(), null))
            .toMatchObject({ children: [{ input: { homeId: 'home', managedId: 'allocation' } }] });
    });
    it('does not offer or apply allocation edits during a create preview', async () => {
        expect(await prepareDeploymentTargetEnablementRetention({ actionId: create.actionId, context: {}, input: {
            serverId: 'home', projectSourceId: 'source', requestKey: 'preview', name: 'Staging', mode: 'preview',
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: 'machine', buildMachineId: 'machine',
            definition: { from: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } },
            firstTargetLink: { machines: [{ machineId: 'machine', installationId: 'installation' }] },
        } }, { homeId: 'home', managedMachineAction: undefined }, null)).toBeNull();
    });
});

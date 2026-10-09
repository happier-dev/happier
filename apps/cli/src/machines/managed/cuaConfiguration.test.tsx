import '../../../../ui/sources/dev/vitestSetup';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dimensions } from 'react-native';
import { installApprovalCommonModuleMocks } from '../../../../ui/sources/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture } from '../../../../ui/sources/dev/testkit/fixtures/machineFixtures';
import { renderScreen, standardCleanup } from '../../../../ui/sources/dev/testkit';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '../../../../ui/sources/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { CUA_PLUGIN } from '../../../../../packages/plugins/machine-cua/src/manifest';
import { createCuaNativeClient } from '../../../../../packages/plugins/machine-cua/src/machine/nativeClient';
import { createCuaLocalProvisioner } from '../../../../../packages/plugins/machine-cua/src/machine/localProvisioner';
import { createCuaByoc } from '../../../../../packages/plugins/machine-cua/src/machine/byoc';
import { createCuaFleet } from '../../../../../packages/plugins/machine-cua/src/machine/fleet';
import { MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('../../../../ui/sources/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});
installApprovalCommonModuleMocks({ text: async () => vi.importActual('../../../../ui/sources/text'),
    router: async () => (await import('../../../../ui/sources/dev/testkit/mocks/router')).createExpoRouterMock().module });
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { resetScopedHomeActionExecutorsForTests } = await import('../../../../ui/sources/sync/ops/actions/scopedHomeActionExecutor');
const { clearDaemonMergedProjectionCacheForTests } = await import('../../../../ui/sources/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetMachineProjectionReadsForTests } = await import('../../../../ui/sources/sync/ops/machineContributionRegistryProjection');
let restoreViewport: (() => void) | undefined;
beforeEach(async () => {
    await home.reset(); resetScopedHomeActionExecutorsForTests(); clearDaemonMergedProjectionCacheForTests(); resetMachineProjectionReadsForTests();
    boundary.rpc.mockReset();
    const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
});
afterEach(() => { standardCleanup(); restoreViewport?.(); restoreViewport = undefined; });

const size = { cpu: 4, memoryBytes: 4096 * 1024 ** 2, diskBytes: 20 * 1024 ** 3 };
const imageId = 'ghcr.io/trycua/linux:24.04-disk';
const digest = `sha256:${'a'.repeat(64)}`;
function processResult(value: unknown): PluginProcessResult {
    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(JSON.stringify(value)), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
// Only native processes and HTTP are substituted. The actual declared query,
// native option parsing, shared form and strict launch owner execute together.
function nativeOptions(id: string, query: unknown) {
    const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: { async run(request) {
        const args = request.args ?? [];
        if (args.includes('doctor')) return processResult({ host: { os: 'linux', arch: 'x86_64', kvm: true, accel: { x86_64: 'kvm', aarch64: 'tcg' } },
            backends: [{ backend: 'qemu', ready: true, provisionable: false }], qemu: { version: '10.1.0' }, lume: { version: null },
            container: { reachable: false, gvisor: false, runtimes: [] } });
        if (args.includes('images')) return processResult([{ ref: imageId, os: 'linux', arch: ['amd64'], local: 'qemu', published: true, spacesd: true,
            digest, sizes: { digest, platforms: [{ arch: 'amd64', disk: size.diskBytes }] } }]);
        if (args.includes('status')) return processResult({ providers: [{ name: 'aws', connected: true, region: 'us-west-2', ttl_hours: 0,
            kinds: [{ image: 'linux', supported: true, machine_type: 't3.medium', usd_per_hour: 0.0416 }] }], resources: [] });
        throw new Error('Configuration must not allocate a resource');
    } }, fleet: { origin: 'https://fleet.example/', http: { async request(request) {
        if (request.method !== 'GET') throw new Error('Configuration must not mutate native capacity');
        const value = request.url.includes('osgymsandboxwarmpools')
            ? { metadata: { name: 'reviewed-pool', namespace: 'reviewed-pool' }, spec: { sandboxTemplateRef: { name: 'template-one' } } }
            : { metadata: { name: 'template-one', namespace: 'reviewed-pool' }, spec: { vmTemplate: { containerDiskImage: imageId,
                runtime: 'kubevirt', cpuCores: 4, memory: '8Gi', services: [{ name: 'env', targetPort: 3211 }] } } };
        return { status: 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
    } } } });
    if (id === 'byoc') return createCuaByoc(native).options('aws', 10);
    if (id === 'fleet') return createCuaFleet(native).options(query);
    return createCuaLocalProvisioner(native, id === 'local-space' ? 'local-space' : 'local-sandbox', 10).options(query);
}

describe('fresh Cua declarations through the mounted shared configurator', () => {
    it.each([
        { id: 'local-sandbox', fields: [['runtimeId', 'qemu'], ['imageId', imageId], ['size.cpu', '4'], ['size.memoryBytes', String(size.memoryBytes)], ['size.diskBytes', String(size.diskBytes)]] },
        { id: 'local-space', fields: [['runtimeId', 'qemu'], ['imageId', imageId], ['size.cpu', '4'], ['size.memoryBytes', String(size.memoryBytes)], ['size.diskBytes', String(size.diskBytes)]] },
        { id: 'byoc', fields: [['cloud', 'aws']] },
        { id: 'fleet', fields: [['namespace', 'reviewed-pool'], ['nativeLease.durationSeconds', '7200']] },
    ])('produces a strict complete $id launch with Create and Save enabled', async ({ id, fields }) => {
        const descriptor = CUA_PLUGIN.manifest.contributes.machineProvisioners?.find(value => value.id === id);
        if (!descriptor) throw new Error('Missing actual Cua descriptor');
        const declaration = CUA_PLUGIN.manifest.contributes.actions?.find(value => value.id === descriptor.actions.options);
        if (!declaration?.inputSchema || !declaration.inputHints) throw new Error('Missing actual Cua options form');
        const controller = { machineId: 'host', installationId: 'installation' };
        const contribution = { pluginId: CUA_PLUGIN.manifest.id, localId: id };
        const serverId = await home.addHome({ name: 'Cua', serverUrl: `https://${id}.example`, serverIdentityId: `srv_${id}`, accountId: 'owner', currentAccount: true });
        const { storage } = await import('../../../../ui/sources/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const projected = PluginProjectedActionV2Schema.parse({ id: declaration.id, pluginId: contribution.pluginId, occurrenceId: 'options',
            title: declaration.title, scopes: declaration.scopes, surfaces: declaration.surfaces, execution: declaration.execution,
            dangerLevel: declaration.dangerLevel, inputHints: declaration.inputHints, available: true });
        const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
            installedPackagesById: { [contribution.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: contribution.pluginId } },
            actionsById: { [buildQualifiedPluginContributionKey({ pluginId: contribution.pluginId, localId: declaration.id })]: projected },
        } });
        boundary.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? projection : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ ? { ok: true, inputSchema: declaration.inputSchema } : { ok: false, code: 'unsupported' });
        for (const [actionId, result] of [['machines.provisioners.list', { controller, provisioners: [{ contribution, occurrenceId: id, descriptor, credentialPurposes: [] }] }],
            ['machines.provisioners.check', { available: true }]] as const) home.answer(serverId, `/v1/actions/${actionId}`, { select(value) {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
        } });
        let choices: ReturnType<typeof MachineProvisionerOptionsResultV1Schema.parse>['choices'] = [];
        home.answer(serverId, '/v1/actions/machines.provisioners.options', { async select(value) {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            const input = request.input as { selectors: unknown };
            const validate = await compilePluginJsonSchema(declaration.inputSchema);
            const result = validate(input.selectors) ? MachineProvisionerOptionsResultV1Schema.parse(await nativeOptions(id, input.selectors)) : { choices: [] };
            choices = result.choices;
            return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId, execution: { ok: true, result } } };
        } });
        const { ManagedMachineConfigurationView } = await import('../../../../ui/sources/components/settings/machines/managed/ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={controller} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId(`managed-config.field:${fields[0][0]}`)).not.toBeNull());
        for (const [path, value] of fields) await act(async () => screen.changeTextByTestId(`managed-config.field:${path}`, value));
        await waitForHomeGovernance(() => expect(choices.some(choice => choice.launch !== undefined)).toBe(true));
        const choice = choices.find(choice => choice.launch !== undefined);
        if (!choice) throw new Error('Native options must produce a complete launch');
        const validateLaunch = await compilePluginJsonSchema(descriptor.launchSchema);
        expect(validateLaunch(choice.launch)).toBe(true);
        for (const dimension of ['size', 'image', 'location'] as const) {
            const nativeFact = choice.nativeFacts?.[dimension];
            if (!nativeFact) continue;
            const section = dimension === 'size' ? 'sizes' : dimension === 'image' ? 'images' : 'locations';
            await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === `managed-config.${section}` && typeof node.props.onChange === 'function').length).toBeGreaterThan(0));
            const control = screen.tree.findAll(node => node.props.testID === `managed-config.${section}` && typeof node.props.onChange === 'function')[0];
            await act(async () => control.props.onChange(nativeFact.id));
        }
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
        expect(screen.findByTestId('managed-config.save-preset')?.props.disabled).toBe(false);
        expect(home.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
        await screen.unmount();
    });
});

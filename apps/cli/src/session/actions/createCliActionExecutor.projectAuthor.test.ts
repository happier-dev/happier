import axios from 'axios';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { WorkspaceExecutionConfigMutationRequestV1Schema, type WorkspaceExecutionConfigContentV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { createLocalServiceActionConfirmationNonceV1, LocalServiceActionRequestV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import type { PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createPluginInvocationLifetime } from '@/plugins/runtime/invocation/lifetime';
import { activatePluginRuntimeRegistry } from '@/plugins/runtime/lifecycle/manager';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { resolveProjectNativeAdapter, type ProjectNativeAdapterInvocationContextFactoryV1 } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import {
    createPixiPrivatePreview, importedPixiTask, preparePixiProject, readPixiPublicPreview,
    restartPixiService, runPixiScriptAndReadOutput, startPixiService, stopPixiService, pixiPlugin, pixiAdapter,
} from '../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/project-native-source';
import {
    configureProjectServicePlacement, configureProjectWorkers, inspectProjectWorker,
} from '../../../../../packages/plugin-sdk/fixtures/authoring-inference/projectWorkers';

const { io } = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io }));

const workspace = { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'checkout-a', rootPath: '/accepted' };
const address = { serverId: workspace.serverId, refId: workspace.workspaceId };
const initialPlacement = { runsOn: { kind: 'primary' as const }, unavailable: 'fail' as const };
const operation = {
    version: 1 as const, operationId: 'run-a', revision: 1, actionId: 'projects.script.run', state: 'accepted' as const,
    scope: { accountId: 'owner', machineId: workspace.machineId }, title: 'Pixi check', createdAt: 1,
    cancellation: 'supported' as const,
    domainRef: { kind: 'projectCommand' as const, purpose: 'script' as const, serverId: workspace.serverId,
        machineId: workspace.machineId, workspaceRefId: workspace.workspaceId, cwd: workspace.rootPath, terminalId: 'actual-terminal' },
};

function authorHost(respond: (method: string, request: unknown) => unknown | Promise<unknown>) {
    const requests: Array<{ method: string; request: unknown }> = [];
    const observedSnapshots: unknown[] = [];
    const mutations: Array<ReturnType<typeof WorkspaceExecutionConfigMutationRequestV1Schema.parse>> = [];
    let content: WorkspaceExecutionConfigContentV1 | null = { t: 'plain', v: {
        enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {}, services: { web: initialPlacement },
    } };
    let revision = 0;
    const baseUrl = 'https://author-home.example';
    // HTTP persistence and the admitted exact Machine process transport are the
    // only replaced system boundaries. SDK schema/policy, CLI dispatch, config
    // compare/rebase and operation-to-terminal output resolution remain real.
    vi.spyOn(axios, 'request').mockImplementation(async config => {
        if (config.url === `${baseUrl}/v1/account/encryption`) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (config.url === `${baseUrl}/v1/projects/execution/config/read`) {
            expect(config.data).toEqual({ address });
            return { status: 200, data: content ? { status: 'present', revision, content } : { status: 'absent' } };
        }
        expect(config.url).toBe(`${baseUrl}/v1/projects/execution/config/mutate`);
        const mutation = WorkspaceExecutionConfigMutationRequestV1Schema.parse(config.data);
        expect(mutation.address).toEqual(address);
        expect(mutation.expectedRevision).toBe(revision);
        mutations.push(mutation);
        content = mutation.content;
        revision += 1;
        return { status: 200, data: { status: 'updated', revision, cursor: revision } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url === `${baseUrl}/v1/account/encryption`) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (url === `${baseUrl}/v1/machines`) return { status: 200, data: [{ id: workspace.machineId, kind: 'persistent',
            active: true, revokedAt: null, replacedByMachineId: null }, { id: 'unrelated-retired-child', kind: 'persistent',
            active: false, revokedAt: 1, replacedByMachineId: null, devcontainerChild: {
                relation: { managedMachineId: 'stale-child', managedMachineKind: 'devcontainer', parentMachineId: 'unrelated-parent' },
                observation: { nativeResourceId: 'retired', user: 'coder', workspaceFolder: '/unrelated',
                    storage: { kind: 'bind', hostPath: '/unrelated-host', childPath: '/unrelated' } },
            } }] };
        expect(url).toBe(`${baseUrl}/v1/machines/${workspace.machineId}`);
        return { status: 200, data: { machine: { id: workspace.machineId, kind: 'persistent', storageMode: 'plain',
            metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null } } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async url => {
        expect(url).toBe(`${baseUrl}/v1/account/project-rows/list`);
        const key = { kind: 'workspace-ref', serverId: workspace.serverId, id: workspace.workspaceId };
        const unrelatedKey = { ...key, id: 'unrelated' };
        return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [{ key, revision: 0,
            content: { t: 'plain', v: { key, value: { id: workspace.workspaceId, serverId: workspace.serverId,
                machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 } } } },
            { key: unrelatedKey, revision: 0, content: { t: 'plain', v: { key: unrelatedKey, value: {
                id: unrelatedKey.id, serverId: workspace.serverId, machineId: 'unrelated-retired-child', rootPath: '/unrelated', createdAtMs: 1,
            } } } }] } };
    });
    io.mockImplementation(() => createApiSessionSocketStub({ emitWithAck(event, payload) {
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        expect(payload).toMatchObject({ method: `${workspace.machineId}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT}`,
            params: { machineId: workspace.machineId, scope: 'workspace', workspaceRoot: workspace.rootPath, projection: 'managed_bindings' } });
        observedSnapshots.push(payload);
        return { ok: true, result: { protocolVersion: 1,
            snapshot: { v: 1, machineId: workspace.machineId, updatedAt: 1, targets: [] } } };
    } }));
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
    const account = createAccountServerActionDeps({ token: credentials.token, credentials, serverId: workspace.serverId, serverHttpBaseUrl: baseUrl });
    const ids = ['projects.prepare', 'projects.script.run', 'projects.worker.preferences.set', 'projects.service.placement.set',
        'localServices.launcher.start', 'localServices.actions.stopManaged', 'localServices.actions.restartManaged', 'localServices.preview.openOrCreate'];
    const { executor } = createCliActionExecutorHarness({ credentials, token: credentials.token, mode: 'plain', ctx: null,
        sessionId: '', serverId: workspace.serverId, serverHttpBaseUrl: baseUrl,
        projectWorkerAccountAction: account.projectWorkerAction,
        machineActionDirectTargetTransport: { machineId: workspace.machineId, invoke: async (method, request) => {
            requests.push({ method, request });
            return await respond(method, request);
        } },
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
            approvalWaivedSurfaces: Object.fromEntries(ids.map(id => [id, ['plugin']])) }), getAccountSettings: () => null },
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
            features: { localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true },
                actions: { enabled: true }, managed: { enabled: true }, preview: { enabled: true }, publicPreview: { enabled: true } },
                browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {},
        }) }),
    });
    const retirement = new AbortController();
    const actions = createPluginInvocationActionsService({ seed: {
        plugin: { id: 'acme.pixi-native', version: '1.0.0' }, occurrenceId: 'author-occurrence',
        correlationId: 'author-request', surface: 'plugin', signal: retirement.signal, isOccurrenceCurrent: () => true,
    }, actionExecutor: executor,
        invokeContributedAction: async () => { throw new Error('The author fixture only invokes canonical host Actions'); },
    });
    return { actions, requests, mutations, observedSnapshots, retirement, readContent: () => content };
}

function serviceControl(action: 'stop_managed' | 'restart_managed') {
    const request = LocalServiceActionRequestV1Schema.parse({ requestId: `author-${action}`, action, target: { kind: 'managed_service' as const,
        machineId: workspace.machineId, managedServiceId: 'actual-instance', cwd: workspace.rootPath,
        declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest' as const, name: 'web' } } } });
    if (request.target.kind !== 'managed_service') throw new Error('Expected a managed service target');
    return { ...request, target: request.target, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) };
}

describe('public Project author Actions through the real CLI host', () => {
    afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); });

    it('recovers a public native lifecycle through a fresh occurrence and admitted IO without replaying its starter', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-public-native-recovery-'));
        const statePath = join(root, 'resource.json');
        await writeFile(statePath, JSON.stringify({ phase: 'running' }));
        const toolPath = join(root, 'fixture-native.cjs');
        // A real script entrypoint keeps native verbs out of Node's CLI command position.
        await writeFile(toolPath, "const fs=require('node:fs');const [operation,id]=process.argv.slice(2);if(operation==='inspect')process.stdout.write(fs.readFileSync(id,'utf8'));else if(operation==='stop')fs.writeFileSync(id,JSON.stringify({phase:'stopped'}));else process.exit(1);");
        const instance = { adapter: pixiAdapter, nativeResourceId: statePath };
        const ingested = ingestCanonicalPluginManifest(pixiPlugin.manifest, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(`Public author manifest was not admitted: ${JSON.stringify(ingested.diagnostics)}`);
        const targets = [{ provenance: 'first_party' as const, source: { kind: 'bundled' as const }, pluginId: pixiAdapter.pluginId,
            manifestPath: '/virtual/pixi/plugin.json', daemonEntryPath: '/virtual/pixi/daemon.js',
            sourceSpec: { kind: 'package' as const, locator: '@acme/pixi-native', trustPolicy: 'local_trusted' as const, installPolicy: 'copy' as const },
            activationEvents: [], manifest: ingested.manifest }];
        const contributes = createResolvedContributionRegistry({ activationTargets: targets });
        // The installed native tool is the OS boundary. A fixture tool records an
        // exact resource on disk; manifest activation, admission and Exec stay real.
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolvePath: async () => root,
            async resolveExecutable(reference) {
                if (reference.kind !== 'systemTool' || reference.id !== 'fixture-native') throw new Error('A starter must not run during recovery');
                return { command: process.execPath, args: [toolPath] };
            },
        } });
        const createInvocationContext: ProjectNativeAdapterInvocationContextFactoryV1 = input => {
            const lifetime = createPluginInvocationLifetime(input.signal);
            const seed = { plugin: { id: pixiAdapter.pluginId, version: '1.0.0' },
                contribution: { id: pixiAdapter.localId, qualifiedId: `${pixiAdapter.pluginId}/projectNativeAdapters/${pixiAdapter.localId}` },
                occurrenceId: input.occurrenceId, correlationId: 'public-recovery', surface: 'cli' as const,
                signal: lifetime.signal, redactionLifetimeSignal: lifetime.redactionLifetimeSignal, isOccurrenceCurrent: input.isCurrent };
            return { context: { ...seed, invokedAtMs: lifetime.invokedAtMs, services: owners.createOperationServices(seed, {
                filesystemRoots: { pluginData: root, workspace: root, projects: new Map() }, hostAccessRequests: [],
            }) }, complete: () => lifetime.complete() };
        };
        const activate = (generation: number) => activatePluginRuntimeRegistry({ contributes, generation,
            occurrenceIdsByPluginId: new Map([[pixiAdapter.pluginId, createPluginRuntimeOccurrenceId(pixiAdapter.pluginId)]]),
            resolveActivationSource: () => ({ kind: 'bundled', moduleId: `@acme/pixi-native/${generation}`, load: async () => ({ activate: pixiPlugin.activate }) }),
        });
        const original = await activate(1);
        let replacement: Awaited<ReturnType<typeof activate>> | undefined;
        const releases: Array<() => Promise<void>> = [];
        try {
            const selected = await resolveProjectNativeAdapter({ reference: pixiAdapter, role: 'nativeServiceLifecycle', targets, registry: original, createInvocationContext });
            expect(selected.kind, JSON.stringify(selected)).toBe('ready');
            if (selected.kind !== 'ready') throw new Error(selected.code);
            const captured = selected.lease.captureNativeServiceLifecycle(instance, { root });
            if (captured.kind !== 'ready') throw new Error(captured.code);
            releases.push(captured.release);
            expect(await captured.lifecycle.inspect(instance)).toEqual({ phase: 'running', readiness: 'not_reported', endpoint: null });
            await original.dispose();
            await expect(captured.lifecycle.inspect(instance)).rejects.toMatchObject({ code: 'native_adapter_retired' });
            replacement = await activate(2);
            const recovered = await resolveProjectNativeAdapter({ reference: pixiAdapter, role: 'nativeServiceLifecycle', targets, registry: replacement, createInvocationContext });
            if (recovered.kind !== 'ready') throw new Error(recovered.code);
            const current = recovered.lease.captureNativeServiceLifecycle(instance, { root });
            if (current.kind !== 'ready') throw new Error(current.code);
            releases.push(current.release);
            expect(await current.lifecycle.stop({ ...instance, nativeResourceId: 'another-resource' })).toEqual({ status: 'unsupported' });
            expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ phase: 'running' });
            expect(await current.lifecycle.inspect(instance)).toMatchObject({ phase: 'running' });
            expect(await current.lifecycle.stop(instance)).toEqual({ status: 'stopped' });
            expect(await current.lifecycle.inspect(instance)).toMatchObject({ phase: 'stopped' });
        } finally {
            for (const release of releases) await release();
            await replacement?.dispose(); await original.dispose(); await owners.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });

    it('retains accepted custody and reads the actual retained terminal without claiming completion', async () => {
        const output = { ok: true as const, terminalId: 'actual-terminal', frames: [{ t: 'bytes' as const,
            terminalId: 'actual-terminal', seq: 0, byteOffset: 0, byteLength: 5, encoding: 'base64' as const,
            data: Buffer.from('hello').toString('base64') }], nextByteOffset: 5, availableByteOffset: 5,
            droppedBeforeByteOffset: 0, done: false };
        const host = authorHost(method => {
            if (method === getActionSpec('projects.script.run').bindings?.rpcMethod) return { operation };
            if (method === ACTION_OPERATION_RPC_METHODS_V2.get) return { kind: 'found', operation };
            if (method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES) return output;
            throw new Error(`Unexpected Machine method ${method}`);
        });
        const result = await runPixiScriptAndReadOutput(host.actions, { workspace, choice: { kind: 'primary' } });
        expect(result).toEqual({ run: { operation }, output });
        expect(host.requests[0]).toEqual({ method: RPC_METHODS.DAEMON_PROJECTS_SCRIPT_RUN,
            request: { workspace, choice: { kind: 'primary' }, selection: { kind: 'native', source: importedPixiTask } } });
        expect(host.requests.at(-1)).toEqual({ method: RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
            request: expect.objectContaining({ terminalId: 'actual-terminal', byteOffset: 0 }) });
    });

    it('does not replay or request output when native acceptance is unknown', async () => {
        const host = authorHost(() => ({ ok: false, errorCode: 'outcome_unknown', error: 'Native acceptance is unknown' }));
        await expect(runPixiScriptAndReadOutput(host.actions, { workspace, choice: { kind: 'primary' } }))
            .rejects.toMatchObject({ code: 'outcome_unknown' });
        expect(host.requests).toHaveLength(1);
    });

    it('preserves setup consent without treating a held script as accepted or reading output', async () => {
        const hold = { kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const,
            reviewedEffectDigest: 'a'.repeat(64), consentScope: 'thisTime' as const };
        const host = authorHost(() => hold);
        expect(await runPixiScriptAndReadOutput(host.actions, { workspace, choice: { kind: 'primary' } }))
            .toEqual({ run: hold });
        expect(host.requests).toHaveLength(1);
    });

    it('executes settings and status Actions while preserving finite/service siblings and unknown load', async () => {
        const advisory = { eligible: true, load: { kind: 'unknown' }, candidate: { serverId: workspace.serverId, machineId: workspace.machineId }, explanation: 'load_unknown' };
        const host = authorHost(() => advisory);
        const next = { enabled: true as const, destination: { kind: 'machine' as const, machineId: workspace.machineId },
            unavailable: 'fail' as const, allowAdHoc: false, scriptOverrides: {} };
        expect(await configureProjectWorkers(host.actions, address, next)).toMatchObject({ status: 'applied', preference: next });
        expect(host.readContent()).toMatchObject({ t: 'plain', v: { ...next, services: { web: initialPlacement } } });
        expect(await inspectProjectWorker(host.actions, { workspace: address,
            destination: { kind: 'machine', machineId: workspace.machineId }, purpose: 'finite' })).toEqual(advisory);
        const observedPlacement = await host.actions.execute('projects.service.placement.get', { workspace: address, serviceName: 'web' });
        expect(observedPlacement, JSON.stringify(observedPlacement))
            .toMatchObject({ status: 'ready', placement: initialPlacement, actual: { status: 'absent' } });
        const placement = { runsOn: { kind: 'workers' as const, destination: next.destination }, unavailable: 'fail' as const };
        expect(await configureProjectServicePlacement(host.actions, { workspace: address, serviceName: 'web' }, placement))
            .toMatchObject({ status: 'applied', placement });
        expect(host.readContent()).toMatchObject({ t: 'plain', v: { ...next, services: { web: placement } } });
        expect(host.mutations).toHaveLength(2);
        // Placement mutation does not dispatch Start, Stop or Move.
        expect(host.requests).toHaveLength(1);
        expect(host.observedSnapshots).toHaveLength(2);
    });

    it('executes setup and the existing service lifecycle/preview Actions with truthful native outcomes', async () => {
        const startInput: PluginActionInputById['localServices.launcher.start'] = { machineId: workspace.machineId,
            targetId: 'project-service:web', workspace, declaration: { workspaceRefId: workspace.workspaceId,
                selection: { kind: 'manifest', name: 'web' } }, expectedEffectDigest: 'a'.repeat(64) };
        const start = { protocolVersion: 1, machineId: workspace.machineId, targetId: startInput.targetId,
            status: 'denied', reasonCode: 'project_service_effect_review_required', reviewedEffectDigest: 'b'.repeat(64),
            reviewedEffect: { command: 'pixi run web' }, snapshot: { v: 1, machineId: workspace.machineId, updatedAt: 1, targets: [] } };
        const publicSnapshot = { v: 1, machineId: workspace.machineId, generatedAt: 1, refreshState: 'idle',
            policy: { enabled: true, allowedModes: ['secret_link'], dnsTlsRequired: true, auditRequired: true, rateLimitProfileIds: [] },
            exposures: [], diagnostics: [] };
        const host = authorHost(method => {
            if (method === getActionSpec('projects.prepare').bindings?.rpcMethod) return { kind: 'notRequired', reviewedEffectDigest: 'a'.repeat(64) };
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) return start;
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_STOP_MANAGED) return { v: 1, requestId: 'author-stop_managed', action: 'stop_managed', status: 'failed', reasonCode: 'termination_incomplete', auditEvents: [] };
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_RESTART_MANAGED) return { v: 1, requestId: 'author-restart_managed', action: 'restart_managed', status: 'denied', reasonCode: 'native_control_unsupported', auditEvents: [] };
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS) return { protocolVersion: 1, snapshot: publicSnapshot };
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE) return { ok: false, errorCode: 'outcome_unknown', error: 'Preview outcome unknown' };
            throw new Error(`Unexpected Machine method ${method}`);
        });
        expect(await preparePixiProject(host.actions, { workspace, phase: 'setup' })).toMatchObject({ kind: 'notRequired' });
        expect(await startPixiService(host.actions, startInput)).toEqual(start);
        expect(await stopPixiService(host.actions, serviceControl('stop_managed'))).toMatchObject({ status: 'failed', reasonCode: 'termination_incomplete' });
        expect(await restartPixiService(host.actions, serviceControl('restart_managed'))).toMatchObject({ status: 'denied', reasonCode: 'native_control_unsupported' });
        expect(await readPixiPublicPreview(host.actions, { machineId: workspace.machineId })).toEqual(publicSnapshot);
        await expect(createPixiPrivatePreview(host.actions, { machineId: workspace.machineId, serviceTarget: serviceControl('stop_managed').target }))
            .rejects.toMatchObject({ code: 'outcome_unknown' });
        expect(host.requests).toHaveLength(6);
    });
});

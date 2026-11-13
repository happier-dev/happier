import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { bindPresentUserActionConfirmation } from '@/sync/ops/actions/presentUserConfirmation';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { buildHomeConnectionDescriptorForProfile, getServerProfileById, reconcileServerProfileHomeConnectionDescriptor } from '@/sync/domains/server/serverProfiles';
import { resolveWebDesktopSetupHandoffTarget } from '@/components/machines/add/machineAddCommand';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { waitForSystemTaskResult } from '@/components/systemTasks/createSystemTaskRunner';
import { publishLocalDaemonStatus, startLocalCliUpdate } from '@/components/settings/machines/localControl/localDaemonSharedState';
import { readLocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { buildThisComputerCliUpdateItem } from '@/updates/items/buildMachineUpdateItems';
import { registerUpdatesActionOwner } from '@/updates/updatesActionRuntime';
import { randomUUID } from '@/platform/randomUUID';
import type { StartedHomePairing } from '@/auth/pairing/startPairingForHome';
import { resetRuntimeFetch, setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { observeAuthenticatedServerFeaturesFresh } from '@/sync/api/capabilities/serverFeaturesClient';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { managedMachineOperationMatchesResource, readManagedInstallationPromptSnapshot } from '@/sync/domains/actionOperations/managedMachineOperation';
import { createManualSystemTaskRunner } from './harness/manualSystemTaskRunner';

export type MachineClientEnrollmentOutputOptions = Readonly<{
    serverId: string;
    homeId: string;
    machineId: string;
    baseUrl: string;
    publicEndpoint: string;
    credentials: AuthCredentials;
    /** Prepares an actual managed allocation, operation and open native installer prompt. */
    prepareManagedBootstrapResponse?: () => Promise<unknown>;
}>;

/** The native reconcile owner must have emitted this snapshot and its open task question. */
export function readManagedBootstrapResponseOutputInput(params: Readonly<{
    serverId: string;
    machine: ManagedMachineV1;
    operation: ActionOperationSnapshotV1;
}>) {
    if (!managedMachineOperationMatchesResource(params.machine, params.operation)) {
        throw new Error('Native bootstrap operation does not match the retained managed resource');
    }
    const current = readManagedInstallationPromptSnapshot(params.operation);
    if (!current || current.kind === 'administrator.establish') {
        throw new Error('Native bootstrap has not produced an approval prompt');
    }
    const { taskId, ...prompt } = current;
    return getActionSpec('machines.managed.bootstrap.respond').inputSchema.parse({
        serverId: params.serverId, homeId: params.machine.homeId, managedId: params.machine.id,
        operationId: params.operation.operationId, taskId, purpose: 'approve', prompt, approved: false,
    });
}

/** Forward a published Home's HTTP bytes to its real disposable server. No response is synthesized. */
export function createPublishedHomeOutputFetch(params: Readonly<{
    publishedOrigin: string;
    loopbackUrl: string;
    fetch?: RuntimeFetch;
}>): RuntimeFetch {
    const request = params.fetch ?? globalThis.fetch.bind(globalThis);
    const published = new URL(params.publishedOrigin).origin;
    const loopback = new URL(params.loopbackUrl);
    return (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== published) return request(input, init);
        url.protocol = loopback.protocol;
        url.host = loopback.host;
        return request(input instanceof Request ? new Request(url, input) : url, init);
    };
}

/** Real UI Action and Updates owners; only native SystemTask process replies are simulated. */
export async function createMachineClientEnrollmentOutputFixture(options: MachineClientEnrollmentOutputOptions) {
    const activeScope = getActiveServerAccountScope();
    const scope = selectActiveServerAccountScopeForServer(activeScope, options.serverId);
    if (!scope) throw new Error(`Enrollment outputs require the connected Home Account: ${activeScope ? 'different_home' : 'no_active_account'}`);
    setRuntimeFetch(createPublishedHomeOutputFetch({ publishedOrigin: options.publicEndpoint, loopbackUrl: options.baseUrl }));
    try {
        const account = await captureLazyActionAccountContext(options.serverId);
        try {
            const observed = await observeAuthenticatedServerFeaturesFresh({ request: account.request });
            if (observed.status !== 'ready' || !observed.features.homeConnectionDescriptor
                || observed.serverIdentityId !== options.homeId) {
                throw new Error('Enrollment output requires the actual authenticated Home descriptor');
            }
            const descriptor = observed.features.homeConnectionDescriptor;
            const saved = await TokenStorage.setCredentialsForServerUrl(descriptor.canonicalServerUrl,
                { serverId: options.homeId }, options.credentials);
            if (!saved) throw new Error('Could not retain credentials for the published Home endpoint');
            const profile = getServerProfileById(options.serverId);
            if (!profile) throw new Error('Enrollment outputs require the retained Home profile');
            const reconciliation = await reconcileServerProfileHomeConnectionDescriptor({ serverUrl: profile.serverUrl,
                observedServerIdentityId: options.homeId, descriptor, observation: 'exact' });
            if (reconciliation.kind !== 'applied' && reconciliation.kind !== 'unchanged') {
                throw new Error('Actual Home descriptor could not be retained by the profile owner');
            }
        } finally { account.dispose(); }
    } catch (error) {
        resetRuntimeFetch();
        throw error;
    }
    const lifetime = new AbortController();
    const manual = createManualSystemTaskRunner('tauri');
    const nativeTasks = new Map<string, SystemTaskSpec>();
    const pairings = new Set<StartedHomePairing>();
    let installedVersion = '1.0.0';
    const latestVersion = '1.1.0';
    const start = manual.bridge.start.getMockImplementation()!;
    const subscribe = manual.bridge.subscribe.getMockImplementation()!;
    const statusData = () => ({
        serviceInstalled: true, daemonRunning: true, needsAuth: false,
        machineId: options.machineId, daemonAccountId: scope.accountId,
        daemonMachineRegistered: true, serviceAutostart: 'on-demand', managedServiceInstalled: true,
        cliUpdate: { currentVersion: installedVersion, latestVersion,
            updateAvailable: installedVersion !== latestVersion, managed: true, origin: null },
    });
    manual.bridge.start.mockImplementation(async spec => {
        const taskId = await start(spec);
        nativeTasks.set(taskId, spec);
        return taskId;
    });
    manual.bridge.subscribe.mockImplementation(async (taskId, listeners) => {
        const unlisten = await subscribe(taskId, listeners);
        const spec = nativeTasks.get(taskId);
        if (spec?.kind !== 'cli.update.v1' && spec?.kind !== 'daemon.service.status.v1') {
            throw new Error(`Unexpected enrollment native task: ${spec?.kind}`);
        }
        queueMicrotask(() => {
            if (spec.kind === 'cli.update.v1') installedVersion = latestVersion;
            manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: true,
                data: spec.kind === 'daemon.service.status.v1' ? statusData() : {} });
        });
        return unlisten;
    });
    const readStatus = async () => {
        const taskId = await manual.runner.start(buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1'));
        const status = readLocalDaemonStatusData(await waitForSystemTaskResult(manual.runner, taskId));
        if (!status) throw new Error('Native status did not produce this computer facts');
        publishLocalDaemonStatus(manual.runner, status);
        return status;
    };
    const status = await readStatus();
    const facts = status.cliUpdate;
    if (!facts) throw new Error('Native status omitted CLI update facts');
    const item = buildThisComputerCliUpdateItem({ machineId: options.machineId, title: 'Happier CLI',
        facts: { ...facts, updateCommand: null }, task: { running: false, step: null, errorMessage: null } });
    if (!item) throw new Error('Native status did not produce a CLI update item');
    const unregisterUpdates = registerUpdatesActionOwner(() => ({ scope,
        groups: [{ id: 'thisComputer', kind: 'thisComputer', machineId: options.machineId,
            machineName: null, online: true, lastSeenAt: null, items: [item] }],
        check: async () => { await readStatus(); },
        executeItem: async selected => {
            if (selected.id !== item.id) throw new Error('Unexpected selected CLI update');
            await startLocalCliUpdate(manual.runner, readLocalDaemonStatusData, { scope,
                machineId: options.machineId, spec: buildLocalDaemonServiceSystemTaskSpec('cli.update.v1'),
                signal: lifetime.signal });
        },
    }));
    const executor = createDefaultActionExecutor({ homeRuntimeRunner: manual.runner,
        homePairingDelivery: { isCurrent: () => !lifetime.signal.aborted,
            onResult: result => { if (result.kind === 'started') pairings.add(result); } } });
    const requirePublicHome = () => {
        const profile = getServerProfileById(options.serverId);
        if (!profile) throw new Error('Enrollment outputs require the retained Home profile');
        const descriptor = buildHomeConnectionDescriptorForProfile(profile);
        const target = resolveWebDesktopSetupHandoffTarget({ descriptor,
            profileSource: profile.source ?? null, fallbackHomeUrl: profile.serverUrl, remote: true });
        if (target.kind === 'unavailable') throw new Error('Enrollment output requires a Home-published public HTTPS, tailnet or Iroh endpoint');
        return descriptor;
    };
    const cases = new Map<ActionId, () => unknown | Promise<unknown>>([
        ['machines.cli.update', () => ({ target: { kind: 'local' } })],
        ['machines.add.command', () => {
            requirePublicHome();
            return { serverId: options.serverId, os: 'linux', method: 'another_computer' };
        }],
        ['machines.pairing.create', () => {
            if (!requirePublicHome()) throw new Error('Pairing output requires the actual Home-published connection descriptor');
            return { serverId: options.serverId };
        }],
    ]);
    if (options.prepareManagedBootstrapResponse) {
        cases.set('machines.managed.bootstrap.respond', options.prepareManagedBootstrapResponse);
    }
    return {
        cases, nativeTasks, runner: manual.runner,
        async execute(id: ActionId, input: unknown) {
            const parsed = getActionSpec(id).inputSchema.parse(input);
            return executor.execute(id, parsed, bindPresentUserActionConfirmation(id, parsed, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: options.serverId, serverIdentityId: options.homeId,
                runtimeAccountId: scope.accountId, actionRequestId: randomUUID(), signal: lifetime.signal,
            }));
        },
        async close() {
            lifetime.abort();
            unregisterUpdates();
            try {
                await Promise.all([...pairings].map(async pairing => {
                    await pairing.cancel();
                    await pairing.completion.catch(() => {});
                }));
            } finally { resetRuntimeFetch(); }
        },
    };
}

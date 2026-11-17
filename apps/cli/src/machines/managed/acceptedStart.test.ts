import axios from 'axios';
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedControllerReportV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { GuestCliIdentityV1Schema } from '@happier-dev/protocol/features';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { LUME_PLUGIN } from '../../../../../packages/plugins/machine-lume/src/manifest';
import { LIMA_PLUGIN } from '../../../../../packages/plugins/machine-lima/src/manifest';
import { limaAcquisitionResource } from '../../../../../packages/plugins/machine-lima/src/machine/provider';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';
import { createDevelopmentPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { TargetActionInvocationRegistration } from '@/plugins/runtime/invocation/targetActionRegistry';
import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import { resolveExecutableManagedDependenciesRegistry } from '@/plugins/projection/registry/managedDependencyExecutables';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createStablePluginManagedDependenciesHost } from '@/plugins/runtime/invocation/services/managedDependencies';
import { createV2ManagedDependencySourceModel } from '@/plugins/runtime/invocation/services/managedDependencySourceModel';
import { createProductionManagedDependencySourceAdapter } from '@/plugins/runtime/invocation/services/managedDependencySourceAdapters';
import { createStableManagedExecutableResolver } from '@/plugins/runtime/invocation/services/managedExecutableResolver';
import { createStablePluginHttpHost } from '@/plugins/runtime/fetch/service';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { withSocketTempDir, withTempDir } from '@/testkit/fs/tempDir';
import { createManagedMachineAcquisitionDriver, type ManagedMachineExecutionOptions } from './acquire';

const controller = { machineId: 'controller', installationId: 'installation' };
const managedId = 'cmvnxb7gn009mmcagisyszwlh';
const homeId = 'srv_accepted_start';
const serverUrl = 'https://home.example';
const unavailable = async (): Promise<never> => { throw new Error('Unexpected external transport'); };
const lumeLaunch = { storage: 'home', image: { kind: 'native-image', reference: 'ghcr.io/trycua/macos:26' },
    cpu: 2, memoryBytes: 4294967296, diskBytes: 161061273600 };
const limaLaunch = { instance: 'reviewed-name', store: '/private/lima-test', image: 'https://example.test/ubuntu.img',
    vmType: 'vz' as const, arch: 'aarch64' as const, cpus: 2, memoryGiB: 4, diskGiB: 20, mounts: [] };

/** The actual public module, private native-role admission and acquisition driver
 * stay real. Only Home/vendor HTTP, the native executable and the clock differ. */
async function setup(root: string, kind: 'lume' | 'lima' = 'lume') {
    const plugin = kind === 'lume' ? LUME_PLUGIN : LIMA_PLUGIN;
    const manifest = normalizePluginManifestV2(plugin.manifest);
    const provider = { pluginId: manifest.id, localId: kind };
    const fixtureLimaLaunch = { ...limaLaunch, store: root };
    const choices = kind === 'lume' ? lumeLaunch : fixtureLimaLaunch;
    const value = kind === 'lume' ? { storage: 'home', vmName: `happier-${managedId}` }
        : limaAcquisitionResource(fixtureLimaLaunch, managedId);
    const resource = { contributionRef: provider, schemaVersion: 1, value };
    const reference = { kind: 'shared_resource' as const, resourceId: 'accepted-start-key' };
    const key = generateKeyPairSync('rsa', { modulusLength: 1024, privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId: reference.resourceId, mode: 'plain',
        content: { v: 1, name: 'Startup key', kind: 'other', value: key } });
    let row = ManagedMachineV1Schema.parse({ id: managedId, homeId, custodianAccountId: 'owner', controller,
        launch: { provider, schemaVersion: 1, name: 'Accepted start', choices },
        enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, allocation: kind === 'lima' ? 'bound' : 'unsubmitted',
        creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        ...(kind === 'lima' ? { resource } : { bootstrapCredentialRef: reference }) });
    const native = { status: 'stopped', connection: 'invalid' as 'invalid' | 'pending', runCount: 0, readStatus: 200,
        otherMacosGuests: 0, fillMacosCapacityAfterRun: false, readinessWaits: 0 };
    const entries: { role: string; at: number; status: string; completed: boolean }[] = [];
    const completionListeners = new Set<() => void>();
    const sourceCustody = createDevelopmentPluginSourceCustody(root);
    const limaNative = kind === 'lima' ? { ...value, name: 'instance' in value ? value.instance : '',
        dir: 'instance' in value ? `${value.store}/${value.instance}` : '', status: 'Stopped',
        memory: limaLaunch.memoryGiB * 1024 ** 3, disk: limaLaunch.diskGiB * 1024 ** 3,
        config: { images: [{ location: limaLaunch.image, arch: limaLaunch.arch }], mounts: [],
            ssh: { forwardAgent: false }, containerd: { user: false, system: false } } } : null;
    await writeFile(join(root, kind === 'lume' ? 'lume' : 'limactl'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') process.stdout.write(${JSON.stringify(kind === 'lume' ? 'lume version 0.6.1' : 'limactl version 2.1.0')});
else if (args[0] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(limaNative))});
else process.exit(9);
`, { mode: 0o755 });
    const contributions = manifest.contributes.managedDependencies.map(definition => ({ pluginId: manifest.id,
        provenance: 'external' as const, source: { kind: 'path' as const }, manifestPath: join(root, 'plugin.json'),
        daemonEntryPath: null, sourceSpec: { kind: 'path' as const, locator: root, trustPolicy: 'local_trusted' as const,
            installPolicy: 'link' as const }, definition })) satisfies readonly ResolvedInstallableContribution[];
    const dependencies = createStablePluginManagedDependenciesHost({
        installablesRegistry: resolveExecutableManagedDependenciesRegistry(contributions),
        sourceModel: createV2ManagedDependencySourceModel({ platform: 'darwin', architecture: 'arm64', contributions }),
        sourceCustodiesByPluginId: new Map([[manifest.id, sourceCustody]]), isCurrent: () => true, getSettings: () => ({}),
        resolveAdapter: unavailable, resolveSourceAdapter: input => createProductionManagedDependencySourceAdapter({ ...input,
            env: { ...process.env, PATH: root } }), removeManagedInstall: unavailable,
    });
    const services = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} },
        managedServices: createManagedServicesOwner({ processSupervisorHost: createManagedServiceProcessSupervisorHost({}),
            dependencies: scope => dependencies.bind(scope.pluginId), resolveScope: scope => scope }),
        exec: { resolveExecutable: createStableManagedExecutableResolver({ systemTools: [], managedDependencies: dependencies,
            resolveSystemTool: unavailable }), resolvePath: async () => root },
        http: createStablePluginHttpHost({ adapter: { openWebSocket: unavailable, request: async request => {
            const url = new URL(request.url);
            const path = url.pathname;
            let response: unknown = { name: 'vmName' in value ? value.vmName : '', locationName: 'home', status: native.status, os: 'macos',
                cpuCount: lumeLaunch.cpu, memorySize: lumeLaunch.memoryBytes,
                diskSize: { allocated: 1073741824, total: lumeLaunch.diskBytes },
                ...(native.connection === 'invalid' ? { ipAddress: 'invalid-native-ip', sshAvailable: true } : {}) };
            if (url.origin === 'https://ghcr.io' && path === '/token') response = { token: 'fixture-registry-token' };
            else if (url.origin === 'https://ghcr.io' && path.includes('/manifests/')) {
                response = { annotations: { 'org.trycua.lume.disk-size': String(lumeLaunch.diskBytes) } };
            }
            else if (path === '/lume/host/status') response = { version: '0.6.1' };
            else if (path === '/lume/config') response = { cachingEnabled: true };
            else if (path === '/lume/config/locations') response = [{ name: 'home' }];
            else if (path === '/lume/vms') response = [response, ...Array.from({ length: native.otherMacosGuests }, (_, index) => ({
                name: `other-${index}`, locationName: 'home', status: 'running', os: 'macOS',
            }))];
            else if (path === '/lume/pull') response = { name: 'vmName' in value ? value.vmName : '', image: 'macos:26' };
            else if (path.startsWith('/lume/vms/') && native.readStatus === 400) {
                response = { message: `Virtual machine not found: ${'vmName' in value ? value.vmName : ''}` };
            }
            else if (path.endsWith('/run')) {
                native.runCount++;
                if (native.fillMacosCapacityAfterRun) native.otherMacosGuests = 2;
                // Native discovery/probing completes before virtual time starts.
                vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
                vi.setSystemTime(0);
            }
            return { status: path.endsWith('/run') ? 202 : request.method === 'GET' && path.startsWith('/lume/vms/') ? native.readStatus : 200,
                headers: {}, finalUrl: request.url,
                body: new TextEncoder().encode(JSON.stringify(response)) };
        } } }),
    });
    const activated = await activateContributionModule({ pluginId: manifest.id, occurrenceId: createPluginRuntimeOccurrenceId(manifest.id),
        manifest, moduleNamespace: { activate: plugin.activate }, isOccurrenceCurrent: () => true });
    const handlers = new Map(activated.registrations.flatMap((registration): [string, TargetActionInvocationRegistration['handler']][] =>
        registration.family === 'actions' ? [[registration.localId, async (input, context) => {
            const entry = { role: registration.localId, at: Date.now(), status: native.status, completed: false };
            entries.push(entry);
            try { return await Reflect.apply(registration.value, undefined, [input, context]); }
            finally { entry.completed = true; for (const listener of completionListeners) listener(); }
        }]] : []));
    const fixture = nativeFixture({ fixtureManifest: manifest, reconciliation: true, actionHandlers: handlers,
        createServices: services.createServices, resolveHostBinding: services.resolveHostBinding });
    const guestCli = GuestCliIdentityV1Schema.parse({ source: 'public-release', line: '0.3', channel: 'stable' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: { teams: { enabled: true } }, capabilities: { guestCli } })));
    vi.spyOn(axios, 'get').mockImplementation(async raw => {
        const path = new URL(String(raw)).pathname;
        if (path.endsWith('/account/profile')) return { status: 200, data: { id: 'owner' } };
        if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
        if (path.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 1 } };
        if (path.endsWith('/resources/materials')) return { status: 200, data: { resources: [{ resourceId: reference.resourceId,
            encryptionMode: 'plain', storedContent, recipientEnvelope: null, entry: { ref: formatSharedSavedSecretRefV1(reference.resourceId),
                source: 'shared_resource', relationship: 'owner', name: 'Startup key', kind: 'other', ownerAccountId: 'owner', revision: 1,
                materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] } };
        throw new Error(`Unexpected Home path ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (raw, body) => {
        const path = new URL(String(raw)).pathname;
        if (path.endsWith('/submit')) row = ManagedMachineV1Schema.parse({ ...row, allocation: 'may-exist' });
        if (path.endsWith('/report')) {
            const report = ManagedControllerReportV1Schema.parse(body);
            if (report.result.kind === 'bound') row = ManagedMachineV1Schema.parse({ ...row, allocation: 'bound', resource: report.result.resource });
            if (report.result.kind === 'pending') row = ManagedMachineV1Schema.parse({ ...row, allocation: 'may-exist', nativeOperationRef: report.result.nativeOperationRef });
        }
        if (path.endsWith('/get')) return { status: 200, data: row };
        return { status: 200, data: { machine: row, ...(path.endsWith('/admit') ? { replayed: false } : {}),
            ...(path.endsWith('/submit') ? { submitted: true } : {}), ...(path.endsWith('/context') ? { requestId: 'accepted-start' } : {}) } };
    });
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: root,
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
        }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }) });
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const driver = createManagedMachineAcquisitionDriver({ token, credentials: { token, encryption: null }, serverUrl, homeId, controller,
        runtimeRegistry: fixture.runtimeRegistry, managedProviderOperationAuthority: authority,
        homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl,
            revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] }, authority: 'current_connection' }) });
    const abort = new AbortController();
    let waiting!: () => void;
    const enteredWait = new Promise<void>(resolve => { waiting = resolve; });
    const options: ManagedMachineExecutionOptions = { requestId: 'accepted-start', signal: abort.signal,
        context: { operationAcceptance: { operationId: 'accepted-start-operation', accept() {} },
            operationOwnerUpdate: { update(change) { if (change.progress?.phase === 'native.readiness.wait') {
                native.readinessWaits++; waiting();
            } } } } };
    const waitForRoleCompletion = async (role: string, count: number) => {
        if (entries.filter(entry => entry.role === role && entry.completed).length >= count) return;
        await new Promise<void>((resolve, reject) => {
            const dispose = () => { completionListeners.delete(changed); abort.signal.removeEventListener('abort', cancelled); };
            const changed = () => {
                if (entries.filter(entry => entry.role === role && entry.completed).length < count) return;
                dispose(); resolve();
            };
            const cancelled = () => { dispose(); reject(abort.signal.reason); };
            completionListeners.add(changed);
            abort.signal.addEventListener('abort', cancelled, { once: true });
            if (abort.signal.aborted) cancelled(); else changed();
        });
    };
    return { native, entries, abort, enteredWait, waitForRoleCompletion, row: () => row, execute: () => kind === 'lima'
        ? driver.execute('machines.managed.bootstrap.retry', { homeId, managedId, expectedIntentRevision: 0 }, options)
        : driver.execute('machines.managed.acquire', { enrollmentIdentity: row.enrollmentIdentity, selection: { kind: 'one-off', homeId, controller,
            launch: row.launch, retention: row.retention, wakeOnAcceptedMessage: false } }, options) };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('accepted native start at the real acquisition boundary', () => {
    it.skipIf(process.platform === 'win32')(
        'settles macOS capacity refusal before Start without readiness retry', async () => {
            await withTempDir('managed-lume-capacity-', async root => {
                const fixture = await setup(root);
                fixture.native.otherMacosGuests = 2;
                try {
                    await expect(fixture.execute()).rejects.toMatchObject({
                        code: 'native_acquisition_unconfirmed',
                        details: { kind: 'managedNative', nativeCause: { localCause: 'native_macos_vm_limit_reached' } },
                    });
                    expect(fixture.native.readinessWaits).toBe(0);
                    expect(fixture.native.runCount).toBe(0);
                    expect(fixture.row()).toMatchObject({ allocation: 'may-exist',
                        nativeOperationRef: { value: { vmName: `happier-${managedId}`, storage: 'home' } } });
                    expect(fixture.entries.filter(entry => entry.role === 'bootstrap')).toEqual([]);
                } finally { fixture.abort.abort(); }
            });
        });

    it.skipIf(process.platform === 'win32').each(['connect', 'cancel', 'capacity-after-acceptance', 'absent', 'unavailable', 'stopped-after-running'] as const)(
        'retains only the current accepted start (%s)', async scenario => {
            await withTempDir('managed-accepted-start-', async root => {
                const fixture = await setup(root);
                fixture.native.fillMacosCapacityAfterRun = scenario === 'capacity-after-acceptance';
                const work = fixture.execute();
                const settled = work.then(() => ({ code: 'unexpected_success' }), error => ({ code: error.code }));
                const finishRole = async (role: string, count: number) => {
                    // Native executable resolution uses a real fixture subprocess.
                    // Finish that IO before advancing the next virtual deadline.
                    await fixture.waitForRoleCompletion(role, count);
                    await vi.advanceTimersByTimeAsync(0);
                };
                try {
                    expect(await Promise.race([
                        fixture.enteredWait.then(() => 'waiting'),
                        settled.then(result => result.code),
                    ])).toBe('waiting');
                    expect(fixture.entries.filter(entry => entry.role === 'bootstrap')).toEqual([]);
                    expect(fixture.native.runCount).toBe(1);
                    if (scenario === 'cancel' || scenario === 'capacity-after-acceptance') {
                        fixture.abort.abort();
                        expect(await settled).toMatchObject({ code: 'cancelled' });
                    } else if (scenario === 'absent' || scenario === 'unavailable') {
                        fixture.native.readStatus = scenario === 'absent' ? 400 : 503;
                        await vi.advanceTimersByTimeAsync(5000);
                        expect(await settled).toMatchObject({ code: 'native_resource_unavailable' });
                        expect(fixture.entries.filter(entry => entry.role === 'bootstrap')).toEqual([]);
                    } else {
                        await vi.advanceTimersByTimeAsync(5000);
                        await finishRole('inspect', 2);
                        await vi.advanceTimersByTimeAsync(10000);
                        await finishRole('inspect', 3);
                        expect(fixture.entries.filter(entry => entry.role === 'inspect').map(entry => entry.at)).toEqual([0, 5000, 15000]);
                        fixture.native.status = 'running';
                        if (scenario === 'stopped-after-running') fixture.native.connection = 'pending';
                        await vi.advanceTimersByTimeAsync(20000);
                        await finishRole('bootstrap', 1);
                        expect(fixture.entries.filter(entry => entry.role === 'bootstrap')).toHaveLength(1);
                        if (scenario === 'stopped-after-running') {
                            fixture.native.status = 'stopped';
                            await vi.advanceTimersByTimeAsync(60000);
                        }
                        expect(await settled).toMatchObject({ code: scenario === 'connect' ? 'provider_unavailable' : 'native_resource_unavailable' });
                        expect(fixture.entries.filter(entry => entry.role === 'bootstrap').every(entry => entry.status === 'running' || entry.status === 'stopped')).toBe(true);
                    }
                    expect(fixture.row()).not.toHaveProperty('startPending');
                    const reads = fixture.entries.length;
                    await vi.advanceTimersByTimeAsync(180000);
                    expect(fixture.entries).toHaveLength(reads);
                } finally { fixture.abort.abort(); await settled; }
            });
        });

    it.skipIf(process.platform === 'win32')('does not invent an accepted start for a retained stopped Lima Retry', async () => {
        await withSocketTempDir(async root => {
            const fixture = await setup(root, 'lima');
            await expect(fixture.execute()).rejects.toMatchObject({ code: 'native_resource_unavailable' });
            expect(fixture.entries.map(entry => entry.role)).toEqual(['bootstrap']);
            expect(fixture.native.runCount).toBe(0);
        });
    });
});

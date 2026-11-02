import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import axios, { AxiosHeaders } from 'axios';
import { configuration, reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor, useServerProfile } from '@/server/serverProfiles';
import { readStoredCredentials, writeCredentialsTokenOnly } from '@/persistence';
import type { ApiMachineClientLifecycleDependencies } from './apiMachine';
import { ApiClient } from './api';
import type { MachineActionDirectTargetTransport } from '@/session/actions/cliActionDeps/types';
import type { RpcHandlerContext } from './rpc/types';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createDeferred } from '@/testkit/async/deferred';
import { createSpawnRequestCoalescer } from '@/daemon/spawn/spawnRequestCoalescer';
import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createMachineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createMachineAdminAccessObserver } from '@/machines/adminAccess/observeMachineAdminAccess';
import { createMachineAdminAccessHost } from '@/machines/adminAccess/machineAdminAccessHost';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { runMachineSetupEffectInternal } from '@/machines/setup/effectInternal';
import type { MachineElevationSpawn } from '@/machines/adminAccess/runElevatedEffect';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, ActionOperationListV1ResponseSchema, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
    ActionOperationSnapshotV1Schema, FeaturesResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

let directory: string;
let cleanups: Array<() => Promise<void>>;
beforeEach(async () => {
    cleanups = [];
    directory = await mkdtemp(join(tmpdir(), 'happier-reboot-admission-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
});
afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    vi.restoreAllMocks(); vi.unstubAllEnvs(); reloadConfiguration();
    await rm(directory, { recursive: true, force: true });
});

async function setupReboot(options: Readonly<{ busyStartup?: boolean; spawn?: MachineElevationSpawn;
    readEncryption?: () => Promise<Readonly<{ mode: 'plain' }>> }> = {}) {
        const profile = await addServerProfile({ name: 'reboot', serverUrl: 'https://home.invalid', webappUrl: 'https://home.invalid' });
        // Captured Home descriptor through its actual profile-adoption owner.
        // Raw capability admission must not invent custody from Account equality.
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId: 'srv_machine_reboot', canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        await useServerProfile(profile.id);
        vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', profile.id);
        vi.stubEnv('HAPPIER_SERVER_URL', profile.serverUrl);
        reloadConfiguration();
        expect(configuration.activeServerId).toBe(profile.id);
        const installation = await readOrCreateInstallationIdentity();
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', provenance: {
            v: 1, kind: 'terminal', authority: 'account_automation',
        } })).toString('base64url')}.fixture`;
        // Actual stored terminal credential codec, not a synthetic API-token
        // object that must correctly lose its claimed present-person authority.
        await writeCredentialsTokenOnly({ token });
        const credentials = await readStoredCredentials();
        if (!credentials) throw new Error('Stored terminal fixture must decode');
        const drain = createDaemonAdmissionDrain();
        const nativeAdmission = createMachineNativeEffectAdmission();
        const startup = createSpawnRequestCoalescer({ recentSuccessTtlMs: 0 });
        const nativeSpawn = createDeferred();
        // Hold only the native-spawn completion. The real startup coalescer and
        // canonical Session producer retain the in-flight admission themselves.
        const startPending = () => startup.run({ kind: 'new', key: 'actual-pending-start' }, async () => {
            await nativeSpawn.promise;
            return { type: 'success', sessionId: 'session' };
        });
        const pending = options.busyStartup ? startPending() : undefined;
        const sessions = createSessionLiveWorkProducer({ startup, readSessions: () => [],
            readActivity: async () => { throw new Error('No started Session exists'); } });
        const runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory, runtimeOptions: { pluginIds: [] } });
        const services = runtime.registry.projectManagedServices;
        const inventory = createManagedActivityInventory({ producers: [sessions, services.activity] });
        // Count actual owner reads without replacing any inventory or producer behavior.
        const inventoryReads = vi.spyOn(inventory, 'read');
        const vitals = createMachineVitalsSampler({
            // Captured OS reader facts; the real sampler owns their admission.
            readers: { read: async input => {
                if (options.busyStartup) throw new Error('Busy refusal cannot read host facts');
                return { state: 'reporting', host: { logicalCores: 4, memoryTotalBytes: 1000, bootedAt: 1000 },
                    sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs,
                        cpu: { reported: false, reason: 'unavailable' }, memory: { reported: false, reason: 'unavailable' },
                        disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
                    minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null } };
            } },
            historyStore: await createMinuteHistoryStore({ directory: join(directory, 'vitals') }),
        });
        if (!options.busyStartup) await vitals.start();
        let elevationProcesses = 0;
        const machineReboot = { nativeAdmission, vitals,
            readServiceFacts: (request: Parameters<typeof services.readMachineRebootServices>[0]) => services.readMachineRebootServices(request),
            spawnElevation: (input: Parameters<MachineElevationSpawn>[0]) => {
                elevationProcesses++;
                if (!options.spawn) throw new Error('A busy Machine must not elevate');
                return options.spawn(input);
            },
        };
        const lifecycle: ApiMachineClientLifecycleDependencies = { managedActivity: { activity: inventory, admissionDrain: drain }, machineReboot };
        const accountChannel = await createRequesterCurrentnessSocketHarness();
        onTestFinished(() => accountChannel.close());
        const releaseHome = publishServerHttpRuntimeOrigin('https://home.invalid', 'https');
        // Installed ApiClient owns the authenticated connection's Home facts.
        // A saved profile descriptor alone is not current execution custody.
        const api = await ApiClient.create(credentials);
        api.setServerFeaturesSnapshotProvider(() => ({ status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_machine_reboot' } },
        }) }));
        const client = api.machineSyncClient({ id: 'machine', encryptionMode: 'plain',
            metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/users/worker',
                happyHomeDir: '/users/worker/.happier', adminAccess: { version: 1, mode: 'ask', administratorUsername: 'operator' } },
            metadataVersion: 1, daemonState: { status: 'running' }, daemonStateVersion: 0,
        }, undefined, lifecycle);
        // Socket and Home currentness are genuine transports. No Action policy,
        // inventory, drain, native admission, operation or lifecycle is mocked.
        const prompt = createDeferred<Extract<NonNullable<ActionOperationSnapshotV1['domainRef']>, { kind: 'machineReboot' }>>();
        const snapshots: ActionOperationSnapshotV1[] = [];
        Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true,
            emitWithAck: (event, payload) => event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1
                ? { v: 1, result: 'success', revision: 1 } : resolveApiSessionSocketDefaultAck(event, payload),
            emit: (event, args) => {
            if (event !== 'action-operation-updated') return;
            const envelope = args[0];
            if (!envelope || typeof envelope !== 'object' || !('content' in envelope)) return;
            const content = envelope.content;
            if (!content || typeof content !== 'object' || !('t' in content) || content.t !== 'plain' || !('v' in content)) return;
            const parsed = ActionOperationSnapshotV1Schema.safeParse(content.v);
            if (!parsed.success) return;
            snapshots.push(parsed.data);
            if (parsed.data.domainRef?.kind === 'machineReboot' && parsed.data.domainRef.task.prompt) prompt.resolve(parsed.data.domainRef);
        } }));
        const homePosts = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, statusText: 'OK', headers: {},
            config: { headers: new AxiosHeaders() }, data: { v: 1, ok: true } });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
            // Existing legacy-Home compatibility: no currentness push route;
            // exact Machine admission is still reverified by its real POST.
            if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 404, data: {} };
            if (!String(url).endsWith('/v1/account/encryption')) throw new Error(`Unexpected Home GET ${url}`);
            return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
                data: { ...await (options.readEncryption?.() ?? Promise.resolve({ mode: 'plain' as const })), updatedAt: 1 } };
        });
        client.registerLocalServicesRoutes({ machineId: 'machine', serverId: configuration.activeServerId, accountId: 'owner',
            // Same public CLI factory/direct-host port as installed startup.
            // No projectManagedServices is provided: reboot must not depend on
            // service observation being enabled or any service being installed.
            resolveLauncherActionExecutor: ({ ingress }) => {
                const direct: MachineActionDirectTargetTransport = { machineId: 'machine',
                    invoke: (method, input, options) => client.invokeLocalMachineAction(method, input, { ...options,
                        ...(ingress ? { rpcContext: ingress } : {}) }),
                    machineReboot: request => client.executeMachineRebootAction({ ...request, context: { ...request.context,
                        machineAdmission: ingress?.machineAdmission,
                        verifyMachineAdmissionCurrent: ingress?.verifyMachineAdmissionCurrent,
                    } }),
                };
                const executor = createCliActionExecutor({ credentials, token, sessionId: 'cli-global',
                    serverId: configuration.activeServerId, serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null,
                    machineActionDirectTargetTransport: direct,
                });
                return { execute: (id, input, context) => executor.execute(id, input, { ...context,
                    // The person confirmed at the UI boundary; the canonical
                    // policy still evaluates the exact Action/input normally.
                    presentUserConfirmation: { actionId: id },
                }) };
            },
        });
        const lifetime = new AbortController();
        const context: RpcHandlerContext = { signal: lifetime.signal, callerAuthority: 'present_user',
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                installationId: installation.installationId, role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: () => verifyMachineRpcAdmissionCurrent({ context: {
                actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                installationId: installation.installationId, role: 'manage', encryptionMode: 'plain',
            }, method: 'machine:machines.reboot', privateKey: Buffer.from(installation.privateKey, 'base64url'),
                daemonToken: token, serverHttpBaseUrl: 'https://home.invalid', signal: context.signal }),
            localActionContext: { surface: 'cli', authority: 'present_user', actionRequestId: 'one-existing-request-envelope' },
        };
        const contextForActor = (actorAccountId: string): RpcHandlerContext => {
            const admission = { ...context.machineAdmission!, actorAccountId };
            return { ...context, machineAdmission: admission,
                verifyMachineAdmissionCurrent: () => verifyMachineRpcAdmissionCurrent({ context: admission,
                    method: `machine:${RPC_METHODS.CAPABILITIES_INVOKE}`,
                    privateKey: Buffer.from(installation.privateKey, 'base64url'), daemonToken: token,
                    serverHttpBaseUrl: 'https://home.invalid', signal: context.signal }) };
        };
        const control = createDaemonControlApp({ controlToken: 'control-token', machineId: 'machine', admissionDrain: drain,
            getChildren: () => [], stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => { throw new Error('Admission test must not create another Session'); },
            requestShutdown: () => {}, onHappySessionWebhook: () => {}, verifyRunMaterializeToken: token => token === 'run-token' });
        // Actual P10 observer; only its OS commands/filesystem are substituted.
        const observer = createMachineAdminAccessObserver({ platform: 'linux', onChanged: async () => {},
            execFile: async (file, args) => {
                if (file === 'id') return { stdout: args[0] === '-u' ? '1001' : args[0] === '-un' ? 'happier' : 'users' };
                if (file === 'sudo') throw Object.assign(new Error('Password required'), { code: 1 });
                throw new Error(`Unexpected observation command ${file}`);
            },
            fileSystem: { lstat: async () => { throw Object.assign(new Error('Absent'), { code: 'ENOENT' }); },
                readFile: async () => { throw new Error('Absent sudoers is not read'); } },
            readTailscaledOperator: async () => ({ authorization: 'unknown' }),
        });
        const admin = createMachineAdminAccessHost({ installationId: installation.installationId, installedCli: '/managed/happier',
            readPolicy: async () => ({ version: 1, mode: 'ask', administratorUsername: 'operator' }),
            observe: async () => (await observer.inspect()).observation, spawn: machineReboot.spawnElevation });
        client.registerMachineAdminAccessRoutes({ observer, target: () => ({ serverId: configuration.activeServerId,
            machineId: 'machine', installationId: installation.installationId, custodianAccountId: 'owner' }), reconcile: admin.reconcile });
        // Installed startup also binds the ordinary capabilities and operation
        // RPCs. Attendance must traverse those real handlers, not a test runner.
        client.setRPCHandlers({
            spawnSession: async () => { throw new Error('Reboot must not start a Session'); },
            stopSession: async () => ({ status: 'not_found' }), requestShutdown: () => {},
        });
        const invoke = () => client.invokeLocalMachineAction('machines.reboot', { serverId: configuration.activeServerId,
            machineId: 'machine', expectedInstallationId: installation.installationId }, {
            signal: context.signal, rpcContext: context, localActionContext: context.localActionContext,
        });
        let closing: Promise<void> | undefined;
        const close = () => closing ??= (async () => {
            // Caller disconnect is not cancellation of an admitted effect.
            // Use its actual operation owner to cancel an unanswered test Ask.
            const owned = ActionOperationListV1ResponseSchema.safeParse(await client.invokeLocalMachineAction(
                ACTION_OPERATION_RPC_METHODS_V2.list, {}, { signal: context.signal, rpcContext: context }));
            for (const operation of owned.success ? owned.data.items : []) {
                if (operation.actionId === 'machines.reboot' && (operation.state === 'accepted' || operation.state === 'running')) {
                    await client.invokeLocalMachineAction(ACTION_OPERATION_RPC_METHODS_V1.cancel,
                        { operationId: operation.operationId }, { signal: context.signal, rpcContext: context });
                    const reference = operation.domainRef;
                    if (reference?.kind === 'machineReboot' && !reference.basis) {
                        // Cleanup only: the public systemTasks capability has
                        // no cancel method. Release this fixture's actual task
                        // at its incumbent owner, never mock its live behavior.
                        await getLiveSystemTasksRunnerAdapter().cancel({ taskId: reference.task.id });
                    }
                }
            }
            lifetime.abort(); nativeSpawn.resolve(); await pending;
            await control.close(); await client.shutdown(); inventory.dispose(); await vitals.stop(); await runtime.dispose(); releaseHome();
        })();
        cleanups.push(close);
        const replaceInstallation = async () => {
            const replacement = await readOrCreateInstallationIdentity(join(directory, 'replacement-installation.json'));
            await writeFile(configuration.installationIdentityFile, JSON.stringify(replacement), { mode: 0o600 });
        };
        return { client, context, contextForActor, drain, nativeAdmission, startup, startPending, control, prompt, snapshots, invoke, replaceInstallation,
            admissionVerifications: () => homePosts.mock.calls.filter(([url]) => String(url).endsWith('/admission/verify')).length,
            maintenanceReads: () => inventoryReads.mock.calls.length,
            elevationProcesses: () => elevationProcesses, close };
}

function rebootProcessBoundary(options: Readonly<{ beforeRootPreparation?: () => void;
    beforeCommand?: () => void; loseDispatchReply?: boolean }> = {}) {
    const commands: Array<Readonly<{ executable: string; args: readonly string[] }>> = [];
    const passwords: string[] = [];
    // Simulated sudo/process streams are the only dispatch boundary. Both the
    // ordinary carrier and the installed root interpreter run unchanged.
    const spawn: MachineElevationSpawn = launch => {
        const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
        const rootInput = new PassThrough();
        const authenticated = new Promise<boolean>(resolve => {
            stdin.once('data', (chunk: Buffer) => {
                const password = chunk.toString('utf8');
                passwords.push(password.replace(/\n$/u, ''));
                chunk.fill(0);
                stdin.pipe(rootInput);
                resolve(password === 'one-use-password\n');
            });
            queueMicrotask(() => stderr.write('[happier-sudo-password:operator]\n'));
        });
        const rootOutput = new Writable({ write(chunk: Buffer, _encoding, done) {
            const record: unknown = JSON.parse(chunk.toString('utf8'));
            const checked = record && typeof record === 'object' && 'result' in record && record.result
                && typeof record.result === 'object' && 'status' in record.result && record.result.status === 'checked';
            // CHECK is an indispensable handshake, not the lost dispatch receipt.
            if (checked || !(options.loseDispatchReply && record && typeof record === 'object'
                && 'type' in record && record.type === 'result')) stdout.write(chunk);
            done();
        } });
        const settled = authenticated.then(async allowed => {
            if (!allowed) return 1;
            return await runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), {
                stdin: rootInput, stdout: rootOutput, platform: 'linux', readUid: () => 0,
                readNativeInit: async () => { options.beforeRootPreparation?.(); return 'systemd\n'; },
                runNative: async command => { options.beforeCommand?.(); commands.push(command); return { code: 0, stdout: '', stderr: '' }; },
            });
        }).then(code => { rootOutput.end(); stdout.end(); stderr.end(); return { code, signal: null }; });
        return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); rootInput.destroy(); await settled; } };
    };
    return { spawn, commands, passwords };
}

async function answerReboot(f: Awaited<ReturnType<typeof setupReboot>>,
    question: Awaited<typeof f.prompt.promise>, rpcContext = f.context) {
    return await f.client.invokeLocalMachineAction(RPC_METHODS.CAPABILITIES_INVOKE, {
        id: 'tool.systemTasks', method: 'respond', params: { taskId: question.task.id,
            expectedPromptKind: 'sudo.password', answer: { password: 'one-use-password' } },
    }, { signal: rpcContext.signal, rpcContext });
}

describe('installed reboot public Action admission', () => {
    it('publishes the admitted before-basis before the sole OS dispatch and keeps ingress closed after dispatch', async () => {
        let holdPublication = false;
        let rootFrameAdmissionBaseline: number | undefined;
        let finalMaintenanceBaseline: number | undefined;
        const publication = createDeferred(), releasePublication = createDeferred();
        const boundary = rebootProcessBoundary({ beforeRootPreparation: () => {
            holdPublication = true;
            // APPLY re-observes the same native fact. Keep the baseline from
            // CHECK, before publication and the final maintenance admission.
            rootFrameAdmissionBaseline ??= f.admissionVerifications();
            finalMaintenanceBaseline ??= f.maintenanceReads();
        } });
        const f = await setupReboot({ spawn: boundary.spawn, readEncryption: async () => {
            if (holdPublication) { publication.resolve(); await releasePublication.promise; }
            return { mode: 'plain' };
        } });
        const invocation = f.invoke();
        try {
            const question = await Promise.race([f.prompt.promise, invocation.then(result => { throw new Error(`Reboot returned before Ask: ${JSON.stringify(result)}`); })]);
            expect(question.task.prompt).toEqual({ kind: 'sudo.password', adminUsername: 'operator' });
            // This host-private replay carries its existing admitted context;
            // the daemon must not add another Home verification before Ask.
            expect(f.admissionVerifications()).toBe(0);
            expect(await answerReboot(f, question, f.contextForActor('foreign-manager')))
                .toMatchObject({ errorCode: 'agent_isolation_unavailable' });
            expect(boundary.passwords).toEqual([]);
            expect((await f.control.inject({ method: 'POST', url: '/execution-run/admission',
                headers: { 'x-happier-daemon-token': 'run-token' }, payload: {} })).json()).toEqual({ admitted: false, reason: 'daemon_draining' });
            expect((await f.control.inject({ method: 'POST', url: '/spawn-session',
                headers: { 'x-happier-daemon-token': 'control-token' }, payload: {} })).json())
                .toMatchObject({ success: false, errorCode: 'daemon_draining' });
            const answer = answerReboot(f, question);
            await publication.promise;
            // Let the real stream/interpreter consume any already-written
            // dispatch frame while the Home publication boundary is held.
            await new Promise(resolve => setImmediate(resolve));
            // A queued async snapshot is not yet an admitted outside holder.
            expect(boundary.commands).toEqual([]);
            releasePublication.resolve();
            expect(await answer).toMatchObject({ ok: true });
            expect(await invocation).toMatchObject({ kind: 'accepted', bootedAt: 1000 });
            expect(rootFrameAdmissionBaseline).toBeDefined();
            expect(f.admissionVerifications() - rootFrameAdmissionBaseline!).toBe(0);
            expect(finalMaintenanceBaseline).toBeDefined();
            expect(f.maintenanceReads() - finalMaintenanceBaseline!).toBe(1);
            expect(boundary.commands).toEqual([{ executable: 'systemctl', args: ['--no-block', 'reboot'], signal: expect.any(AbortSignal) }]);
            expect(f.snapshots.some(snapshot => snapshot.domainRef?.kind === 'machineReboot'
                && snapshot.domainRef.basis?.dispatchStarted === true)).toBe(true);
            expect(f.drain.isQuiescing()).toBe(true);
            await expect(f.nativeAdmission.run({ operation: { operationId: 'later', kind: 'service-control' }, keys: [] }, async () => {}))
                .rejects.toMatchObject({ code: 'effect_in_progress' });
            expect(JSON.stringify(f.snapshots)).not.toContain('one-use-password');
            expect(boundary.passwords).toEqual(['one-use-password']);
        } finally { releasePublication.resolve(); await f.close(); await invocation; }
    });

    it('refuses an installation replacement at the final local dispatch boundary after root preparation', async () => {
        let holdPublication = false;
        const publication = createDeferred(), releasePublication = createDeferred();
        const boundary = rebootProcessBoundary({ beforeRootPreparation: () => { holdPublication = true; } });
        const f = await setupReboot({ spawn: boundary.spawn, readEncryption: async () => {
            if (holdPublication) { publication.resolve(); await releasePublication.promise; }
            return { mode: 'plain' };
        } });
        const invocation = f.invoke();
        try {
            const question = await Promise.race([f.prompt.promise, invocation.then(result => { throw new Error(`Reboot returned before Ask: ${JSON.stringify(result)}`); })]);
            const answer = answerReboot(f, question);
            await publication.promise;
            await f.replaceInstallation();
            releasePublication.resolve();
            expect(await answer).toMatchObject({ ok: true });
            expect(await invocation).toMatchObject({ errorCode: 'plan_changed' });
            expect(boundary.commands).toEqual([]);
            expect(f.elevationProcesses()).toBe(1);
            expect(f.drain.isQuiescing()).toBe(false);
            expect(JSON.stringify(f.snapshots)).not.toContain('one-use-password');
            await f.nativeAdmission.run({ operation: { operationId: 'after-replacement', kind: 'service-control' }, keys: [] }, async () => {});
        } finally { releasePublication.resolve(); await f.close(); await invocation; }
    });

    it('cancels an actual unanswered Ask through its public operation owner without reopening a neighbor drain', async () => {
        const boundary = rebootProcessBoundary();
        const f = await setupReboot({ spawn: boundary.spawn });
        const invocation = f.invoke();
        let neighboringDrain: (() => void) | undefined;
        try {
            const question = await Promise.race([f.prompt.promise, invocation.then(result => { throw new Error(`Reboot returned before Ask: ${JSON.stringify(result)}`); })]);
            const operation = f.snapshots.find(snapshot => snapshot.domainRef?.kind === 'machineReboot'
                && snapshot.domainRef.task.id === question.task.id);
            if (!operation) throw new Error('The admitted prompt must carry its operation identity');
            neighboringDrain = f.drain.beginTemporaryDrain();
            expect(await f.client.invokeLocalMachineAction(ACTION_OPERATION_RPC_METHODS_V1.cancel,
                { operationId: operation.operationId }, { signal: f.context.signal, rpcContext: f.context }))
                .toEqual({ kind: 'requested' });
            expect(await invocation).toMatchObject({ errorCode: 'cancelled' });
            expect(boundary.commands).toEqual([]);
            expect(f.elevationProcesses()).toBe(0);
            expect(f.drain.isQuiescing()).toBe(true);
            neighboringDrain();
            expect(f.drain.isQuiescing()).toBe(false);
            await f.nativeAdmission.run({ operation: { operationId: 'after-cancel', kind: 'service-control' }, keys: [] }, async () => {});
        } finally { neighboringDrain?.(); await f.close(); await invocation; }
    });

    it('rejects an installation replaced while the original password question is open before any elevation', async () => {
        const boundary = rebootProcessBoundary();
        const f = await setupReboot({ spawn: boundary.spawn });
        const invocation = f.invoke();
        try {
            const question = await Promise.race([f.prompt.promise, invocation.then(result => { throw new Error(`Reboot returned before Ask: ${JSON.stringify(result)}`); })]);
            await f.replaceInstallation();
            expect(await answerReboot(f, question)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
            expect(boundary.passwords).toEqual([]);
            expect(boundary.commands).toEqual([]);
            expect(f.elevationProcesses()).toBe(0);
        } finally { await f.close(); await invocation; }
    });

    it('retains unknown dispatch and both exclusions after a lost native reply without replaying the request', async () => {
        const boundary = rebootProcessBoundary({ loseDispatchReply: true });
        const f = await setupReboot({ spawn: boundary.spawn });
        const invocation = f.invoke();
        try {
            const question = await Promise.race([f.prompt.promise, invocation.then(result => { throw new Error(`Reboot returned before Ask: ${JSON.stringify(result)}`); })]);
            expect(await answerReboot(f, question)).toMatchObject({ ok: true });
            expect(await invocation).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
            expect(await f.invoke()).toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
            expect(f.elevationProcesses()).toBe(1);
            expect(boundary.commands).toHaveLength(1);
            const dispatched = f.snapshots.filter(snapshot => snapshot.domainRef?.kind === 'machineReboot'
                && snapshot.domainRef.basis?.dispatchStarted);
            expect(new Set(dispatched.map(snapshot => snapshot.operationId)).size).toBe(1);
            expect(dispatched.at(-1)).toMatchObject({ state: 'running', cancellation: 'unsupported' });
            expect(f.drain.isQuiescing()).toBe(true);
            await expect(f.nativeAdmission.run({ operation: { operationId: 'after-loss', kind: 'service-control' }, keys: [] }, async () => {}))
                .rejects.toMatchObject({ code: 'effect_in_progress' });
        } finally { await f.close(); await invocation; }
    });

    it.each(['pending-start', 'shutdown'] as const)('rechecks actual %s acquired during Ask and never releases a neighbor drain', async interleaving => {
        const boundary = rebootProcessBoundary();
        const f = await setupReboot({ spawn: boundary.spawn });
        const invocation = f.invoke();
        let neighboringDrain: (() => void) | undefined;
        let pending: ReturnType<typeof f.startPending> | undefined;
        try {
            const question = await Promise.race([f.prompt.promise, invocation.then(result => { throw new Error(`Reboot returned before Ask: ${JSON.stringify(result)}`); })]);
            neighboringDrain = f.drain.beginTemporaryDrain();
            if (interleaving === 'pending-start') pending = f.startPending();
            else f.drain.beginShutdown();
            if (interleaving === 'shutdown') {
                await new Promise(resolve => setImmediate(resolve));
                expect(await f.client.invokeLocalMachineAction(RPC_METHODS.CAPABILITIES_INVOKE,
                    { id: 'tool.systemTasks', method: 'poll', params: { taskId: question.task.id, cursor: 0 } },
                    { signal: f.context.signal, rpcContext: f.context }))
                    .toMatchObject({ ok: true, result: { pendingPrompt: null } });
            }
            expect(await answerReboot(f, question)).toMatchObject({ ok: interleaving === 'pending-start' });
            expect(await invocation).toEqual(interleaving === 'pending-start'
                ? { kind: 'blocked', reasons: ['setup'] } : { kind: 'unavailable', reason: 'daemon_shutting_down' });
            expect(boundary.commands).toEqual([]);
            expect(f.elevationProcesses()).toBe(interleaving === 'pending-start' ? 1 : 0);
            expect(f.drain.isQuiescing()).toBe(true);
            neighboringDrain();
            expect(f.drain.isQuiescing()).toBe(interleaving === 'shutdown');
        } finally { neighboringDrain?.(); await f.close(); await pending; await invocation; }
    });

    it('blocks an actual pending Session startup at the registered public Action without opening an elevation process', async () => {
        const f = await setupReboot({ busyStartup: true });
        const { startup, drain, nativeAdmission, control } = f;
        try {
            expect(startup.readInFlightRequests()).toHaveLength(1);
            await expect(f.invoke()).resolves.toEqual({ kind: 'blocked', reasons: ['setup'] });
            expect(f.elevationProcesses()).toBe(0);
            expect(drain.isQuiescing()).toBe(false);
            // Positive pre-dispatch refusal releases ONLY this reboot's drain.
            expect((await control.inject({ method: 'POST', url: '/execution-run/admission',
                headers: { 'x-happier-daemon-token': 'run-token' }, payload: {} })).json()).toEqual({ admitted: true });
            await nativeAdmission.run({ operation: { operationId: 'later-native', kind: 'service-control' }, keys: [] }, async () => {});
        } finally {
            await f.close();
        }
    });
});

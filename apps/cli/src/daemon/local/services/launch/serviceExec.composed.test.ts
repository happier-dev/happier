import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import childProcessBoundary from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent,
    type MachineRpcAdmissionBoundary } from '@/api/machine/machineRpcAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { DaemonTerminalEnsureResponseSchema } from '@happier-dev/protocol/daemon/terminal';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineRpcHandlers } from '@/api/machine/rpcHandlers';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { produceEnvironmentProjectServices } from './projectDeclarations';
import * as ptyBoundary from '@/terminal/pty/provider';
import * as terminationBoundary from '@/processes/terminate/terminateProcessTree';
import type { PtyProcess, PtySpawnParams } from '@/terminal/pty/provider';
import { machineNativeEffectAdmission, type MachineNativeEffectContext } from './machineNativeEffectAdmission';
import * as nativeCompose from './nativeComposeLifecycle';
import { withFiniteComposeFixture } from './serviceExec.testkit';
import { authorizePluginExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { spawnAuthorizedHostExecLaunchForHost, type HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { MachineNativeEffectOperation } from './machineNativeEffectAdmission';
import { access } from 'node:fs/promises';
import { RESTIC_RUNTIME_V1, buildResticRequestV1, type ResticRequestV1 } from '@happier-dev/deployments';
import type { EnvironmentSecretBindingV1, DeploymentImageV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createDeploymentBackupEnvironmentForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { createNativeComposeImageIdentity } from './nativeComposeImageIdentity';
import { nativeRestic0191 } from './nativeResticRegistry.testkit';
import { qualifyNativeBackupNetworking } from './nativeResticNetwork.testkit';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MachineServiceExecResultV1Schema } from '@happier-dev/protocol';
import { DeploymentEnvironmentAccessInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createCliDeploymentActionDeps } from '@/deployments/createCliDeploymentActionDeps';
import { createCliProjectAdmission } from '@/session/actions/cliActionDeps/projectAdmission';
import { createCliMachineResourceActionDeps } from '@/session/actions/cliActionDeps/machineResources';

type Command = Readonly<{ mode: 'exec' | 'run'; argv: readonly string[] }>;
type FiniteResult = Readonly<{ kind: 'completed'; exitCode: number; stdout: string; stderr: string;
    stdoutTruncated: boolean; stderrTruncated: boolean }> | Readonly<{ kind: 'outcome_unknown' }>;
type CommandFactory = (input: Readonly<{ render: nativeCompose.NativeComposeProjectRender; context: MachineNativeEffectContext;
    service: string; command: Command; environmentOverrides?: Readonly<Record<string, string>>; signal?: AbortSignal }>) => Promise<object>;

/** A missing implementation remains a runtime RED, not a shared-package import failure. */
function finiteOwner(project: nativeCompose.NativeComposeEnvironmentProject) {
    return {
        render: Reflect.get(project, 'render') as ((options: Readonly<{ purpose: 'serviceCommand'; service: string }>) => Promise<nativeCompose.NativeComposeProjectRender>),
        prepare: Reflect.get(project, 'prepareRuntimeImages') as ((input: Readonly<{
            render: nativeCompose.NativeComposeProjectRender; context: MachineNativeEffectContext;
        }>) => Promise<void>) | undefined,
        admit: Reflect.get(project, 'admitServiceCommand') as CommandFactory | undefined,
        execute: Reflect.get(nativeCompose, 'executeAdmittedServiceCommand') as ((context: object) => Promise<FiniteResult>) | undefined,
    };
}

describe('admitted finite Compose command', () => {
    it('publishes admitted native project and member identities without exposing an Environment as a new Machine watch', async () => {
        await withFiniteComposeFixture(async ({ project, source, io }) => {
            const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
            if (!lease) throw new Error('Expected the installed runtime');
            try {
                const rendered = await project.render();
                const activated = await machineNativeEffectAdmission.run({
                    operation: { operationId: 'native-watch-identity', kind: 'deploy' },
                    keys: rendered.keys, settleNative: project.settleNative,
                }, context => project.activate({ render: rendered, context }));
                await source.commit();
                const [handle] = await produceEnvironmentProjectServices({ owner: lease.registry.projectManagedServices,
                    serverId: 'finite-home', release: source, specIdentity: 'native-watch-identity',
                    isCurrent: () => true, nativeEffects: { keys: rendered.keys, settleNative: project.settleNative }, io, project: activated });
                if (!handle) throw new Error('Expected the admitted Environment observation');
                const target = { serverId: 'finite-home', machineId: source.machineId };
                const adapter = { pluginId: 'happier.machine.services', localId: 'compose' };
                for (const tuple of [[rendered.engineId, rendered.projectName], [rendered.engineId, rendered.projectName, handle.composeService]]) {
                    expect(lease.registry.projectManagedServices.resolveNativeService({ adapter,
                        nativeResourceId: JSON.stringify(tuple) }, target))
                        .toMatchObject({ authority: 'project', serviceId: handle.serviceId, handle });
                }
                expect(lease.registry.projectManagedServices.resolveNativeService({ adapter,
                    nativeResourceId: JSON.stringify(['other-engine', rendered.projectName]) }, target)).toBeNull();
            } finally { await lease.release(); }
        });
    });

    it('returns completed redacted exec output after requester access is revoked and refuses the next invocation without post-admission authority reads', async () => {
        let phase = 'fixture';
        onTestFinished(() => { console.info('[C-P30 finite admission phase]', phase); });
        await withFiniteComposeFixture(async ({ project, docker, source, io }) => {
            phase = 'render';
            const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
            if (!lease) throw new Error('Expected the fixture installed runtime');
            const rendered = await project.render();
            phase = 'activate';
            const activated = await machineNativeEffectAdmission.run({ operation: { operationId: 'one-admission-deploy', kind: 'deploy' },
                keys: rendered.keys, settleNative: project.settleNative }, context => project.activate({ render: rendered, context }));
            await source.commit();
            phase = 'mount';
            const handles = await produceEnvironmentProjectServices({ owner: lease.registry.projectManagedServices,
                serverId: 'finite-home', release: source, specIdentity: 'one-admission-current-generation',
                isCurrent: () => true, nativeEffects: { keys: rendered.keys, settleNative: project.settleNative }, io, project: activated });
            const handle = handles[0];
            if (!handle) throw new Error('Expected the mounted native generation');
            const authorityEvents: string[] = [];
            let environmentAccess = true;
            let firstAdmissionEventCount: number | undefined;
            let accessRequests = 0;
            const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'finite-owner' })).toString('base64url')}.signature`,
                encryption: null, credentialProvenance: 'stored_session' as const };
            // Only Home HTTP and Docker/OS are substituted. Real Account admission,
            // Environment-access carrier, Action dependency factory, mounted selector,
            // native admission and Exec redaction execute beneath these boundaries.
            const home = createServer((request, response) => {
                void (async () => {
                    if (request.method !== 'POST' || request.url !== '/v1/deployments/environments/access'
                        || request.headers.authorization !== `Bearer ${credentials.token}`) {
                        response.writeHead(403).end(); return;
                    }
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) chunks.push(Buffer.from(chunk));
                    const body = DeploymentEnvironmentAccessInputV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    if (body.serverId !== 'finite-home' || body.environmentIds.length !== 1 || body.environmentIds[0] !== source.environmentId) {
                        response.writeHead(400).end(); return;
                    }
                    accessRequests += 1;
                    authorityEvents.push('environment-access');
                    const result = { ok: true, items: environmentAccess
                        ? [{ environmentId: source.environmentId, read: true, deploy: true }] : [] };
                    // This is the first real admission response, not the later
                    // spawn boundary: duplicate pre-spawn authority reads fail too.
                    firstAdmissionEventCount ??= authorityEvents.length;
                    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
                })().catch(() => { response.writeHead(500).end(); });
            });
            home.listen(0, '127.0.0.1');
            await once(home, 'listening');
            const address = home.address();
            if (!address || typeof address === 'string') throw new Error('Expected a loopback Home HTTP boundary');
            const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
            const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
            const admission = createCliProjectAdmission({ credentials, serverId: 'finite-home', serverHttpBaseUrl }, {
                projectHomeId: 'finite-home', actionHomeId: 'finite-home', executionRunActionFailure: failure });
            const deployment = createCliDeploymentActionDeps({ serverHttpBaseUrl, admitAccount: admission.projectAccountAdmission,
                resolveRequestHeaders: async () => {
                    authorityEvents.push('http-credential');
                    return { Authorization: `Bearer ${credentials.token}` };
                }, async dispatchReceipt() { throw new Error('Exec must not dispatch a Deployment'); } });
            const deps = createCliMachineResourceActionDeps({ credentials, token: credentials.token, serverIdentityId: 'finite-home',
                serverHttpBaseUrl, isCredentialCurrent: async () => { authorityEvents.push('credential-current'); return true; },
                machineActionDirectTargetTransport: { machineId: source.machineId,
                    async invoke() { throw new Error('An admitted local command must not forward to another Machine'); } },
            }, { ...admission, projectHomeId: 'finite-home', readEnvironmentAccess: deployment.readEnvironmentAccess,
                observeEnvironmentAccessChanges: deployment.observeEnvironmentAccessChanges,
                async callMachineAction() { throw new Error('An admitted local command must not forward to another Machine'); },
                executionRunActionFailure: failure });
            const executeCommand = deps.machineServiceExec;
            if (!executeCommand) throw new Error('Expected the installed service Exec Action dependency');
            let operationSequence = 0;
            const operations = createHostActionOperationRuntime({ serverId: 'finite-home', machineId: source.machineId,
                custodyBinding: { serverId: 'finite-home', installationId: source.installationId },
                resolveAccountId: async () => 'finite-owner', generateOperationId: () => `one-admission-operation-${++operationSequence}` });
            const input = { serverId: 'finite-home', machineId: source.machineId, mode: 'exec' as const, argv: ['read-token'],
                target: { kind: 'current' as const, serviceId: handle.serviceId, expectedGeneration: handle.instanceId } };
            const invoke = (actionRequestId: string) => operations.observeExecution({ actionId: 'machines.services.exec', input, actionRequestId,
                execute: async operation => {
                    const raw = await executeCommand({ input, approvalScope: { kind: 'environment', environmentId: source.environmentId },
                        signal: operation.signal, context: { serverId: 'finite-home', runtimeAccountId: 'finite-owner', authority: 'present_user',
                            signal: operation.signal, operationAcceptance: operation.operationAcceptance,
                            operationOwnerUpdate: operation.operationOwnerUpdate } });
                    const denied = ActionExecuteFailureSchema.safeParse(raw);
                    return denied.success ? denied.data : { ok: true, result: MachineServiceExecResultV1Schema.parse(raw) };
                } });
            let pending: ReturnType<typeof invoke> | undefined;
            let observeExecSpawn!: () => void;
            let observeExecFailure!: (error: Error) => void;
            const execSpawned = new Promise<void>((resolve, reject) => {
                observeExecSpawn = resolve; observeExecFailure = reject;
            });
            const originalSpawn = childProcessBoundary.spawn;
            // Observe the real selected OS child without replacing its process,
            // argv, streams or native admission/preparation path.
            const spawn = vi.spyOn(childProcessBoundary, 'spawn').mockImplementation((...args) => {
                const child: ReturnType<typeof originalSpawn> = Reflect.apply(originalSpawn, childProcessBoundary, args);
                if (args[0] === docker.executablePath && Array.isArray(args[1])
                    && args[1].includes('exec') && args[1].at(-1) === 'read-token') {
                    child.once('spawn', observeExecSpawn);
                    child.once('error', observeExecFailure);
                }
                return child;
            });
            syncBuiltinESMExports();
            const restoreSpawn = () => { spawn.mockRestore(); syncBuiltinESMExports(); };
            onTestFinished(restoreSpawn);
            try {
                await docker.setCommandOutcome({ environmentKey: 'TOKEN', stderr: 'finite-native-secret-sentinel', exitCode: 0 });
                await docker.holdCommandReplies(true);
                pending = invoke('admitted-before-access-revocation');
                phase = 'native-dispatch';
                await Promise.race([
                    execSpawned,
                    pending.then(result => {
                        // The held OS child cannot finish here. Surface the
                        // preceding real admission result instead of timing out
                        // on an absent child and misclassifying that as RED.
                        throw new Error(`Exec settled before native dispatch: ${result.ok ? 'ok' : result.errorCode}; accessRequests=${accessRequests}; authorityEvents=${authorityEvents.join(',')}`);
                    }, (error: unknown) => {
                        const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
                            ? error.code : error instanceof Error ? error.name : 'unknown';
                        throw new Error(`Exec rejected before native dispatch: ${code}; accessRequests=${accessRequests}; authorityEvents=${authorityEvents.join(',')}`);
                    }),
                ]);
                // Revocation occurs only after the actual OS Docker invocation.
                // Its retained native generation and local cancellation stay current.
                environmentAccess = false;
                phase = 'finite-settlement';
                await docker.holdCommandReplies(false);
                const completed = await pending;
                expect(completed).toMatchObject({ ok: true, result: { exitCode: 0, stdout: '[REDACTED]', stderr: '[REDACTED]',
                    stdoutTruncated: false, stderrTruncated: false } });
                expect(firstAdmissionEventCount).toBeDefined();
                expect(authorityEvents.slice(firstAdmissionEventCount)).toEqual([]);
                expect(accessRequests).toBe(1);
                expect(await invoke('after-access-revocation')).toMatchObject({ ok: false, errorCode: 'service_exec_denied' });
                phase = 'inspect-current-generation';
                expect(accessRequests).toBe(2);
                const executions = (await docker.readInvocations()).filter(row => row.args.includes('exec'));
                expect(executions).toHaveLength(1);
                expect(executions[0].environmentKeys).toContain('UNREVIEWED');
                expect(executions[0].dockerHostMatchesExpected).toBe(true);
                expect(executions[0].args[executions[0].args.indexOf('--project-name') + 1]).toBe(rendered.projectName);
                expect(await handle.inspectCurrentOccurrence()).toMatchObject({ nativePhase: 'running' });
                phase = 'completed';
            } finally {
                restoreSpawn();
                await docker.holdCommandReplies(false);
                await pending?.catch(() => undefined);
                await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
                for (const service of handles) await service.dispose();
                await activated.dispose(); await lease.release();
            }
        });
    });
    it.each(['complete', 'cancelBeforeCreate', 'metadataSequence', 'rawReadback'] as const)('admits P45 restic on the selected named volume through real source, image proof, P42 custody and the existing command owner: %s', async outcome => {
        await withFiniteComposeFixture(async ({ project, docker, source, root, exec }) => {
            await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
            // Native registry/process boundary is substituted; the actual
            // image owner verifies the recorded public index/variant/CONFIG.
            const images = createNativeComposeImageIdentity({ directory: async () => root, async run(args) {
                const tool = await exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose', cwd: source.rootPath });
                const result = await exec.run({ executable: tool.executable, cwd: source.rootPath, args });
                if (result.termination.observed.kind !== 'exit') throw new Error('Expected native metadata exit');
                return { exitCode: result.termination.observed.exitCode, stdout: Buffer.from(result.stdout).toString('utf8') };
            } });
            const [runtimeImage] = await images.resolveVariants({ service: 'restic', reference: RESTIC_RUNTIME_V1.image,
                platforms: ['linux/amd64'] });
            if (!runtimeImage) throw new Error('Expected the recorded platform variant');
            expect(runtimeImage.indexDigest).toBe(RESTIC_RUNTIME_V1.image.split('@')[1]);
            const render = await project.render();
            const activated = await machineNativeEffectAdmission.run({ operation: { operationId: 'restic-fixture-deploy', kind: 'deploy' },
                keys: render.keys, settleNative: project.settleNative }, context => project.activate({ render, context }));
            await source.commit();
            const roles = ['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const;
            const values = ['repository-native-private', 'access-native-private', 'secret-native-private'];
            const seed = new Uint8Array(32).fill(48);
            const uses = roles.map((role): Extract<EnvironmentSecretBindingV1, { purpose: 'backupDestination' }> => ({
                purpose: 'backupDestination', configKey: 'destination', role, source: { kind: 'secret',
                    ref: formatSharedSavedSecretRefV1(role), resourceRevision: 1 } }));
            const grants = uses.map((_use, index) => sealMachineSecretGrant({
                subject: { v: 1, kind: 'secret', environmentId: source.environmentId, machineId: source.machineId,
                    installationId: source.installationId, resourceId: roles[index], resourceRevision: 1 },
                installationPublicKey: tweetnacl.sign.keyPair.fromSeed(seed).publicKey,
                content: { kind: 'secret', value: values[index] },
            }));
            const controller = new AbortController();
            const destination = createDeploymentBackupEnvironmentForHost({ signal: controller.signal, isCurrent: () => true,
                repository: 's3:https://fixture.invalid/backup',
                preparation: { environmentId: source.environmentId,
                    machineId: source.machineId, installationId: source.installationId, installationPrivateSeed: seed,
                    bindings: uses, backupDestinationUses: uses, grants, backupConfigBaseDir: root,
                    assertCurrent: source.assertCurrent } });
            const attachment = await destination.execEnv.prepare({ backupDestination: { configKey: 'destination' } }, { signal: controller.signal });
            const resticAccess = destination.readAccess();
            const passwordPath = resticAccess.credentialFiles[0].hostPath;
            const request = buildResticRequestV1({ environmentId: source.environmentId,
                access: resticAccess,
                command: { kind: 'backupPaths', sourceId: 'worker-data', paths: ['/data'] } });
            type Admitted = Parameters<typeof nativeCompose.executeAdmittedServiceCommand>[0];
            type Input = Readonly<{ render: nativeCompose.NativeComposeProjectRender; context: MachineNativeEffectContext;
                runtimeImage: DeploymentImageV1; request: ResticRequestV1; destinationAttachment: typeof attachment; signal?: AbortSignal;
                selector: Readonly<{ kind: 'volume'; sourceId: string; service: string; volume: string; consistency: 'stopDuringCopy' }> }>;
            const admit = Reflect.get(project, 'admitResticCommand') as ((input: Input) => Promise<Admitted>) | undefined;
            try {
                expect(admit, 'the native owner must admit the third operation arm').toBeTypeOf('function');
                await machineNativeEffectAdmission.run({ operation: { operationId: 'restic-existing-parent', kind: 'backup' },
                    keys: render.keys, settleNative: project.settleNative }, async context => {
                    if (outcome === 'metadataSequence' || outcome === 'rawReadback') {
                        const binary = Buffer.from([0, 255, 195, 40, 128, 10]);
                        if (outcome === 'rawReadback') await docker.setOperationStdout(binary);
                        const metadataRequest = buildResticRequestV1({ environmentId: source.environmentId,
                            access: resticAccess,
                            command: outcome === 'rawReadback' ? { kind: 'dump', snapshotId: 'a'.repeat(64), path: '/database.dump' } : { kind: 'config' } });
                        const first = await nativeCompose.executeAdmittedServiceCommand(await project.admitResticCommand({
                            render, context, runtimeImage, request: metadataRequest, destinationAttachment: attachment }));
                        expect(first).toMatchObject({ kind: 'completed', exitCode: 0 });
                        if (outcome === 'rawReadback') {
                            // Invalid UTF-8 distinguishes raw measurement from
                            // re-encoding diagnostic text (or inventing a digest).
                            expect(first).toMatchObject({ stdoutBytes: binary.byteLength,
                                stdoutChecksumSha256: createHash('sha256').update(binary).digest('hex') });
                            return;
                        }
                        for (const command of [{ kind: 'snapshots', latest: 1 }, { kind: 'tree', treeId: 'b'.repeat(64) }] as const) {
                            const nextRequest = buildResticRequestV1({ environmentId: source.environmentId,
                                access: resticAccess, command });
                            const next = await nativeCompose.executeAdmittedServiceCommand(await project.admitResticCommand({
                                render, context, runtimeImage, request: nextRequest, destinationAttachment: attachment, signal: controller.signal }));
                            expect(next).toMatchObject({ kind: 'completed', exitCode: 0 });
                            await access(passwordPath);
                        }
                        expect(await docker.readOperationContainerIds()).toEqual([]);
                        return;
                    }
                    await expect(admit!({ render, context, runtimeImage, request, destinationAttachment: attachment,
                        selector: { kind: 'volume', sourceId: 'worker-data', service: 'worker', volume: 'foreign', consistency: 'stopDuringCopy' } }))
                        .rejects.toMatchObject({ code: 'service_admission_unavailable' });
                    await expect(admit!({ render, context, runtimeImage, request, destinationAttachment: attachment,
                        selector: { kind: 'volume', sourceId: 'worker-data', service: 'worker', volume: 'data', consistency: 'stopDuringCopy' } }))
                        .rejects.toMatchObject({ code: 'service_admission_unavailable' });
                    await docker.stopCurrentContainers(); // P45's explicit stop stage, never hidden inside admission.
                    const command = await admit!({ render, context, runtimeImage, request, destinationAttachment: attachment,
                        selector: { kind: 'volume', sourceId: 'worker-data', service: 'worker', volume: 'data', consistency: 'stopDuringCopy' },
                        signal: controller.signal });
                    expect((await docker.readInvocations()).filter(row => row.args[0] === 'run')).toEqual([]);
                    if (outcome === 'cancelBeforeCreate') {
                        await docker.holdOperationConstruction();
                        const pending = nativeCompose.executeAdmittedServiceCommand(command).then(result => result, () => null);
                        const constructor = await docker.waitForOperationConstruction();
                        controller.abort();
                        // Reproduce the old run transport's client cancellation
                        // BEFORE the independent Engine commits its late helper.
                        // Settled create custody instead waits for that constructor.
                        if (constructor === 'run') await pending;
                        await docker.releaseOperationConstruction();
                        expect(await pending).not.toMatchObject({ kind: 'completed' });
                        expect(await docker.readOperationContainerIds(), 'cancel-before-create must leave no late helper').toEqual([]);
                        return;
                    }
                    const result = await nativeCompose.executeAdmittedServiceCommand(command);
                    expect(result.kind).toBe('completed');
                    if (result.kind !== 'completed') throw new Error('Expected native restic exit');
                    expect(result.exitCode).toBe(0);
                    expect(JSON.parse(result.stdout)).toEqual({ passwordReadable: true, accessPresent: true,
                        secretPresent: true, readOnlyData: true });
                    for (const value of values) expect(JSON.stringify(result)).not.toContain(value);
                });
                if (outcome !== 'complete') return;
                const invocations = await docker.readInvocations();
                expect(invocations.filter(row => row.args[0] === 'run')).toHaveLength(0);
                expect(invocations.filter(row => row.args[0] === 'start')).toHaveLength(1);
                const runs = invocations.filter(row => row.args[0] === 'create');
                expect(runs).toHaveLength(1);
                expect(runs[0].args).not.toContain('--network'); expect(runs[0].args).not.toContain('--net');
                if (process.env.HAPPIER_TEST_NATIVE_BACKUP_NETWORK === '1') {
                    await qualifyNativeBackupNetworking(runs[0].args);
                }
                expect(runs[0].args).toContain(runtimeImage.registryReference);
                for (const value of values) expect(JSON.stringify(runs)).not.toContain(value);
                await access(passwordPath); // Job, not the completed child, owns the preparation.
            } finally {
                attachment.dispose(); controller.abort();
                await expect(access(passwordPath)).rejects.toMatchObject({ code: 'ENOENT' });
                await activated.dispose();
            }
        }, { namedVolume: true, nativeExecutableIo: true });
    });
    it('hands the actual mounted generation to its shell consumer and settles the session on observed client exit', async () => {
        await withFiniteComposeFixture(async ({ project, docker, source, io }) => {
            const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
            if (!lease) throw new Error('Expected the fixture installed runtime');
            const fixtureOwners: { activated?: Awaited<ReturnType<typeof project.activate>>;
                handles?: Awaited<ReturnType<typeof produceEnvironmentProjectServices>> } = {};
            try {
                const rendered = await project.render();
                const activated = await machineNativeEffectAdmission.run({ operation: { operationId: 'shell-fixture-deploy', kind: 'deploy' },
                    keys: rendered.keys, settleNative: project.settleNative }, context => project.activate({ render: rendered, context }));
                fixtureOwners.activated = activated;
                await source.commit();
                const handles = await produceEnvironmentProjectServices({ owner: lease.registry.projectManagedServices,
                    serverId: 'finite-home', release: source, specIdentity: 'shell-owner-current-generation',
                    isCurrent: () => true, nativeEffects: { keys: rendered.keys, settleNative: project.settleNative }, io, project: activated });
                fixtureOwners.handles = handles;
                const handle = handles[0];
                if (!handle) throw new Error('Expected the native current service');
                // Missing source remains an observable runtime RED at the real
                // mounted owner, never a not-yet-exported-symbol build break.
                type ShellObservation = Readonly<{ kind: 'client_exit'; terminal: Readonly<{ ok: true; terminalId: string }>;
                    clientExit: Readonly<{ kind: 'exited'; exit: Readonly<{ exitCode: number | null; signal: number | null }> }>
                        | Readonly<{ kind: 'unavailable' }> }>
                    | Readonly<{ kind: 'not_started'; terminal: Readonly<{ ok: false; errorCode: string; error: string }> }>;
                const withShell = Reflect.get(handle, 'withServiceShell') as ((options: Readonly<{ operation: MachineNativeEffectOperation }>,
                    consume: (launch: HostAuthorizedPluginExecLaunch) => Promise<ShellObservation>) => Promise<unknown>) | undefined;
                let consumed = 0;
                const shellCapture: { launch?: HostAuthorizedPluginExecLaunch } = {};
                await docker.setCommandOutcome({ environmentKey: 'TOKEN', exitCode: 0 });
                const operationId = 'mounted-service-shell';
                await withShell?.({ operation: { operationId, kind: 'serviceShell' } }, async launch => {
                    consumed += 1;
                    shellCapture.launch = launch;
                    expect(launch.cwd).toBe(source.rootPath);
                    expect(launch.env.DOCKER_HOST).toBe('unix:///admitted-finite-engine.sock');
                    expect(launch.env.UNREVIEWED).toBe('unreviewed-value');
                    expect(launch.args[launch.args.indexOf('--project-name') + 1]).toBe(rendered.projectName);
                    expect(launch.env).not.toHaveProperty('TOKEN');
                    expect(launch.args.slice(-4)).toEqual(['exec', '-it', 'worker', '/bin/sh']);
                    await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'held-shell-collision', kind: 'deploy' },
                        keys: rendered.keys }, async () => undefined)).rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: operationId });
                    const process = spawnAuthorizedHostExecLaunchForHost(launch, { retainLaunch() {} });
                    const result = await process.handle.wait();
                    await process.dispose();
                    await process.waitForSettlement();
                    expect(result.termination.observed).toMatchObject({ kind: 'exit', exitCode: 0 });
                    expect(Buffer.from(result.stdout).toString('utf8')).toBe('[REDACTED]');
                    return { kind: 'client_exit', terminal: { ok: true, terminalId: 'fixture-native-terminal' },
                        clientExit: { kind: 'exited', exit: { exitCode: 0, signal: null } } };
                });
                expect(consumed, 'the mounted native owner must supply the shell launch').toBe(1);
                expect(shellCapture.launch?.secretRedactionLease?.isActive()).toBe(true);
                // Owner ruling 2026-10-29T16:20Z accepts client exit as this
                // session's settlement, including deliberate native detach.
                await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'after-shell-session-ended', kind: 'deploy' },
                    keys: rendered.keys }, async () => undefined)).resolves.toBeUndefined();
                const notStarted = { kind: 'not_started' as const,
                    terminal: { ok: false as const, errorCode: 'terminal_unavailable', error: 'terminal_unavailable' } };
                expect(await withShell?.({ operation: { operationId: 'shell-not-started', kind: 'serviceShell' } }, async () => notStarted)).toEqual(notStarted);
                expect((await docker.readInvocations()).filter(row => row.args.includes('exec'))).toHaveLength(1);
                const unknownOperationId = 'mounted-service-shell-unconfirmed-client';
                const unknownCapture: { launch?: HostAuthorizedPluginExecLaunch;
                    client?: ReturnType<typeof spawnAuthorizedHostExecLaunchForHost> } = {};
                let clientSettlementObserved = false;
                await docker.setCommandOutcome({ environmentKey: 'TOKEN', hold: true });
                try {
                    expect(await withShell?.({ operation: { operationId: unknownOperationId, kind: 'serviceShell' } }, async launch => {
                        unknownCapture.launch = launch;
                        // This consumer boundary has lost its exit observation.
                        // The fixture retains only the actual OS process so it
                        // can later supply the existing reconciliation witness.
                        unknownCapture.client = spawnAuthorizedHostExecLaunchForHost(launch, { retainLaunch() {} });
                        await vi.waitFor(async () => expect((await docker.readInvocations())
                            .filter(row => row.args.includes('exec'))).toHaveLength(2));
                        return { kind: 'client_exit', terminal: { ok: true, terminalId: 'fixture-unconfirmed-terminal' },
                            clientExit: { kind: 'unavailable' } };
                    })).toMatchObject({ kind: 'client_exit', clientExit: { kind: 'unavailable' } });
                    const { launch: unknownLaunch, client: unknownClient } = unknownCapture;
                    if (!unknownLaunch || !unknownClient) throw new Error('Expected the actual unconfirmed shell handoff');
                    expect(unknownLaunch.secretRedactionLease?.isActive()).toBe(true);
                    const observeSettled = async (operation: MachineNativeEffectOperation) =>
                        operation.operationId === unknownOperationId && clientSettlementObserved;
                    await machineNativeEffectAdmission.reconcileUnknown({ keys: rendered.keys, observeSettled });
                    expect(unknownLaunch.secretRedactionLease?.isActive()).toBe(true);
                    await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'unconfirmed-shell-privacy-collision', kind: 'deploy' },
                        keys: rendered.keys }, async () => undefined)).rejects.toMatchObject({ code: 'effect_in_progress',
                        actionOperationId: unknownOperationId });
                    // Remove the unrelated generation-observer references:
                    // the unknown shell must now be the redactor's sole owner.
                    for (const owned of handles) await owned.dispose();
                    await activated.dispose();
                    expect(unknownLaunch.secretRedactionLease?.isActive()).toBe(true);
                    expect(unknownLaunch.secretRedactionLease?.redact('finite-native-secret-sentinel')).toBe('[REDACTED]');
                    await unknownClient.dispose();
                    const settlement = await unknownClient.waitForSettlement();
                    expect(settlement.status).toBe('ended');
                    clientSettlementObserved = true;
                    // A witnessed local client settlement still does not
                    // release native/private custody before its one owner joins.
                    expect(unknownLaunch.secretRedactionLease?.isActive()).toBe(true);
                    await machineNativeEffectAdmission.reconcileUnknown({ keys: rendered.keys, observeSettled });
                    expect(unknownLaunch.secretRedactionLease?.isActive()).toBe(false);
                    await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'after-unconfirmed-shell-reconciled', kind: 'deploy' },
                        keys: rendered.keys }, async () => undefined)).resolves.toBeUndefined();
                } finally {
                    if (unknownCapture.client) {
                        await unknownCapture.client.dispose();
                        await unknownCapture.client.waitForSettlement();
                        clientSettlementObserved = true;
                        await machineNativeEffectAdmission.reconcileUnknown({ keys: rendered.keys,
                            observeSettled: async operation => operation.operationId === unknownOperationId && clientSettlementObserved });
                    }
                }
                for (const owned of handles) await owned.dispose();
                await activated.dispose();
                expect(shellCapture.launch?.secretRedactionLease?.isActive()).toBe(false);
            } finally {
                try { for (const owned of fixtureOwners.handles ?? []) await owned.dispose(); }
                finally { try { await fixtureOwners.activated?.dispose(); } finally { await lease.release(); } }
            }
        });
    });
    it.each([RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.DAEMON_TERMINAL_RESTART])(
        'consumes the admitted person service shell through installed terminal composition: %s', async method => {
        let phase = 'fixture';
        onTestFinished(() => { console.info('[C-P30 registered shell phase]', { method, phase }); });
        await withFiniteComposeFixture(async ({ project, source, io, root }) => {
            phase = 'render';
            const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
            if (!lease) throw new Error('Expected the fixture installed runtime');
            const rendered = await project.render();
            phase = 'activate';
            const activated = await machineNativeEffectAdmission.run({ operation: { operationId: 'terminal-fixture-deploy', kind: 'deploy' },
                keys: rendered.keys, settleNative: project.settleNative }, context => project.activate({ render: rendered, context }));
            await source.commit();
            phase = 'mount';
            const handles = await produceEnvironmentProjectServices({ owner: lease.registry.projectManagedServices,
                serverId: 'finite-home', release: source, specIdentity: 'terminal-current-generation',
                isCurrent: () => true, nativeEffects: { keys: rendered.keys, settleNative: project.settleNative }, io, project: activated });
            const handle = handles[0];
            if (!handle) throw new Error('Expected a mounted service generation');
            const clients: Array<{ params: PtySpawnParams; events: EventEmitter; writes: string[]; pid: number; exited: boolean }> = [];
            const spawn = vi.spyOn(ptyBoundary, 'createNodePtyProvider').mockReturnValue({ spawn(params) {
                const client = { params, events: new EventEmitter(), writes: [] as string[], pid: 52_000 + clients.length, exited: false };
                client.events.on('exit', () => { client.exited = true; });
                clients.push(client);
                const pty: PtyProcess = { pid: client.pid,
                    write(data) { client.writes.push(data); }, resize() {}, kill() {},
                    onData(listener) { client.events.on('data', listener); return { dispose() { client.events.off('data', listener); } }; },
                    onExit(listener) { client.events.on('exit', listener); return { dispose() { client.events.off('exit', listener); } }; },
                };
                return pty;
            } });
            onTestFinished(() => { spawn.mockRestore(); });
            // Only PTY/process OS boundaries are substituted. Installed registration,
            // identity, native selection, runner, terminal custody and rings stay real.
            const terminateProcessTree = terminationBoundary.terminateProcessTree;
            const stop = vi.spyOn(terminationBoundary, 'terminateProcessTree').mockImplementation(async (target, options) => {
                const client = clients.find(value => value.pid === target.pid);
                if (!client) return await terminateProcessTree(target, options);
                client.events.emit('exit', { exitCode: 0 });
            });
            onTestFinished(() => { stop.mockRestore(); });
            let operationSequence = 0;
            const operations = createHostActionOperationRuntime({ serverId: 'finite-home', machineId: source.machineId,
                custodyBinding: { serverId: 'finite-home', installationId: source.installationId },
                resolveAccountId: async () => 'finite-owner', generateOperationId: () => `shell-operation-${++operationSequence}` });
            let current = true;
            const installationKeys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
            const home = 'https://finite-home.invalid';
            const originalPost = axios.post;
            let admissionVerifications = 0;
            // Home HTTP is the sole admission substitute. The installed requester
            // authorizer, actual installation proof, schema and identity selector
            // all run; an allow-all domain authorizer would bypass this contract.
            const homeHttp = vi.spyOn(axios, 'post').mockImplementation(async (url, raw, options) => {
                if (url !== `${home}/v1/machines/${source.machineId}/admission/verify`) return originalPost(url, raw, options);
                admissionVerifications += 1;
                const packet: unknown = raw;
                if (!packet || typeof packet !== 'object') throw new Error('Expected the actual Machine admission request');
                const context = SocketRpcMachineAdmissionContextV1Schema.parse(Reflect.get(packet, 'context'));
                const proof = MachineInstallationProofV1Schema.parse(Reflect.get(packet, 'proof'));
                const admittedMethod: unknown = Reflect.get(packet, 'method');
                if (typeof admittedMethod !== 'string') throw new Error('Expected the signed Machine method');
                expect(context.machineId).toBe(source.machineId);
                expect(context.installationId).toBe(source.installationId);
                expect(context.custodianAccountId).toBe('finite-owner');
                expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: source.machineId,
                    installationId: source.installationId, accountId: 'finite-owner', rpcAdmission: { context, method: admittedMethod } },
                    proof, publicKey: installationKeys.publicKey })).toBe(true);
                return { status: current ? 200 : 403, data: { v: 1, ok: true } };
            });
            onTestFinished(() => { homeHttp.mockRestore(); });
            const admissionBoundary = { machineId: source.machineId,
                resolveHomeServerIdentityId: async () => 'finite-home', resolveCustodianAccountId: async () => 'finite-owner',
                resolveInstallationId: () => source.installationId,
                verifyMachineAdmission: ({ context, method: admittedMethod, signal }) => verifyMachineRpcAdmissionCurrent({
                    context, method: admittedMethod, privateKey: installationKeys.secretKey,
                    daemonToken: 'finite-daemon-fixture', serverHttpBaseUrl: home, ...(signal ? { signal } : {}) }),
            } satisfies MachineRpcAdmissionBoundary;
            const rpc = new RpcHandlerManager({ scopePrefix: source.machineId, localMachineId: source.machineId, encryptionMode: 'plain',
                authorizeRequest: request => authorizeMachineRpcRequest(request, admissionBoundary) });
            phase = 'registration';
            const registration = registerMachineRpcHandlers({ rpcHandlerManager: rpc,
                handlers: { spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Not installed' }),
                    stopSession: async () => true, requestShutdown() {} },
                deps: { currentServerId: 'finite-home', currentMachineId: source.machineId, workingDirectory: root,
                    resolveHostHomeServerIdentityId: async () => 'finite-home', actionOperations: operations },
            });
            const machineAdmission = { actorAccountId: 'finite-owner', custodianAccountId: 'finite-owner', machineId: source.machineId,
                installationId: source.installationId, role: 'manage' as const, encryptionMode: 'plain' as const };
            const owner = { callerAuthority: 'present_user' as const,
                machineAdmission, verifyMachineAdmissionCurrent: () => admissionBoundary.verifyMachineAdmission({
                    context: machineAdmission, method: `${source.machineId}:${method}` }) };
            const request = { terminalKey: 'service-shell', launch: {
                kind: 'service_shell' as const, serviceId: handle.serviceId, expectedGeneration: handle.instanceId } };
            const scope = { accountId: 'finite-owner', machineId: source.machineId };
            try {
                // Ordinary terminals neither acquire a shell-operation receipt nor
                // wait for their interactive process to end.
                phase = 'ordinary-terminal';
                const ordinary = DaemonTerminalEnsureResponseSchema.parse(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
                    { terminalKey: 'ordinary-machine-shell', cwd: root }, { rpcContext: owner }));
                expect(ordinary).toMatchObject({ ok: true, reused: false });
                expect(operations.store.list(scope).items).toEqual([]);
                if (!ordinary.ok) throw new Error('Expected ordinary terminal');
                await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_CLOSE, { terminalId: ordinary.terminalId }, { rpcContext: owner });
                clients.length = 0;
                await expect(rpc.invokeLocal(method, request, { rpcContext: { ...owner, callerAuthority: 'account_automation' } }))
                    .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
                expect(await rpc.invokeLocal(method, request, { rpcContext: { ...owner,
                    machineAdmission: { ...owner.machineAdmission, actorAccountId: 'member', role: 'use' } } }))
                    .toMatchObject({ ok: false, errorCode: 'terminal_unavailable', error: 'agent_isolation_unavailable' });
                expect(clients).toEqual([]);
                expect(await rpc.invokeLocal(method, request, { rpcContext: { ...owner,
                    machineAdmission: { ...owner.machineAdmission, role: 'use' } } })).toMatchObject({ ok: false });
                for (const extra of [{ cwd: root }, { initialCommand: 'docker compose exec foreign sh' },
                    { launch: { ...request.launch, target: { kind: 'candidate', deploymentId: 'candidate-b' } } }]) {
                    expect(await rpc.invokeLocal(method, { ...request, ...extra }, { rpcContext: owner }))
                        .toMatchObject({ ok: false, errorCode: 'terminal_invalid_request' });
                }
                const replaced = await rpc.invokeLocal(method, { ...request, launch: { ...request.launch, expectedGeneration: 'replaced-generation' } },
                    { rpcContext: owner });
                expect.soft(replaced, JSON.stringify({ response: replaced, operations: operations.store.list(scope).items.map(item => ({
                    state: item.state, errorCode: item.error?.errorCode,
                })) })).toMatchObject({ ok: false, errorCode: 'service_generation_changed' });
                expect(clients).toEqual([]);
                phase = 'owner-open';
                const verificationsBeforeOpen = admissionVerifications;
                const opened = DaemonTerminalEnsureResponseSchema.parse(await rpc.invokeLocal(method, request, { rpcContext: owner }));
                expect(opened, JSON.stringify({ response: opened, operations: operations.store.list(scope).items.map(item => ({
                    state: item.state, errorCode: item.error?.errorCode,
                })) })).toMatchObject({ ok: true, reused: false });
                if (!opened.ok) throw new Error('Expected admitted owner terminal');
                expect(admissionVerifications - verificationsBeforeOpen,
                    'the shell admits its caller once before native selection').toBe(1);
                expect(clients).toHaveLength(1);
                expect(clients[0].params.args.slice(-4)).toEqual(['exec', '-it', 'worker', '/bin/sh']);
                expect(clients[0].params.options.cwd).toBe(source.rootPath);
                expect(clients[0].params.options.env?.DOCKER_HOST).toBe('unix:///admitted-finite-engine.sock');
                expect(clients[0].params.options.env?.UNREVIEWED).toBe('unreviewed-value');
                expect(clients[0].params.args[clients[0].params.args.indexOf('--project-name') + 1]).toBe(rendered.projectName);
                expect(clients[0].params.options.env).not.toHaveProperty('TOKEN');
                const liveOperation = operations.store.list(scope).items.find(operation => operation.state === 'running');
                expect(liveOperation).toBeDefined();
                expect(opened).toMatchObject({ operation: { serverId: 'finite-home', machineId: source.machineId,
                    operationId: liveOperation!.operationId } });
                await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'shell-conflict', kind: 'deploy' },
                    keys: rendered.keys }, async () => undefined)).rejects.toMatchObject({ code: 'effect_in_progress',
                    actionOperationId: liveOperation!.operationId });
                expect(await rpc.invokeLocal(method, { ...request, terminalKey: 'competing-service-shell' }, { rpcContext: owner }))
                    .toMatchObject({ ok: false, errorCode: 'effect_in_progress', details: { actionOperationId: liveOperation!.operationId } });
                // Reconnect uses the same retained terminal id and emits no launch.
                phase = 'interactive-input';
                clients[0].events.emit('data', 'service-output');
                expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
                    { terminalId: opened.terminalId, cursor: 0 }, { rpcContext: owner })).toMatchObject({ ok: true,
                    events: [expect.objectContaining({ data: 'service-output' })] });
                expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_INPUT,
                    { terminalId: opened.terminalId, data: 'echo owner\n' }, { rpcContext: owner })).toMatchObject({ ok: true });
                expect(clients[0].writes).toEqual(['echo owner\n']);
                expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
                    { terminalId: opened.terminalId, cursor: 0 }, { rpcContext: { ...owner,
                        machineAdmission: { ...owner.machineAdmission, actorAccountId: 'member' } } }))
                    .toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
                current = false;
                expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_INPUT,
                    { terminalId: opened.terminalId, data: 'forbidden\n' }, { rpcContext: owner }))
                    .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
                expect(clients[0].writes).toEqual(['echo owner\n']);
                current = true;
                expect(clients).toHaveLength(1);
                // This is the real client's observed exit. The admitted app
                // remains running; 16:20Z accepts intentional detach as settlement.
                clients[0].events.emit('exit', { exitCode: 0 });
                phase = 'client-exit-settlement';
                const settled = await operations.runner.waitForTerminal(scope, liveOperation!.operationId);
                expect(settled).toMatchObject({ state: 'succeeded', result: { ok: true, terminalId: opened.terminalId,
                    sessionEnded: true, clientExit: { exitCode: 0, signal: null } } });
                expect(settled?.result).not.toHaveProperty('processExited');
                await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'after-terminal-session-ended', kind: 'deploy' },
                    keys: rendered.keys }, async () => undefined)).resolves.toBeUndefined();
                expect(await handle.inspectCurrentOccurrence()).toMatchObject({ nativePhase: 'running' });
                phase = 'explicit-close';
                const closeable = DaemonTerminalEnsureResponseSchema.parse(await rpc.invokeLocal(method,
                    { ...request, terminalKey: 'service-shell-close' }, { rpcContext: owner }));
                expect(closeable).toMatchObject({ ok: true });
                if (!closeable.ok) throw new Error('Expected a closeable owner shell');
                const closeOperation = operations.store.list(scope).items.find(operation => operation.state === 'running');
                if (!closeOperation) throw new Error('Expected the closeable shell operation');
                expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_CLOSE,
                    { terminalId: closeable.terminalId }, { rpcContext: owner })).toMatchObject({ ok: true });
                expect(await operations.runner.waitForTerminal(scope, closeOperation.operationId))
                    .toMatchObject({ state: 'succeeded', result: { sessionEnded: true } });
                // Manage grants full control of this Machine, including a new
                // shell. They do not disclose somebody else's retained terminal.
                phase = 'manager-own-shell';
                const manager = { ...owner, machineAdmission: { ...machineAdmission, actorAccountId: 'member' } };
                const managed = DaemonTerminalEnsureResponseSchema.parse(await rpc.invokeLocal(method,
                    { ...request, terminalKey: 'manager-service-shell' }, { rpcContext: manager }));
                expect(managed).toMatchObject({ ok: true });
                if (!managed.ok) throw new Error('Expected a Manage member shell');
                const managerScope = { ...scope, accountId: 'member' };
                const managerOperation = operations.store.list(managerScope).items.find(operation => operation.state === 'running');
                if (!managerOperation) throw new Error('Expected the Manage member shell operation');
                expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
                    { terminalId: managed.terminalId, cursor: 0 }, { rpcContext: owner }))
                    .toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
                expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_CLOSE,
                    { terminalId: managed.terminalId }, { rpcContext: manager })).toMatchObject({ ok: true });
                expect(await operations.runner.waitForTerminal(managerScope, managerOperation.operationId))
                    .toMatchObject({ state: 'succeeded', result: { sessionEnded: true } });
                phase = 'unknown-local-custody';
                const unknown = DaemonTerminalEnsureResponseSchema.parse(await rpc.invokeLocal(method,
                    { ...request, terminalKey: 'service-shell-lost-local-custody' }, { rpcContext: owner }));
                expect(unknown).toMatchObject({ ok: true });
                if (!unknown.ok) throw new Error('Expected a second admitted owner terminal');
                const unknownOperation = operations.store.list(scope).items.find(operation => operation.state === 'running');
                if (!unknownOperation) throw new Error('Expected the second live operation');
                const lostClient = clients.at(-1)!;
                // Real terminal-owner disposal removes local exit custody; no
                // fabricated callback result can classify this as client exit.
                registration.getFiniteTerminalSessions().dispose();
                await vi.waitFor(() => expect(operations.store.get(scope, unknownOperation.operationId))
                    .toMatchObject({ state: 'running', observation: { kind: 'outcome_uncertain', code: 'indeterminate' } }));
                expect(lostClient.exited).toBe(false);
                await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'unconfirmed-terminal-conflict', kind: 'deploy' },
                    keys: rendered.keys }, async () => undefined)).rejects.toMatchObject({ code: 'effect_in_progress',
                    actionOperationId: unknownOperation.operationId });
                // Cleanup feeds an actual exit of this original OS-boundary
                // client to the existing unknown-effect reconciliation seam.
                // This adds no production exit detector or native predicate.
                lostClient.events.emit('exit', { exitCode: 0 });
                await machineNativeEffectAdmission.reconcileUnknown({ keys: rendered.keys,
                    observeSettled: async operation => operation.operationId === unknownOperation.operationId && lostClient.exited });
            } finally {
                phase = 'registration-cleanup';
                for (const client of clients) client.events.emit('exit', { exitCode: 0 });
                await registration.dispose();
                spawn.mockRestore(); stop.mockRestore(); homeHttp.mockRestore();
                for (const service of handles) await service.dispose();
                await activated.dispose(); await lease.release();
            }
            phase = 'fixture-cleanup';
        });
    });
    it.each(['bound', 'absent', 'withdrawn'] as const)('keeps a migration connection override inside its candidate service: %s', async direct => {
        let phase = 'fixture';
        onTestFinished(() => { console.info('[C-P30 migration connection phase]', { direct, phase }); });
        const pooled = 'pooled-command-fixture-value';
        const directValue = 'direct-command-fixture-value';
        await withFiniteComposeFixture(async ({ project, docker, source, exec, envPort }) => {
            phase = 'render';
            if (direct === 'withdrawn') {
                await expect(project.render()).rejects.toMatchObject({ code: 'secret_missing' });
                expect((await docker.readInvocations()).some(row => row.args.includes('run'))).toBe(false);
                return;
            }
            const owner = finiteOwner(project);
            const rendered = await owner.render({ purpose: 'serviceCommand', service: 'worker' });
            await docker.setCommandOutcome({ environmentKey: 'DATABASE_URL', exitCode: 0,
                expectedServiceValues: { environment: { DATABASE_URL: direct === 'bound' ? directValue : pooled },
                    absentEnvironmentKeys: ['LABEL_ONLY', 'UNUSED_RUNTIME'],
                    labels: { 'fixture.connection-reference': pooled, 'fixture.label-only': 'label-only-binding-value' } } });
            await machineNativeEffectAdmission.run({ operation: { operationId: 'migration-connection-command', kind: 'deploy' },
                keys: rendered.keys, settleNative: project.settleNative }, async context => {
                phase = 'prepare';
                await owner.prepare?.({ render: rendered, context });
                phase = 'admit';
                const command = await owner.admit?.({ render: rendered, context, service: 'worker',
                    command: { mode: 'run', argv: ['migrate'] },
                    ...(direct === 'bound' ? { environmentOverrides: { DATABASE_URL: '${DIRECT_URL}' } } : {}) });
                phase = 'execute';
                const result = command ? await owner.execute?.(command) : undefined;
                expect(result).toMatchObject({ kind: 'completed', exitCode: 0,
                    stdout: JSON.stringify({ environmentMatchesExpected: true, labelsMatchExpected: true }) + '[REDACTED]' });
            });
            const finite = (await docker.readInvocations()).filter(row => row.args.includes('run'));
            expect(finite).toHaveLength(1);
            expect(finite[0].files.filter(file => file.path === '-').map(file => file.content))
                .toEqual(['[private native stdin omitted]']);
            expect(finite[0].args.join(' ')).not.toContain(pooled);
            expect(finite[0].args.join(' ')).not.toContain(directValue);
            phase = 'ordinary-attachment';
            const attachment = await envPort.prepare({ source, phase: 'runtime' });
            const tool = await exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose', cwd: source.rootPath });
            phase = 'ordinary-authorize';
            const ordinary = await authorizePluginExecLaunchForHost(exec, { executable: tool.executable,
                cwd: source.rootPath, args: ['version'], deploymentEnv: attachment });
            try {
                phase = 'ordinary-environment';
                expect(ordinary.env.DATABASE_URL).toBe(pooled);
                expect(ordinary.env.DIRECT_URL).toBe(direct === 'bound' ? directValue : undefined);
            } finally { await ordinary.release(); }
            phase = 'fixture-cleanup';
        }, { runtimeSecrets: { DATABASE_URL: pooled, LABEL_ONLY: 'label-only-binding-value', UNUSED_RUNTIME: 'unused-binding-value',
                ...(direct === 'absent' ? {} : { DIRECT_URL: directValue }) },
            serviceEnvironment: { DATABASE_URL: '${DATABASE_URL}', ...(direct === 'absent' ? {} : { DIRECT_URL: '${DIRECT_URL}' }) },
            serviceLabels: { 'fixture.connection-reference': '${DATABASE_URL}', 'fixture.label-only': '${LABEL_ONLY}' },
            ...(direct === 'withdrawn' ? { withdrawnResourceIds: ['finite-direct_url'] } : {}) });
    });

    it('keeps the admitted Docker endpoint when an ordinary runtime binding is named DOCKER_HOST', async () => {
        await withFiniteComposeFixture(async ({ project, docker }) => {
            // This reaches the current source/phase/Exec wiring without
            // depending on the candidate command factory.
            await project.render();
            const invocations = await docker.readInvocations();
            expect(invocations.length).toBeGreaterThan(0);
            expect(invocations.every(row => row.dockerHostMatchesExpected === true)).toBe(true);
        }, { applicationDockerHost: 'application-docker-host-value' });
    });

    it('keeps runtime bindings out of the prebuilt image planning Compose process', async () => {
        await withFiniteComposeFixture(async ({ project, docker }) => {
            // Runtime discovery uses the local image. Builder-only planOnly
            // would instead demand registry authority before this assertion.
            const images = await project.prepareImages({ platforms: ['linux/amd64'] });
            expect(images).toHaveLength(1);
            const config = (await docker.readInvocations()).filter(row => row.args.includes('config'));
            expect(config.length).toBeGreaterThan(1);
            expect(config.every(row => !row.environmentKeys.includes('TOKEN'))).toBe(true);
        }, { recordedImages: false });
    });

    it('runs the pinned first-deploy candidate once with literal argv, trusted host environment and P42 redaction', async () => {
        await withFiniteComposeFixture(async ({ project, docker }) => {
            const rendered = await project.render({ purpose: 'serviceCommand', service: 'worker' });
            const owner = finiteOwner(project);
            const argv = ['print', '$HOME', 'semi;colon', '--service-ports', 'line\nbreak'];
            await docker.setCommandOutcome({ environmentKey: 'TOKEN', stdout: ' ordinary output', stderr: 'command stderr', exitCode: 7 });
            await machineNativeEffectAdmission.run({ operation: { operationId: 'first-candidate-command', kind: 'deploy' },
                keys: rendered.keys, settleNative: project.settleNative }, async context => {
                await owner.prepare?.({ render: rendered, context });
                const command = await owner.admit?.({ render: rendered, context, service: 'worker', command: { mode: 'run', argv } });
                const result = command ? await owner.execute?.(command) : undefined;
                expect(result).toEqual({ kind: 'completed', exitCode: 7, stdout: '[REDACTED] ordinary output', stderr: 'command stderr',
                    stdoutTruncated: false, stderrTruncated: false });
            });
            const invocations = await docker.readInvocations();
            const finite = invocations.filter(row => row.args.includes('run'));
            expect(finite).toHaveLength(1);
            expect(finite[0].args.slice(finite[0].args.indexOf('run'))).toEqual([
                'run', '--rm', '-T', '--no-build', '--pull', 'never', '--no-deps', 'worker', ...argv]);
            // The host's ordinary environment is supported. The admitted
            // explicit project operand, not ambient COMPOSE_PROJECT_NAME,
            // selects the candidate's native project.
            expect(finite[0].args[finite[0].args.indexOf('--project-name') + 1]).toBe(rendered.projectName);
            expect(finite[0].environmentKeys).toContain('UNREVIEWED');
            expect(finite[0].dockerHostMatchesExpected).toBe(true);
            expect(invocations.filter(row => row.args.includes('up') || row.args.includes('build') || row.args.includes('pull'))).toEqual([]);
        });
    });
});

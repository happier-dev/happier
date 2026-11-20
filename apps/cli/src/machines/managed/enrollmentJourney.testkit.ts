import { guestCliExecutable } from './enrollmentPayload.testkit';
import packageJson from '../../../package.json';
import { machineProvisionerAuthorFixture } from '../../../../../packages/plugin-sdk/fixtures/authoring-inference/machineProvisioners';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { TargetActionInvocationRegistration } from '@/plugins/runtime/invocation/targetActionRegistry';
import { isRecord } from '@happier-dev/protocol/common/records';
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual, promisify } from 'node:util';
import { expect, onTestFinished, vi } from 'vitest';
import { machineSetup } from '@happier-dev/cli-common';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import type { ActionExecutorDeps, ActionExecuteResult, JsonValue } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestPublicSettlementSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { createDaemonManagedMachineActionAdapter } from '@/daemon/startup/managedMachineActionAdapter';
import type { RecordedApprovalExecutionObservationArgs } from '@/session/actions/createCliActionExecutorHarness';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner, createActiveAccountSettingsConnectedAccountPurposeBindingStore } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { fixture as nativeFixture, roles, roleActionId } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { MachineEffectInternalRequestSchema } from '@/machines/setup/effectInternalProtocol';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import { decodeStoredCredentials, encodeStoredCredentials } from '@/persistence';
import { updateSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { buildManagedSudoersSteps, MANAGED_SUDOERS_PATH } from '@/machines/adminAccess/managedSudoers';
import type { MachineAdminAccessNativeDependencies } from '@/machines/adminAccess/observeMachineAdminAccess';

import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import type { AgentIsolationReadinessSystem } from '@/daemon/agentIsolation/agentIsolationReadiness';

/** Process/OS substitute beneath the real finite native qualification owner. */
export function createEnrollmentJourneyIsolationReadinessSystem(agentUid: number): AgentIsolationReadinessSystem { return { run: async (command, args, options) => {
    if (command === 'getent') return { stdout: args.includes('group')
        ? args.at(-1) === 'happier-agent' ? 'happier-agent:x:988:\n' : 'happier-workspace:x:1001:happier,happier-agent\n'
        : `happier-agent:x:${agentUid}:988::/var/lib/happier-agent:/usr/sbin/nologin\n`, stderr: '' };
    expect(command).toBe('sudo');
    expect(args.slice(0, 5)).toEqual(['-n', '-u', 'happier-agent', '--', '/opt/happier/cli/current/happier']);
    const frame = await readAgentLaunchFrame(Readable.from([options!.inputBytes!], { objectMode: false }));
    expect(frame.executable).toBe('/bin/sh');
    execFileSync('/bin/sh', ['-n', '-c', frame.args[1]!]);
    const headers = frame.selectedMaterials.find(file => file.relativePath === 'files/headers');
    const challenge = frame.selectedMaterials.find(file => file.relativePath === 'files/challenge');
    if (!headers || !challenge) throw new Error('The readiness producer must frame its native challenge');
    const authorization = Buffer.from(headers.contentBase64, 'base64').toString('utf8').trim().slice('Authorization: '.length);
    for (const auth of [authorization, undefined]) await new Promise<void>((resolve, reject) => {
        const request = httpRequest({ socketPath: frame.args[7]!, path: '/readiness',
            ...(auth ? { headers: { authorization: auth } } : {}) }, response => {
            expect(response.statusCode).toBe(auth ? 200 : 401);
            response.resume(); response.once('end', resolve);
        });
        request.once('error', reject); request.end();
    });
    const privateCount = Number(frame.args[9]);
    for (const path of frame.args.slice(10 + privateCount)) {
        await appendFile(join(path, 'daemon'), 'agent');
        await writeFile(join(path, 'agent'), 'agent');
    }
    return { stdout: Buffer.from(challenge.contentBase64, 'base64'), stderr: '' };
} }; }

export type EnrollmentJourneyNativeBoundary = Readonly<{
    backend: machineSetup.MachineSetupBackend;
    admin: MachineAdminAccessNativeDependencies;
}>;

export function createEnrollmentJourneyProviderAuthority(materializationBaseDir: string) {
    const noProviderCredential = async (): Promise<never> => { throw new Error('This native guest has no provider account credential'); };
    return createManagedProviderOperationAuthority({ materializationBaseDir,
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({ store: createActiveAccountSettingsConnectedAccountPurposeBindingStore(),
            selectTarget: noProviderCredential, resolveTarget: noProviderCredential, materializeAccount: noProviderCredential,
            projectTargetAccounts: noProviderCredential, assertTargetAccountMaterializable: noProviderCredential }),
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 0,
        createRedactionLease: () => ({ add() {}, close() {} }) });
}

type Home = Readonly<{
    baseDir: string; baseUrl: string; serverId: string; accountId: string; machineId: string; installationId: string;
    token: string; daemonToken?: string; keys: Readonly<{ publicKey: Uint8Array; secretKey: Uint8Array }>;
    machineEncryptionKey: Uint8Array | null;
    encryption: Readonly<{ type: 'dataKey'; machineKey: Uint8Array; publicKey: Uint8Array }> | null;
    prepareControllerProvisioner(manifest: unknown): Promise<void>;
}>;
type NativeFixtureOptions = NonNullable<Parameters<typeof nativeFixture>[0]>;
type NativeRoleExecution = NonNullable<NativeFixtureOptions['onNativeRole']>;

/** The only substituted system is the provisioner's native guest/process boundary. */
export async function acquireEnrollmentJourneyGuest<T extends Home>(controller: T, ports: Readonly<{
    requester?: Pick<Home, 'accountId' | 'token' | 'encryption'>;
    runRequesterAction?(id: 'action.operations.get' | 'machines.managed.bootstrap.respond', input: Record<string, unknown>): Promise<unknown>;
    acquireInput?: ReturnType<typeof ManagedAcquireInputV1Schema.parse>;
    /** The provisioner and guest OS are the external boundary, never Home admission. */
    native?: Readonly<{
        manifest?: NativeFixtureOptions['fixtureManifest'];
        /** Use the public SDK author's actual activation and handlers. */
        publicAuthor?: boolean;
        payloadRoot?: string | null;
        execute?(role: Parameters<NativeRoleExecution>[0],
            input: JsonValue | undefined, context: Parameters<NativeRoleExecution>[2],
            next: () => Promise<void>): Promise<JsonValue | void>;
    }>;
    onSettled?(operation: ActionOperationSnapshotV1): void;
    /** Proves the person's single creation confirmation covers guest policy effects. */
    confirmWholeOperation?: boolean;
    startGuest(guest: T, native: EnrollmentJourneyNativeBoundary): Promise<void>;
    startController(action: NonNullable<ActionExecutorDeps['managedMachineAction']>): Promise<Readonly<{
        actionOperations: ReturnType<typeof createHostActionOperationRuntime>;
        observeRecordedApprovalExecution: ReturnType<typeof createCliActionExecutorFromCredentials>['observeRecordedApprovalExecution'];
        close(): Promise<void>;
    }>>;
}>): Promise<T> {
    const requester = ports.requester ?? controller;
    const directory = ports.acquireInput
        ? await mkdtemp(join(controller.baseDir, 'enrollment-guest-')) : join(controller.baseDir, 'enrollment-guest');
    const guestHome = join(directory, 'home');
    const payload = join(directory, 'payload');
    const resultPath = join(directory, 'enrolled.json');
    await mkdir(guestHome, { recursive: true });
    await mkdir(payload);
    await writeFile(join(payload, 'happier'), ports.native?.publicAuthor
        ? guestCliExecutable(`if [ "$1" = "--version" ]; then printf '%s\\n' '${packageJson.version}'; else printf 'public-author-installed\\n'; fi\n`)
        : '#!/bin/sh\nexit 0\n');
    if (ports.native?.publicAuthor) await writeFile(join(payload, 'author-module.js'), 'export const authorPayload = true;\n');
    vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', ports.native?.payloadRoot === null ? undefined : ports.native?.payloadRoot ?? payload);
    if (!requester.encryption) throw new Error('The enrollment journey requires its requester E2EE credential');
    const descriptor = { v: 1 as const, homeServerIdentityId: controller.serverId,
        canonicalServerUrl: controller.baseUrl, revision: 1, endpoints: [{ kind: 'https' as const, url: controller.baseUrl }] };
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
        [configuration.activeServerId]: { ...settings.servers?.[configuration.activeServerId], id: configuration.activeServerId,
            name: 'S0 Home', serverUrl: controller.baseUrl, webappUrl: controller.baseUrl,
            homeConnectionDescriptor: descriptor, createdAt: 1, updatedAt: 1, lastUsedAt: 1 } },
        machineIdByServerIdByAccountId: { ...settings.machineIdByServerIdByAccountId,
            [configuration.activeServerId]: { [controller.accountId]: controller.machineId } },
        lastTokenSubByServerId: { ...settings.lastTokenSubByServerId, [configuration.activeServerId]: controller.accountId },
    }));
    const credentials = decodeStoredCredentials(encodeStoredCredentials({ token: requester.token, encryption: requester.encryption }));
    const controllerCredentials = decodeStoredCredentials(encodeStoredCredentials({ token: controller.token, encryption: controller.encryption }));
    if (!credentials) throw new Error('The S0 controller requires its real stored credential');
    const target = resolveHomeTargetFromDescriptor({ descriptor, authority: 'trusted_enrollment' });
    const providerAuthority = createEnrollmentJourneyProviderAuthority(directory);
    const guestModule = fileURLToPath(new URL('./enrollmentGuest.testkit.ts', import.meta.url));
    const sourceRuntime = fileURLToPath(new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url));
    const guestEntry = join(directory, 'guest.mjs');
    const commandComplete = 'S0_ENROLLMENT_COMMAND_COMPLETE';
    await writeFile(guestEntry, `import { createInterface } from 'node:readline';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { runEnrollmentGuestBoundary } from ${JSON.stringify(guestModule)};
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
    const frame = JSON.parse(line);
    try {
        await runEnrollmentGuestBoundary(frame.command, frame.args, process.argv[2], process.argv[3], frame.input);
        process.stdout.write(${JSON.stringify(commandComplete + '\n')});
    } catch (error) {
        process.stderr.write(JSON.stringify({ name: error?.name, code: error?.code,
            frames: error?.stack?.split('\\n').slice(1, 4) }) + '\\n');
        process.exitCode = 1; break;
    }
}
lines.close(); process.stdin.destroy();\n`);
    const observed: { guest?: T; guestControlReady?: boolean; terminal?: ActionOperationSnapshotV1; nativePhase?: string;
        operation?: Readonly<{ state: string; phase?: string; prompt?: string }>; guestFailure?: string } = {};
    const lifetime = new AbortController();
    let guestProcess: ChildProcessWithoutNullStreams | undefined;
    let guestExited: Promise<void> | undefined;
    let pendingCommand: Readonly<{ lines: string[]; resolve(stdout: string): void; reject(error: Error): void }> | undefined;
    const runGuestCommand = async (command: 'request' | 'wait', args: string[], input: string, signal: AbortSignal): Promise<string> => {
        if (!guestProcess) {
            // One source guest keeps its loaded graph across the two real CLI
            // commands. Measured cold import alone took 156.9s on nl3.
            const child = guestProcess = spawn(process.execPath, ['--conditions=happier-source', '--import', sourceRuntime,
                guestEntry, resultPath, controller.baseUrl], {
                signal: lifetime.signal, cwd: resolve(dirname(guestModule), '../../..'), env: { ...process.env, HOME: guestHome, HAPPIER_HOME_DIR: guestHome,
                    HAPPIER_SERVER_URL: controller.baseUrl, HAPPIER_WEBAPP_URL: controller.baseUrl,
                    TSX_TSCONFIG_PATH: resolve(dirname(guestModule), '../../../tsconfig.json') },
            });
            const lines = createInterface({ input: child.stdout });
            lines.on('line', line => {
                if (line === commandComplete) {
                    const current = pendingCommand; pendingCommand = undefined;
                    if (current) current.resolve(current.lines.join('\n') + '\n');
                } else pendingCommand?.lines.push(line);
            });
            child.stderr.on('data', chunk => { observed.guestFailure = String(chunk).trim(); });
            child.stdin.on('error', () => {});
            child.on('error', error => pendingCommand?.reject(new Error(`Guest process failed: ${error.name}`)));
            guestExited = new Promise(resolve => child.once('close', code => {
                lines.close();
                pendingCommand?.reject(new Error(`Guest process exited: ${code}; ${observed.guestFailure ?? ''}`));
                pendingCommand = undefined; resolve();
            }));
        }
        const child = guestProcess;
        const abort = () => { child.kill('SIGTERM'); };
        signal.throwIfAborted();
        signal.addEventListener('abort', abort, { once: true });
        try {
            return await new Promise<string>((resolve, reject) => {
                if (pendingCommand) { reject(new Error('Guest commands must remain serial')); return; }
                pendingCommand = { lines: [], resolve, reject };
                child.stdin.write(JSON.stringify({ command, args, input }) + '\n');
            });
        } finally { signal.removeEventListener('abort', abort); }
    };
    let publicKey = '';
    const rootSteps: string[] = [];
    const installed = new Set<string>();
    const files = new Map<string, Extract<machineSetup.MachineRecipeStepV1, { kind: 'file' }>>();
    const groups = new Map<string, readonly string[]>();
    const backend: machineSetup.MachineSetupBackend = {
        async observe(step) { return { stepId: step.id, status: installed.has(step.id) ? 'satisfied' : 'drifted', facts: {} }; },
        async apply(step) { rootSteps.push(step.id); installed.add(step.id);
            if (step.kind === 'file') files.set(step.path, step);
            if (step.kind === 'group') groups.set(step.name, step.members ?? []);
        },
    };
    const expectedGrant = buildManagedSudoersSteps({ daemonUsername: 'happier', previousPolicy: { version: 1, mode: 'none' }, policy: { version: 1, mode: 'preauthorized' } })[0];
    if (!expectedGrant) throw new Error('The canonical Preauthorized producer must provide its managed grant');
    const grantPresent = () => {
        const file = files.get(MANAGED_SUDOERS_PATH);
        return !!file && file.state !== 'absent' && file.owner === expectedGrant.owner && file.group === expectedGrant.group
            && file.mode === expectedGrant.mode && isDeepStrictEqual(file.content, expectedGrant.content);
    };
    const absent = () => Object.assign(new Error('Virtual guest OS path is absent'), { code: 'ENOENT' });
    const guestNative: EnrollmentJourneyNativeBoundary = { backend, admin: { platform: 'linux',
        execFile: async (file, args) => {
            if (file === 'sudo' && !grantPresent()) throw Object.assign(new Error('Virtual guest sudo denied'), { code: 1 });
            return { stdout: file === 'id' ? args[0] === '-u' ? '1001' : args[0] === '-un' || args[0] === '-gn' ? 'happier'
                : ['happier', ...[...groups].filter(([, members]) => members.includes('happier')).map(([name]) => name)].join(' ') : '' };
        },
        fileSystem: {
            lstat: async path => { const file = files.get(path); if (!file || file.state === 'absent') throw absent();
                return { uid: file.owner === 'root' ? 0 : 1001, gid: file.group === 'root' ? 0 : 1001,
                    mode: file.mode ?? 0, isFile: () => true, isSymbolicLink: () => false }; },
            readFile: async path => { const file = files.get(path); if (!file || !file.content || file.content.kind !== 'literal') throw absent(); return file.content.value; },
        },
    } };
    const nativeResults: NonNullable<NativeFixtureOptions['nativeRoleResults']> = {};
    const executeNativeRole: NativeRoleExecution = async (role, body, context) => {
            observed.nativePhase = role;
            if (role === 'putFile' && ports.native?.publicAuthor) {
                if (!isRecord(body) || typeof body.guestPath !== 'string' || typeof body.bytesBase64 !== 'string') throw new Error('Missing native payload');
                await mkdir(dirname(body.guestPath), { recursive: true });
                await writeFile(body.guestPath, Buffer.from(body.bytesBase64, 'base64'));
            }
            if (role !== 'exec') return;
            if (!isRecord(body) || !Array.isArray(body.argv)) throw new Error('Missing native guest command');
            const command = body.argv[2];
            if (typeof command !== 'string') throw new Error('Invalid native guest command');
            observed.nativePhase = command.includes('effect-internal') ? 'bootstrap-effects'
                : /\bauth\b/u.test(command) ? /\brequest\b/u.test(command) ? 'guest-auth-request' : /\bwait\b/u.test(command) ? 'guest-auth-wait' : 'guest-auth-status'
                : command.includes('version_path') ? 'installer-inventory' : 'guest-os';
            const stdin = typeof body.inputBase64 === 'string' ? Buffer.from(body.inputBase64, 'base64').toString() : '';
            if (command.includes('sudo -n -u root -- true') && !grantPresent()) throw new Error('Bootstrap did not install its reviewed grant');
            let stdout = '';
            if (command.includes('uname -s')) stdout = command.includes('uname -m') ? `Linux\nx86_64\n${guestHome}\n` : 'Linux\n';
            else if (command.includes('/etc/os-release')) stdout = 'ubuntu\nnoble\namd64\n';
            else if (command === 'id -u happier') stdout = '1001\n';
            else if (ports.native?.publicAuthor && (command.includes('managed_guest_cli_absent') || command.includes('mkdir -p')
                || command.startsWith('umask 077;') || command.startsWith('cat -- ') || command.startsWith('mv -- ')
                || command.includes('mktemp') || command.includes('version_path')
                || command.includes('tar ') || command.includes('__install-payload') || command.includes('rm -'))) {
                // Install and promotion run in a real, private host HOME. System
                // account/service configuration remains the native OS boundary.
                const result = await promisify(execFile)('/bin/sh', ['-c', command], {
                    env: { ...process.env, HOME: guestHome }, signal: context.signal });
                stdout = result.stdout;
            }
            else if (command.includes('managed_guest_cli_absent')) stdout = 'managed_guest_cli_absent\n';
            else if (command.includes('mktemp')) stdout = '/tmp/happier-bootstrap-transfer.s0\n';
            else if (command.includes('version_path')) stdout = 'current=\nprevious=\n';
            else if (command.includes('effect-internal')) {
                const frame = MachineEffectInternalRequestSchema.parse(JSON.parse(stdin.trim()));
                if (frame.mode === 'check' && !('steps' in frame)) throw new Error('Unexpected firewall check frame');
                const result = frame.mode === 'check'
                    ? { status: 'checked', plan: await machineSetup.checkMachineSetupEffectPlan({ basis: frame.basis, steps: frame.steps, backend }) }
                    : await machineSetup.applyMachineSetupEffectPlans({ ...frame, backend });
                stdout = JSON.stringify({ type: 'result', result }) + '\n';
            } else if (/\bauth\b/u.test(command) && (/\brequest\b/u.test(command) || /\bwait\b/u.test(command))) {
                const kind = /\brequest\b/u.test(command) ? 'request' : 'wait';
                const args = kind === 'request' ? ['--json', '--remote-enrollment', '--home-target-stdin', '--managed-enrollment-stdin']
                    : ['--json', '--public-key', publicKey, '--remote-enrollment'];
                stdout = await runGuestCommand(kind, args, stdin, context.signal);
                if (kind === 'request') {
                    const response: unknown = JSON.parse(stdout.trim());
                    if (!response || typeof response !== 'object' || !('publicKey' in response) || typeof response.publicKey !== 'string')
                        throw new Error('The public guest auth request did not return its pairing key');
                    publicKey = response.publicKey;
                } else {
                    const result: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
                    if (!result || typeof result !== 'object' || !('machineId' in result) || typeof result.machineId !== 'string'
                        || !('installation' in result) || !('machineEncryptionKey' in result) || typeof result.machineEncryptionKey !== 'string'
                        || !('daemonToken' in result) || typeof result.daemonToken !== 'string')
                        throw new Error('The public guest enrollment did not return its identity');
                    const identity = MachineInstallationIdentityV1Schema.parse(result.installation);
                    const guest = { ...controller, ...requester, machineId: result.machineId, installationId: identity.installationId, daemonToken: result.daemonToken,
                        keys: { publicKey: decodeBase64(identity.publicKey, 'base64url'), secretKey: decodeBase64(identity.privateKey, 'base64url') },
                        machineEncryptionKey: decodeBase64(result.machineEncryptionKey) };
                    observed.guest = guest;
                    await ports.startGuest(guest, guestNative);
                    // The receiving fixture returns only after real handler
                    // registration, capability ACK and Home alive publication.
                    observed.guestControlReady = true;
                }
            } else if (/\bauth\b/u.test(command) && /\bstatus\b/u.test(command)) {
                stdout = JSON.stringify({ v: 1, ok: true, kind: 'auth_status', data: { authenticated: true, credentialState: 'valid',
                    machineRegistrationState: 'server-confirmed', machineId: observed.guest?.machineId } }) + '\n';
            } else if (/\bdaemon\b/u.test(command) && /\bstatus\b/u.test(command)) {
                stdout = JSON.stringify({ server: { activeServerId: controller.serverId }, service: { installed: true },
                    daemon: { running: true, healthy: observed.guestControlReady === true },
                    auth: { needsAuth: false, machineId: observed.guest?.machineId } }) + '\n';
            } else stdout = JSON.stringify({ ok: true, data: {} }) + '\n';
            nativeResults.exec = { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                stdoutBase64: Buffer.from(stdout).toString('base64'), stderrBase64: '', stdoutTruncated: false, stderrTruncated: false };
        };
    let authorHandlers: ReadonlyMap<string, TargetActionInvocationRegistration['handler']> | undefined;
    const authorManifest = ports.native?.publicAuthor ? normalizePluginManifestV2(machineProvisionerAuthorFixture.manifest) : undefined;
    if (authorManifest) {
        const activated = await activateContributionModule({ pluginId: authorManifest.id,
            occurrenceId: createPluginRuntimeOccurrenceId(authorManifest.id), isOccurrenceCurrent: () => true,
            manifest: authorManifest, moduleNamespace: { activate: machineProvisionerAuthorFixture.activate } });
        onTestFinished(() => activated.dispose());
        expect(activated.status).toBe('active');
        authorHandlers = new Map(activated.registrations.filter(entry => entry.family === 'actions').map(entry => [entry.localId,
            async (body: Parameters<TargetActionInvocationRegistration['handler']>[0], context: Parameters<TargetActionInvocationRegistration['handler']>[1]) => {
                // The author owns every role. Only its native guest command
                // transport is replaced by this journey's OS/process boundary.
                let authored: unknown;
                const execute = async () => {
                    authored = await Reflect.apply(entry.value, undefined, [body, context]);
                    if (entry.localId === 'exec' || entry.localId === 'put-file') {
                        await executeNativeRole(entry.localId === 'exec' ? 'exec' : 'putFile', body, context);
                        if (entry.localId === 'exec') authored = nativeResults.exec;
                    }
                };
                const role = roles.find(role => roleActionId(role) === entry.localId);
                if (role && ports.native?.execute) {
                    const result = await ports.native.execute(role, body, context, execute);
                    if (result !== undefined) return result;
                } else await execute();
                return authored;
            }]));
    }
    const native = nativeFixture({ privateNative: true, credentialPurposes: [], supportedIntents: ['start', 'stop', 'delete'],
        fixtureManifest: authorManifest ?? ports.native?.manifest, actionHandlers: authorHandlers, nativeRoleResults: nativeResults,
        onNativeRole: async (role, body, context) => {
            const result = ports.native?.execute
                ? await ports.native.execute(role, body, context, async () => { await executeNativeRole(role, body, context); })
                : await executeNativeRole(role, body, context);
            if (result !== undefined) nativeResults[role] = result;
        } });
    await controller.prepareControllerProvisioner(native.manifest);
    let pendingApproval: RecordedApprovalExecutionObservationArgs | undefined;
    const managedMachineAction = createDaemonManagedMachineActionAdapter({ credentials, controllerCredentials: controllerCredentials ?? undefined,
        machineId: controller.machineId, serverBaseUrl: controller.baseUrl, serverId: controller.serverId,
        installationIdentity: { installationId: controller.installationId, privateKey: controller.keys.secretKey },
        managedProviderOperationAuthority: providerAuthority,
        resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: controller.machineId, serverIdentityId: target.homeServerIdentityId }),
        acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
        observeRecordedApprovalExecution: observePolicyApproval,
    });
    const ingress = await ports.startController(managedMachineAction);
    async function observePolicyApproval(request: RecordedApprovalExecutionObservationArgs): Promise<ActionExecuteResult> {
        pendingApproval = request;
        try {
            return await ingress.observeRecordedApprovalExecution(request);
        } finally { pendingApproval = undefined; }
    }
    const operations = ingress.actionOperations;
    // Observe the real admitted owner in the fixture; an unadmitted local RPC
    // read defaults to the controller Account and cannot inspect member work.
    const operationScope = { accountId: requester.accountId, machineId: controller.machineId };
    const author = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
        externalActionClient: true,
        serverId: controller.serverId, serverIdentityId: controller.serverId, serverApiUrl: controller.baseUrl,
        machineId: controller.machineId });
    let taskId: string | undefined;
    let operationId: string | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => cleanupPromise ??= (async () => {
        lifetime.abort();
        try {
            if (operationId && !observed.terminal) operations.runner.cancel(operationScope, operationId);
            if (taskId) {
                await getLiveSystemTasksRunnerAdapter().cancel({ taskId });
                await getLiveSystemTasksRunnerAdapter().wait({ taskId });
            }
            if (operationId && !observed.terminal) await operations.runner.waitForTerminal(operationScope, operationId);
        } finally { await guestExited; await ingress.close(); native.retire(); }
    })();
    // The allocation's controller and native occurrence also serve the rest
    // of the enrolled journey; test completion owns their retirement.
    onTestFinished(cleanup);
    try {
        const actionId = 'machines.managed.acquire';
        const actionInput = ManagedAcquireInputV1Schema.parse(ports.acquireInput ?? { enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
            role: 'deployTarget', adminAccessAtCreation: 'preauthorized' }, selection: { kind: 'one-off', homeId: controller.serverId,
            controller: { machineId: controller.machineId, installationId: controller.installationId },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'S0 guest', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const actionRequestId = randomUUID();
        const actionTarget = { kind: 'machine' as const, machineId: controller.machineId };
        // A UI confirmation originates at the Account host, not a terminal
        // executor relabeled as UI. Keep Home's signed root and sealed invocation.
        let result: ActionExecuteResult = ports.confirmWholeOperation
            ? await dispatchOriginalAccountAction({ actionId, input: actionInput, requestId: actionRequestId,
                target: actionTarget, credentials, serverHttpBaseUrl: controller.baseUrl, serverIdentityId: controller.serverId,
                invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' },
                    presentUserConfirmation: { actionId, requestId: actionRequestId,
                        inputDigest: computeActionInputApprovalDigestV1(actionId, actionInput), accountId: requester.accountId,
                        serverId: controller.serverId, target: actionTarget } }, signal: lifetime.signal })
            : await author.execute(actionId, actionInput, { surface: 'cli', authority: 'present_user',
                serverId: controller.serverId, actionRequestId, presentUserConfirmation: { actionId }, signal: lifetime.signal });
        expect(result.ok, result.ok ? undefined : result.errorCode).toBe(true);
        const approval = result.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
        if (approval?.success) {
            expect(ports.confirmWholeOperation, 'Confirmed acquisition must not create a parent approval Artifact').not.toBe(true);
            const approved = await author.execute('approval.request.decide', { artifactId: approval.data.artifactId, decision: 'approve' },
                { surface: 'cli', authority: 'present_user', serverId: controller.serverId, actionRequestId: randomUUID() });
            if (!approved.ok) throw new Error(`S0 acquisition approval failed: ${approved.errorCode}`);
            const read = await author.execute('approval.request.get', { artifactId: approval.data.artifactId },
                { surface: 'cli', authority: 'present_user', serverId: controller.serverId, actionRequestId: randomUUID() });
            if (!read.ok) throw new Error(`S0 acquisition approval read failed: ${read.errorCode}`);
            const outputSchema = getActionSpec('approval.request.get').outputSchema;
            if (!outputSchema) throw new Error('The approval request read Action requires its canonical output schema.');
            const stored = outputSchema.parse(read.result);
            if (!stored || typeof stored !== 'object' || !('request' in stored)) throw new Error('The acquisition approval settlement is unavailable');
            const settlement = ApprovalRequestPublicSettlementSchema.parse(stored.request);
            if (!settlement.execution.ok) throw new Error(`S0 approved acquisition failed: ${settlement.execution.errorCode}`);
            result = { ok: true, result: settlement.execution.result };
        }
        if (!result.ok || !result.result || typeof result.result !== 'object' || !('operation' in result.result)
            || !result.result.operation || typeof result.result.operation !== 'object' || !('operationId' in result.result.operation)
            || typeof result.result.operation.operationId !== 'string') throw new Error('Public acquire did not accept an owned operation');
        operationId = result.result.operation.operationId;
        let requesterActionFailure: unknown;
        let answeredTaskId: string | undefined;
        try { await expect.poll(async () => {
            const current = operations.store.get(operationScope, operationId!);
            if (!current) { observed.operation = { state: 'not_found' }; return false; }
            observed.operation = { state: current.state, phase: current.progress?.kind === 'phase' ? current.progress.phase : undefined,
                prompt: current.domainRef?.kind === 'managedMachine' ? current.domainRef.bootstrapTask?.prompt?.kind : undefined };
            if (current.state === 'failed' || current.state === 'succeeded') {
                observed.terminal = current;
                ports.onSettled?.(current);
                return true;
            }
            if (pendingApproval) {
                expect(ports.confirmWholeOperation, `Confirmed acquisition must not create an internal ${pendingApproval.expectedOrigin.actionId} approval Artifact`).not.toBe(true);
                const pending = pendingApproval;
                expect(pending.expectedOrigin.machineId).toBe(observed.guest?.machineId);
                // The person answers the exact child's real public approval;
                // controller ACK, retained intent and OS grant are not consent.
                const approved = await author.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' },
                    { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                        serverId: controller.serverId, actionRequestId: randomUUID() });
                if (!approved.ok) throw new Error(`S0 ${pending.expectedOrigin.actionId} approval failed: ${approved.errorCode}`);
            }
            const ref = current.domainRef;
            if (ref?.kind === 'managedMachine' && ref.bootstrapTask) taskId = ref.bootstrapTask.id;
            if (ref?.kind === 'managedMachine' && ref.bootstrapTask?.prompt?.kind === 'auth.approveRemoteProvisioning') {
                if (requester.accountId === controller.accountId) {
                    await getLiveSystemTasksRunnerAdapter().respond({ taskId: ref.bootstrapTask.id, answer: { approved: true } });
                } else if (answeredTaskId !== ref.bootstrapTask.id) {
                    try {
                        const address = { serverId: controller.serverId,
                            machineId: controller.machineId, operationId,
                            managed: { homeId: controller.serverId, managedId: ref.id }, waitForTerminal: true, includeManagedPrompt: true } as const;
                        const inspection = ports.runRequesterAction ? await ports.runRequesterAction('action.operations.get', address)
                            : await author.execute('action.operations.get', address, { surface: 'cli', authority: 'present_user',
                                serverId: controller.serverId, actionRequestId: randomUUID(), signal: lifetime.signal });
                        expect(inspection).toMatchObject({ ok: true, result: { kind: 'found', operation: {
                            operationId, domainRef: { bootstrapTask: { id: ref.bootstrapTask.id, prompt: ref.bootstrapTask.prompt } },
                        } } });
                        const answer = {
                            serverId: controller.serverId, homeId: controller.serverId, managedId: ref.id, operationId,
                            taskId: ref.bootstrapTask.id, purpose: 'approve', approved: true, prompt: ref.bootstrapTask.prompt,
                        } as const;
                        const approval = ports.runRequesterAction ? await ports.runRequesterAction('machines.managed.bootstrap.respond', answer)
                            : await author.execute('machines.managed.bootstrap.respond', answer, {
                                surface: 'cli', authority: 'present_user', serverId: controller.serverId,
                                actionRequestId: randomUUID(), presentUserConfirmation: { actionId: 'machines.managed.bootstrap.respond' },
                                signal: lifetime.signal });
                        expect(approval).toMatchObject({ ok: true, result: { taskId: ref.bootstrapTask.id } });
                        answeredTaskId = ref.bootstrapTask.id;
                    } catch (error) {
                        requesterActionFailure = error;
                        return true;
                    }
                }
            }
            return false;
        // Share the ONE journey's existing budget; guest source loading is
        // observed here rather than adding a shorter enrollment-phase cutoff.
        }, { timeout: 300_000 }).toBe(true); } catch (error) {
            throw new Error(`S0 enrollment observation: ${JSON.stringify({ nativePhase: observed.nativePhase, operation: observed.operation })}`, { cause: error });
        }
        if (requesterActionFailure) throw requesterActionFailure;
        if (observed.terminal?.state !== 'succeeded') throw new Error(`S0 acquisition failed: ${JSON.stringify({
            error: observed.terminal?.error, nativePhase: observed.nativePhase, guestFailure: observed.guestFailure,
        })}`);
        if (!observed.guest) throw new Error('Retained enrollment did not produce the target Machine');
        expect(observed.guest.machineId).not.toBe(controller.machineId);
        if (ports.native?.publicAuthor) {
            expect(await readFile(join(guestHome, '.happier/cli/current/author-module.js'), 'utf8'))
                .toBe('export const authorPayload = true;\n');
            const installed = await promisify(execFile)(join(guestHome, '.happier/cli/current/happier'), ['--author-install-marker'],
                { env: { ...process.env, HOME: guestHome } });
            expect(installed.stdout).toBe('public-author-installed\n');
        }
        if (actionInput.enrollmentIdentity?.kind === 'dedicatedDaemonUser') {
            expect(rootSteps).toEqual(expect.arrayContaining(['bootstrap-isolation-packages', 'agent-account']));
        }
        return observed.guest;
    } catch (error) {
        await cleanup();
        throw error;
    }
}

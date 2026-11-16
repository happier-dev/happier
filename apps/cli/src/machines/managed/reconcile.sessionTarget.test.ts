import { describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from '@/api/client/credentialAxios';
import { ManagedOpaquePresetMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachinePresetContentV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { fixture, roleResult } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import type { ManagedMachineAcquisitionDriverInput } from './acquire';
import type { ManagedMachinePolicyInvalidation } from '@/api/apiMachine';
import { createManagedNativeInvocation, reconcileManagedMachine } from './reconcile';
import { createManagedMachineAcquisitionDriver, createManagedMachineControllerClient } from './acquire';
import { createManagedPresetHydrator } from './presetHydration';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveRemoteInstalledFirstPartyBinaryPath } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import nacl from 'tweetnacl';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeExternalActionHttpBodyV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { reloadConfiguration } from '@/configuration';

const trustBoundary = vi.hoisted(() => ({ stopScan: false }));
vi.mock('node:child_process', async original => {
    const actual = await original<typeof import('node:child_process')>();
    return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
        if (trustBoundary.stopScan && args[0] === 'ssh-keyscan') throw new Error('Fixture stops at the SSH observation boundary');
        return actual.spawnSync(...args);
    } };
});

/**
 * A Session placed in a managed target: the already-admitted Session spawn is the
 * authority for that target's channel roles, through the one managed-invocation
 * owner (real custody check and contributed-Action dispatch; the plugin's role
 * handlers are the fixture's native boundary).
 */
const homeId = 'srv_session_target';
const machine = ManagedMachineV1Schema.parse({ id: 'managed-target', homeId, custodianAccountId: 'owner',
    controller: { machineId: 'controller-1', installationId: 'installation-1' },
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Target', choices: {} },
    enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, allocation: 'bound', creationState: 'active',
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { guest: 'a' } },
    desired: 'start', desiredWhen: 'now', intentRevision: 3, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});

const own = { guest: 'a' };

/** A fixture guest answering the holder bootstrap's commands (platform probe; holder files already present). */
function guestExec(input: unknown) {
    const { argv, inputBase64 } = input as { argv?: string[]; inputBase64?: string };
    const command = inputBase64 ? Buffer.from(inputBase64, 'base64').toString() : String(argv?.at(-1) ?? '');
    const stdout = command.includes('uname -s') ? 'Linux\naarch64\n/home/u\n'
        : command.includes('sha256sum') ? `${'a'.repeat(64)}  happier-session-holder\n${'b'.repeat(64)}  happier-process-custody\n` : '';
    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdoutBase64: Buffer.from(stdout).toString('base64'), stderrBase64: '', stdoutTruncated: false, stderrTruncated: false };
}

function harness(options: Readonly<{ streamRole?: boolean; holdStream?: boolean; guest?: boolean; targetExec?: (body: unknown) => Promise<ReturnType<typeof guestExec>>; targetPutFile?: (body: unknown) => Promise<void>;
    onNativeRole?: NonNullable<Parameters<typeof fixture>[0]>['onNativeRole'] }> = {}) {
    const calls: string[] = [];
    const inputs: unknown[] = [];
    const native = fixture({ credentialPurposes: [], streamRole: options.streamRole ?? true,
        nativeCredentialService: Boolean(options.onNativeRole),
        ...(options.guest || options.targetExec ? { nativeRoleResults: { exec: (options.targetExec ?? guestExec) as never } } : {}),
        async onNativeRole(role, input, context) {
            calls.push(role); inputs.push(input);
            await options.onNativeRole?.(role, input, context);
            if (role === 'putFile') await options.targetPutFile?.(input);
            // A held channel runs until its invocation is aborted (the provider's carrier process).
            if (role === 'stream' && options.holdStream) await new Promise(resolve => context.signal?.addEventListener('abort', resolve, { once: true }));
        } });
    const refuse = async (): Promise<never> => { throw new Error('No credential use in this fixture'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: '.',
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: refuse, subscribe: () => ({ dispose() {} }) },
            selectTarget: refuse, resolveTarget: refuse, materializeAccount: refuse, projectTargetAccounts: refuse, assertTargetAccountMaterializable: refuse,
        }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const input: ManagedMachineAcquisitionDriverInput = { token: 'controller-token', serverUrl: 'https://home.example', homeId,
        controller: machine.controller!, credentials: { token: 'controller-token', encryption: null }, managedProviderOperationAuthority: authority,
        runtimeRegistry: native.runtimeRegistry,
        homeTarget: resolveHomeTargetFromDescriptor({ authority: 'current_connection',
            descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'https://home.example', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home.example' }] } }),
    };
    return { calls, inputs, native, input };
}

describe('Session-target authority for managed provider channel roles', () => {
    it.each([false, true])('uses the author digest for a cold source without preparation guest metadata (Prepare %s)', async enabled => {
        const acquired: unknown[] = [];
        const h = harness({ onNativeRole: async (role, body) => {
            if (role === 'acquire') { acquired.push(body); throw new Error('Fixture stops before allocation'); }
        } });
        let row = ManagedOpaquePresetMachineV1Schema.parse({ id: machine.id, homeId, custodianAccountId: 'owner',
            controller: machine.controller, preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
            acquisitionMode: 'resource-bound', allocation: 'unsubmitted', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const digest = 'a'.repeat(64);
        const content = { t: 'plain' as const, v: ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'Reviewed source',
            preparation: { enabled }, launch: machine.launch,
            authorEffectReview: { kind: 'devcontainer', reviewedEffectDigest: digest, effects: [] } }) };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const input = { ...h.input, token, credentials: { token, encryption: null } };
        const hydrator = createManagedPresetHydrator(input);
        const opened = await hydrator.open(row, { content, recipients: [] });
        const options = { requestId: 'cold-source', acquisitionMode: 'resource-bound' as const,
            context: { operationOwnerUpdate: { update() {} } } };
        const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
            if (String(url).endsWith('/submit')) {
                row = ManagedOpaquePresetMachineV1Schema.parse({ ...row, allocation: 'may-exist' });
                return { status: 200, data: { submitted: true, machine: row } };
            }
            return { status: 200, data: { machine: row } };
        });
        onTestFinished(() => post.mockRestore());
        await expect(reconcileManagedMachine({ input, options, hydrator, machine: opened,
            action: 'machines.managed.acquire', client: createManagedMachineControllerClient(input, options, 'machines.managed.acquire', hydrator) })).rejects.toThrow();
        expect(acquired).toEqual([{ managedId: machine.id, launch: machine.launch!.choices, reviewedEffectDigest: digest }]);
    });

    it('admits transport preparation and channel roles for the Session\'s own target while the Session is current', async () => {
        const h = harness();
        const session = new AbortController();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: session.signal } }, () => machine);
        expect(await invocation.invoke('exec', { resource: own, argv: ['uname', '-m'] })).toEqual(roleResult('exec'));
        expect(await invocation.invoke('putFile', { resource: own, guestPath: '/h', bytesBase64: '' })).toEqual(roleResult('put-file'));
        expect(await invocation.invoke('stream', { resource: own, argv: ['holder', 'attach'] })).toEqual(roleResult('stream'));
        expect(await invocation.invoke('bootstrap', { resource: own })).toEqual(roleResult('bootstrap'));
        expect(h.calls).toEqual(['exec', 'putFile', 'stream', 'bootstrap']);

        // Least privilege: lifecycle and creation roles, and exec that would start a daemon, are refused before native IO.
        for (const role of ['power', 'destroy', 'acquire', 'rebuild', 'resize'] as const) {
            await expect(invocation.invoke(role, { resource: own })).rejects.toMatchObject({ code: 'native_intent_unsupported' });
        }
        await expect(invocation.invoke('exec', { resource: own, argv: ['true'], processConfig: { environment: { HOME: '/h', HAPPIER_HOME_DIR: '/h/.happier' },
            detachedDaemonStartArgv: ['happier', 'daemon', 'start'] } })).rejects.toMatchObject({ code: 'native_intent_unsupported' });
        expect(h.calls).toEqual(['exec', 'putFile', 'stream', 'bootstrap']);

        // Bound to the Session's lifetime: once it ends, the authority is gone.
        session.abort();
        await expect(invocation.invoke('stream', { resource: own, argv: ['holder', 'attach'] })).rejects.toBeTruthy();
        expect(h.calls).toEqual(['exec', 'putFile', 'stream', 'bootstrap']);
    });

    it('is the only extra authority: without it the same call has no admission', () => {
        const h = harness();
        expect(() => createManagedNativeInvocation({ input: h.input, options: { requestId: 'no-authority' }, machine,
            action: 'session.spawn_new' } as never, () => machine)).toThrow(expect.objectContaining({ code: 'admission_unavailable' }));
    });

    it('refuses a target controlled by another Machine', () => {
        const h = harness();
        const elsewhere = { ...machine, controller: { machineId: 'controller-2', installationId: 'installation-2' } };
        expect(() => createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine: elsewhere,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: new AbortController().signal } }, () => elsewhere))
            .toThrow(expect.objectContaining({ code: 'admission_unavailable' }));
    });

    it('binds the authority to the row\'s own guest: another resource is refused before native IO', async () => {
        const h = harness();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: new AbortController().signal } }, () => machine);
        for (const [role, body] of [['exec', { resource: { guest: 'b' }, argv: ['true'] }], ['putFile', { resource: { guest: 'b' }, guestPath: '/h', bytesBase64: '' }],
            ['stream', { resource: { guest: 'b' }, argv: ['holder', 'attach'] }], ['stream', { argv: ['holder', 'attach'] }],
            ['bootstrap', { resource: { guest: 'b' } }]] as const) {
            await expect(invocation.invoke(role, body)).rejects.toMatchObject({ code: 'admission_unavailable' });
        }
        expect(h.calls).toEqual([]);
    });

    it('never wakes a stopped target: exec and putFile carry allowWake false', async () => {
        const h = harness();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: new AbortController().signal } }, () => machine);
        await invocation.invoke('exec', { resource: own, argv: ['true'] });
        await invocation.invoke('putFile', { resource: own, guestPath: '/h', bytesBase64: '' });
        expect(h.inputs).toEqual([expect.objectContaining({ allowWake: false }), expect.objectContaining({ allowWake: false })]);
    });

    it('ends a running channel when the Session ends', async () => {
        const h = harness({ holdStream: true });
        const session = new AbortController();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: session.signal } }, () => machine);
        const channel = invocation.invoke('stream', { resource: own, argv: ['holder', 'attach'] });
        const settled = channel.then(() => 'settled', () => 'settled');
        await expect.poll(() => h.calls).toEqual(['stream']);
        session.abort();
        await expect(settled).resolves.toBe('settled');
    });

    it('serves finite calls while the Session\'s Agent channel stays open (each call is its own provider operation)', async () => {
        // A placed Session holds its Agent's holder channel for its whole life; the Session-end cleanup, a second
        // Agent's holder start and the Files/Git channel all run next to it through the same authority.
        const h = harness({ holdStream: true });
        const session = new AbortController();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: session.signal } }, () => machine);
        const agentChannel = invocation.invoke('stream', { resource: own, argv: ['holder', 'attach'] }).then(() => 'settled', () => 'settled');
        await expect.poll(() => h.calls).toEqual(['stream']);
        await expect(invocation.invoke('exec', { resource: own, argv: ['rm', '-rf', '/g/.happier/sessions/s1'] })).resolves.toEqual(roleResult('exec'));
        const filesChannel = invocation.invoke('stream', { resource: own, argv: ['holder', 'attach', '--ops'] }).then(() => 'settled', () => 'settled');
        await expect.poll(() => h.calls).toEqual(['stream', 'exec', 'stream']);
        session.abort();
        await expect(Promise.all([agentChannel, filesChannel])).resolves.toEqual(['settled', 'settled']);
    });

    it('ends when the row stops being this Session\'s target (rebuilt, unbound or deleted)', async () => {
        const h = harness();
        let current = machine;
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: new AbortController().signal } }, () => current);
        for (const changed of [{ ...machine, resource: { ...machine.resource!, value: { guest: 'rebuilt' } } },
            { ...machine, controller: { ...machine.controller!, installationId: 'installation-2' } },
            { ...machine, desired: 'delete' as const }]) {
            current = changed;
            await expect(invocation.invoke('exec', { resource: own, argv: ['true'] })).rejects.toMatchObject({ code: 'admission_unavailable' });
        }
        expect(h.calls).toEqual([]);
    });
});

describe('Session placement on a managed target (driver)', () => {
    const holder = { version: 'v1', resolveArtifacts: async () => ({ holder: { bytes: new Uint8Array([1]), sha256: 'a'.repeat(64) },
        helper: { bytes: new Uint8Array([2]), sha256: 'b'.repeat(64) } }) };

    it('publishes native SSH bootstrap trust on the original Session launch operation before network observation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'session-bootstrap-trust-'));
        vi.stubEnv('HAPPIER_HOME_DIR', root); reloadConfiguration();
        onTestFinished(async () => { vi.unstubAllEnvs(); reloadConfiguration(); await rm(root, { recursive: true, force: true }); });
        trustBoundary.stopScan = true;
        onTestFinished(() => { trustBoundary.stopScan = false; });
        const updates: unknown[] = [];
        const h = harness({ onNativeRole: async (role, _input, context) => {
            if (role === 'bootstrap') await context.services.machineProvisioners.establishSshHostTrust({
                kind: 'ssh', address: '192.0.2.7', user: 'guest',
            });
        } });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => machine });
        await expect(driver.openSessionTarget({ managedId: machine.id, sessionId: 'session',
            requesterAccountId: 'owner', lifetime: new AbortController().signal, holder,
            operation: { actionRequestId: 'startup-operation', signal: new AbortController().signal,
                operationProgress: { update() {} }, operationOwnerUpdate: { update(value) { updates.push(value); } } },
        })).rejects.toBeTruthy();
        expect(updates).toContainEqual(expect.objectContaining({ domainRef: expect.objectContaining({
            kind: 'managedMachine', id: machine.id, bootstrapTask: expect.objectContaining({ taskKind: 'remote.ssh.bootstrapMachine.v1' }),
        }) }));
        expect(h.calls).toEqual(['bootstrap']);
    });

    it.each(['absent', 'empty', 'succeeded', 'skipped'] as const)('starts through the relay on a loopback-only Home without CLI installation when Setup is %s', async state => {
        const h = harness({ guest: true });
        const row = ManagedMachineV1Schema.parse({ ...machine, acquisitionMode: 'resource-bound',
            preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
            ...(state === 'absent' ? {} : { machineSetup: state === 'empty'
                ? { setup: { items: [], scripts: [{ body: '' }] }, state: 'pending' }
                : { setup: { scripts: [{ body: 'already-satisfied' }] }, state } }) });
        const fetch = vi.fn(async () => { throw new Error('Full CLI supplier must not be used'); });
        vi.stubGlobal('fetch', fetch);
        const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('No installation report without installation'));
        onTestFinished(() => { vi.unstubAllGlobals(); post.mockRestore(); });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => row,
            homeTarget: resolveHomeTargetFromDescriptor({ authority: 'current_connection', descriptor: {
                v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'http://controller.localhost:3033', revision: 1,
                endpoints: [{ kind: 'https', url: 'http://controller.localhost:3033' }],
            } }),
        });
        await expect(driver.openSessionTarget({ managedId: row.id, sessionId: 'holder-nonce', committedSessionId: 'committed-session',
            requesterAccountId: 'owner', lifetime: new AbortController().signal, holder,
            operation: { actionRequestId: 'startup-operation', signal: new AbortController().signal,
                operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } },
        })).resolves.toMatchObject({ id: `managed:${row.id}` });
        expect(fetch).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
        expect(row.bootstrapInstalled).toBeUndefined();
    });

    it.skipIf(process.platform === 'win32')('installs the Setup interpreter without enrollment, retains failed Setup and reuses installation on Retry', async () => {
        const { PassThrough } = await import('node:stream');
        const { runMachineSetupEffectInternal } = await import('../setup/effectInternal');
        const { MachineRecipeV1Schema } = await import('@happier-dev/protocol/machines/setup/machineRecipeV1');
        const recipe = MachineRecipeV1Schema.parse({ id: 'tool', revision: '1', title: 'Guest tool',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            steps: [{ id: 'tool', kind: 'command', executable: 'true', args: [],
                check: { executable: 'true', args: [], unsatisfiedExitCodes: [1] } }] });
        const root = await mkdtemp(join(tmpdir(), 'bound-session-cli-'));
        onTestFinished(() => rm(root, { recursive: true, force: true }));
        const guestHome = join(root, 'guest'), payload = join(root, 'payload');
        const binaryPath = resolveRemoteInstalledFirstPartyBinaryPath({ componentId: 'happier-cli', remoteHomeDir: join(guestHome, '.happier'),
            channel: resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label });
        await Promise.all([mkdir(guestHome), mkdir(payload)]);
        // The guest executable is an explicit operator fixture. Its self-install
        // delegates to the canonical installation owner, rather than simulating promotion.
        const installer = `import { installVersionedPayload } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('@happier-dev/cli-common/firstPartyRuntime')).href)};
const args=process.argv.slice(1); const value=flag=>args[args.indexOf(flag)+1];
await installVersionedPayload({componentId:value('--component'),channel:value('--channel'),versionId:value('--version'),payloadRoot:value('--payload-root'),processEnv:process.env,selectAsDefaultReleaseChannel:true});`;
        await writeFile(join(payload, 'happier'), `#!/bin/sh
if [ "$1 $2" = 'self __install-payload' ]; then
  [ "$HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION" = '1' ] || exit 92
  exec ${safeBashSingleQuote(process.execPath)} --conditions=happier-source --import ${safeBashSingleQuote(createRequire(import.meta.url).resolve('tsx'))} --input-type=module -e ${safeBashSingleQuote(installer)} "$@"
fi
if [ "$1" = '--version' ]; then printf '%s\n' '0.3.0-dev'; exit 0; fi
exit 91
`);
        await chmod(join(payload, 'happier'), 0o755);
        vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payload);
        vi.stubGlobal('fetch', async () => Response.json({ capabilities: { guestCli: { source: 'home-payload', line: '0.3', channel: 'stable' } } }));
        onTestFinished(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
        const h = harness({ targetExec: async body => {
            const request = body as { argv: string[]; inputBase64?: string };
            if (request.argv[2]!.includes('uname -s')) return { ...guestExec(body), stdoutBase64: Buffer.from(`Linux\naarch64\n${guestHome}\n`).toString('base64') };
            if (request.argv[2]!.includes('sha256sum')) return guestExec(body);
            if (request.argv[2]!.includes('effect-internal')) {
                expect(await readFile(binaryPath, 'utf8')).toContain('self __install-payload');
                const stdin = new PassThrough(), stdout = new PassThrough();
                let text = '';
                stdout.on('data', (chunk: Buffer) => { text += chunk.toString(); });
                stdin.end(Buffer.from(request.inputBase64!, 'base64'));
                // OS boundary: the interpreter executes in the guest's root
                // context; actual recipe resolution, Check and Apply stay real.
                const status = await runMachineSetupEffectInternal(['--operation-id=startup-operation'], { stdin, stdout, readUid: () => 0,
                    runNative: async command => {
                        const result = await promisify(execFile)(command.executable, command.args);
                        return { code: 0, stdout: result.stdout, stderr: result.stderr };
                    } });
                return { ...guestExec(body), stdoutBase64: Buffer.from(text).toString('base64'),
                    termination: { observed: { kind: 'exit', exitCode: status }, requestedBy: { kind: 'none' } } };
            }
            const child = promisify(execFile)('/bin/sh', ['-c', request.argv[2]!], { cwd: guestHome, env: { ...process.env, HOME: guestHome } });
            child.child.stdin?.on('error', () => {}); // Commands that never read stdin close it early; execFile still owns their exit result.
            child.child.stdin?.end(request.inputBase64 ? Buffer.from(request.inputBase64, 'base64') : '');
            try {
                const result = await child;
                return { ...guestExec(body), stdoutBase64: Buffer.from(result.stdout).toString('base64') };
            } catch (error) {
                if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') throw error;
                return { ...guestExec(body), termination: { observed: { kind: 'exit', exitCode: error.code }, requestedBy: { kind: 'none' } } };
            }
        }, targetPutFile: async body => {
            const request = body as { guestPath: string; bytesBase64: string };
            await writeFile(request.guestPath, Buffer.from(request.bytesBase64, 'base64'));
        } });
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
        const target = { kind: 'machine' as const, machineId: machine.controller!.machineId };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-session-admission', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
            serverIdentityId: homeId, actionId: 'session.spawn_new', requestId: 'creation', machineId: target.machineId,
            installationId: machine.controller!.installationId, target, requestEnvelopeDigest: 'a'.repeat(43),
        } });
        let retained = ManagedMachineV1Schema.parse({ ...machine, acquisitionMode: 'resource-bound', preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
            machineSetup: { setup: { items: [{ kind: 'setupRecipe', selection: {
                ref: { pluginId: 'guest.tools', recipeId: recipe.id, revision: recipe.revision }, inputs: {} } }],
                scripts: [{ body: 'exit 19' }] }, state: 'pending' } });
        let reports = 0;
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, wire, config) => {
            expect(url).toBe('https://home.example/v1/machines/setup/report');
            const body = decodeExternalActionHttpBodyV1(wire)?.body ?? wire;
            expect(body).toMatchObject({ homeId, managedId: retained.id, presetId: 'preset', presetRevision: 1,
                target: { kind: 'bound', controller: machine.controller, sessionId: 'committed-session' } });
            expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, target,
                installationId: machine.controller!.installationId, requestId: 'creation', effectActionId: 'session.spawn_new',
                method: 'POST', path: '/v1/machines/setup/report', body,
                signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: keys.publicKey })).toBe(true);
            if ('bootstrapInstalled' in body) {
                retained = ManagedMachineV1Schema.parse({ ...retained, bootstrapInstalled: true }); reports++;
            } else {
                const report = body as { state: 'running' | 'succeeded' | 'failed' };
                retained = ManagedMachineV1Schema.parse({ ...retained, machineSetup: { ...retained.machineSetup!, state: report.state } });
            }
            return { status: 200, data: { machine: retained } };
        });
        onTestFinished(() => post.mockRestore());
        const driver = createManagedMachineAcquisitionDriver({ ...h.input,
            runtimeRegistry: { ...h.input.runtimeRegistry, contributes: { ...h.input.runtimeRegistry.contributes,
                machineRecipes: [{ pluginId: 'guest.tools', definition: recipe }] } }, externalActionMachineRequestPrivateKey: keys.secretKey,
            readPolicyCurrent: async () => retained });
        const operations = createHostActionOperationRuntime({ machineId: target.machineId, resolveAccountId: async () => 'owner', generateOperationId: () => 'startup-operation' });
        const outcome = await operations.observeExecution({ actionId: 'session.spawn_new', input: {}, execute: async operation => {
            const request = { managedId: machine.id, sessionId: 'holder-nonce', committedSessionId: 'committed-session', requesterAccountId: 'owner',
                lifetime: new AbortController().signal, holder, operation: { ...operation, externalActionExecutionAuthorization: authorization, externalActionTarget: target } };
            await expect(driver.openSessionTarget(request)).rejects.toMatchObject({ code: 'machine_setup_setup_failed' });
            expect(retained.bootstrapInstalled).toBe(true);
            expect(await readFile(binaryPath, 'utf8')).toContain('self __install-payload');
            const installedVersion = await realpath(binaryPath);
            await expect(driver.openSessionTarget(request)).rejects.toMatchObject({ code: 'machine_setup_setup_failed' });
            const { operation: _, ...recovery } = request;
            await driver.openSessionTarget(recovery);
            expect(await realpath(binaryPath)).toBe(installedVersion);
            return { ok: true, result: {} };
        } });
        expect(outcome).toMatchObject({ ok: true });
        expect(reports).toBe(1);
        expect(h.calls).not.toContain('acquire');
    }, 120_000);

    it.skipIf(process.platform === 'win32')('runs bound scripts without installing an unused interpreter and retries only unfinished scripts on the same resource', async () => {
        const guestHome = await mkdtemp(join(tmpdir(), 'bound-script-retry-'));
        onTestFinished(() => rm(guestHome, { recursive: true, force: true }));
        const h = harness({ targetExec: async body => {
            const request = body as { argv: string[]; inputBase64?: string };
            if (request.argv[2]!.includes('uname -s')) return { ...guestExec(body), stdoutBase64: Buffer.from(`Linux\naarch64\n${guestHome}\n`).toString('base64') };
            if (request.argv[2]!.includes('sha256sum')) return guestExec(body);
            try {
                const child = promisify(execFile)('/bin/sh', ['-c', request.argv[2]!], { cwd: guestHome, env: { ...process.env, HOME: guestHome } });
                child.child.stdin?.on('error', () => {});
                child.child.stdin?.end(request.inputBase64 ? Buffer.from(request.inputBase64, 'base64') : '');
                const result = await child;
                return { ...guestExec(body), stdoutBase64: Buffer.from(result.stdout).toString('base64') };
            } catch (error) {
                if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') throw error;
                return { ...guestExec(body), termination: { observed: { kind: 'exit', exitCode: error.code }, requestedBy: { kind: 'none' } } };
            }
        } });
        const provisioner = h.native.manifest.contributes.machineProvisioners[0]!;
        const { launch: _launch, resource: _resource, enrollmentIdentity: _identity, ...structuralMachine } = machine;
        let row = ManagedOpaquePresetMachineV1Schema.parse({ ...structuralMachine,
            acquisitionMode: 'resource-bound',
            preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' }, machineSetup: { state: 'pending' } });
        const launch = machine.launch!;
        const setup = { scripts: [{ body: 'printf a >> "$HOME/effects"' },
            { body: '[ -f "$HOME/allow-b" ] || exit 19; printf b >> "$HOME/effects"' }] };
        let content = { t: 'plain' as const, v: ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'script target', launch, setup,
            reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: row.retention, wakeOnAcceptedMessage: false },
            nativeResult: { kind: 'bound', resource: machine.resource } }) };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const states: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, wire) => {
            if (String(url).endsWith('/context')) return { status: 200, data: { machine: row,
                presetContent: { content, recipients: [] }, requestId: 'creation' } };
            expect(String(url)).toBe('https://home.example/v1/machines/setup/report');
            const body = (decodeExternalActionHttpBodyV1(wire)?.body ?? wire) as {
                state: 'running' | 'succeeded' | 'failed'; target: { sessionId: string }; presetContent: { content: typeof content };
            };
            expect(body.target.sessionId).toBe('committed-session');
            states.push(body.state);
            content = body.presetContent.content;
            row = ManagedOpaquePresetMachineV1Schema.parse({ ...row, machineSetup: { state: body.state } });
            return { status: 200, data: { machine: row } };
        });
        const fetch = vi.fn(async () => { throw new Error('Scripts do not use the CLI interpreter'); });
        vi.stubGlobal('fetch', fetch);
        onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, token, credentials: { token, encryption: null }, readPolicyCurrent: async () => row });
        const request = { managedId: row.id, sessionId: 'holder-nonce', committedSessionId: 'committed-session', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder, operation: { actionRequestId: 'setup-operation',
                signal: new AbortController().signal, operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } };
        await expect(driver.openSessionTarget(request)).rejects.toMatchObject({ code: 'machine_setup_setup_failed' });
        expect(await readFile(join(guestHome, 'effects'), 'utf8')).toBe('a');
        expect(content.v.setupSourceFacts).toMatchObject({ 'account:preset': { pendingScripts: [1] } });
        await writeFile(join(guestHome, 'allow-b'), '');
        await expect(driver.openSessionTarget(request)).resolves.toMatchObject({ id: `managed:${row.id}` });
        expect(await readFile(join(guestHome, 'effects'), 'utf8')).toBe('ab');
        expect(states).toEqual(['running', 'failed', 'running', 'succeeded']);
        expect(fetch).not.toHaveBeenCalled();
        expect(row.bootstrapInstalled).toBeUndefined();
        expect(h.calls).not.toContain('acquire');
    });

    it('refuses unfinished Setup before admitting an Agent target and preserves whole-success reuse', async () => {
        const h = harness({ guest: true });
        const row = ManagedMachineV1Schema.parse({ ...machine, acquisitionMode: 'resource-bound', bootstrapInstalled: true,
            preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
            machineSetup: { setup: { scripts: [{ body: 'required-setup-script' }] }, state: 'pending' } });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => row });
        const request = { managedId: row.id, sessionId: 'holder-nonce', committedSessionId: 'committed-session', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder, operation: { actionRequestId: 'startup-operation',
                signal: new AbortController().signal, operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } };
        const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Network boundary unavailable'));
        onTestFinished(() => post.mockRestore());
        await expect(driver.openSessionTarget(request)).rejects.toMatchObject({ code: 'managed_controller_request_failed',
            details: { kind: 'managedControllerRequest', path: '/v1/machines/setup/report', category: 'transport' } });
        const prepared = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => ({ ...row,
            machineSetup: { ...row.machineSetup!, state: 'succeeded' } }) });
        await expect(prepared.openSessionTarget(request)).resolves.toMatchObject({ id: `managed:${row.id}` });
        const { operation: _, ...heldRecovery } = request;
        await expect(driver.openSessionTarget(heldRecovery)).resolves.toMatchObject({ id: `managed:${row.id}` });
    });

    it('requires the committed Session carrier before preparing a fresh bound target', async () => {
        const h = harness({ guest: true });
        const row = ManagedMachineV1Schema.parse({ ...machine, acquisitionMode: 'resource-bound' });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => row });
        await expect(driver.openSessionTarget({ managedId: row.id, sessionId: 'holder-nonce', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder, operation: { actionRequestId: 'startup-operation',
                signal: new AbortController().signal, operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } },
        })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(h.calls).toEqual([]);
    });

    it('cancels finite preparation with its Session operation before any guest effect', async () => {
        const h = harness({ guest: true });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => machine });
        const stopped = new AbortController();
        stopped.abort();
        const request = { managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder,
            operation: { actionRequestId: 'spawn-operation', signal: stopped.signal,
                operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } };
        await expect(driver.openSessionTarget(request)).rejects.toThrow();
        expect(h.calls).toEqual([]);
    });

    it('keeps live target authority after finite preparation ends and supports held recovery without another preparation operation', async () => {
        const h = harness({ guest: true });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => machine });
        const finished = new AbortController();
        const request = { managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder,
            operation: { actionRequestId: 'spawn-operation', signal: finished.signal,
                operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } };
        const target = await driver.openSessionTarget(request);
        finished.abort();
        await expect(target.exec('true', new AbortController().signal)).resolves.toMatchObject({ status: 0 });
        const { operation: _, ...recovery } = request;
        await expect(driver.openSessionTarget(recovery)).resolves.toMatchObject({ id: target.id });
    });

    it('places a Session only for the row\'s custodian; another requester is refused before any native IO', async () => {
        const h = harness();
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => machine });
        const session = new AbortController();
        await expect(driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'someone-else',
            lifetime: session.signal, holder })).rejects.toMatchObject({ code: 'managed_target_access_unavailable' });
        expect(h.calls).toEqual([]);
        // The custodian prepares the admitted transport before the holder's platform probe.
        await driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: session.signal, holder }).catch(() => undefined);
        expect(h.calls.slice(0, 2)).toEqual(['bootstrap', 'exec']);
    });

    it('refuses a row this controller does not currently hold', async () => {
        const h = harness();
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => null });
        await expect(driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(h.calls).toEqual([]);
    });

    it('admits once across native effects, ignores unrelated pushes, and revokes a running channel on its selected row change', async () => {
        const h = harness({ holdStream: true, guest: true });
        const session = new AbortController();
        onTestFinished(() => { session.abort(); });
        let row = machine;
        let reads = 0;
        let notify: ((change?: ManagedMachinePolicyInvalidation) => void | Promise<void>) | undefined;
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => { reads++; return row; },
            subscribeManagedMachineChanges: listener => { notify = listener; return () => { notify = undefined; }; } });
        const target = await driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: session.signal, holder });
        await target.exec('true', new AbortController().signal);
        await target.putFile('/g/config', new Uint8Array([1]), new AbortController().signal);
        const channel = target.openChannel(['holder', 'attach'], new AbortController().signal);
        const closed = new Promise(resolve => channel.once('close', resolve));
        channel.resume();
        await expect.poll(() => h.calls.includes('stream')).toBe(true);
        expect(reads).toBe(1);
        await notify!({ kind: 'managed', managedIds: ['unrelated-target'] });
        await notify!({ kind: 'machines', machineIds: ['unrelated-machine'] });
        expect(reads).toBe(1);

        // Custody moves to another Account while the Session runs: the push revokes the open channel...
        row = { ...machine, custodianAccountId: 'next-owner' };
        await notify!({ kind: 'managed', managedIds: [machine.id] });
        await closed;
        expect(reads).toBe(2);
        // ...and every later call is refused before native IO.
        const before = h.calls.length;
        await expect(target.exec('true', new AbortController().signal)).rejects.toMatchObject({ code: 'intent_changed' });
        expect(h.calls.length).toBe(before);
        expect(reads).toBe(2);
    });

    it.each([false, true, 'baked', 'deferred'] as const)('opens the opaque preset context and preserves required Setup even without a retained Setup record (%s)', async requiredSetup => {
        const h = harness({ guest: true });
        const provisioner = h.native.manifest.contributes.machineProvisioners[0]!;
        const launch = machine.launch!;
        let row = ManagedOpaquePresetMachineV1Schema.parse({ id: machine.id, homeId, custodianAccountId: 'owner',
            controller: machine.controller, preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
            acquisitionMode: 'resource-bound', ...(requiredSetup === 'deferred' ? {} : { bootstrapInstalled: true }),
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 3,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        let content = { t: 'plain' as const, v: ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'private-target', launch,
            ...(requiredSetup ? { setup: { scripts: [{ body: 'required-setup-script' }] } } : {}),
            ...(requiredSetup === 'baked' || requiredSetup === 'deferred' ? { preparationExecution: { launch, binaryPath: '/prepared/happier',
                ...(requiredSetup === 'deferred' ? { deferredSetup: { scripts: [{ body: 'required-setup-script' }] } } : {}) } } : {}),
            reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: row.retention, wakeOnAcceptedMessage: false },
            nativeResult: { kind: 'bound', resource: machine.resource } }) };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
        const admittedTarget = { kind: 'machine' as const, machineId: machine.controller!.machineId };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'session-context-admission', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
            serverIdentityId: homeId, actionId: 'session.spawn_new', requestId: 'creation', machineId: admittedTarget.machineId,
            installationId: machine.controller!.installationId, target: admittedTarget, requestEnvelopeDigest: 'a'.repeat(43),
        } });
        let contexts = 0;
        let contextRequest: { body: unknown; signature: string } | undefined;
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, wire, config) => {
            if (String(url).endsWith('/machines/setup/report')) {
                const report = (decodeExternalActionHttpBodyV1(wire)?.body ?? wire) as {
                    state: 'running' | 'succeeded' | 'failed'; presetContent: { content: typeof content };
                };
                content = report.presetContent.content;
                row = ManagedOpaquePresetMachineV1Schema.parse({ ...row, machineSetup: { state: report.state } });
                return { status: 200, data: { machine: row } };
            }
            expect(String(url)).toBe('https://home.example/v1/machines/managed/controller/context');
            const body = decodeExternalActionHttpBodyV1(wire)?.body ?? wire;
            contextRequest = { body, signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) };
            contexts++;
            return { status: 200, data: { machine: row, presetContent: { content, recipients: [] }, requestId: 'creation' } };
        });
        try {
            const driver = createManagedMachineAcquisitionDriver({ ...h.input, token, credentials: { token, encryption: null },
                externalActionMachineRequestPrivateKey: keys.secretKey,
                readPolicyCurrent: async () => row });
            const opening = driver.openSessionTarget({ managedId: row.id, sessionId: 's1', committedSessionId: 'committed-session', requesterAccountId: 'owner',
                lifetime: new AbortController().signal, holder,
                operation: { actionRequestId: 'startup-operation', signal: new AbortController().signal,
                    externalActionExecutionAuthorization: authorization, externalActionTarget: admittedTarget,
                    operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } }).then(target => {
                expect(contextRequest?.body).toMatchObject({ managedId: row.id, sessionId: 'committed-session' });
                expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, target: admittedTarget,
                    installationId: machine.controller!.installationId, requestId: 'creation', effectActionId: 'session.spawn_new',
                    method: 'POST', path: '/v1/machines/managed/controller/context', body: contextRequest?.body,
                    signature: contextRequest?.signature ?? '', publicKey: keys.publicKey })).toBe(true);
                return target;
            });
            if (requiredSetup === true || requiredSetup === 'deferred') {
                await expect(opening).resolves.toMatchObject({ id: `managed:${row.id}` });
                expect(row).toHaveProperty('machineSetup.state', 'succeeded');
                if (requiredSetup === 'deferred') {
                    expect(row.bootstrapInstalled).not.toBe(true);
                    expect(h.calls).not.toContain('putFile');
                    expect(h.inputs.some(input => {
                        const payload = input as { inputBase64?: string };
                        return payload.inputBase64 && Buffer.from(payload.inputBase64, 'base64').toString('utf8').includes('required-setup-script');
                    })).toBe(true);
                }
                return;
            }
            const target = await opening;
            expect(target.platform.os).toBe('linux');
            expect(h.calls).toContain('exec');
            await target.exec('true', new AbortController().signal);
            await target.putFile('/g/config', new Uint8Array([1]), new AbortController().signal);
            expect(contexts).toBe(1);
            expect(row).not.toHaveProperty('launch');
            expect(row).not.toHaveProperty('resource');
        } finally { post.mockRestore(); }
    });

    it('sends target commands as the provider exec input, never in its argv (host and guest process lists)', async () => {
        const h = harness({ guest: true });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => machine });
        const target = await driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder });
        await target.exec("printf '%s' fixture-agent-arg", new AbortController().signal);
        const last = h.inputs.at(-1) as { argv: string[]; inputBase64?: string };
        expect(JSON.stringify(last.argv)).not.toContain('fixture-agent-arg');
        expect(Buffer.from(last.inputBase64 ?? '', 'base64').toString()).toContain('fixture-agent-arg');
    });
});

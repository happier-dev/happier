import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, createMachineSetupNativeBackend,
    type MachineRecipeStepV1, type MachineSetupNativeCommand } from '@happier-dev/cli-common/machineSetup';
import { MachineEffectInternalRecordSchema } from './effectInternalProtocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { watch, type FSWatcher } from 'node:fs';

it.skipIf(process.platform !== 'linux')('keeps daemon-written direct children private from a UID with ancestor traversal only', async context => {
    try { await execFileWithDeadline('sudo', ['-n', 'true'], {}); }
    catch { context.skip('Passwordless sudo is unavailable for the real member-UID boundary'); return; }
    try { await execFileWithDeadline('python3', ['-c', 'import ctypes; ctypes.CDLL("libacl.so.1")'], {}); }
    catch { context.skip('Python ctypes and native libacl are unavailable for the traversal ACL fixture'); return; }
    const { stdout } = await execFileWithDeadline('id', ['-u', 'nobody'], { encoding: 'utf8' });
    const uid = Number(String(stdout).trim());
    expect(uid).not.toBe(process.getuid?.());
    // The executor's TMPDIR can itself be private to its owner; the native UID
    // fixture needs a public ancestor before the one reviewed traversal grant.
    const home = await mkdtemp('/tmp/happier-private-children-');
    const petPackage = await mkdtemp('/tmp/happier-traversal-pet-');
    const runtimePayload = await mkdtemp('/tmp/happier-traversal-runtime-');
    const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_DEBUG_ARTIFACTS_DIR', 'HAPPIER_SYNTHETIC_DEBUG_ARTIFACTS_DIR',
        'HAPPIER_SUBPROCESS_ARTIFACTS_ENABLED', 'HAPPIER_SUBPROCESS_STDERR_MAX_BYTES']);
    environment.patch({ HAPPIER_HOME_DIR: home, HAPPIER_DEBUG_ARTIFACTS_DIR: undefined, HAPPIER_SYNTHETIC_DEBUG_ARTIFACTS_DIR: undefined,
        HAPPIER_SUBPROCESS_ARTIFACTS_ENABLED: '1', HAPPIER_SUBPROCESS_STDERR_MAX_BYTES: undefined });
    vi.resetModules();
    let cacheWatcher: FSWatcher | undefined;
    try {
        const { configuration } = await import('../../configuration');
        const { writeSettings, writeAccountChangesCursor } = await import('../../persistence');
        await writeSettings({ schemaVersion: 6, onboardingCompleted: true, servers: { home: {
            id: 'home', name: 'Synthetic', serverUrl: 'https://home.test', webappUrl: 'https://home.test',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_security_home', canonicalServerUrl: 'https://home.test',
                revision: 1, endpoints: [{ kind: 'https', url: 'https://home.test' }] },
        } } });
        await writeAccountChangesCursor('synthetic-account', 1);
        const { createTransparentPetSpritesheetPng } = await import('../../pets/testkit/petTestImages');
        await writeFile(join(petPackage, 'pet.json'), JSON.stringify({ id: 'synthetic-pet', displayName: 'Synthetic',
            description: 'Synthetic native permission fixture', spritesheetPath: 'spritesheet.png' }));
        await writeFile(join(petPackage, 'spritesheet.png'), createTransparentPetSpritesheetPng());
        const trace = join(configuration.happyHomeDir, 'tool-traces', 'synthetic.jsonl');
        const writeDaemonChildren = async (revision: number) => {
            const { importPetPackage } = await import('../../pets/storage/importPetPackage');
            expect(await importPetPackage({ target: 'local', packagePath: petPackage })).toMatchObject({ ok: true });
            const { createProjectSetupSuccessStore } = await import('../../workspaces/projectSetup/projectSetupSuccess');
            await createProjectSetupSuccessStore({ homeDir: home }).recordCompletion({
                serverId: 'synthetic-home', machineId: 'synthetic-machine', workspaceRefId: 'synthetic-workspace',
            }, { v: 1, workspaceRefId: 'synthetic-workspace', cwd: '/synthetic-project',
                platform: { os: 'linux', arch: 'x64' }, reviewedEffectDigest: 'effect', setupInputsDigest: 'inputs',
                environmentBindingReferences: [], completedAtMs: 1 });
            const { ensurePluginStoreDirectories } = await import('../../plugins/store/paths');
            await ensurePluginStoreDirectories({ happyHomeDir: home });
            const { createSshTunnelRegistry } = await import('../../daemon/ssh/tunnels/registry');
            await createSshTunnelRegistry().write([]);
            const { acquireSessionRunnerLock } = await import('../../daemon/sessionRunnerLock');
            const lock = await acquireSessionRunnerLock({ sessionId: `synthetic-session-${revision}`, happyHomeDir: home });
            expect(lock.ok).toBe(true);
            if (lock.ok) await lock.release();
            const { writeExecutionRunMarker } = await import('../../daemon/executionRunRegistry');
            await writeExecutionRunMarker({ pid: process.pid, happySessionId: 'synthetic-session',
                runId: 'synthetic-run', callId: 'synthetic-call', sidechainId: 'synthetic-call', intent: 'review',
                backendTarget: { kind: 'backend', backendId: 'claude' }, permissionMode: 'read_only',
                runClass: 'bounded', ioMode: 'request_response', retentionPolicy: 'ephemeral', status: 'running',
                startedAtMs: 1, updatedAtMs: 1 });
            const { resolveReleasedCodexStartupOverridesCacheV1Compatibility } = await import('../../agent/runtime/startup/releasedStartupOverridesCacheV1');
            const cachePublished = new Promise<void>((resolve, reject) => {
                cacheWatcher = watch(home, { recursive: true }, (_event, file) => {
                    if (file?.toString() === 'cli/startup-overrides-cache.json') resolve();
                });
                cacheWatcher.once('error', reject);
            });
            resolveReleasedCodexStartupOverridesCacheV1Compatibility('codex')!.write({
                permissionMode: 'default', permissionModeUpdatedAt: revision, modelId: null, modelUpdatedAt: 0, updatedAt: revision,
            });
            await cachePublished;
            cacheWatcher?.close();
            const { ToolTraceWriter } = await import('../../agent/tools/trace/toolTrace');
            new ToolTraceWriter({ filePath: trace }).record({ v: 1, ts: 1, direction: 'inbound',
                sessionId: 'synthetic-session', protocol: 'acp', kind: 'tool-result', payload: { content: 'synthetic-private-content' } });
        };
        const member = join(home, 'member');
        await mkdir(member, { mode: 0o700 });
        await execFileWithDeadline('sudo', ['-n', 'chown', String(uid), '--', member], {});
        // Real Linux ACL boundary, without requiring the optional setfacl binary.
        // The grant exposes only ancestor traversal to this existing member UID.
        await execFileWithDeadline('python3', ['-c', `
import ctypes, os, sys
acl = ctypes.CDLL('libacl.so.1', use_errno=True)
acl.acl_from_text.argtypes = [ctypes.c_char_p]
acl.acl_from_text.restype = ctypes.c_void_p
acl.acl_set_file.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
acl.acl_free.argtypes = [ctypes.c_void_p]
value = acl.acl_from_text(('user::rwx,user:' + sys.argv[2] + ':--x,group::---,mask::--x,other::---').encode())
if not value: raise OSError(ctypes.get_errno(), 'acl_from_text')
try:
    if acl.acl_set_file(os.fsencode(sys.argv[1]), 0x8000, value): raise OSError(ctypes.get_errno(), 'acl_set_file')
finally: acl.acl_free(value)
`, home, String(uid)], {});
        const probeAsMember = async (targets: readonly { name: string; path: string; directory: boolean; executable?: boolean }[]) => {
            const probe = await execFileWithDeadline('sudo', ['-n', '-u', `#${uid}`, '--', 'python3', '-c', `
import json, os, subprocess, sys
results = []
for target in json.loads(sys.argv[1]):
    code = None
    try:
        if target.get('executable'): subprocess.run([target['path']], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif target['directory']: os.listdir(target['path'])
        else: os.close(os.open(target['path'], os.O_RDONLY))
    except OSError as error: code = error.errno
    results.append({'name': target['name'], 'errno': code})
print(json.dumps({'uid': os.getuid(), 'results': results}))
`, JSON.stringify(targets)], { encoding: 'utf8' });
            return JSON.parse(String(probe.stdout)) as { uid: number; results: { name: string; errno: number | null }[] };
        };
        const expectedProbe = (targets: readonly { name: string }[]) => ({ uid, results: targets.map(target => ({
            name: target.name, errno: target.name === 'member' || target.name.startsWith('public-runtime-') ? null : osConstants.errno.EACCES,
        })) });
        // These real writers can run before the startup cache creates cli/.
        const { createSubprocessStderrAppender } = await import('../../agent/runtime/subprocessArtifacts');
        const appender = await createSubprocessStderrAppender({ agentName: 'synthetic', pid: process.pid, label: 'native-permissions' });
        expect(appender).not.toBeNull();
        await appender?.close();
        const { TmuxUtilities } = await import('../../integrations/tmux/TmuxUtilities');
        // The genuine OS spawn fails before starting tmux; its real root writer
        // still executes. No existing tmux server or Session is reached.
        expect(await new TmuxUtilities('synthetic', { TMUX_TMPDIR: join(home, 'tmux'), PATH: join(home, 'missing-tools') })
            .spawnInTmux([])).toMatchObject({ success: false });
        const { createDeploymentTargetRoleAdmissionFixture } = await import('../../deployments/targets/deploymentTargetRoleAdmission.testkit');
        const { normalizeStoredComposeDefinitionInput } = await import('../../workspaces/projectSetup/nativeComposeSource');
        const { admitDeploymentTargetRoleForHost } = await import('../../deployments/targets/admitDeploymentTargetRoleForHost');
        const { createDeploymentTargetRoleSourceAdmissionForHost } = await import('../../deployments/targets/createDeploymentTargetRoleAdmissionHost');
        const { createDeploymentSourceMaterializationPort } = await import('../../deployments/targets/ownServer/exactCommitRelease');
        const { createDeploymentGitRegistry } = await import('../../deployments/targets/ownServer/exactCommitRelease.testkit');
        const fixture = createDeploymentTargetRoleAdmissionFixture('uploadDeploy');
        const definition = await normalizeStoredComposeDefinitionInput({ from: 'compose', document: 'services: {}', profiles: [], services: [] });
        fixture.state.environment.content.definition = definition;
        fixture.state.receipt.content.sourceIntent = definition;
        fixture.state.receipt.content.sourceMethod = 'upload';
        const admission = await admitDeploymentTargetRoleForHost({ ...fixture.request,
            input: { ...fixture.input, sourceIntent: definition } }, fixture.host);
        if (!admission.receipt) throw new Error('Expected the canonical admitted receipt');
        const port = createDeploymentSourceMaterializationPort({
            admit: createDeploymentTargetRoleSourceAdmissionForHost({ ...admission, receipt: admission.receipt }, fixture.host, fixture.request.context),
            registry: createDeploymentGitRegistry(),
        });
        const materialized = await port.materialize({ environmentId: admission.environment.environment.id, deploymentId: admission.receipt.deployment.id });
        await materialized.abort();
        const earlyChildren = await readdir(home, { withFileTypes: true });
        const earlyTargets = earlyChildren.map(child => ({ name: child.name, path: join(home, child.name), directory: child.isDirectory() }));
        const earlyProbe = await probeAsMember(earlyTargets);
        // The real install root is shared with private CLI state. It must deny
        // listing while retaining access to the explicitly public executable.
        await writeFile(join(runtimePayload, 'happier'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
        const { promoteVersionedPayload, resolveInstalledFirstPartyComponentPaths } = await import('@happier-dev/cli-common/firstPartyRuntime');
        const installEnvironment = { ...process.env, HAPPIER_FIRST_PARTY_INSTALL_HOME: home };
        await promoteVersionedPayload({ componentId: 'happier-cli', versionId: '1.0.0',
            stagedPayloadPath: runtimePayload, processEnv: installEnvironment });
        const installed = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', processEnv: installEnvironment });
        const { resolveManagedToolsRoot } = await import('@happier-dev/cli-common/agents');
        const { buildAgentIsolationToolsRootStep } = await import('@happier-dev/cli-common/machineSetup');
        const [username, primaryGroup] = await Promise.all(['-un', '-gn'].map(async option =>
            String((await execFileWithDeadline('id', [option], { encoding: 'utf8' })).stdout).trim()));
        const toolsRoot = resolveManagedToolsRoot(installEnvironment);
        await createMachineSetupNativeBackend().apply(buildAgentIsolationToolsRootStep({
            daemonUsername: username, daemonPrimaryGroup: primaryGroup, toolsRoot,
        }));
        const runtimeRoots = [{ name: 'cli', path: join(home, 'cli'), directory: true },
            { name: 'tools', path: toolsRoot, directory: true }];
        const runtimeProbe = await probeAsMember(runtimeRoots);
        await writeDaemonChildren(1);
        await writeDaemonChildren(2);
        const children = await readdir(home, { withFileTypes: true });
        const targets = [{ name: 'home', path: home, directory: true },
            ...children.map(child => ({ name: child.name, path: join(home, child.name), directory: child.isDirectory() })),
            // A guessed filename must remain private independently of listing.
            { name: 'guessed-trace', path: trace, directory: false },
            { name: 'startup-cache', path: join(home, 'cli', 'startup-overrides-cache.json'), directory: false },
            { name: 'subprocess-log', path: appender!.path, directory: false },
            { name: 'public-runtime-readable', path: installed.binaryPath, directory: false },
            { name: 'public-runtime-executable', path: installed.binaryPath, directory: false, executable: true }];
        expect({ early: earlyProbe, runtime: runtimeProbe, final: await probeAsMember(targets) }).toEqual({
            early: expectedProbe(earlyTargets), runtime: expectedProbe(runtimeRoots), final: expectedProbe(targets),
        });
    } finally {
        cacheWatcher?.close();
        environment.restore();
        vi.resetModules();
        await rm(home, { recursive: true, force: true });
        await rm(petPackage, { recursive: true, force: true });
        await rm(runtimePayload, { recursive: true, force: true });
    }
});

it.skipIf(process.platform !== 'linux').each(['root CHECK', 'RunAs shim', 'owned stop'] as const)('keeps a reviewed native traversal grant effective through the %s entry', async entry => {
    const home = await mkdtemp(join(tmpdir(), 'happier-check-traversal-'));
    const environment = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    environment.patch({ HAPPIER_HOME_DIR: home });
    try {
        await chmod(home, 0o700);
        let granted = false;
        // OS ACL/account boundary only: Linux chmod's group bits are the ACL
        // mask. The real filesystem, native backend and interpreter stay real.
        const runNative = async ({ executable, args }: MachineSetupNativeCommand) => {
            if (executable === 'getent') return { code: 0, stdout: 'happier-agent:x:996:988::/var/lib/happier-agent:/usr/sbin/nologin\n', stderr: '' };
            if (executable === 'setfacl') {
                granted = true;
                await chmod(String(args.at(-1)), 0o710);
                return { code: 0, stdout: '', stderr: '' };
            }
            if (executable === 'getfacl') return { code: 0, stdout: [
                'user::rwx', ...(granted ? ['user:996:--x'] : []), 'group::---',
                `mask::${(await lstat(String(args.at(-1)))).mode & 0o010 ? '--x' : '---'}`, 'other::---',
            ].join('\n'), stderr: '' };
            throw new Error(`Unexpected native command: ${executable}`);
        };
        const backend = createMachineSetupNativeBackend({ run: runNative });
        const basis = { kind: 'setup' as const, machineId: 'machine', desiredRevision: 1 };
        const steps: MachineRecipeStepV1[] = [{ id: 'ancestor', kind: 'pathTraversal', path: home, agentUsername: 'happier-agent' }];
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
        expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied' });
        expect((await backend.observe(steps[0]!)).status).toBe('satisfied');

        vi.resetModules();
        if (entry === 'owned stop') {
            // A real child is the process boundary. Stop keeps the native census,
            // identity checks and canonical termination owner intact.
            const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
            try {
                await once(child, 'spawn');
                const ended = once(child, 'exit');
                const { terminateProcessTree } = await import('../../processes/terminate/terminateProcessTree');
                await terminateProcessTree(child);
                await ended;
                expect((await backend.observe(steps[0]!)).status).toBe('satisfied');
            } finally {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }
            return;
        }
        if (entry === 'RunAs shim') {
            await import('../../cli/commands/agentLaunch');
            expect((await backend.observe(steps[0]!)).status).toBe('satisfied');
            return;
        }
        const { runMachineSetupEffectInternal } = await import('./effectInternal');
        const output = new PassThrough();
        const records: string[] = [];
        output.on('data', (chunk: Buffer) => records.push(chunk.toString('utf8')));
        const code = await runMachineSetupEffectInternal(['--operation-id=check', '--installation-id=installation'], {
            stdin: Readable.from([JSON.stringify({ v: 1, mode: 'check', machineId: 'machine',
                installationId: 'installation', operationId: 'check', basis, steps }) + '\n']),
            stdout: output, readUid: () => 0, runNative,
        });
        expect(code).toBe(0);
        const terminal = records.join('').trim().split('\n').map(line => MachineEffectInternalRecordSchema.parse(JSON.parse(line))).at(-1);
        expect(terminal).toMatchObject({ type: 'result', result: { status: 'checked',
            plan: { nativeFacts: [{ stepId: 'ancestor', status: 'satisfied' }] } } });
        expect((await backend.observe(steps[0]!)).status).toBe('satisfied');
    } finally {
        environment.restore();
        vi.resetModules();
        await rm(home, { recursive: true, force: true });
    }
});

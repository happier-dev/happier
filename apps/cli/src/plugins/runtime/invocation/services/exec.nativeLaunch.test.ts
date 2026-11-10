import { describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PluginError } from '@happier-dev/plugin-sdk';

import { authorizePluginExecLaunchForHost, authorizeResolvedAgentNativeExecLaunchForHost, authorizeResolvedProjectExecLaunchForHost,
    createStablePluginExecService, createStableRunnerPluginExecService, issueAgentNativeLaunchQualifierForHost,
    installManagedProcessCustodyForHost,
    type HostAgentNativeLaunchPreparation } from './exec';
import { withTempDir } from '@/testkit/fs/tempDir';
import * as linuxProcessLaunch from '@/daemon/platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { prepareSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import { buildSpawnChildProcessEnv } from '@/daemon/spawn/buildSpawnChildProcessEnv';
import { resolveNativeAgentLaunchEnvironment } from '@/agent/runtime/launchEnvironment';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';

const executable = Object.freeze({ kind: 'systemTool', id: 'fixture.node' } as const);

describe('host-issued Agent native launch qualifier', () => {
    it('uses the finite operation working directory by default and preserves an explicit child directory', async () => {
        await withTempDir('happier-native-operation-cwd-', async root => {
            const operationCwd = join(root, 'operation');
            const explicitCwd = join(root, 'explicit');
            await Promise.all([mkdir(operationCwd), mkdir(explicitCwd)]);
            const service = createStablePluginExecService({
                defaultCwd: operationCwd,
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => root,
            });
            const request = { executable, args: ['-e', 'process.stdout.write(process.cwd())'] };
            const inherited = await service.run(request);
            expect(Buffer.from(inherited.stdout).toString()).toBe(await realpath(operationCwd));
            const explicit = await service.run({ ...request, cwd: explicitCwd });
            expect(Buffer.from(explicit.stdout).toString()).toBe(await realpath(explicitCwd));
        });
    });
    it.each(['unknown', 'member', 'applying member'] as const)('applies native admission before filesystem effects for %s (2026-11-02 guest fallback ruling)', async source => {
        await withTempDir('happier-native-requester-admission-', async cwd => {
            const identity = source === 'unknown' ? { kind: 'unknown' as const, reason: 'session_requester_unavailable' as const }
                : { kind: 'isolated' as const, separationRequired: true, requester: {
                    serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
            const launch = authorizeResolvedProjectExecLaunchForHost({
                launch: { command: process.execPath, args: [], cwd, env: {}, release() {} },
                agentNativeLaunch: true, agentIsolation: { requesterIdentity: identity,
                    read: () => source === 'applying member'
                        ? { enabled: true, status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [cwd] }
                        : { enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] } },
                prepareAgentNativeLaunch: async () => { await writeFile(join(cwd, 'native-effect'), 'effect'); },
                signal: new AbortController().signal, assertCurrent() {},
            });
            if (source === 'member') {
                // Admitted Use guests inherit the owner's OS identity when provisioning is off.
                const admitted = await launch;
                try {
                    expect(admitted).toMatchObject({ command: process.execPath, args: [], cwd, env: {} });
                    expect(await readdir(cwd)).toEqual(['native-effect']);
                } finally { await admitted.release(); }
            } else {
                await expect(launch).rejects.toMatchObject({ code: 'agent_isolation_unavailable', execLaunch: 'notStarted' });
                expect(await readdir(cwd)).toEqual([]);
            }
        });
    });
    it('does not grant daemon identity from the person execution-kind string without owner proof', async () => {
        await expect(authorizeResolvedProjectExecLaunchForHost({
            launch: { command: process.execPath, args: [], env: {}, release() {} },
            executionKind: 'person_break_glass', signal: new AbortController().signal, assertCurrent() {},
        })).rejects.toMatchObject({ code: 'agent_isolation_unavailable', execLaunch: 'notStarted' });
    });
    it('retains the supplied environment for trusted tools and the qualified native child', async () => {
        vi.stubEnv('NATIVE_REMOVED', 'ambient-rival');
        try {
        const service = createStablePluginExecService({
            environment: { SELECTED_ROUTE: 'selected', NATIVE_PROFILE: 'authored-profile' },
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd(),
            prepareAgentNativeLaunch: async () => {},
        });
        const request = { executable, args: ['-e', 'process.stdout.write(JSON.stringify({route:process.env.SELECTED_ROUTE??null,profile:process.env.NATIVE_PROFILE??null,removed:process.env.NATIVE_REMOVED??null}))'] };
        const ordinary = await service.run(request);
        expect(JSON.parse(Buffer.from(ordinary.stdout).toString())).toEqual({ route: 'selected', profile: 'authored-profile', removed: null });
        const native = await service.run(request, { nativeLaunch: issueAgentNativeLaunchQualifierForHost(service) });
        expect(native.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
        expect(JSON.parse(Buffer.from(native.stdout).toString())).toEqual({ route: 'selected', profile: 'authored-profile', removed: null });
        } finally { vi.unstubAllEnvs(); }
    });

    it('allows an undeclared Machine-native system tool while preserving isolated requester admission', async () => {
        const service = (requesterIdentity?: Parameters<typeof createStablePluginExecService>[0]['requesterIdentity']) => createStablePluginExecService({ signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, executionKind: 'machine_native', requesterIdentity,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd(),
            agentIsolation: { read: () => ({ enabled: true,
                status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [] }) },
        });
        await expect(service().run({ executable, args: ['--version'] })).resolves.toMatchObject({
            termination: { observed: { kind: 'exit', exitCode: 0 } },
        });
        await expect(service({ kind: 'isolated', separationRequired: true, requester: {
            serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation',
        } }).run({ executable, args: ['--version'] })).rejects.toMatchObject({
            code: 'agent_isolation_unavailable', execLaunch: 'notStarted',
        });
    });

    it.each([
        { policy: 300000, inherited: undefined, explicit: undefined, expected: '300000' },
        { policy: 1250, inherited: undefined, explicit: undefined, expected: '1250' },
        { policy: null, inherited: undefined, explicit: undefined, expected: null },
        { policy: null, inherited: '9000', explicit: undefined, expected: '9000' },
        { policy: 300000, inherited: '9000', explicit: undefined, expected: '9000' },
        { policy: 300000, inherited: undefined, explicit: '', expected: '' },
        { policy: 300000, inherited: undefined, explicit: '7000', expected: '7000' },
    ])('carries Session tool-idle policy through native exec and its child ($policy/$inherited/$explicit)', async ({ policy, inherited, explicit, expected }) => {
        const runnerEnvironment = buildSpawnChildProcessEnv({
            processEnv: {}, extraEnv: inherited === undefined ? {} : { AGENT_BROWSER_IDLE_TIMEOUT_MS: inherited },
            readMachineResourcesPolicy: () => ({ status: 'ready', revision: 1, source: 'stored',
                policy: MachineResourcesPolicyV1Schema.parse({ v: 1, processes: { toolIdleCloseMs: policy } }) }),
        });
        const nativeEnvironment = resolveNativeAgentLaunchEnvironment({
            processEnv: { ...runnerEnvironment, FX_QAB_PRIVATE_ENV: 'must-not-leak' },
            ...(explicit === undefined ? {} : { environmentVariables: { AGENT_BROWSER_IDLE_TIMEOUT_MS: explicit } }),
        });
        const service = createStablePluginExecService({ environment: nativeEnvironment.values,
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd(),
        });
        const result = await service.run({ executable,
            args: ['-e', `const {spawnSync}=require('node:child_process');
                const child=spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify({idle:process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS??null,private:process.env.FX_QAB_PRIVATE_ENV??null}))'],{env:process.env});
                process.stdout.write(child.stdout); process.exit(child.status??1);`],
        });
        expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
        expect(JSON.parse(Buffer.from(result.stdout).toString('utf8'))).toEqual({ idle: expected, private: null });
    });
    it.skipIf(process.platform !== 'linux')('finalizes the current Session material and MCP carrier into the isolated tuple without forwarding custodian env', async () => {
        await withTempDir('happier-isolated-finalizer-', async cwd => {
            const transport = await prepareSessionMcpLocalTransport({ agentUid: process.getuid!() });
            const release = vi.fn();
            try {
                const launch = await authorizeResolvedProjectExecLaunchForHost({
                    launch: { command: '/agent', args: ['--stdio'], cwd,
                        env: { PATH: '/usr/bin', SELECTED: 'selected', HAPPIER_DAEMON_TOKEN: 'custodian-sentinel' }, release },
                    signal: new AbortController().signal, assertCurrent() {}, agentNativeLaunch: true,
                    // Constructed observation tests tuple consumption, not native readiness.
                    agentIsolation: { read: () => ({ enabled: true,
                        status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [cwd],
                        localTransport: { agentUid: process.getuid!() },
                        launch: { managedHappierBinaryPath: '/opt/happier/cli/current/happier', runtimeHome: '/var/lib/happier-agent/session',
                            selectedEnvironmentKeys: ['SELECTED'], selectedMaterials: [], sessionMcpContext: transport.localContext } }) },
                });
                expect(launch.command).toBe('sudo');
                expect(launch.args).toEqual(['-n', '-u', 'happier-agent', '--', '/opt/happier/cli/current/happier', 'agent-launch']);
                expect(launch.env).toEqual({});
                expect(launch.stdinPreamble).toBeInstanceOf(Uint8Array);
                expect(Buffer.from(launch.stdinPreamble!).includes(Buffer.from('custodian-sentinel'))).toBe(false);
                await launch.release();
                expect(release).toHaveBeenCalledOnce();
            } finally { await transport.retire(); }
        });
    });
    it.skipIf(process.platform !== 'linux')('keeps the private native payload cwd out of the daemon-side RunAs wrapper', async () => {
        await withTempDir('happier-native-private-cwd-', async root => {
            const nativeHome = join(root, 'native-home');
            const enrolledRoot = join(root, 'workspace');
            await mkdir(nativeHome, { mode: 0o700 });
            await mkdir(enrolledRoot);
            const launch = await authorizeResolvedProjectExecLaunchForHost({
                launch: { command: '/opt/happier/cli/current/happier', args: ['filesystem-effect'], cwd: nativeHome, env: {} },
                requesterIdentity: { kind: 'isolated', separationRequired: false, requester: {
                    serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' } },
                agentLaunchKind: 'exec', signal: new AbortController().signal, assertCurrent() {},
                // Constructed native observation exercises the real finalizer,
                // not OS readiness or cross-UID directory permissions.
                agentIsolation: { read: () => ({ enabled: true,
                    status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [enrolledRoot],
                    localTransport: { agentUid: 2402, agentGid: 2402 },
                    launch: { managedHappierBinaryPath: '/opt/happier/cli/current/happier',
                        runtimeHome: join(nativeHome, 'runtime', 'operation'), selectedEnvironmentKeys: [], selectedMaterials: [] } }) },
            });
            try {
                expect(launch.command).toBe('sudo');
                expect(launch.args).toEqual(['-n', '-u', 'happier-agent', '--', '/opt/happier/cli/current/happier', 'agent-launch']);
                const payload = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble!], { objectMode: false }));
                expect(payload.cwd).toBe(await realpath(nativeHome));
                expect(payload.executable).toBe('/opt/happier/cli/current/happier');
                expect(payload.args).toEqual(['filesystem-effect']);
                // Logical cwd remains available to terminal custody/display.
                // Only the physical RunAs launcher inherits the daemon cwd.
                expect(launch.cwd).toBe(await realpath(nativeHome));
                expect(Reflect.get(launch, 'launcherCwd')).toBe(process.cwd());
            } finally { await launch.release(); }
        });
    });
    it.each(['ordinary', 'forwarded'] as const)('uses the host-held Project isolation context without accepting a caller override (%s)', async route => {
        const signal = new AbortController().signal;
        const agentIsolation = { read: () => ({ enabled: true,
            status: { kind: 'applying' as const, phase: 'runtime_replacement' as const }, workspaceRoots: [process.cwd()] }) };
        const create = (held = false) => createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd(),
            ...(held ? { agentIsolation } : {}),
            ...(route === 'forwarded' ? { authorizeLaunch: async () => ({
                command: process.execPath, args: [], cwd: process.cwd(), env: {}, release() {},
            }) } : {}),
        });
        const options = { signal, agentIsolation };
        await expect(authorizePluginExecLaunchForHost(create(), { executable, cwd: process.cwd() }, options))
            .rejects.toMatchObject({ code: 'workspace_exec_isolation_unavailable', execLaunch: 'notStarted' });
        const forged = { signal, agentIsolation: { read: () => ({ ...agentIsolation.read(), enabled: false }) } };
        await expect(create(true).run({ executable, cwd: process.cwd() }, forged))
            .rejects.toMatchObject({ code: 'workspace_exec_isolation_unavailable', execLaunch: 'notStarted' });
    });

    it('keeps the host-admitted person terminal tuple while ignoring a caller-forged person kind', async () => {
        const agentIsolation = { read: () => ({ enabled: true,
            status: { kind: 'applying' as const, phase: 'runtime_replacement' as const }, workspaceRoots: [process.cwd()] }),
            prepareLaunch: async (): Promise<never> => { throw new Error('Person terminals cannot consume an Agent lease'); } };
        const input = {
            launch: { command: process.execPath, args: [], cwd: process.cwd(), env: { PERSON_TERMINAL: 'custodian' } },
            signal: new AbortController().signal, assertCurrent() {}, agentIsolation,
            executionKind: 'person_break_glass' as const,
            requesterIdentity: { kind: 'owner_person' as const, requester: {
                serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation',
            } },
        };
        const person = await authorizeResolvedProjectExecLaunchForHost(input);
        expect(person).toMatchObject(input.launch);
        await person.release();
        const service = createStablePluginExecService({ signal: input.signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd(), agentIsolation,
        });
        // JavaScript may add this field, but only the host authorizer owns it.
        const forged = { signal: input.signal, executionKind: 'person_break_glass' };
        await expect(service.run({ executable, cwd: process.cwd(), args: ['--version'] }, forged))
            .rejects.toMatchObject({ code: 'workspace_exec_isolation_unavailable', execLaunch: 'notStarted' });
    });

    it.each([
        { executable, cwd: process.cwd() },
        { executable: { kind: 'managedDependency' as const, id: 'fixture.command' } },
        { executable: { kind: 'packaged-runtime-binary' as const, directorySegments: ['fixture'], executableBaseName: 'command' } },
    ])('keeps Machine-native $executable.kind content and explicit working directories behind isolation', async request => {
        const service = createStablePluginExecService({ signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, executionKind: 'machine_native',
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd(),
            agentIsolation: { read: () => ({ enabled: true,
                status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [] }) },
        });
        const refused = { code: 'workspace_exec_isolation_unavailable', execLaunch: 'notStarted',
            data: { details: { reason: 'workspace_not_ready' } } };
        await expect(service.run({ ...request, args: ['--version'] })).rejects.toMatchObject(refused);
        await expect(service.spawn({ ...request, args: ['--version'] })).rejects.toMatchObject(refused);
    });

    it('does not let Machine-native authority override an Agent launch or an admitted Workspace launch kind', async () => {
        const service = (agentLaunchKind?: 'workspaceExec') => createStablePluginExecService({ signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, executionKind: 'machine_native', agentLaunchKind,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd(),
            prepareAgentNativeLaunch: async () => undefined,
            agentIsolation: { read: () => ({ enabled: true,
                status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [] }) },
        });
        const agent = service();
        await expect(agent.run({ executable, args: ['--version'] }, { nativeLaunch: issueAgentNativeLaunchQualifierForHost(agent) }))
            .rejects.toMatchObject({ code: 'agent_isolation_unavailable', execLaunch: 'notStarted' });
        await expect(service('workspaceExec').run({ executable, args: ['--version'] }))
            .rejects.toMatchObject({ code: 'workspace_exec_isolation_unavailable', execLaunch: 'notStarted' });
    });

    it('ignores a plugin-forged Machine-native classification on SDK requests and options', async () => {
        const signal = new AbortController().signal;
        const service = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd(),
            agentIsolation: { read: () => ({ enabled: true,
                status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [] }) },
        });
        const request = { executable, args: ['--version'], executionKind: 'machine_native', hostNativeSystemTool: true };
        const options = { signal, executionKind: 'machine_native', hostNativeSystemTool: true };
        await expect(service.run(request, options))
            .rejects.toMatchObject({ code: 'workspace_exec_isolation_unavailable', execLaunch: 'notStarted' });
        await expect(service.spawn(request, options))
            .rejects.toMatchObject({ code: 'workspace_exec_isolation_unavailable', execLaunch: 'notStarted' });
    });

    it.skipIf(process.platform !== 'linux')('rechecks launch authority after asynchronous managed process scope preparation', async () => {
        let current = true;
        const release = vi.fn();
        // The OS scope adapter is the external boundary; Exec authorization and dispatch stay real.
        const scope = vi.spyOn(linuxProcessLaunch, 'prepareCgroupProcessLaunchScope').mockImplementation(async () => {
            await Promise.resolve();
            current = false;
            return null;
        });
        const service = createStablePluginExecService({ signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath, release }),
            resolvePath: async () => process.cwd(),
            async assertLaunchCurrent(signal) {
                signal.throwIfAborted();
                if (!current) throw new PluginError({ code: 'fixture_account_retired', message: 'Account retired' });
            },
        });
        const request = { executable, args: ['-e', 'process.exit(0)'] };
        const custody = installManagedProcessCustodyForHost(service, request, null);
        try {
            await expect(service.spawn(request).then(async handle => {
                try { await handle.wait(); } finally { await handle.dispose(); }
            })).rejects.toMatchObject({ code: 'fixture_account_retired',
                execLaunch: 'notStarted', data: { execLaunch: 'notStarted' } });
            expect(release).toHaveBeenCalledOnce();
        } finally { custody.dispose(); scope.mockRestore(); }
    });

    it.each(['host', 'runner'] as const)('preserves typed system-tool resolution refusals from the %s authority', async kind => {
        const refusal = new PluginError({ code: 'fixture_resolution_denied', message: 'Tool resolution refused', retryable: true });
        const common = { signal: new AbortController().signal, isOccurrenceCurrent: () => true };
        const service = kind === 'host' ? createStablePluginExecService({
            ...common, resolveExecutable: async () => ({ command: process.execPath }),
            resolvePath: async () => process.cwd(), systemTools: { resolve: async () => { throw refusal; } },
        }) : createStableRunnerPluginExecService({
            ...common, agentCli: { checkReadiness: async () => ({ launchable: [] }) },
            resolveExecutable: async () => { throw new Error('No host executable resolution expected'); },
            resolveSystemTool: async () => { throw refusal; },
            authorizeLaunch: async () => { throw new Error('Resolution must refuse before launch'); },
        });
        await expect(service.systemTools.resolve({ toolId: 'fixture.agent', purpose: 'Start native Agent' }))
            .rejects.toMatchObject({ code: 'fixture_resolution_denied', retryable: true,
                execLaunch: 'notStarted', data: { execLaunch: 'notStarted' } });
    });

    it.each(['currentness', 'environment'] as const)('retains prelaunch evidence when %s fails after authorization', async phase => {
        const release = vi.fn();
        let current = true;
        const service = createStablePluginExecService({ signal: new AbortController().signal,
            isOccurrenceCurrent: () => current, resolveExecutable: async () => ({ command: process.execPath, release }),
            resolvePath: async () => process.cwd(),
            transformAgentChildLaunchEnvironment: () => {
                if (phase === 'environment') throw new Error('Invalid child environment');
                current = false;
                return {};
            },
        });
        await expect(service.spawn({ executable }))
            .rejects.toMatchObject({ code: phase === 'currentness' ? 'plugin_generation_stale' : 'plugin_exec_spawn_failed',
                execLaunch: 'notStarted', data: { execLaunch: 'notStarted' } });
        expect(release).toHaveBeenCalledOnce();
    });

    it('refuses a forged native launch qualifier before resolving or launching a process', async () => {
        const resolveExecutable = vi.fn(async () => ({ command: process.execPath }));
        const service = createStablePluginExecService({ signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, resolveExecutable,
            resolvePath: async () => process.cwd(),
        });
        // JavaScript plugins may pass arbitrary values despite the opaque SDK type.
        const options = { signal: new AbortController().signal, nativeLaunch: Object.freeze({ purpose: 'agent' }) };
        // @ts-expect-error A forged object is deliberately not a host-issued token.
        await expect(service.run({ executable, args: ['-e', 'process.stdout.write("forged")'] }, options))
            .rejects.toMatchObject({ code: 'plugin_exec_native_launch_qualifier_invalid' });
        expect(resolveExecutable).not.toHaveBeenCalled();
    });

    it('keeps ordinary tools and probes nonactivating and binds native authority to the exact Exec service', async () => {
        const prepareAgentNativeLaunch = vi.fn<HostAgentNativeLaunchPreparation>(async () => ({
            projectLaunch: { status: 'refused', kind: 'approval_pending', code: 'project_setup_consent_required' },
        }));
        const create = () => createStablePluginExecService({ signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: process.execPath }),
            resolvePath: async () => process.cwd(), prepareAgentNativeLaunch,
        });
        const service = create();
        const request = { executable, args: ['-e', 'process.stdout.write("probe")'], purpose: 'cold Agent' };
        const result = await service.run(request);
        expect(new TextDecoder().decode(result.stdout)).toBe('probe');
        expect(prepareAgentNativeLaunch).not.toHaveBeenCalled();
        const foreign = issueAgentNativeLaunchQualifierForHost(create());
        await expect(service.spawn(request, { nativeLaunch: foreign }))
            .rejects.toMatchObject({ code: 'plugin_exec_native_launch_qualifier_invalid' });
        expect(prepareAgentNativeLaunch).not.toHaveBeenCalled();
        await expect(service.spawn(request, { nativeLaunch: issueAgentNativeLaunchQualifierForHost(service) }))
            .rejects.toMatchObject({ code: 'project_setup_consent_required' });
        await expect(service.clients.spawn({ kind: 'jsonStream', launch: request, maxFrameBytes: 1024 },
            { nativeLaunch: issueAgentNativeLaunchQualifierForHost(service) }))
            .rejects.toMatchObject({ code: 'project_setup_consent_required' });
    });

    it('produces native environment before capturing the complete authorized tuple and preserves release custody', async () => {
        await withTempDir('native qualifier root ', async root => {
            await writeFile(join(root, 'mise.toml'), '[env]\nKEEP = "native"\n');
            const release = vi.fn();
            const nativeRun = vi.fn(async () => ({ exitCode: 0, stdout: 'KEEP=native\0NATIVE=ready\0' }));
            const prepareAgentNativeLaunch = vi.fn<HostAgentNativeLaunchPreparation>(async (_signal, cwd, env) => {
                expect(cwd).toBe(root);
                expect(env).toMatchObject({ REMOVE: 'old', KEEP: 'request' });
                return { projectLaunch: { status: 'ready', reviewedEffectDigest: 'effect-current', toolchain: {
                    selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, platform: 'linux',
                    io: { resolveTool: async () => ({ executablePath: '/native/mise', version: '2026.10.4' }), run: nativeRun },
                } } };
            });
            const service = createStablePluginExecService({ environment: { REMOVE: 'old' },
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                resolveExecutable: async () => ({ command: process.execPath, args: ['--installed'], release }),
                resolvePath: async () => root, prepareAgentNativeLaunch,
            });
            const launch = await authorizePluginExecLaunchForHost(service, {
                executable, args: ['--session', 'spaces "quotes" \\'], cwd: { root: 'workspace', relativePath: '' },
                env: { KEEP: 'request' }, stdin: new Uint8Array([0, 255]), timeoutMs: 9876,
                maxStdoutBytes: 1000, maxStderrBytes: 2000,
            }, { agentIsolation: null, nativeLaunch: issueAgentNativeLaunchQualifierForHost(service) });
            expect(launch).toMatchObject({ command: process.execPath,
                args: ['--installed', '--session', 'spaces "quotes" \\'], cwd: root,
                env: { KEEP: 'native', NATIVE: 'ready' }, stdin: new Uint8Array([0, 255]),
                timeoutMs: 9876, maxStdoutBytes: 1000, maxStderrBytes: 2000 });
            expect(launch.env).not.toHaveProperty('REMOVE');
            expect(nativeRun).toHaveBeenCalledOnce();
            await launch.release(); await launch.release();
            expect(release).toHaveBeenCalledOnce();
        });
    });

    it('releases a resolved native tuple when preparation retires its invocation', async () => {
        const controller = new AbortController();
        const release = vi.fn();
        const service = createStablePluginExecService({ signal: controller.signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd(),
            prepareAgentNativeLaunch: async () => { controller.abort(); return undefined; },
        });
        await expect(authorizeResolvedAgentNativeExecLaunchForHost(service, {
            command: process.execPath, args: [], env: {}, release,
        })).rejects.toMatchObject({ code: 'plugin_exec_aborted' });
        expect(release).toHaveBeenCalledOnce();
    });

    it('fails closed when a recognized qualifier has no host preparation owner', async () => {
        const resolveExecutable = vi.fn(async () => ({ command: process.execPath }));
        const service = createStablePluginExecService({ signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveExecutable, resolvePath: async () => process.cwd(),
        });
        const nativeLaunch = issueAgentNativeLaunchQualifierForHost(service);
        await expect(service.spawn({ executable }, { nativeLaunch }))
            .rejects.toMatchObject({ code: 'plugin_exec_native_launch_unavailable' });
        expect(resolveExecutable).not.toHaveBeenCalled();
        const release = vi.fn();
        await expect(authorizeResolvedAgentNativeExecLaunchForHost(service,
            { command: process.execPath, args: [], env: {}, release }, undefined, nativeLaunch))
            .rejects.toMatchObject({ code: 'plugin_exec_native_launch_unavailable' });
        expect(release).toHaveBeenCalledOnce();
    });

    it('rejects malformed resolved launch input before native preparation', async () => {
        const prepareAgentNativeLaunch = vi.fn<HostAgentNativeLaunchPreparation>(async () => undefined);
        const service = createStablePluginExecService({ signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd(), prepareAgentNativeLaunch,
        });
        const release = vi.fn();
        await expect(authorizeResolvedAgentNativeExecLaunchForHost(service,
            { command: process.execPath, args: [], env: {}, cwd: 'relative-root', release }))
            .rejects.toMatchObject({ code: 'plugin_exec_invalid_cwd' });
        expect(prepareAgentNativeLaunch).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
    });

    it.each(['declared', 'resolved'] as const)('refuses changed reviewed inputs before a %s native launch and releases the original executable', async kind => {
        await withTempDir('native qualifier currentness ', async root => {
            await writeFile(join(root, 'mise.toml'), '[env]\nKEEP = "native"\n');
            let current = true;
            const release = vi.fn();
            const service = createStablePluginExecService({ signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                resolveExecutable: async () => ({ command: process.execPath, release }), resolvePath: async () => root,
                prepareAgentNativeLaunch: async () => ({ projectLaunch: {
                    status: 'ready', reviewedEffectDigest: 'old-effect',
                    verifyCurrent: async () => { if (!current) throw new PluginError({ code: 'project_setup_effect_changed', message: 'Effect changed' }); },
                    toolchain: { selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, platform: 'linux',
                        io: { resolveTool: async () => ({ executablePath: '/native/mise', version: '2026.10.4' }),
                            run: async () => { current = false; return { exitCode: 0, stdout: 'KEEP=native\0' }; } } },
                } }),
            });
            const nativeLaunch = issueAgentNativeLaunchQualifierForHost(service);
            await expect(kind === 'declared'
                ? authorizePluginExecLaunchForHost(service, { executable, cwd: { root: 'workspace', relativePath: '' } }, { agentIsolation: null, nativeLaunch })
                : authorizeResolvedAgentNativeExecLaunchForHost(service, { command: process.execPath, args: [], env: {}, cwd: root, release }, undefined, nativeLaunch))
                .rejects.toMatchObject({ code: 'project_setup_effect_changed', execLaunch: 'notStarted', data: { execLaunch: 'notStarted' } });
            expect(release).toHaveBeenCalledOnce();
        });
    });
});

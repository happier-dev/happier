import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { createManagedServiceDurabilityOwner } from '@/plugins/runtime/invocation/services/managedServiceDurability';
import { createDaemonManagedServiceEndpointReadOwner } from '@/plugins/runtime/invocation/services/daemonManagedServiceEndpointReadOwner';
import { ManagedServiceEndpointReadOpenRequestV1Schema } from '@/agent/runtime/session/process/managedServiceEndpointReadProtocol';
import {
    resolveOpenCodeAttachTarget,
    createOpenCodeAttachArgs,
    resolveOpenCodeAttachReachability,
} from '../../../../../packages/plugins/opencode/src/agent/surfaces/sessions/attach/descriptor';

import { createProviderCliAttachSurface, probeLocalSocket } from './providerCliAttach';
import { createTerminalLauncherFixture } from '@/testkit/process/terminalLauncher';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';

const launchFileBoundary = vi.hoisted(() => ({ beforeWrite: null as (() => void) | null }));
// The real OS launch-file write is the await after exact managed-access resolution.
vi.mock('node:fs/promises', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs/promises')>();
    return { ...original, writeFile: async (...args: Parameters<typeof original.writeFile>) => {
        if (typeof args[0] === 'string' && basename(args[0]) === 'launch.json') launchFileBoundary.beforeWrite?.();
        return await original.writeFile(...args);
    } };
});

describe('createProviderCliAttachSurface', () => {
    it.each(['session', 'explicit'] as const)('keeps hosted Session environments isolated in %s attach probes and native launches', async (environmentSource) => {
        vi.stubEnv('ATTACH_SCOPE_MARKER', 'host-process');
        try {
            const outcomes = await Promise.all(['session-a', 'session-b'].map((sessionId) => {
                const environment = { ...process.env, ATTACH_SCOPE_MARKER: sessionId };
                const expected = environmentSource === 'explicit' ? 'explicit-attach' : sessionId;
                const fixture = createTerminalLauncherFixture();
                fixture.child.once('message', () => setImmediate(() => fixture.child.emit('exit', 0, null)));
                const surface = createProviderCliAttachSurface({
                    agentId: 'opencode', resolveTarget: () => ({ ok: true, value: {} }),
                    createArgs: (_target, host) => ['attach', host.cliVersion ?? 'missing'],
                    cliVersionArgs: ['-e', 'process.stdout.write(process.env.ATTACH_SCOPE_MARKER ?? "")'],
                    // Executable resolution and HTTP/terminal launch are the native system boundaries.
                    resolveLaunchSpec: () => ({ source: 'managed', resolvedPath: process.execPath, command: process.execPath, args: [] }),
                    resolveReachability: (_target, host) => ({ kind: 'http', url: `https://fixture.test/${host.cliVersion}` }),
                    fetchFn: async (input) => new Response(null, { status: String(input).endsWith(`/${expected}`) ? 200 : 503 }),
                    spawnProcess: fixture.spawnProcess,
                    ...(environmentSource === 'explicit' ? { env: { ...process.env, ATTACH_SCOPE_MARKER: expected } } : {}),
                });
                return runAddedHostedSession({ environment, workingDirectory: process.cwd(), end() {} }, async () => {
                    const availability = await surface.evaluateAvailability!({ sessionId, metadata: {}, depth: 'live' });
                    const attached = await surface.attach({ sessionId, metadata: {} });
                    return { expected, availability, attached, native: fixture.readSpec() };
                });
            }));
            for (const { expected, availability, attached, native } of outcomes) {
                expect({ availability, attached, native }).toMatchObject({
                    availability: { available: true }, attached: { ok: true },
                    native: { args: ['attach', expected], env: { ATTACH_SCOPE_MARKER: expected } },
                });
            }
            expect(process.env.ATTACH_SCOPE_MARKER).toBe('host-process');
        } finally { vi.unstubAllEnvs(); }
    });
    it('keeps Happier Herdr pane ownership out of the actual native attach launch', async () => {
        const fixture = createTerminalLauncherFixture();
        const inherited = Object.freeze({ PATH: '/bin', HERDR_ENV: '1', CLAUDECODE: '1', IS_SANDBOX: '1' });
        const surface = createProviderCliAttachSurface({
            agentId: 'opencode', resolveTarget: resolveOpenCodeAttachTarget, createArgs: createOpenCodeAttachArgs,
            resolveLaunchSpec: () => ({ source: 'managed', resolvedPath: '/managed/opencode', command: '/managed/opencode', args: [] }),
            env: inherited, spawnProcess: fixture.spawnProcess,
        });
        const completion = Promise.resolve(surface.attach({
            sessionId: 'happier-native-env', metadata: { path: '/repo', runtimeDescriptorV1: {
                v: 1, agentId: 'opencode', agent: { backendMode: 'server', providerSessionId: 'native-one',
                    serverBaseUrl: 'https://operator.example.test', serverBaseUrlExplicit: true },
            } },
        }));
        await vi.waitFor(() => expect(fixture.spawnProcess).toHaveBeenCalledTimes(1));
        const native = fixture.readSpec();
        fixture.child.emit('exit', 0, null);
        await expect(completion).resolves.toMatchObject({ ok: true });
        expect(native).toMatchObject({ env: { PATH: '/bin', IS_SANDBOX: '1' } });
        expect(native).not.toHaveProperty('env.HERDR_ENV');
        expect(native).not.toHaveProperty('env.CLAUDECODE');
        expect(inherited.HERDR_ENV).toBe('1');
    });
    it('refuses access withdrawn during the real asynchronous private launch-file write', async () => {
        const { spawnProcess, child } = createTerminalLauncherFixture();
        child.once('message', () => setImmediate(() => child.emit('exit', 0, null)));
        let current = true;
        const surface = createProviderCliAttachSurface({
            agentId: 'opencode', resolveTarget: () => ({ ok: true, value: { baseUrl: 'http://127.0.0.1:4312' } }),
            createArgs: () => [], managedServiceTargetBaseUrl: (target) => target.baseUrl,
            managedServiceCredentialEnvironmentKey: 'PRIVATE_FIXTURE_KEY',
            resolveManagedServiceAccess: async () => ({ baseUrl: 'http://127.0.0.1:4312', request: async () => ({ ok: true }),
                childEnvironment: {}, isCurrent: () => current }),
            resolveLaunchSpec: () => ({ source: 'managed', resolvedPath: '/fixture/native', command: '/fixture/native', args: [] }),
            spawnProcess,
        });
        launchFileBoundary.beforeWrite = () => { current = false; };
        try {
            const result = Promise.resolve(surface.attach({ sessionId: 'fixture-withdrawal', metadata: {} }));
            // A wrongly launched fixture must settle too, so RED is not a timeout.
            void result.catch(() => undefined);
            await vi.waitFor(() => expect(current).toBe(false));
            await expect(result).resolves.toMatchObject({ ok: false, code: 'attach_failed' });
            expect(spawnProcess).not.toHaveBeenCalled();
        } finally { launchFileBoundary.beforeWrite = null; }
    });
    it.each(['unavailable', 'mismatched', 'withdrawn'] as const)('rejects %s exact managed-service access before ambient probing or child launch', async (outcome) => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-attach-access-'));
        const durability = createManagedServiceDurabilityOwner({ rootDir });
        const baseUrl = 'http://127.0.0.1:4312';
        const projectionToken = await durability.publishEndpointProjection({
            sessionId: 'session-one', pluginId: 'happier.agent.opencode',
            contributionId: 'happier.agent.opencode/agents/opencode',
            serverId: 'opencode-server', instanceId: 'server-one',
            sourceCustody: { kind: 'managed', immutableGenerationId: 'opencode-occurrence', installSource: 'localPath' },
            custodyOwner: 'sessionRunner', mode: 'externalAttach',
            endpoint: { baseUrl, host: '127.0.0.1', port: 4312 },
            process: null, createdAtMs: 1,
        });
        if (outcome === 'withdrawn') {
            await durability.releaseEndpointProjection({
                sessionId: 'session-one', pluginId: 'happier.agent.opencode',
                instanceId: 'server-one', projectionToken,
            });
        }
        // The runner RPC transport reports a real closed-protocol unavailable outcome.
        const owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'fixture-token', encryption: null },
            resolveProjection: (query) => durability.resolveEndpointProjection(query),
            resolveRunnerEndpointReadRpc: async (sessionId) => ({
                sessionId,
                call: async ({ request }) => {
                    const parsed = ManagedServiceEndpointReadOpenRequestV1Schema.parse(request);
                    return { v: 1, requestId: parsed.requestId, status: 'unavailable' };
                },
            }),
        });
        const fetchFn = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
        const { spawnProcess } = createTerminalLauncherFixture();
        const surface = createProviderCliAttachSurface({
            agentId: 'opencode', resolveTarget: resolveOpenCodeAttachTarget,
            createArgs: createOpenCodeAttachArgs, resolveReachability: resolveOpenCodeAttachReachability,
            managedServiceTargetBaseUrl: (target) => target.baseUrl,
            managedServiceCredentialEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
            managedServiceCredentialEnvironmentAliases: ['OPENCODE_PASSWORD'],
            resolveManagedServiceAccess: (input) => owner.resolveSessionClientAccess({
                ...input, pluginId: 'happier.agent.opencode',
                contributionId: 'happier.agent.opencode/agents/opencode',
                environmentKey: 'OPENCODE_SERVER_PASSWORD',
            }),
            resolveLaunchSpec: () => ({ source: 'managed', resolvedPath: '/fixture/opencode', command: '/fixture/opencode', args: [] }),
            env: { OPENCODE_SERVER_PASSWORD: 'ambient-wrong', OPENCODE_PASSWORD: 'ambient-wrong' },
            fetchFn,
            spawnProcess,
        });
        const metadata = {
            path: '/repo',
            runtimeDescriptorV1: { v: 1 as const, agentId: 'opencode' as const,
                agent: { backendMode: 'server', providerSessionId: 'native-one', serverBaseUrl: outcome === 'mismatched' ? 'https://operator.example.test' : baseUrl, serverBaseUrlExplicit: true } },
        };
        try {
            expect(await surface.evaluateAvailability?.({ operation: 'attach', sessionId: 'session-one', metadata, depth: 'live' }))
                .toMatchObject({ available: false, reasonCode: 'agent_unavailable' });
            expect(await surface.attach({ sessionId: 'session-one', metadata })).toMatchObject({ ok: false, code: 'attach_failed' });
            expect(fetchFn).not.toHaveBeenCalled();
            expect(spawnProcess).not.toHaveBeenCalled();
        } finally {
            await owner.dispose();
        }
    });

    it('launches provider-native attach with descriptor args and inherited stdio', async () => {
        const fixture = createTerminalLauncherFixture();
        const { spawnProcess, child } = fixture;
        const readFallbackServerBaseUrl = vi.fn(async (
            input: Readonly<{ sessionId: string }>,
        ) => input.sessionId === 'happier-session-1'
            ? 'https://fallback-opencode.example.test'
            : null);

        const surface = createProviderCliAttachSurface<{
            providerSessionId: string;
            directory: string;
            baseUrl: string;
        }>({
            agentId: 'opencode',
            resolveTarget: ({ metadata, fallbackServerBaseUrl }) => {
                const runtimeHandle = metadata.runtimeDescriptorV1?.agent;
                return {
                    ok: true,
                    value: {
                        providerSessionId: String(runtimeHandle?.providerSessionId),
                        directory: String(metadata.path),
                        baseUrl: fallbackServerBaseUrl ?? String(runtimeHandle?.serverBaseUrl),
                    },
                };
            },
            createArgs: (target) => [
                'attach',
                target.baseUrl,
                '--dir',
                target.directory,
                '--session',
                target.providerSessionId,
            ],
            readFallbackServerBaseUrl,
            resolveLaunchSpec: () => ({
                source: 'managed',
                resolvedPath: '/managed/opencode',
                command: 'opencode',
                args: ['--managed'],
            }),
            spawnProcess,
        });

        const attachPromise = surface.attach({
            sessionId: 'happier-session-1',
            metadata: {
                path: '/repo',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'opencode',
                    agent: {
                        providerSessionId: 'oc-session-1',
                        serverBaseUrl: 'https://metadata-opencode.example.test',
                    },
                },
            },
        });

        await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
        expect(fixture.readSpec()).toMatchObject({
            command: 'opencode', args: [
                '--managed',
                'attach',
                'https://fallback-opencode.example.test',
                '--dir',
                '/repo',
                '--session',
                'oc-session-1',
            ],
        });
        expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({ stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
        expect(readFallbackServerBaseUrl).toHaveBeenCalledWith({
            sessionId: 'happier-session-1',
        });

        child.emit('exit', 0, null);
        await expect(attachPromise).resolves.toEqual({
            ok: true,
            value: { exitCode: 0 },
        });
    });

    it.each([false, true])('stops the exact attach child and reports signal failures (killFails=%s)', async (killFails) => {
        vi.stubEnv('HAPPIER_LOG_LEVEL', 'info');
        vi.resetModules();
        const { createProviderCliAttachSurface: createSurface } = await import('./providerCliAttach');
        const { logger } = await import('@/ui/logger');
        logger.infoFile('Provider attach cleanup regression started');
        const kill = vi.fn((_signal: 'SIGINT' | 'SIGKILL') => {
            if (killFails) throw new Error('attach signal failed');
            return true;
        });
        let acknowledgeForcedSignal = () => {};
        const forcedSignal = new Promise<void>((resolve) => { acknowledgeForcedSignal = resolve; });
        const { spawnProcess, child } = createTerminalLauncherFixture({ onSignal: (signal) => {
            try { kill(signal); }
            finally { if (signal === 'SIGKILL') acknowledgeForcedSignal(); }
        } });
        const controller = new AbortController();
        const surface = createSurface<Record<string, never>>({
            agentId: 'codex',
            resolveTarget: () => ({ ok: true, value: {} }),
            createArgs: () => ['attach'],
            resolveLaunchSpec: () => ({
                source: 'managed',
                resolvedPath: '/managed/codex',
                command: 'codex',
                args: [],
            }),
            spawnProcess,
        });

        const attachPromise = surface.attach({
            sessionId: 'session-1',
            metadata: {},
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));

        try {
            controller.abort();
            await Promise.resolve();
            expect(kill).toHaveBeenCalledWith('SIGINT');
            if (killFails) {
                // node:timers retains its real clock; await the exact launcher signal.
                await forcedSignal;
                expect(kill).toHaveBeenCalledWith('SIGKILL');
                await vi.waitFor(async () => {
                    logger.flushSync();
                    const log = await readFile(logger.logFilePath, 'utf8');
                    expect(log).toContain('provider_attach_cleanup_signal_failed');
                    expect(log).toContain('SIGINT');
                    expect(log).toContain('SIGKILL');
                });
            }
            child.emit('exit', 0, 'SIGINT');
            await expect(attachPromise).resolves.toEqual({
                ok: true,
                value: { exitCode: 0 },
            });
        } finally {
            child.emit('exit', 0, 'SIGINT');
            vi.unstubAllEnvs();
        }
    });

    it('probes descriptor health URL with a bounded request', async () => {
        const fetchFn = vi.fn(async () => ({ ok: true }));
        const surface = createProviderCliAttachSurface<{ healthUrl: string }>({
            agentId: 'opencode',
            resolveTarget: () => ({ ok: true, value: { healthUrl: 'https://opencode.example.test/global/health' } }),
            createArgs: () => [],
            resolveReachability: (target) => ({ kind: 'http', url: target.healthUrl }),
            fetchFn: fetchFn as unknown as typeof fetch,
            reachabilityTimeoutMs: 25,
        });

        await expect(surface.evaluateAvailability?.({
            operation: 'attach',
            sessionId: 'session-1',
            metadata: {},
            depth: 'live',
        })).resolves.toEqual({ available: true });
        expect(fetchFn).toHaveBeenCalledWith(
            'https://opencode.example.test/global/health',
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('passes the exact selected CLI version to provider-owned argv and reachability', async () => {
        const createArgs = vi.fn(() => []);
        const resolveReachability = vi.fn(() => ({
            kind: 'http' as const,
            url: 'https://opencode.example.test/api/info',
        }));
        const fetchFn = vi.fn(async () => ({ ok: true }));
        const surface = createProviderCliAttachSurface<{ baseUrl: string }>({
            agentId: 'opencode',
            resolveTarget: () => ({ ok: true, value: { baseUrl: 'https://opencode.example.test' } }),
            createArgs,
            resolveReachability,
            cliVersionArgs: ['--version'],
            resolveCliVersion: async () => '2.0.15',
            resolveLaunchSpec: () => ({
                source: 'managed',
                resolvedPath: '/fixture/opencode-v2',
                command: '/fixture/opencode-v2',
                args: [],
            }),
            fetchFn: fetchFn as unknown as typeof fetch,
        });

        await expect(surface.evaluateAvailability?.({
            operation: 'attach',
            sessionId: 'session-1',
            metadata: {},
            depth: 'live',
        })).resolves.toEqual({ available: true });
        expect(resolveReachability).toHaveBeenCalledWith(
            { baseUrl: 'https://opencode.example.test' },
            { cliVersion: '2.0.15' },
        );
    });

    it('reuses one selected launch for the attach version probe and child spawn', async () => {
        const fixture = createTerminalLauncherFixture();
        const { spawnProcess, child } = fixture;
        const selectedLaunch = Object.freeze({
            source: 'system' as const,
            resolvedPath: '/tools/opencode-v2',
            command: '/tools/opencode-v2',
            args: Object.freeze(['--selected-v2']),
        });
        const resolveLaunchSpec = vi.fn(async () => selectedLaunch);
        const resolveCliVersion = vi.fn(async ({ launch }) => {
            expect(launch).toBe(selectedLaunch);
            return '2.0.15';
        });
        const surface = createProviderCliAttachSurface<Record<string, never>>({
            agentId: 'opencode',
            resolveTarget: () => ({ ok: true, value: {} }),
            cliVersionArgs: ['--version'],
            resolveLaunchSpec,
            resolveCliVersion,
            createArgs: (_target, host) => ['attach', `--version=${host.cliVersion ?? ''}`],
            spawnProcess,
        });

        const attachPromise = surface.attach({ sessionId: 'session-v2', metadata: {} });
        await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
        expect(resolveLaunchSpec).toHaveBeenCalledTimes(1);
        expect(resolveCliVersion).toHaveBeenCalledWith({
            launch: selectedLaunch,
            args: ['--version'],
            env: expect.any(Object),
        });
        expect(fixture.readSpec()).toMatchObject({ command: '/tools/opencode-v2', args: ['--selected-v2', 'attach', '--version=2.0.15'] });
        child.emit('exit', 0, null);
        await expect(attachPromise).resolves.toEqual({ ok: true, value: { exitCode: 0 } });
    });

    it('uses exact managed-service access for authenticated health and child credentials', async () => {
        const fixture = createTerminalLauncherFixture();
        const { spawnProcess, child } = fixture;
        const request = vi.fn(async () => ({ ok: true }));
        const resolveManagedServiceAccess = vi.fn(async () => ({
            baseUrl: 'http://127.0.0.1:4096/',
            request,
            childEnvironment: Object.freeze({
                OPENCODE_SERVER_PASSWORD: 'exact-host-owned-password',
                OPENCODE_PASSWORD: 'wrong-returned-alias',
                PATH: '/wrong-returned-path',
            }),
        }));
        const ambientEnv = Object.freeze({
            PATH: '/bin',
            OPENCODE_PASSWORD: 'wrong-canonical-ambient-password',
            OPENCODE_SERVER_PASSWORD: 'wrong-ambient-password',
        });
        const surface = createProviderCliAttachSurface<{ baseUrl: string }>({
            agentId: 'opencode',
            resolveTarget: () => ({
                ok: true,
                value: { baseUrl: 'http://127.0.0.1:4096/' },
            }),
            createArgs: () => [
                '--server',
                'http://127.0.0.1:4096/',
                '--session',
                'opencode-session-1',
                '/repo',
            ],
            resolveReachability: () => ({
                kind: 'http',
                url: 'http://127.0.0.1:4096/api/info',
            }),
            resolveManagedServiceAccess,
            managedServiceTargetBaseUrl: (target) => target.baseUrl,
            managedServiceCredentialEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
            managedServiceCredentialEnvironmentAliases: ['OPENCODE_PASSWORD'],
            resolveLaunchSpec: () => ({
                source: 'managed',
                resolvedPath: '/managed/opencode',
                command: 'opencode',
                args: [],
            }),
            env: ambientEnv,
            spawnProcess,
        });

        await expect(surface.evaluateAvailability?.({
            operation: 'attach',
            sessionId: 'session-1',
            metadata: {},
            depth: 'live',
        })).resolves.toEqual({ available: true });
        expect(request).toHaveBeenCalledWith({
            pathAndQuery: '/api/info',
            signal: expect.any(AbortSignal),
        });

        const attachPromise = surface.attach({ sessionId: 'session-1', metadata: {} });
        await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
        expect(fixture.readSpec()).toMatchObject({
            command: 'opencode', args: [
                '--server',
                'http://127.0.0.1:4096/',
                '--session',
                'opencode-session-1',
                '/repo',
            ], env: {
                    PATH: '/bin',
                    OPENCODE_PASSWORD: 'exact-host-owned-password',
                    OPENCODE_SERVER_PASSWORD: 'exact-host-owned-password',
                },
        });
        expect(ambientEnv.OPENCODE_SERVER_PASSWORD).toBe('wrong-ambient-password');
        child.emit('exit', 0, null);
        await attachPromise;
    });

    it('probes a provider-owned local socket through the canonical attach reachability seam', async () => {
        const probeSocket = vi.fn(async () => true);
        const surface = createProviderCliAttachSurface<{ socketPath: string }>({
            agentId: 'codex',
            resolveTarget: () => ({ ok: true, value: { socketPath: '/tmp/codex.sock' } }),
            createArgs: () => [],
            resolveReachability: (target) => ({ kind: 'localSocket', path: target.socketPath }),
            probeSocket,
            reachabilityTimeoutMs: 25,
        });

        await expect(surface.evaluateAvailability?.({
            operation: 'attach',
            sessionId: 'session-1',
            metadata: {},
            depth: 'live',
        })).resolves.toEqual({ available: true });
        expect(probeSocket).toHaveBeenCalledWith('/tmp/codex.sock', 25);
    });

    it('uses the Codex rendezvous path as the Windows local-socket liveness signal', async () => {
        const statPath = vi.fn(async () => ({}) as never);

        await expect(probeLocalSocket('C:\\Temp\\codex.sock', 25, {
            platform: 'win32',
            statPath,
        })).resolves.toBe(true);
        expect(statPath).toHaveBeenCalledWith('C:\\Temp\\codex.sock');
    });

    it('does not use local managed-server fallback when evaluating a remote provider attach target', async () => {
        const resolveTarget = vi.fn(({ fallbackServerBaseUrl }: { fallbackServerBaseUrl?: string | null }) =>
            fallbackServerBaseUrl
                ? { ok: true as const, value: { baseUrl: fallbackServerBaseUrl } }
                : { ok: false as const, reason: 'missing explicit remote server URL' },
        );
        const surface = createProviderCliAttachSurface<{ baseUrl: string }>({
            agentId: 'opencode',
            resolveTarget,
            createArgs: () => [],
            readFallbackServerBaseUrl: async () => 'http://127.0.0.1:4096/',
        });

        await expect(surface.evaluateAvailability?.({
            operation: 'attach',
            sessionId: 'session-1',
            metadata: {},
            currentMachineId: 'machine-local',
            sessionMachineId: 'machine-remote',
            hasLocalAttachmentInfo: false,
        })).resolves.toEqual({
            available: false,
            reasonCode: 'missing_metadata',
            safeMessage: 'missing explicit remote server URL',
        });
        expect(resolveTarget).toHaveBeenCalledWith({ metadata: {}, fallbackServerBaseUrl: null });
    });

    it('spawns the resolved platform invocation instead of the raw provider command', async () => {
        const fixture = createTerminalLauncherFixture();
        const { spawnProcess, child } = fixture;
        const surface = createProviderCliAttachSurface<{ providerSessionId: string }>({
            agentId: 'opencode',
            resolveTarget: () => ({ ok: true, value: { providerSessionId: 'oc-session-1' } }),
            createArgs: (target) => ['attach', '--session', target.providerSessionId],
            resolveLaunchSpec: () => ({
                source: 'managed',
                resolvedPath: 'opencode.cmd',
                command: 'opencode.cmd',
                args: ['--managed'],
            }),
            resolveCommandInvocation: ({ command, args }) => ({
                command: 'cmd.exe',
                args: ['/d', '/s', '/c', `"${command} ${args.join(' ')}"`],
                windowsVerbatimArguments: true,
            }),
            spawnProcess,
        });

        const attachPromise = surface.attach({ sessionId: 'session-1', metadata: {} });

        await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
        expect(fixture.readSpec()).toMatchObject({
            command: 'cmd.exe', args: ['/d', '/s', '/c', '"opencode.cmd --managed attach --session oc-session-1"'],
                windowsVerbatimArguments: true,
        });

        child.emit('exit', 0, null);
        await expect(attachPromise).resolves.toEqual({
            ok: true,
            value: { exitCode: 0 },
        });
    });
});

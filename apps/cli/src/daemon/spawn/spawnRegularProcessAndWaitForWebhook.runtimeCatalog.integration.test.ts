import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_SECURITY_PATH_V1,
  AccountSecurityGetResponseV1Schema,
  MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
  MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
  MachineUpdateOperationProtocolCapabilitiesResponseV1Schema,
  SessionMetadataTuplePatchV1Schema,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '../types';
import { createPersistedTakeoverAdmissionWaiter } from './persistedTakeoverAdmission';
import { withTakeoverAdmissionCommitRevalidation } from './spawnCommitRevalidation';
import { withTempDir } from '@/testkit/fs/tempDir';
import { configuration, reloadConfiguration } from '@/configuration';
import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import { listSessionMarkers } from '../sessionRegistry';
import { createOnChildExited } from '../sessions/onChildExited';
import { createSpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { persistAcceptedSpawnMarker } from './persistAcceptedSpawnMarker';
import { createSpawnHappyCliEnvScope, withTempHappyCliEntrypoint } from '@/testkit/process/spawnHappyCliHarness';
import { spawnRegularProcessAndWaitForWebhook } from './spawnRegularProcessAndWaitForWebhook';
import { routeSpawnModeAndWaitForWebhook } from './routeSpawnModeAndWaitForWebhook';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDaemonPluginDevelopmentRootsOwner } from '@/plugins/daemon/developmentRoots';
import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import { buildAgentCliSessionCommandBuildInput, partitionProviderSessionArgs } from '@/cli/providerSessionArgPartition';
import { parseAndStripTerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { buildPluginHostSessionRuntimeOptions, buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { resolveProviderSessionRuntimePreferences } from '@/session/runtime/catalogHooks';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { prepareRunnerAgentSessionBootstrapForLease } from './prepareAgentRuntimeSessionBridge';
import { createRunnerAgentSessionRuntimeBootstrap } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { captureSessionLaunchControlMetadata, createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { resolveTerminalRequestFromSpawnOptions } from '@/terminal/runtime/terminalConfig';
import { createHerdrClient } from '@/integrations/herdr/client';
import { HERDR_ACTION_TIMEOUT_MS, HERDR_STARTUP_TIMEOUT_MS } from '@/integrations/herdr/runtimeBinary';
import { createHerdrTerminalHostAdapter } from '@/integrations/herdr/adapter';
import { createTerminalAttachmentId, readTerminalHostAttachmentInfo, readTerminalHostAttachmentState, removeTerminalHostAttachmentInfo, writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { probeSessionRunnerServiceability } from '../sessions/isSessionRunnerActive';
import { resolveDisconnectedTerminalHostResumeGate, resolveTrackedSessionTerminalHostExitCandidate, shouldRetainTrackedTerminalHostExitMarker, superviseDisconnectedTerminalHostCandidate, superviseTrackedOptionalTerminalPresentation } from '../sessions/disconnectedTerminalHostSupervision';
import { startDaemonHeartbeatLoop } from '../lifecycle/heartbeat';
import { retireExactTerminalControlServiceability } from '../sessions/retireTerminalControlServiceability';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { acquireDaemonLock, readDaemonState, releaseDaemonLock, writeDaemonStateForLockOwner } from '@/persistence';
import { resolveComparableCliVersion } from '../resolveComparableCliVersion';
import { projectPath } from '@/projectPath';
import { createStopSession } from '../sessions/stopSession';
import { waitForTrackedRunnerProcessesExit } from '../sessions/waitForTrackedRunnerProcessesExit';
import { buildTerminalMetadataFromHostHandle } from '@/terminal/runtime/terminalMetadata';
import { resolveDaemonSessionTerminalPresentation } from '../sessions/resolveTrackedSessionTerminalPresentation';
import { ApiMachineClient } from '@/api/apiMachine';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const mocks = vi.hoisted(() => ({
  spawnHappyCLI: vi.fn(),
  writeFile: vi.fn(),
  io: vi.fn(),
}));

vi.mock('socket.io-client', () => ({ io: mocks.io }));

vi.mock('@/utils/spawnHappyCLI', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/spawnHappyCLI')>(),
  // Only child creation is an OS boundary; keep launch-spec selection real.
  spawnHappyCLI: mocks.spawnHappyCLI,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // Linux now uses its real cgroup launch composer even for manual daemons.
    // Stub only that resulting OS child creation; real fixture children and
    // process census still execute normally.
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (args[0] === '/bin/sh' && args[2]?.env?.HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR) {
        return mocks.spawnHappyCLI(args[1], args[2]);
      }
      return actual.spawn(...args);
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  writeFile: mocks.writeFile,
}));

function createFakeChildProcess(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function createParams() {
  return {
    args: ['opencode'],
    directory: '/tmp/happier-project',
    options: { directory: '/tmp/happier-project' },
    trackedSpawnOptions: { directory: '/tmp/happier-project' },
    normalizedExistingSessionId: '',
    effectiveResume: '',
    directoryCreated: false,
    extraEnvForChildWithMessage: {},
    processEnv: {
      PATH: process.env.PATH,
      HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
      HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ: '321',
    },
    pidToTrackedSession: new Map(),
    pidToAwaiter: new Map(),
    pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(),
    resolveCanonicalTrackedSessionId: vi.fn(() => 'session-1'),
    onChildExited: vi.fn(),
    spawnLifecycleCallbacks: {
      registerConnectedServiceSpawnTarget: vi.fn(),
      registerSpawnResourceCleanupForPid: vi.fn(),
      cleanupSpawnResourcesForPid: vi.fn(async () => true),
      consumeSessionAttachCleanupForPid: vi.fn(),
      cleanupPendingSessionAttach: vi.fn(async () => {}),
      persistAcceptedSpawnMarker:
        vi.fn(async (_tracked: TrackedSession) => {}),
      removeAcceptedSpawnMarkerIfOwned:
        vi.fn(async () => true),
    },
    cleanupSpawnResources: vi.fn(),
    logDebug: vi.fn(),
    warn: vi.fn(),
  } as const;
}

describe('spawnRegularProcessAndWaitForWebhook', () => {
  let routeRegistryGeneration = 0;
  let pendingCapturedCase: Promise<void> | undefined;
  let currentTestSignal: AbortSignal | undefined;
  const originalOomScoreAdjustment = process.env.HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ;
  const originalSessionWebhookTimeoutMs = process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalPlatform = process.platform;
  const originalDebug = process.env.DEBUG;

  beforeEach((context) => {
    currentTestSignal = context.signal;
    mocks.spawnHappyCLI.mockReset().mockReturnValue(createFakeChildProcess(4242));
    mocks.writeFile.mockReset().mockResolvedValue(undefined);
    process.env.HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ = '321';
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
  });

  afterAll(async () => {
    // The real singleton's shutdown is terminal, not a per-case reset.
    await pluginReloadController.shutdown();
  });

  it.skipIf(originalPlatform === 'win32').each([
    ['codex', 'acp', 'none', 'herdr'],
    ['codex', 'appServer', 'provider_attach', 'herdr'],
    ['codex', 'appServer', 'provider_attach', 'plain'],
    ['opencode', 'server', 'provider_attach', 'herdr'],
    ['opencode', 'server', 'provider_attach', 'plain'],
    ['claude', 'agentSdk', 'runner', 'plain'],
    ['claude', 'unifiedTerminal', 'managed_terminal', 'zellij'],
  ] as const)('carries captured %s/%s %s placement for %s through the real route without hosting its controller', async (agentId, backendMode, presentationKind, requestedHost) => {
    const signal = currentTestSignal;
    if (!signal) throw new Error('The canonical test context did not provide its cancellation signal');
    let currentPhase = 'entrypoint';
    let childToCancel: ChildProcess | undefined;
    let normalChildToCancel: ChildProcess | undefined;
    let releaseHeldRead: (() => void) | undefined;
    const enterPhase = (phase: string) => {
      signal.throwIfAborted();
      currentPhase = phase;
    };
    const cancelOwnedWork = () => {
      console.error('[captured-route-fixture] Test aborted', { agentId, backendMode, phase: currentPhase });
      releaseHeldRead?.();
      for (const child of [childToCancel, normalChildToCancel]) {
        if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    };
    signal.addEventListener('abort', cancelOwnedWork, { once: true });
    const work = withTempHappyCliEntrypoint(async (entrypoint) => {
      const envScope = createSpawnHappyCliEnvScope();
      const features = createEnvKeyScope(['HAPPIER_FEATURE_AGENTS_CLAUDE_UNIFIED_TERMINAL__ENABLED', 'HAPPIER_FEATURE_SESSIONS_DIRECT__ENABLED']);
      features.patch({ HAPPIER_FEATURE_AGENTS_CLAUDE_UNIFIED_TERMINAL__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_DIRECT__ENABLED: '1' });
      envScope.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
        HAPPIER_MANAGED_NODE_BIN: process.execPath, HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0' });
      try {
        await withTempDir('happier-headless-spawn-custody-', async (homeDir) => await withHerdrApi(async api => {
          const previousHomeDir = process.env.HAPPIER_HOME_DIR;
          const previousHerdrBinary = process.env.HERDR_BIN_PATH;
          process.env.HAPPIER_HOME_DIR = homeDir;
          api.setServerVersion('0.9.3');
          process.env.HERDR_BIN_PATH = writeExecutableShimSync({
            dir: homeDir, fileName: 'herdr', contents: `#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args.includes('--version'))console.log('herdr 0.9.3');\nelse console.log(${JSON.stringify(JSON.stringify({ sessions: [{ name: 'fixture', socket_path: api.socketPath, running: true }] }))});\n`,
          });
          reloadConfiguration();
          const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
          mocks.writeFile.mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
            // Keep real fixture persistence; the Linux resource adapter must not write test /proc state.
            if (typeof args[0] === 'string' && args[0].startsWith('/proc/')) return;
            return await fs.writeFile(...args);
          });
          const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: join(homeDir, 'device-local-key.json') });
          const child = spawn(process.execPath, ['-e', '/* herdr-route-captured-boundary */ setInterval(() => {}, 1000)'], { cwd: homeDir, detached: true, stdio: 'ignore' });
          childToCancel = child;
          await once(child, 'spawn');
          const exited = once(child, 'exit');
          const pid = child.pid!;
          mocks.spawnHappyCLI.mockReturnValueOnce(child);
          const pidToTrackedSession = new Map<number, TrackedSession>();
          const spawnResourceCleanupByPid = new Map<number, () => void | Promise<void>>();
          const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
          const onChildExited = createOnChildExited({
            pidToTrackedSession, spawnResourceCleanupByPid, sessionAttachCleanupByPid,
            getApiMachineForSessions: () => null,
          });
          const spawnLifecycleCallbacks = createSpawnLifecycleCallbacks({
            connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: '',
            hasConnectedServiceAuth: () => false,
            getSpawnResourceCleanupOnExit: () => null, onSpawnResourceCleanupArmed: () => {},
            spawnResourceCleanupByPid,
            getSessionAttachCleanup: () => null, setSessionAttachCleanup: () => {},
            sessionAttachCleanupByPid,
            persistAcceptedSpawnMarker: (trackedSession) => persistAcceptedSpawnMarker({ trackedSession, deviceLocalSecretStorage }),
          });
          const params = {
            ...createParams(), args: [agentId], directory: homeDir, pidToTrackedSession, onChildExited, spawnLifecycleCallbacks,
            options: { directory: homeDir, runtimeDescriptorV1: { v: 1 as const, agentId, agent: { backendMode } } },
            trackedSpawnOptions: {
              directory: homeDir,
              backendTarget: { kind: 'backend' as const, sourceKind: 'built_in' as const, backendId: agentId },
              terminal: { mode: requestedHost, herdr: { sessionName: 'fixture' } },
            },
          };
          const developmentRoots = createDaemonPluginDevelopmentRootsOwner({ happyHomeDir: homeDir,
            submitObservation: async () => { throw new Error('This fixture does not observe development sources'); } });
          let bootstrap: Awaited<ReturnType<typeof prepareRunnerAgentSessionBootstrapForLease>> = null;
          let relayToClose: Server | undefined;
          const previousServer = process.env.HAPPIER_SERVER_URL;
          try {
            enterPhase('registry admission');
            const generation = ++routeRegistryGeneration;
            const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: homeDir, generation,
              resolveDevelopmentSourceAuthority: developmentRoots.resolveDevelopmentSourceAuthority });
            const adoption = await pluginReloadController.adoptPreparedRuntimeRegistry({ registry, changedPluginIds: [],
              durableRevision: generation, runningSessionDisposition: 'retainRunningSessions' });
            if (!adoption.ok) throw new Error('Failed to prepare actual daemon runtime');
            enterPhase('selected runtime');
            const surfaces = await resolveBackendExecutionSurfaces(params.trackedSpawnOptions.backendTarget, { runtimeRegistry: registry });
            if (!surfaces.resolveTerminalPresentation) throw new Error('Actual runtime has no placement owner');
            const selection = {
              cwd: homeDir, requestedHost, runtimeDescriptorV1: params.options.runtimeDescriptorV1,
              launchEnvironment: { values: {}, unset: [] },
            };
            const selected = await resolveDaemonSessionTerminalPresentation(surfaces, selection);
            expect(selected.kind).toBe(presentationKind);
            if (!selected.runtimeDescriptorV1) throw new Error('The actual placement owner did not capture its selected runtime');
            expect(selected.runtimeDescriptorV1).toMatchObject(params.options.runtimeDescriptorV1);
            const recoveryPresentation = await resolveDaemonSessionTerminalPresentation(surfaces, {
              ...selection, runtimeDescriptorV1: selected.runtimeDescriptorV1,
            }, 'session-1');
            expect(recoveryPresentation).toEqual(presentationKind === 'provider_attach'
              ? { ...selected, startingMode: 'remote' }
              : selected);
            if (presentationKind === 'provider_attach') {
              expect(selected.startingMode).toBe(requestedHost === 'plain' ? 'remote' : 'terminal');
            }
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
            try {
              bootstrap = await prepareRunnerAgentSessionBootstrapForLease({
                target: params.trackedSpawnOptions.backendTarget, lease,
                launch: { runtimeDescriptorV1: selected.runtimeDescriptorV1 },
              });
            } finally { await lease.release(); }
            if (!bootstrap) throw new Error('The actual admitted Agent did not issue its runner bootstrap');
            enterPhase('controller route');
            const terminalRequest = resolveTerminalRequestFromSpawnOptions({ happyHomeDir: homeDir, terminal: params.trackedSpawnOptions.terminal });
            if (terminalRequest.requested === 'herdr') {
              const client = createHerdrClient({ binary: process.env.HERDR_BIN_PATH!, sessionName: terminalRequest.herdr.sessionName,
                processEnv: params.processEnv, actionTimeoutMs: HERDR_ACTION_TIMEOUT_MS, startupTimeoutMs: HERDR_STARTUP_TIMEOUT_MS });
              terminalRequest.herdr.socketPath = await client.ensureServer();
              expect(terminalRequest.herdr.socketPath).toBe(api.socketPath);
            }
            const pending = routeSpawnModeAndWaitForWebhook({ ...params,
              runnerAgentSessionBootstrapAuthorization: bootstrap.authorization,
              extraEnvForChildWithMessage: bootstrap.childEnv,
              terminalPresentation: selected,
              terminalRequest,
              effectiveBackendTargetV2: params.trackedSpawnOptions.backendTarget,
              happyHomeDir: homeDir, onUntrackedHostedChild: () => {},
            });
            await vi.waitFor(() => expect(params.pidToAwaiter.has(pid)).toBe(true)).catch(async () => {
              const result = await pending;
              expect(api.requests.filter(request => request.method === 'layout.apply')).toEqual([]);
              expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
            });
            const tracked = pidToTrackedSession.get(pid)!;
            // Network webhook boundary: the pre-session PID placeholder is sufficient for this spawn-custody assertion.
            params.pidToAwaiter.get(pid)?.({ ...tracked });
            await pending;
            enterPhase('bootstrap metadata');
            expect(api.requests.filter(request => request.method === 'layout.apply')).toEqual([]);
            // The native-client placement must cross the actual CLI ingress,
            // not just remain in the daemon's selection result.
            const launchArgs: unknown = mocks.spawnHappyCLI.mock.calls.at(-1)?.[0];
            expect(mocks.spawnHappyCLI.mock.calls.at(-1)?.[1]).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });
            if (!Array.isArray(launchArgs) || !launchArgs.every((arg): arg is string => typeof arg === 'string')) {
              throw new Error('The actual controller launch did not reach the OS boundary');
            }
            const terminal = parseAndStripTerminalRuntimeFlags([...launchArgs].slice(1));
            const parsed = partitionProviderSessionArgs({ args: terminal.argv, providerSubcommand: agentId });
            const expectedStartingMode = requestedHost === 'plain' || presentationKind === 'none' ? 'remote' : 'terminal';
            expect(parsed.startingMode).toBe(expectedStartingMode);
            const providerOptions = await resolveProviderSessionRuntimePreferences(agentId, buildAgentCliSessionCommandBuildInput({
              settings: {}, processEnv: {}, startedBy: 'daemon', isExplicitCliSubcommand: true, parsed,
            }));
            const binding = buildPluginSessionBindingInput({
              credentials: { token: 'fixture-token', encryption: null }, directory: homeDir,
              startingMode: parsed.startingMode, ...providerOptions,
              startedBy: parsed.startedBy, terminalRuntime: terminal.terminal,
            });
            expect(binding.runtimePreferences.startingMode).toBe(expectedStartingMode === 'terminal' && agentId === 'codex' ? 'local' : expectedStartingMode);
            if (requestedHost !== 'plain' && (presentationKind === 'provider_attach' || presentationKind === 'managed_terminal')) {
              expect(binding.runtimePreferences.terminal).toMatchObject({ mode: 'plain', requested: requestedHost });
              if (requestedHost === 'herdr') expect(binding.runtimePreferences.terminal).toMatchObject({ herdrSessionName: 'fixture', herdrSocketPath: api.socketPath });
            }
            const source = await createRunnerAgentSessionRuntimeBootstrap({
              happyHomeDir: homeDir, publicReleaseRing: configuration.publicReleaseRing,
              authorityFilePath: bootstrap.authorization.authorityFilePath,
              bootstrapFilePath: bootstrap.authorization.bootstrapFilePath,
            });
            if (!source) throw new Error('The actual runner could not consume its admitted bootstrap');
            const hostOptions = buildPluginHostSessionRuntimeOptions({ ...binding, bootstrap: {
              ...binding.bootstrap, runtimeDescriptorV1: source.startupRuntimeDescriptorV1,
            } });
            const captured = createSessionMetadata({
              flavor: agentId, machineId: 'route-machine', directory: homeDir,
              runtimeDescriptorV1: hostOptions.runtimeDescriptorV1,
              launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {} }),
            });
            expect(captured.metadata.runtimeDescriptorV1).toEqual(selected.runtimeDescriptorV1);
            const marker = (await listSessionMarkers()).find((candidate) => candidate.pid === pid);
            expect(tracked.spawnOptions?.terminal?.mode).toBe(presentationKind === 'none' ? 'plain' : requestedHost);
            expect(marker?.respawn?.terminal?.mode).toBe(presentationKind === 'none' ? 'plain' : requestedHost);
            expect(tracked.hostedTerminal).toBeUndefined();
            expect(tracked.tmuxSessionId).toBeUndefined();
            if (presentationKind === 'provider_attach' || backendMode === 'agentSdk') {
              // The socket is the external presenter boundary. The registered
              // runtime, exact descriptor, runner-presence and disposition owners remain real.
              api.panes.add('managed');
              const attachment = await writeTerminalHostAttachmentInfo({
                happyHomeDir: homeDir, sessionId: 'session-1', handle: {
                  kind: 'herdr', sessionName: 'fixture', socketPath: api.socketPath,
                  paneId: 'managed', terminalId: 'terminal_1',
                  attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
                },
              });
              if (attachment.version !== 2) throw new Error('The actual owned descriptor was not written');
              const candidate = {
                sessionId: 'session-1', pid, happyHomeDir: homeDir,
                attachmentId: attachment.attachmentId, handle: attachment.handle,
                spawnOptions: { ...tracked.spawnOptions, directory: homeDir, backendTarget: params.trackedSpawnOptions.backendTarget,
                  runtimeDescriptorV1: selected.runtimeDescriptorV1,
                  environmentVariables: selected.environmentOverlay },
              };
              if (presentationKind === 'provider_attach') {
                // Accepted webhook data is a network boundary; all runtime
                // selection and the metadata producer above remain canonical.
                const observed: TrackedSession = { ...tracked, happySessionId: 'session-1',
                  spawnOptions: candidate.spawnOptions, happySessionMetadataFromLocalWebhook: captured.metadata };
                pidToTrackedSession.set(pid, observed);
                api.panes.delete('managed');
                const rawSession = createSessionRecordFixture({ id: 'session-1', encryptionMode: 'plain',
                  metadataLayoutVersion: 0, metadataVersion: 4,
                  metadata: JSON.stringify({ ...captured.metadata, terminal: { mode: 'herdr',
                    controlServiceabilityV1: { v: 1, attachmentId: attachment.attachmentId, state: 'servable', observedAt: 1 } } }),
                });
                const retirementRequests: unknown[] = [];
                const relay = createServer(async (request, response) => {
                  response.setHeader('Content-Type', 'application/json');
                  if (request.method === 'GET' && request.url === ACCOUNT_SECURITY_PATH_V1) {
                    response.end(JSON.stringify(AccountSecurityGetResponseV1Schema.parse({ v: 1,
                      encryptionMode: 'plain', terminalPresentUserPolicy: 'allowed', nativeEmail: null,
                      password: { status: 'not_enrolled', revision: null } })));
                  } else if (request.method === 'GET' && request.url === '/v2/sessions/session-1') {
                    response.end(JSON.stringify({ session: rawSession }));
                  } else if (request.method === 'GET' && request.url === '/v1/account/encryption/currentness') {
                    response.end(JSON.stringify({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
                  } else if (request.method === 'PATCH' && request.url === '/v2/sessions/session-1') {
                    request.setEncoding('utf8');
                    let body = '';
                    for await (const chunk of request) {
                      if (typeof chunk !== 'string') throw new Error('Unexpected HTTP body chunk');
                      body += chunk;
                    }
                    retirementRequests.push(JSON.parse(body));
                    response.end(JSON.stringify({ success: true, metadataLayoutVersion: 1,
                      sharedMetadata: { version: 5 }, agentState: { version: 0 } }));
                  } else { response.statusCode = 404; response.end('{}'); }
                });
                relayToClose = relay;
                await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
                {
                const address = relay.address();
                if (!address || typeof address === 'string') throw new Error('The owned relay did not bind a TCP endpoint');
                process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
                reloadConfiguration();
                const lock = await acquireDaemonLock();
                if (!lock) throw new Error('The owned heartbeat fixture did not acquire its daemon lock');
                let interval: NodeJS.Timeout | undefined;
                const originalSetInterval = global.setInterval;
                let tick: () => Promise<void> = async () => { throw new Error('The heartbeat clock was not scheduled'); };
                const clock = vi.spyOn(global, 'setInterval').mockImplementation((handler, delay, ...args) => {
                  tick = async () => { await handler(...args); };
                  return originalSetInterval(() => {}, delay);
                });
                try {
                  const hostAdapter = createHerdrTerminalHostAdapter({ binary: process.env.HERDR_BIN_PATH!,
                    sessionName: 'fixture', socketPath: api.socketPath,
                    actionTimeoutMs: HERDR_ACTION_TIMEOUT_MS, startupTimeoutMs: HERDR_STARTUP_TIMEOUT_MS });
                  const currentCliVersion = resolveComparableCliVersion({ fallbackVersion: '0.3.0', projectRootPath: projectPath() });
                  const heartbeatParams = {
                    pidToTrackedSession, spawnResourceCleanupByPid, sessionAttachCleanupByPid,
                    getApiMachineForSessions: () => null, onChildExited,
                    controlPort: address.port, fileState: { pid: process.pid, httpPort: address.port,
                      startedAt: Date.now(), startedWithCliVersion: currentCliVersion,
                      daemonLogPath: join(homeDir, 'heartbeat.log') },
                    currentCliVersion,
                    requestShutdown: () => { throw new Error('The owned current heartbeat cannot require shutdown'); },
                    writeDaemonStateForCurrentOwner: (state: Parameters<typeof writeDaemonStateForLockOwner>[1]) => writeDaemonStateForLockOwner(lock, state),
                    onTrackedSessionHealthy: (current: TrackedSession) => superviseTrackedOptionalTerminalPresentation({
                      tracked: current, isCurrent: () => pidToTrackedSession.get(pid) === current, happyHomeDir: homeDir,
                      loadTerminalHostAdapters: async () => ({ herdr: hostAdapter }),
                      probeSessionServiceability: (sessionId) => probeSessionRunnerServiceability({ sessionId,
                        trackedSessions: pidToTrackedSession.values(),
                        probeCapability: async () => { throw new Error('Positive-dead presenter retirement does not call native control'); } }),
                      retireExactTerminalControlServiceability: (fact) => retireExactTerminalControlServiceability({
                        credentials: { token: 'fixture-token', encryption: null }, sessionId: fact.sessionId,
                        attachmentId: fact.attachmentInfo.attachmentId, terminalMode: fact.terminalMode }),
                    }),
                  };
                  interval = startDaemonHeartbeatLoop(heartbeatParams);
                  clock.mockRestore();
                  enterPhase('heartbeat retirement');
                  await tick();
                  enterPhase('Stop safety guards');
                  expect(await readDaemonState()).toMatchObject({ pid: process.pid, httpPort: address.port, lastHeartbeatAt: expect.any(Number) });
                  expect(await readTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-1' })).toBeNull();
                  const retirement = SessionMetadataTuplePatchV1Schema.parse(retirementRequests.at(-1));
                  if (retirement.mode !== 'owner_migration' || retirement.target.ownerMetadata.t !== 'plain') throw new Error('The real plain owner did not publish retirement');
                  expect(retirement.target.ownerMetadata.v).toMatchObject({ runtime: { terminal: { controlServiceabilityV1: {
                    attachmentId: attachment.attachmentId, retired: true, state: 'unknown', reason: 'attachment_retired' } } } });
                  expect(child.exitCode).toBeNull();
                  expect(child.signalCode).toBeNull();
                  expect(process.kill(pid, 0)).toBe(true);
                  expect(pidToTrackedSession.get(pid)).toBe(observed);
                  expect((await listSessionMarkers()).some((current) => current.pid === pid)).toBe(true);
                  const markerBeforeStop = (await listSessionMarkers()).find(current => current.pid === pid);
                  expect(observed.processStartTimeMs).toBeTypeOf('number');
                  expect(markerBeforeStop?.processStartTimeMs).toBe(observed.processStartTimeMs);
                  if (typeof observed.processStartTimeMs !== 'number') throw new Error('The accepted marker lacks its real OS generation');
                  const stop = createStopSession({ pidToTrackedSession,
                    areTrackedRunnersExited: ({ trackedPids }) => waitForTrackedRunnerProcessesExit({
                      runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0 }),
                    waitForTrackedRunnersExit: ({ trackedPids }) => waitForTrackedRunnerProcessesExit({
                      runners: trackedPids.map(pid => ({ pid })), timeoutMs: configuration.daemonSpawnExistingSessionWaitForExitMs,
                      pollIntervalMs: configuration.daemonSpawnExistingSessionWaitForExitPollIntervalMs, onExitObserved: onChildExited }),
                  });
                  pidToTrackedSession.set(pid, { ...observed, processStartTimeMs: observed.processStartTimeMs + 1 });
                  expect(await stop('session-1')).toEqual({ status: 'incomplete', reason: 'missing_attachment_identity' });
                  expect(process.kill(pid, 0)).toBe(true);
                  pidToTrackedSession.set(pid, { ...observed, startedBy: 'terminal' });
                  expect(await stop('session-1')).toEqual({ status: 'incomplete', reason: 'missing_attachment_identity' });
                  expect(process.kill(pid, 0)).toBe(true);
                  pidToTrackedSession.set(pid, observed);
                  // Hold only the genuine procfs read; a replacement tracked
                  // object cannot inherit the earlier absent-presenter proof.
                  const fsBoundary = await import('node:fs/promises');
                  const readFile = fs.readFile;
                  let readStarted = false;
                  let releaseRead = () => {};
                  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
                  releaseHeldRead = releaseRead;
                  const readSpy = vi.spyOn(fsBoundary, 'readFile').mockImplementation(async (...args) => {
                    if (args[0] === `/proc/${pid}/stat` && !readStarted) {
                      readStarted = true;
                      await readGate;
                    }
                    return await readFile(...args);
                  });
                  const replacedStop = stop('session-1');
                  try {
                    await vi.waitFor(() => expect(readStarted).toBe(true));
                    pidToTrackedSession.set(pid, { ...observed });
                    releaseRead();
                    expect(await replacedStop).toEqual({ status: 'incomplete', reason: 'missing_attachment_identity' });
                    expect(process.kill(pid, 0)).toBe(true);
                  } finally {
                    releaseRead();
                    try { await replacedStop; }
                    finally {
                      readSpy.mockRestore();
                      releaseHeldRead = undefined;
                      pidToTrackedSession.set(pid, observed);
                    }
                  }
                  enterPhase('positive Stop');
                  expect(await stop('session-1')).toEqual({ status: 'stopped' });
                  await exited;
                  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
                } finally {
                  if (interval) clearInterval(interval);
                  clock.mockRestore();
                  await releaseDaemonLock(lock);
                }
                }
                enterPhase('orphan presenter recovery');
                api.panes.add('managed');
                await writeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-1', handle: attachment.handle });
              }
              const supervision = await superviseDisconnectedTerminalHostCandidate({
                candidate, terminalHostAdapters: { herdr: createHerdrTerminalHostAdapter({
                  binary: process.env.HERDR_BIN_PATH!, sessionName: 'fixture', socketPath: api.socketPath,
                  actionTimeoutMs: HERDR_ACTION_TIMEOUT_MS, startupTimeoutMs: HERDR_STARTUP_TIMEOUT_MS,
                }) },
                probeSessionServiceability: (sessionId) => probeSessionRunnerServiceability({
                  sessionId, trackedSessions: [],
                  probeCapability: async () => { throw new Error('An absent runner cannot serve its control endpoint'); },
                }),
              });
              if (presentationKind === 'provider_attach') {
                expect(resolveDisconnectedTerminalHostResumeGate(supervision)).toEqual({ action: 'resume' });
                expect(api.panes.has('managed')).toBe(false);
                expect(await readTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-1' })).toBeNull();
              } else {
                expect(supervision).toEqual({ state: 'recoverable_unservable', reason: 'runner_absent' });
                expect(resolveDisconnectedTerminalHostResumeGate(supervision)).toEqual({ action: 'fence', reason: 'runner_absent' });
                expect(api.panes.has('managed')).toBe(true);
                const retainedAttachment = await readTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-1' });
                if (retainedAttachment?.version !== 2) throw new Error('The owned host descriptor was not retained');
                expect(retainedAttachment.attachmentId).toBe(attachment.attachmentId);
                // This separate custody observation models the SDK runner's
                // actual owned host, not its earlier plain placement request.
                const hostedTerminal = buildTerminalMetadataFromHostHandle(attachment.handle);
                if (hostedTerminal.mode !== 'herdr' || !hostedTerminal.herdr?.sessionName) {
                  throw new Error('The owned Herdr descriptor did not project its host metadata');
                }
                const observed: TrackedSession = { ...tracked, happySessionId: 'session-1',
                  spawnOptions: { ...candidate.spawnOptions, terminal: {
                    mode: 'herdr', herdr: { sessionName: hostedTerminal.herdr.sessionName },
                  } },
                  happySessionMetadataFromLocalWebhook: { ...captured.metadata, terminal: hostedTerminal },
                };
                pidToTrackedSession.set(pid, observed);
                await removeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-1',
                  expectedAttachmentId: attachment.attachmentId });
                expect(await createStopSession({ pidToTrackedSession })('session-1')).toEqual({ status: 'incomplete', reason: 'missing_attachment_identity' });
                expect(child.exitCode).toBeNull();
                expect(child.signalCode).toBeNull();
              }
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
              await exited;
              enterPhase('final-exit custody');
              const finalExitTracked: TrackedSession = { ...tracked, happySessionId: 'session-1',
                spawnOptions: candidate.spawnOptions, happySessionMetadataFromLocalWebhook: captured.metadata,
                publishedTerminalControlServiceabilityAttachmentId: attachment.attachmentId };
              if (presentationKind === 'provider_attach') {
                const replacement = await writeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-1',
                  handle: { ...attachment.handle, attachmentId: createTerminalAttachmentId() } });
                const exitCandidate = await resolveTrackedSessionTerminalHostExitCandidate({ tracked: finalExitTracked,
                  pid, happyHomeDir: homeDir, attachmentInfo: replacement });
                expect(exitCandidate?.attachmentId).toBe(replacement.attachmentId);
                await removeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-1',
                  expectedAttachmentId: replacement.attachmentId });
                await expect(Promise.resolve().then(() => resolveTrackedSessionTerminalHostExitCandidate({
                  tracked: finalExitTracked, pid, happyHomeDir: homeDir, attachmentInfo: null,
                }))).resolves.toBeNull();
                enterPhase('marker custody neighbors');
                const owned = await writeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-1',
                  handle: { ...attachment.handle, attachmentId: createTerminalAttachmentId() } });
                expect(await shouldRetainTrackedTerminalHostExitMarker({ tracked: finalExitTracked, happyHomeDir: homeDir })).toBe(true);
                expect(await shouldRetainTrackedTerminalHostExitMarker({
                  tracked: { ...finalExitTracked, publishedTerminalControlServiceabilityAttachmentLifecycle: 'borrowed' },
                  happyHomeDir: homeDir,
                })).toBe(true);
                await removeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-1',
                  expectedAttachmentId: owned.attachmentId });
                const hostPath = join(homeDir, 'terminal', 'sessions', 'session-1.host.json');
                await fs.writeFile(hostPath, JSON.stringify({ version: 1, sessionId: 'session-1',
                  handle: attachment.handle, updatedAt: 1 }), 'utf8');
                expect(await readTerminalHostAttachmentState({ happyHomeDir: homeDir, sessionId: 'session-1' }))
                  .toMatchObject({ status: 'present', info: { version: 1 } });
                expect(await shouldRetainTrackedTerminalHostExitMarker({ tracked: finalExitTracked, happyHomeDir: homeDir })).toBe(true);
                await fs.unlink(hostPath);
                const borrowed = await writeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-1',
                  handle: attachment.handle, lifecycle: 'borrowed' });
                expect(await shouldRetainTrackedTerminalHostExitMarker({ tracked: finalExitTracked, happyHomeDir: homeDir })).toBe(false);
                await removeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-1',
                  expectedAttachmentId: borrowed.attachmentId });
                await fs.writeFile(hostPath, '{', 'utf8');
                expect(await readTerminalHostAttachmentState({ happyHomeDir: homeDir, sessionId: 'session-1' }))
                  .toEqual({ status: 'unreadable', reason: 'invalid' });
                expect(await shouldRetainTrackedTerminalHostExitMarker({ tracked: finalExitTracked, happyHomeDir: homeDir })).toBe(true);
                await fs.unlink(hostPath);
                expect(await shouldRetainTrackedTerminalHostExitMarker({ tracked: finalExitTracked, happyHomeDir: homeDir })).toBe(false);
                // A separate accepted process is required: the preceding Stop
                // already retired the first process's marker. Its genuine zero
                // exit must clear history-only optional presentation custody.
                enterPhase('normal-exit Machine transport');
                const normalChild = spawn(process.execPath, ['-e',
                  'setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(0)); process.send({ready:true});'],
                { cwd: homeDir, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
                normalChildToCancel = normalChild;
                const normalExit = once(normalChild, 'exit');
                let machine: ApiMachineClient | undefined;
                try {
                  await once(normalChild, 'message', { signal });
                  enterPhase('normal-exit Machine transport');
                  const normalPid = normalChild.pid;
                  if (!normalPid) throw new Error('The owned normal-exit child did not spawn');
                  const normalTracked: TrackedSession = {
                    pid: normalPid, startedBy: 'daemon', childProcess: normalChild,
                    happySessionId: 'session-1', spawnOptions: candidate.spawnOptions,
                    happySessionMetadataFromLocalWebhook: captured.metadata,
                    publishedTerminalControlServiceabilityAttachmentId: attachment.attachmentId,
                    publishedTerminalControlServiceabilityAttachmentLifecycle: 'owned',
                  };
                  pidToTrackedSession.set(normalPid, normalTracked);
                  await persistAcceptedSpawnMarker({ trackedSession: normalTracked, deviceLocalSecretStorage });
                  expect((await listSessionMarkers()).some(marker => marker.pid === normalPid)).toBe(true);
                  const machineSocket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event) => {
                    if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
                      return MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse({ v: 1, result: 'success', revision: 1 });
                    }
                    if (event === MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1) {
                      return { v: 1, status: 'already_inactive', sessionId: 'session-1' };
                    }
                    throw new Error(`Unexpected Machine socket request: ${event}`);
                  } });
                  // The transport supplies terminal finality without emitting
                  // an unrelated Machine registration/connect event.
                  machineSocket.connect.mockImplementation(() => machineSocket);
                  bindApiSessionSocketMock(mocks.io, machineSocket);
                  machine = new ApiMachineClient('fixture-token', { id: 'route-machine', encryptionMode: 'plain',
                    metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
                  machine.connect();
                  await vi.waitFor(() => expect(mocks.io).toHaveBeenCalled());
                  enterPhase('normal-exit durable staging');
                  const normalOnChildExited = createOnChildExited({
                    pidToTrackedSession, spawnResourceCleanupByPid, sessionAttachCleanupByPid,
                    getApiMachineForSessions: () => machine ?? null,
                    shouldPreserveSessionMarkerOnExit: ({ trackedSession }) => shouldRetainTrackedTerminalHostExitMarker({
                      tracked: trackedSession, happyHomeDir: homeDir,
                    }),
                  });
                  normalChild.kill('SIGTERM');
                  expect(await normalExit).toEqual([0, null]);
                  await normalOnChildExited(normalPid, { reason: 'process-exited', code: 0, signal: null });
                  expect(pidToTrackedSession.has(normalPid)).toBe(false);
                  expect((await listSessionMarkers()).some(marker => marker.pid === normalPid)).toBe(false);
                } finally {
                  try { await machine?.shutdown(); }
                  finally {
                    if (normalChild.exitCode === null && normalChild.signalCode === null) normalChild.kill('SIGTERM');
                    await normalExit;
                    normalChildToCancel = undefined;
                  }
                }
              } else {
                await removeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-1',
                  expectedAttachmentId: attachment.attachmentId });
                await expect(Promise.resolve().then(() => resolveTrackedSessionTerminalHostExitCandidate({
                  tracked: finalExitTracked, pid, happyHomeDir: homeDir, attachmentInfo: null,
                }))).rejects.toThrow(Error);
              }
            }
          } finally {
            try {
              await bootstrap?.cleanupBootstrapFile();
              await developmentRoots.stop();
            } finally {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
              await exited;
              await onChildExited(pid, { reason: 'test-cleanup', code: null, signal: 'SIGTERM' });
              childToCancel = undefined;
              if (relayToClose) {
                const relay = relayToClose;
                await new Promise<void>((resolve, reject) => relay.close(error => error ? reject(error) : resolve()));
              }
              if (previousServer === undefined) delete process.env.HAPPIER_SERVER_URL;
              else process.env.HAPPIER_SERVER_URL = previousServer;
              if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
              else process.env.HAPPIER_HOME_DIR = previousHomeDir;
              if (previousHerdrBinary === undefined) delete process.env.HERDR_BIN_PATH;
              else process.env.HERDR_BIN_PATH = previousHerdrBinary;
              reloadConfiguration();
            }
          }
        }));
      } finally {
        envScope.restore();
        features.restore();
      }
    }).finally(() => signal.removeEventListener('abort', cancelOwnedWork));
    pendingCapturedCase = work;
    await work;
  });

  it('tracks the stable V2 authority path and exact bootstrap identity for a runner bootstrap', async () => {
    const params = createParams();
    const pending = (await import(
      './spawnRegularProcessAndWaitForWebhook'
    )).spawnRegularProcessAndWaitForWebhook({
      ...params,
      runnerAgentSessionBootstrapAuthorization: {
        authorityFilePath: '/private/runner-authority.json',
        bootstrapFilePath: '/private/runner-bootstrap.json',
        descriptor: {
          v: 1,
          pluginId: 'plugin.acme',
          pluginVersion: '1.0.0',
          agentId: 'agent',
          backendId: 'agent',
          occurrenceId: 'occurrence:plugin.acme:1',
          sourceCustody: {
            kind: 'managed',
            immutableGenerationId: 'generation-1',
            installSource: 'npm',
          },
        },
      },
      runnerAgentInvocationContext: Object.freeze({
        cwd: '/tmp/happier-project',
        environment: Object.freeze({}),
        providerBindingActive: true,
      }),
      extraEnvForChildWithMessage: {
        PROVIDER_SECRET: 'must-not-become-daemon-authority',
      },
    });

    await vi.waitFor(() => {
      expect(params.pidToAwaiter.has(4242)).toBe(true);
    });
    const tracked = params.pidToTrackedSession.get(4242)!;
    expect(tracked).toMatchObject({
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/private/runner-authority.json',
      runnerAgentBootstrapIdentity: {
        agentId: 'agent',
        backendId: 'agent',
      },
      runnerAgentInvocationContext: {
        cwd: '/tmp/happier-project',
        environment: {},
        providerBindingActive: true,
      },
    });
    expect(JSON.stringify(tracked)).not.toContain(
      'must-not-become-daemon-authority',
    );
    params.pidToAwaiter.get(4242)?.({
      ...tracked,
      happySessionId: 'session-4242',
    });

    await expect(pending).resolves.toEqual({
      type: 'success',
      sessionId: 'session-4242',
    });
    expect(JSON.stringify(params.logDebug.mock.calls)).not.toContain('session-4242');
  });

  it('does not create a child when takeover cancellation arrives during awaited commit revalidation', async () => {
    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const controller = new AbortController();
    const admission = waiter.register({ mode: 'persisted', operationId: 'operation-1', attemptId: 'attempt-1' }, { signal: controller.signal });
    let entered!: () => void;
    let release!: () => void;
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const revalidateBeforeCommit = withTakeoverAdmissionCommitRevalidation(admission, async () => {
      entered();
      await held;
      return null;
    });
    const pending = spawnRegularProcessAndWaitForWebhook({
      ...createParams(),
      takeoverAdmission: admission,
      revalidateBeforeCommit,
    });
    await checking;
    controller.abort();
    release();
    await expect(pending).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED });
    expect(mocks.spawnHappyCLI).not.toHaveBeenCalled();
    expect(admission.readOutcome()?.status).toBe('failed');
  });

  it('runs the final provider authorization guard immediately before regular child creation', async () => {
    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const refusal = {
      type: 'error' as const,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'provider_authorization_changed',
    };
    const revalidateBeforeCommit = vi.fn(async () => refusal);

    await expect(spawnRegularProcessAndWaitForWebhook({
      ...createParams(),
      revalidateBeforeCommit,
    })).resolves.toEqual(refusal);

    expect(revalidateBeforeCommit).toHaveBeenCalledTimes(1);
    expect(mocks.spawnHappyCLI).not.toHaveBeenCalled();
  });

  it('matches an early canonical webhook while accepted-marker persistence is blocked and completes once after acceptance', async () => {
    const child = createFakeChildProcess(4243);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    let releaseMarker!: () => void;
    const markerPersisted = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const params = createParams();
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(async () => {
      await markerPersisted;
    });
    const onTrackedSessionReported = vi.fn();
    const onTrackedSessionReady = vi.fn(async () => {
      expect(params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget).toHaveBeenCalledWith(4243);
    });
    const writeSessionMarkerFn = vi.fn(async () => {});

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const { createOnHappySessionWebhook } = await import('../sessions/onHappySessionWebhook');
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      readCredentialsFn: async () => null,
      onTrackedSessionReady,
      onTrackedSessionReported,
    });
    const pending = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => expect(params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1));
    expect(params.pidToTrackedSession.get(4243)).toEqual(expect.objectContaining({
      pid: 4243,
      startedBy: 'daemon',
    }));
    expect(params.pidToAwaiter.has(4243)).toBe(true);

    const webhookReadiness = onWebhook('session-4243', {
      hostPid: 4243,
      path: '/tmp/happier-project',
      startedBy: 'daemon',
    } as Metadata);
    expect(params.pidToTrackedSession.get(4243)).toEqual(expect.objectContaining({
      happySessionId: 'session-4243',
    }));
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
    expect(onTrackedSessionReported).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();

    releaseMarker();
    await expect(pending).resolves.toEqual({ type: 'success', sessionId: 'session-4243' });
    await expect(webhookReadiness).resolves.toBeUndefined();
    expect(onTrackedSessionReady).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(onTrackedSessionReported).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(writeSessionMarkerFn).toHaveBeenCalledTimes(1));
    expect(params.pidToAwaiter.has(4243)).toBe(false);
    expect(params.pidToSpawnResultResolver.has(4243)).toBe(false);
    expect(params.pidToSpawnWebhookTimeout.has(4243)).toBe(false);
  });

  it('keeps one startup owner when canonical activation pauses across wrapper promotion', async () => {
    const wrapperPid = 4244;
    const runnerPid = 4245;
    const child = createFakeChildProcess(wrapperPid);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    const params = createParams();
    let resumeActivation!: () => void;
    const activationPaused = new Promise<void>((resolve) => {
      resumeActivation = resolve;
    });
    const activationStarted = vi.fn();
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker
      .mockImplementationOnce(async (tracked) => {
        tracked.activateConnectedAccountSessionBindingOnCanonicalSession =
          vi.fn(async () => {
            activationStarted();
            await activationPaused;
            return null;
          });
      });
    const promoteSessionMarkerFn = vi.fn(async () => ({
      sourceMarkerOwnership: {
        happySessionId: `PID-${wrapperPid}`,
      },
      targetMarkerOwnership: {
        happySessionId: `PID-${runnerPid}`,
        processCommandHash: 'b'.repeat(64),
        processStartTimeMs: 2_000,
      },
      targetProcessCommand: 'runner command',
    }));
    const { createOnChildExited } =
      await import('../sessions/onChildExited');
    const onChildExited = createOnChildExited({
      pidToTrackedSession: params.pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      promoteSessionMarkerFn,
      removeSessionMarkerFn: vi.fn(async () => undefined),
    } as never);
    const { createOnHappySessionWebhook } =
      await import('../sessions/onHappySessionWebhook');
    const writeSessionMarkerFn = vi.fn(async () => undefined);
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      getParentPidFn: () => wrapperPid,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: runnerPid,
        processStartTimeMs: 2_000,
        command: 'runner command',
      }),
      writeSessionMarkerFn,
      onTrackedSessionReady: vi.fn(async () => undefined),
    });
    const { spawnRegularProcessAndWaitForWebhook } =
      await import('./spawnRegularProcessAndWaitForWebhook');
    const killSpy = vi.spyOn(process, 'kill')
      .mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === runnerPid && signal === 0) return true;
        return true;
      }) as typeof process.kill);
    const pending = spawnRegularProcessAndWaitForWebhook({
      ...params,
      onChildExited,
    });
    let originalTrackedSession: TrackedSession | undefined;
    await vi.waitFor(() => {
      originalTrackedSession =
        params.pidToTrackedSession.get(wrapperPid);
      expect(originalTrackedSession).toBeDefined();
    });
    await onWebhook(
      `PID-${runnerPid}`,
      {
        hostPid: runnerPid,
        path: '/tmp/happier-project',
        startedBy: 'daemon',
      } as Metadata,
    );
    const canonicalWebhook = onWebhook(
      'session-promoted',
      {
        hostPid: runnerPid,
        path: '/tmp/happier-project',
        startedBy: 'daemon',
      } as Metadata,
    );
    await vi.waitFor(() => expect(activationStarted).toHaveBeenCalledOnce());

    child.emit('exit', 0, null);
    await vi.waitFor(() => {
      expect(params.pidToTrackedSession.get(runnerPid))
        .toBe(originalTrackedSession);
      expect(promoteSessionMarkerFn).toHaveBeenCalledOnce();
    });
    resumeActivation();

    await expect(canonicalWebhook).resolves.toBeUndefined();
    await expect(pending).resolves.toEqual({
      type: 'success',
      sessionId: 'session-promoted',
    });
    expect(writeSessionMarkerFn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pid: runnerPid,
        happySessionId: `PID-${runnerPid}`,
      }),
    );
    expect(params.pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(params.pidToAwaiter).toHaveLength(0);
    expect(params.pidToSpawnResultResolver).toHaveLength(0);
    expect(params.pidToSpawnWebhookTimeout).toHaveLength(0);
    killSpy.mockRestore();
  });

  it('continues the same startup when the wrapper exits before accepted-marker persistence promotes its live runner', async () => {
    const wrapperPid = 4247;
    const runnerPid = 4248;
    const child = createFakeChildProcess(wrapperPid);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    const params = createParams();
    let releaseMarker!: () => void;
    const markerPersisted = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker
      .mockImplementationOnce(async (tracked) => {
        await markerPersisted;
      });
    const promoteSessionMarkerFn = vi.fn(async () => ({
      sourceMarkerOwnership: {
        happySessionId: `PID-${wrapperPid}`,
      },
      targetMarkerOwnership: {
        happySessionId: `PID-${runnerPid}`,
        processCommandHash: 'b'.repeat(64),
        processStartTimeMs: 2_000,
      },
      targetProcessCommand: 'runner command',
    }));
    const { createOnChildExited } =
      await import('../sessions/onChildExited');
    const onChildExited = createOnChildExited({
      pidToTrackedSession: params.pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      promoteSessionMarkerFn,
      removeSessionMarkerFn: vi.fn(async () => undefined),
    } as never);
    const { createOnHappySessionWebhook } =
      await import('../sessions/onHappySessionWebhook');
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      getParentPidFn: () => wrapperPid,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: runnerPid,
        processStartTimeMs: 2_000,
        command: 'runner command',
      }),
      writeSessionMarkerFn: vi.fn(async () => undefined),
    });
    const { spawnRegularProcessAndWaitForWebhook } =
      await import('./spawnRegularProcessAndWaitForWebhook');
    vi.spyOn(process, 'kill')
      .mockImplementation(((candidatePid: number, signal?: NodeJS.Signals | number) => {
        if (candidatePid === runnerPid && signal === 0) return true;
        return true;
      }) as typeof process.kill);

    const pending = spawnRegularProcessAndWaitForWebhook({
      ...params,
      onChildExited,
    });
    await vi.waitFor(() => {
      expect(params.pidToAwaiter.has(wrapperPid)).toBe(true);
    });
    await onWebhook(
      `PID-${runnerPid}`,
      {
        hostPid: runnerPid,
        path: '/tmp/happier-project',
        startedBy: 'daemon',
      } as Metadata,
    );

    child.emit('exit', 0, null);
    releaseMarker();
    await vi.waitFor(() => {
      expect(params.pidToTrackedSession.get(runnerPid))
        .toBeDefined();
    });
    await onWebhook(
      'session-after-early-wrapper-exit',
      {
        hostPid: runnerPid,
        path: '/tmp/happier-project',
        startedBy: 'daemon',
      } as Metadata,
    );

    await expect(pending).resolves.toEqual({
      type: 'success',
      sessionId: 'session-after-early-wrapper-exit',
    });
    expect(params.pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(params.pidToTrackedSession.get(runnerPid))
      .toEqual(expect.objectContaining({
        pid: runnerPid,
        happySessionId: 'session-after-early-wrapper-exit',
      }));
  });

  it('rejects an old webhook success when replacement custody owns the PID before marker acceptance', async () => {
    const child = createFakeChildProcess(4250);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    let releaseMarker!: () => void;
    const markerPersisted = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const params = createParams();
    const replacementLifecycleCleanup = vi.fn();
    const lifecycleCleanupByPid = new Map<number, () => void>();
    params.onChildExited.mockImplementation(async (pid) => {
      params.pidToTrackedSession.delete(pid);
      params.pidToAwaiter.delete(pid);
      params.pidToSpawnResultResolver.delete(pid);
      const cleanup = lifecycleCleanupByPid.get(pid);
      lifecycleCleanupByPid.delete(pid);
      cleanup?.();
    });
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(async () => {
      await markerPersisted;
    });
    const onTrackedSessionReported = vi.fn();
    const writeSessionMarkerFn = vi.fn(async () => {});

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const { createOnHappySessionWebhook } = await import('../sessions/onHappySessionWebhook');
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      readCredentialsFn: async () => null,
      onTrackedSessionReported,
    });
    const pending = spawnRegularProcessAndWaitForWebhook(params);
    await vi.waitFor(() => expect(params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1));

    const supersededWebhookReadiness = onWebhook('session-old-4250', {
      hostPid: 4250,
      path: '/tmp/happier-project',
      startedBy: 'daemon',
    } as Metadata);
    const supersededWebhookFailure = expect(supersededWebhookReadiness).rejects.toThrow('spawn custody');
    expect(onTrackedSessionReported).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();

    const replacementTracked = {
      pid: 4250,
      startedBy: 'daemon',
      happySessionId: 'PID-4250',
    };
    const replacementAwaiter = vi.fn();
    const replacementResolver = vi.fn();
    const replacementTimeout = setTimeout(() => {}, 60_000);
    params.pidToTrackedSession.set(4250, replacementTracked);
    params.pidToAwaiter.set(4250, replacementAwaiter);
    params.pidToSpawnResultResolver.set(4250, replacementResolver);
    params.pidToSpawnWebhookTimeout.set(4250, replacementTimeout);
    lifecycleCleanupByPid.set(4250, replacementLifecycleCleanup);

    releaseMarker();
    await expect(pending).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: expect.any(String),
    });
    await Promise.resolve();
    await Promise.resolve();
    await supersededWebhookFailure;

    expect(onTrackedSessionReported).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();
    expect(params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForPid).toHaveBeenCalledWith(4250);
    expect(params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget).not.toHaveBeenCalled();
    expect(params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid).toHaveBeenCalledWith(4250);
    expect(params.onChildExited).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(params.pidToTrackedSession.get(4250)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4250)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4250)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4250)).toBe(replacementTimeout);
    expect(replacementAwaiter).not.toHaveBeenCalled();
    expect(replacementResolver).not.toHaveBeenCalled();

    child.emit('exit', 1, null);
    await Promise.resolve();
    await Promise.resolve();

    expect(params.onChildExited).not.toHaveBeenCalled();
    expect(params.pidToTrackedSession.get(4250)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4250)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4250)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4250)).toBe(replacementTimeout);
    expect(lifecycleCleanupByPid.get(4250)).toBe(replacementLifecycleCleanup);
    expect(replacementLifecycleCleanup).not.toHaveBeenCalled();
    clearTimeout(replacementTimeout);
  });

  it('keeps early child-exit observation armed while accepted-spawn custody is persisted', async () => {
    const child = createFakeChildProcess(4244);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    let releaseMarker!: () => void;
    const markerPersisted = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    let markerPresent = false;
    const params = createParams();
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(async () => {
      await markerPersisted;
      markerPresent = true;
    });
    params.onChildExited.mockImplementationOnce(async () => {
      await markerPersisted;
      markerPresent = false;
    });

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const pending = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => expect(params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1));
    child.emit('exit', 1, null);
    expect(params.onChildExited).toHaveBeenCalledOnce();

    releaseMarker();

    await vi.waitFor(() => expect(params.onChildExited).toHaveBeenCalledTimes(1));
    expect(markerPresent).toBe(false);
    expect(params.onChildExited).toHaveBeenCalledWith(4244, expect.objectContaining({
      reason: 'process-exited-before-webhook',
    }));
    await expect(pending).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: 'Child process exited before session webhook (pid=4244, code=1, signal=null)',
    });
  });

  it('treats child error as diagnostic until a later exit authoritatively terminates the child', async () => {
    const child = createFakeChildProcess(4245);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    let releaseMarker!: () => void;
    const markerPersisted = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const flushStreamingSanitizer = vi.fn(() => '');
    const params = {
      ...createParams(),
      createStreamingSanitizer: () => ({
        push: () => '',
        flush: flushStreamingSanitizer,
      }),
    };
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(async () => {
      await markerPersisted;
    });

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const pending = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => expect(params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1));
    child.emit('error', new Error('spawn failed'));
    expect(params.onChildExited).not.toHaveBeenCalled();
    expect(flushStreamingSanitizer).not.toHaveBeenCalled();
    releaseMarker();

    await vi.waitFor(() => expect(params.pidToAwaiter.has(4245)).toBe(true));
    expect(params.onChildExited).not.toHaveBeenCalled();
    child.emit('exit', 1, null);

    await expect(pending).resolves.toEqual(expect.objectContaining({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: expect.stringContaining('Child process exited before session webhook'),
    }));
    expect(params.onChildExited).toHaveBeenCalledTimes(1);
    expect(params.onChildExited).toHaveBeenCalledWith(4245, expect.objectContaining({
      reason: 'process-exited-before-webhook',
    }));
    expect(flushStreamingSanitizer).toHaveBeenCalledTimes(2);
  });

  it('cleans only the exact provisional webhook custody when marker publication fails after an early canonical webhook', async () => {
    const child = createFakeChildProcess(4246);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    const params = createParams();
    params.onChildExited.mockImplementationOnce(async (pid) => {
      params.pidToTrackedSession.delete(pid);
    });
    let rejectMarker!: (error: Error) => void;
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(
      async () => await new Promise<void>((_resolve, reject) => {
        rejectMarker = reject;
      }),
    );
    const onTrackedSessionReported = vi.fn();
    const writeSessionMarkerFn = vi.fn(async () => {});

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const { createOnHappySessionWebhook } = await import('../sessions/onHappySessionWebhook');
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      readCredentialsFn: async () => null,
      onTrackedSessionReported,
    });
    const pending = spawnRegularProcessAndWaitForWebhook({
      ...params,
    });

    await vi.waitFor(() => expect(params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1));
    const failedMarkerWebhookReadiness = onWebhook('session-4246', {
      hostPid: 4246,
      path: '/tmp/happier-project',
      startedBy: 'daemon',
    } as Metadata);
    const failedMarkerWebhookFailure = expect(failedMarkerWebhookReadiness).rejects.toThrow('spawn custody');
    expect(params.pidToTrackedSession.get(4246)).toEqual(expect.objectContaining({
      happySessionId: 'session-4246',
    }));
    expect(params.onChildExited).not.toHaveBeenCalled();
    expect(onTrackedSessionReported).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();
    rejectMarker(new Error('marker write rejected'));

    await expect(pending).rejects.toThrow('marker write rejected');
    await failedMarkerWebhookFailure;
    expect(child.kill).not.toHaveBeenCalled();
    expect(params.cleanupSpawnResources).toHaveBeenCalledOnce();
    expect(params.spawnLifecycleCallbacks.cleanupPendingSessionAttach).not.toHaveBeenCalled();
    expect(params.pidToTrackedSession.has(4246)).toBe(false);
    expect(params.pidToAwaiter.has(4246)).toBe(false);
    expect(params.pidToSpawnResultResolver.has(4246)).toBe(false);
    expect(params.pidToSpawnWebhookTimeout.has(4246)).toBe(false);
    expect(params.onChildExited).toHaveBeenCalledOnce();
    expect(onTrackedSessionReported).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();

    await expect(onWebhook('session-4246', {
      hostPid: 4246,
      path: '/tmp/happier-project',
      startedBy: 'daemon',
    } as Metadata)).resolves.toBeUndefined();
    expect(params.pidToTrackedSession.has(4246)).toBe(false);
    child.emit('exit', null, 'SIGTERM');
    await Promise.resolve();
    expect(params.onChildExited).toHaveBeenCalledOnce();
    expect(params.pidToTrackedSession.has(4246)).toBe(false);
  });

  it('cancels its superseded webhook timeout when marker rejection preserves replacement custody', async () => {
    vi.useFakeTimers();
    process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = '25';
    const child = createFakeChildProcess(4247);
    const replacementChild = createFakeChildProcess(4247);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    const params = createParams();
    let rejectMarker!: (error: Error) => void;
    let announceMarker!: () => void;
    const markerStarted = new Promise<void>((resolve) => { announceMarker = resolve; });
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(
      async () => await new Promise<void>((_resolve, reject) => {
        rejectMarker = reject;
        announceMarker();
      }),
    );

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const pending = spawnRegularProcessAndWaitForWebhook(params);
    await markerStarted;
    expect(params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1);
    expect(params.pidToSpawnWebhookTimeout.has(4247)).toBe(true);

    const replacementTracked = {
      pid: 4247,
      startedBy: 'daemon',
      happySessionId: 'PID-4247',
      childProcess: replacementChild,
    };
    const replacementAwaiter = vi.fn();
    const replacementResolver = vi.fn();
    const replacementTimeoutCallback = vi.fn();
    const replacementTimeout = setTimeout(replacementTimeoutCallback, 1_000);
    params.pidToTrackedSession.set(4247, replacementTracked);
    params.pidToAwaiter.set(4247, replacementAwaiter);
    params.pidToSpawnResultResolver.set(4247, replacementResolver);
    params.pidToSpawnWebhookTimeout.set(4247, replacementTimeout);

    await vi.advanceTimersByTimeAsync(50);

    expect(params.pidToTrackedSession.get(4247)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4247)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4247)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4247)).toBe(replacementTimeout);
    expect(replacementTracked).not.toHaveProperty('sessionWebhookTimedOutAtMs');
    expect(replacementAwaiter).not.toHaveBeenCalled();
    expect(replacementResolver).not.toHaveBeenCalled();
    expect(replacementTimeoutCallback).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(replacementChild.kill).not.toHaveBeenCalled();
    expect(params.cleanupSpawnResources).not.toHaveBeenCalled();
    expect(params.spawnLifecycleCallbacks.cleanupPendingSessionAttach).not.toHaveBeenCalled();

    rejectMarker(new Error('marker write rejected after replacement'));
    await expect(pending).rejects.toThrow('marker write rejected after replacement');
    expect(child.kill).not.toHaveBeenCalled();
    expect(params.pidToTrackedSession.get(4247)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4247)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4247)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4247)).toBe(replacementTimeout);
    expect(replacementTracked).not.toHaveProperty('sessionWebhookTimedOutAtMs');
    expect(replacementAwaiter).not.toHaveBeenCalled();
    expect(replacementResolver).not.toHaveBeenCalled();
    expect(replacementTimeoutCallback).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(replacementChild.kill).not.toHaveBeenCalled();
    clearTimeout(replacementTimeout);
  });

  it('settles an exiting old child after marker acceptance without delegating replacement custody by PID', async () => {
    const child = createFakeChildProcess(4248);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    let releaseMarker!: () => void;
    const persistAcceptedSpawnMarker = vi.fn(
      async () => await new Promise<void>((resolve) => {
        releaseMarker = resolve;
      }),
    );
    const oldAttachCleanup = vi.fn(async () => {});
    const replacementAttachCleanup = vi.fn(async () => {});
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    let pendingAttachCleanup: (() => Promise<void>) | null = oldAttachCleanup;
    const { createSpawnLifecycleCallbacks } = await import('./createSpawnLifecycleCallbacks');
    const realSpawnLifecycleCallbacks = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: {},
      catalogAgentId: 'opencode',
      materializationKey: 'materialization-old-spawn',
      hasConnectedServiceAuth: () => false,
      getSpawnResourceCleanupOnExit: () => null,
      onSpawnResourceCleanupArmed: vi.fn(),
      spawnResourceCleanupByPid: new Map(),
      getSessionAttachCleanup: () => pendingAttachCleanup,
      setSessionAttachCleanup: (cleanup) => {
        pendingAttachCleanup = cleanup;
      },
      sessionAttachCleanupByPid,
      persistAcceptedSpawnMarker,
    });
    const consumeSessionAttachCleanupForPid = vi.fn(
      realSpawnLifecycleCallbacks.consumeSessionAttachCleanupForPid,
    );
    const registerConnectedServiceSpawnTarget = vi.fn(
      realSpawnLifecycleCallbacks.registerConnectedServiceSpawnTarget,
    );
    const registerSpawnResourceCleanupForPid = vi.fn(
      realSpawnLifecycleCallbacks.registerSpawnResourceCleanupForPid,
    );
    const spawnLifecycleCallbacks = {
      ...realSpawnLifecycleCallbacks,
      consumeSessionAttachCleanupForPid,
      registerConnectedServiceSpawnTarget,
      registerSpawnResourceCleanupForPid,
    };
    const params = {
      ...createParams(),
      spawnLifecycleCallbacks,
    };
    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const pending = spawnRegularProcessAndWaitForWebhook(params);
    await vi.waitFor(() => expect(persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1));

    const replacementTracked = {
      pid: 4248,
      startedBy: 'daemon',
      happySessionId: 'PID-4248',
    };
    const replacementAwaiter = vi.fn();
    const replacementResolver = vi.fn();
    const replacementTimeout = setTimeout(() => {}, 60_000);
    params.pidToTrackedSession.set(4248, replacementTracked);
    params.pidToAwaiter.set(4248, replacementAwaiter);
    params.pidToSpawnResultResolver.set(4248, replacementResolver);
    params.pidToSpawnWebhookTimeout.set(4248, replacementTimeout);
    sessionAttachCleanupByPid.set(4248, replacementAttachCleanup);

    child.emit('exit', 1, null);

    expect(params.pidToTrackedSession.get(4248)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4248)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4248)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4248)).toBe(replacementTimeout);
    expect(replacementAwaiter).not.toHaveBeenCalled();
    expect(replacementResolver).not.toHaveBeenCalled();

    releaseMarker();
    await expect(pending).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: 'Child process exited before session webhook (pid=4248, code=1, signal=null)',
    });
    expect(params.onChildExited).not.toHaveBeenCalled();
    expect(params.pidToTrackedSession.get(4248)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4248)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4248)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4248)).toBe(replacementTimeout);
    expect(sessionAttachCleanupByPid.get(4248)).toBe(replacementAttachCleanup);
    expect(consumeSessionAttachCleanupForPid).toHaveBeenCalledWith(4248);
    expect(registerConnectedServiceSpawnTarget).not.toHaveBeenCalled();
    expect(registerSpawnResourceCleanupForPid).toHaveBeenCalledWith(4248);
    expect(oldAttachCleanup).not.toHaveBeenCalled();
    expect(replacementAttachCleanup).not.toHaveBeenCalled();
    clearTimeout(replacementTimeout);
  });

  it('does not delegate an old child exit after marker publication when replacement custody owns the PID', async () => {
    const child = createFakeChildProcess(4249);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    const params = createParams();

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const pending = spawnRegularProcessAndWaitForWebhook(params);
    await vi.waitFor(() => {
      expect(params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid).toHaveBeenCalledWith(4249);
    });

    const replacementTracked = {
      pid: 4249,
      startedBy: 'daemon',
      happySessionId: 'PID-4249',
    };
    const replacementAwaiter = vi.fn();
    const replacementResolver = vi.fn();
    const replacementTimeout = setTimeout(() => {}, 60_000);
    params.pidToTrackedSession.set(4249, replacementTracked);
    params.pidToAwaiter.set(4249, replacementAwaiter);
    params.pidToSpawnResultResolver.set(4249, replacementResolver);
    params.pidToSpawnWebhookTimeout.set(4249, replacementTimeout);

    child.emit('exit', 1, null);

    await expect(pending).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: 'Child process exited before session webhook (pid=4249, code=1, signal=null)',
    });
    expect(params.onChildExited).not.toHaveBeenCalled();
    expect(params.pidToTrackedSession.get(4249)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4249)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4249)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4249)).toBe(replacementTimeout);
    expect(replacementAwaiter).not.toHaveBeenCalled();
    expect(replacementResolver).not.toHaveBeenCalled();
    clearTimeout(replacementTimeout);
  });

  afterEach(async () => {
    // Vitest rejects the action clock on timeout; it does not join the action.
    // Join its cancellation/OS cleanup before another row can reuse globals.
    try {
      await pendingCapturedCase;
    } finally {
      pendingCapturedCase = undefined;
      currentTestSignal = undefined;
      vi.useRealTimers();
      if (originalDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = originalDebug;
      if (originalOomScoreAdjustment === undefined) {
        delete process.env.HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ;
      } else {
        process.env.HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ = originalOomScoreAdjustment;
      }
      if (originalSessionWebhookTimeoutMs === undefined) {
        delete process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = originalSessionWebhookTimeoutMs;
      }
      if (originalHappyHomeDir === undefined) {
        delete process.env.HAPPIER_HOME_DIR;
      } else {
        process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
      }
      if (originalServerUrl === undefined) {
        delete process.env.HAPPIER_SERVER_URL;
      } else {
        process.env.HAPPIER_SERVER_URL = originalServerUrl;
      }
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
      vi.restoreAllMocks();
    }
  });

  it('sanitizes provider credentials from stdout, stderr, exit diagnostics, and callbacks', async () => {
    const child = createFakeChildProcess(5152);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    process.env.DEBUG = '1';
    const rawSecret = 'provider-secret-42';
    const sanitizeDiagnosticText = vi.fn((value: string) => value.replaceAll(rawSecret, '[REDACTED]'));

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = { ...createParams(), sanitizeDiagnosticText };
    const resultPromise = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => expect(mocks.spawnHappyCLI).toHaveBeenCalledTimes(1));
    child.stdout.emit('data', `stdout echoed ${rawSecret}`);
    child.stderr.emit('data', `stderr echoed ${rawSecret}`);
    child.emit('exit', 1, null);

    const result = await resultPromise;
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(JSON.stringify(params.logDebug.mock.calls)).not.toContain(rawSecret);
    expect(JSON.stringify(params.onChildExited.mock.calls)).not.toContain(rawSecret);
    expect(JSON.stringify(params.logDebug.mock.calls)).toContain('[REDACTED]');
    expect(sanitizeDiagnosticText).toHaveBeenCalled();
  });

  it('uses channel-scoped streaming sanitizers so chunk boundaries cannot expose provider credentials', async () => {
    const child = createFakeChildProcess(5153);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    process.env.DEBUG = '1';
    const rawSecret = 'provider-secret-42';
    const createStreamingSanitizer = () => {
      let pending = '';
      return {
        push(value: string | Uint8Array) {
          pending += typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
          if (!pending.includes(rawSecret)) return '';
          const output = pending.replaceAll(rawSecret, '[REDACTED]');
          pending = '';
          return output;
        },
        flush() {
          const output = pending.replaceAll(rawSecret, '[REDACTED]');
          pending = '';
          return output;
        },
      };
    };

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = { ...createParams(), createStreamingSanitizer };
    const resultPromise = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => expect(mocks.spawnHappyCLI).toHaveBeenCalledTimes(1));
    child.stdout.emit('data', 'stdout provider-sec');
    child.stdout.emit('data', 'ret-42 done');
    child.stderr.emit('data', 'stderr provider-');
    child.stderr.emit('data', 'secret-42 done');
    child.emit('exit', 1, null);

    const result = await resultPromise;
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(JSON.stringify(params.logDebug.mock.calls)).not.toContain(rawSecret);
    expect(JSON.stringify(params.onChildExited.mock.calls)).not.toContain(rawSecret);
    expect(JSON.stringify(params.logDebug.mock.calls)).toContain('[REDACTED]');
  });

  it('captures a redacted stderr tail when a child exits before the session webhook', async () => {
    const child = createFakeChildProcess(5151);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = createParams();
    params.onChildExited.mockImplementation(async (pid) => {
      params.pidToTrackedSession.delete(pid);
    });

    const resultPromise = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => {
      expect(mocks.spawnHappyCLI).toHaveBeenCalledTimes(1);
    });
    child.stderr.emit(
      'data',
      [
        'startup phase one',
        'authorization: bearer sk-secretsecretsecretsecretsecret',
        'fatal: missing configured provider runtime',
      ].join('\n'),
    );
    child.emit('exit', 1, null);

    const result = await resultPromise;
    expect(result.type).toBe('error');
    if (result.type !== 'error') {
      throw new Error('Expected child pre-webhook exit to return a spawn error');
    }
    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: expect.stringContaining('fatal: missing configured provider runtime'),
    });
    expect(result.errorMessage).toContain('recent stderr:');
    expect(result.errorMessage).toContain('authorization: bearer [REDACTED]');
    expect(result.errorMessage).not.toContain('sk-secretsecretsecretsecretsecret');
    expect(params.onChildExited).toHaveBeenCalledWith(5151, expect.objectContaining({
      reason: 'process-exited-before-webhook',
      code: 1,
      signal: null,
      stderrTail: expect.stringContaining('fatal: missing configured provider runtime'),
    }));
  });

  it('cancels the exact regular launch when the webhook deadline expires', async () => {
    const child = createFakeChildProcess(6262);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = '10';

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = createParams();
    params.onChildExited.mockImplementation(async (pid) => {
      params.pidToTrackedSession.delete(pid);
    });

    const pending = spawnRegularProcessAndWaitForWebhook({
      ...params,
    });
    await vi.waitFor(() => {
      expect(params.pidToTrackedSession.has(6262)).toBe(true);
    });
    const tracked = params.pidToTrackedSession.get(6262);
    const result = await pending;

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session webhook timeout for PID 6262',
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(params.cleanupSpawnResources).toHaveBeenCalledOnce();
    expect(
      params.cleanupSpawnResources.mock.invocationCallOrder[0],
    ).toBeLessThan(
      params.onChildExited.mock.invocationCallOrder[0]!,
    );
    expect(tracked).toEqual(expect.objectContaining({
      sessionWebhookTimedOutAtMs: expect.any(Number),
    }));
  });

  it('retains regular startup custody when canonical exit cleanup is incomplete', async () => {
    const child = createFakeChildProcess(6264);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = '10';
    const { spawnRegularProcessAndWaitForWebhook } =
      await import('./spawnRegularProcessAndWaitForWebhook');
    const params = createParams();
    params.onChildExited.mockImplementation(async () => undefined);

    await expect(
      spawnRegularProcessAndWaitForWebhook(params),
    ).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage:
        'startup_retirement_incomplete:exit_cleanup_incomplete',
    });
    expect(params.onChildExited).toHaveBeenCalledOnce();
    expect(params.pidToTrackedSession.get(6264)).toEqual(
      expect.objectContaining({ pid: 6264 }),
    );
  });

  it('reports timeout and retires once when canonical activation outlives the startup deadline', async () => {
    const child = createFakeChildProcess(6263);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = '25';
    let resumeActivation!: () => void;
    const activationPaused = new Promise<void>((resolve) => {
      resumeActivation = resolve;
    });
    let announceActivation!: () => void;
    const activationEntered = new Promise<void>((resolve) => { announceActivation = resolve; });
    const activationStarted = vi.fn(() => announceActivation());
    let announceMarker!: () => void;
    const markerStarted = new Promise<void>((resolve) => { announceMarker = resolve; });
    const params = createParams();
    params.onChildExited.mockImplementation(async (pid) => {
      params.pidToTrackedSession.delete(pid);
    });
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker
      .mockImplementationOnce(async (tracked) => {
        tracked.activateConnectedAccountSessionBindingOnCanonicalSession =
          vi.fn(async () => {
            activationStarted();
            await activationPaused;
            return null;
          });
        announceMarker();
      });
    const onTrackedSessionReady = vi.fn(async () => undefined);
    const { spawnRegularProcessAndWaitForWebhook } =
      await import('./spawnRegularProcessAndWaitForWebhook');
    const { createOnHappySessionWebhook } =
      await import('../sessions/onHappySessionWebhook');
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: vi.fn(async () => undefined),
      onTrackedSessionReady,
    });

    const pending = spawnRegularProcessAndWaitForWebhook({
      ...params,
    });
    await markerStarted;
    expect(params.pidToAwaiter.has(6263)).toBe(true);
    const tracked = params.pidToTrackedSession.get(6263);
    expect(tracked).toBeDefined();
    const canonicalWebhook = onWebhook(
      'session-6263',
      {
        hostPid: 6263,
        path: '/tmp/happier-project',
        startedBy: 'daemon',
      } as Metadata,
    );
    await activationEntered;
    expect(activationStarted).toHaveBeenCalledOnce();

    await expect(pending).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session webhook timeout for PID 6263',
    });
    expect(child.kill).not.toHaveBeenCalled();

    resumeActivation();
    await expect(canonicalWebhook).rejects.toThrow(
      'custody changed',
    );
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
    expect(params.pidToAwaiter).toHaveLength(0);
    expect(params.pidToSpawnResultResolver).toHaveLength(0);
    expect(params.pidToSpawnWebhookTimeout).toHaveLength(0);
  });

  it('applies the spawned child OOM score adjustment after a PID is available', async () => {
    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = createParams();

    const resultPromise = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => {
      expect(mocks.writeFile).toHaveBeenCalledWith('/proc/4242/oom_score_adj', '321\n', 'utf8');
    });
    const awaiter = params.pidToAwaiter.get(4242);
    expect(awaiter).toBeDefined();
    awaiter?.({
      startedBy: 'daemon',
      pid: 4242,
      happySessionId: 'session-1',
      spawnOptions: params.trackedSpawnOptions,
      directoryCreated: false,
    });

    await expect(resultPromise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
  });

  it('uses daemon-issued child controls instead of ambient process env for regular child launch', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/ambient-happier-home';
    process.env.HAPPIER_SERVER_URL = 'https://ambient.example.test';

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = {
      ...createParams(),
      processEnv: {
        PATH: process.env.PATH,
        HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
        HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ: '321',
        HAPPIER_HOME_DIR: '/tmp/ambient-happier-home',
        HAPPIER_SERVER_URL: 'https://ambient.example.test',
      },
      extraEnvForChildWithMessage: {
        HAPPIER_HOME_DIR: '/tmp/daemon-happier-home',
        HAPPIER_SERVER_URL: 'https://daemon.example.test',
      },
    } as Parameters<typeof spawnRegularProcessAndWaitForWebhook>[0] & { processEnv: NodeJS.ProcessEnv };

    const resultPromise = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => {
      expect(mocks.spawnHappyCLI).toHaveBeenCalled();
    });
    const launchOptions = mocks.spawnHappyCLI.mock.calls[0]?.[1] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(launchOptions?.env?.HAPPIER_HOME_DIR).toBe('/tmp/daemon-happier-home');
    expect(launchOptions?.env?.HAPPIER_SERVER_URL).toBe('https://daemon.example.test');

    const awaiter = params.pidToAwaiter.get(4242);
    expect(awaiter).toBeDefined();
    awaiter?.({
      startedBy: 'daemon',
      pid: 4242,
      happySessionId: 'session-1',
      spawnOptions: params.trackedSpawnOptions,
      directoryCreated: false,
    });

    await expect(resultPromise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
  });
});

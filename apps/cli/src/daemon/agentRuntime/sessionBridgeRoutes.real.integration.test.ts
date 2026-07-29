import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';

import { configuration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { waitForCondition } from '@/testkit/async/waitFor';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { createSpawnPluginRuntimeLease } from '@/daemon/spawn/spawnPluginRuntimeLease';
import { prepareAgentRuntimeSessionBridge } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { spawnRegularProcessAndWaitForWebhook } from '@/daemon/spawn/spawnRegularProcessAndWaitForWebhook';
import type { TrackedSession } from '@/daemon/types';
import { createExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import {
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { createAgentRuntimeSessionBridgeRoutes } from './sessionBridgeRoutes';

const fixturePath = resolve(
  process.cwd(),
  'src/daemon/agentRuntime/fixtures/realDaemonChildBridge.fixture.ts',
);
const DAEMON_CHILD_BUNDLE_CACHE_ROOT = join(
  process.cwd(),
  'node_modules',
  '.cache',
  'happier-tests',
  'daemon-agent-runtime-session-bridge',
);

async function spawnDaemonChild(params: Readonly<{
  role: 'external' | 'loss' | 'restart' | 'packed' | 'packed-restart';
  authorization: NonNullable<Awaited<ReturnType<typeof prepareAgentRuntimeSessionBridge>>>['authorization'];
  bundlePath: string;
  resultPath: string;
  readyPath: string;
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
  onChildExited: (pid: number) => void | Promise<void>;
}>) {
  const spawnResultPromise = spawnRegularProcessAndWaitForWebhook({
    args: [],
    directory: process.cwd(),
    options: { directory: process.cwd() },
    trackedSpawnOptions: { directory: process.cwd() },
    normalizedExistingSessionId: 'g3-real-session',
    effectiveResume:
      params.role === 'restart' || params.role === 'packed-restart'
        ? 'provider-g3-composed'
        : '',
    directoryCreated: false,
    extraEnvForChildWithMessage: {
      HAPPIER_HOME_DIR: configuration.happyHomeDir,
      HAPPIER_ACTIVE_SERVER_ID: configuration.activeServerId,
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID:
        process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID ?? configuration.activeServerId,
      HAPPIER_SERVER_URL: configuration.serverUrl,
      HAPPIER_LOCAL_SERVER_URL: configuration.apiServerUrl,
      HAPPIER_PUBLIC_SERVER_URL: configuration.publicServerUrl,
      HAPPIER_WEBAPP_URL: configuration.webappUrl,
      HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE:
        params.authorization.tokenFilePath,
      G3_CHILD_ROLE: params.role,
      G3_CHILD_RESULT_PATH: params.resultPath,
      G3_CHILD_READY_PATH: params.readyPath,
    },
    localServicesBridgeAuthorization: {
      tokenHash: 'fixture-unused',
      pluginId: 'happier.agent.grok',
      contributionId: 'grok',
    },
    agentRuntimeSessionBridgeAuthorization: params.authorization,
    processEnv: process.env,
    pidToTrackedSession: params.pidToTrackedSession,
    pidToAwaiter: params.pidToAwaiter,
    pidToSpawnResultResolver: params.pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
    resolveCanonicalTrackedSessionId: () => 'g3-real-session',
    onChildExited: async (pid) => await params.onChildExited(pid),
    spawnLifecycleCallbacks: {
      async persistAcceptedSpawnMarker() {},
      async removeAcceptedSpawnMarkerIfOwned() {
        return true;
      },
      consumeSessionAttachCleanupForPid() {},
      async cleanupPendingSessionAttach() {},
      registerSpawnResourceCleanupForPid() {},
      registerConnectedServiceSpawnTarget() {},
    },
    async cleanupSpawnResources() {},
    logDebug() {},
    warn() {},
    runnerLaunchOptions: {
      runtimeDecision: {
        runtime: 'node',
        argvPrefix: [params.bundlePath],
      },
    },
  });

  await waitForCondition(
    () => Array.from(params.pidToTrackedSession.values()).some(
      (session) => session.happySessionId === 'g3-real-session',
    ),
    { timeoutMs: 20_000, intervalMs: 10, label: 'daemon-spawned child custody' },
  );
  const tracked = Array.from(params.pidToTrackedSession.values()).find(
    (session) => session.happySessionId === 'g3-real-session',
  );
  if (!tracked?.childProcess || typeof tracked.pid !== 'number') {
    throw new Error('Expected daemon spawn custody for the real child process');
  }
  expect(tracked).toMatchObject({
    happySessionId: 'g3-real-session',
    agentRuntimeBridgeTokenHash: params.authorization.tokenHash,
    agentRuntimeBridgePluginId: params.authorization.descriptor.pluginId,
    agentRuntimeBridgeAgentId: params.authorization.descriptor.agentId,
    agentRuntimeBridgeBackendId: params.authorization.descriptor.backendId,
    agentRuntimeBridgeGeneration: params.authorization.descriptor.generation,
  });
  const child = tracked.childProcess;
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const exited = new Promise<void>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveExit();
      else reject(new Error(`child exited code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
  const webhook = params.pidToAwaiter.get(tracked.pid);
  if (!webhook) throw new Error('Expected daemon spawn webhook awaiter');
  webhook(tracked);
  expect(await spawnResultPromise).toMatchObject({
    type: 'success',
    sessionId: 'g3-real-session',
  });
  return Object.freeze({
    child,
    pid: tracked.pid,
    exited,
    output: () => Object.freeze({ stdout, stderr }),
  });
}

describe('daemon Agent runtime composed child carrier', () => {
  it('runs takeover and acknowledged follow lifecycle from a real authenticated child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-external-session-real-child-'));
    await mkdir(DAEMON_CHILD_BUNDLE_CACHE_ROOT, { recursive: true });
    const bundleRoot = await mkdtemp(
      join(DAEMON_CHILD_BUNDLE_CACHE_ROOT, 'external-session-real-child-'),
    );
    const childBundlePath = join(bundleRoot, 'real-daemon-child-bridge.mjs');
    const resultPath = join(root, 'external-result.json');
    const readyPath = join(root, 'external-ready');
    await build({
      entryPoints: [fixturePath],
      outfile: childBundlePath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      target: 'node22',
      alias: { '@': resolve(process.cwd(), 'src') },
    });

    let app: ReturnType<typeof createDaemonControlApp> | null = null;
    let routes: ReturnType<typeof createAgentRuntimeSessionBridgeRoutes> | null = null;
    const scope = createProviderLaunchResourceScope();
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const pidToSpawnResultResolver =
      new Map<number, (result: SpawnSessionResult) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    const retirement = new AbortController();
    const owner = createExternalSessionHostOperationOwner();
    const takeoverRequests: unknown[] = [];
    const followRequests: unknown[] = [];
    const bridgeOperationKinds: string[] = [];
    let followDisposeCount = 0;
    let resolveFollowEventAcknowledged: () => void = () => {};
    let rejectFollowEventAcknowledged: (error: unknown) => void = () => {};
    const followEventAcknowledged = new Promise<void>((resolveAck, rejectAck) => {
      resolveFollowEventAcknowledged = resolveAck;
      rejectFollowEventAcknowledged = rejectAck;
    });
    const installation = await owner.install({
      takeoverOperation: {
        async execute(request) {
          takeoverRequests.push(request);
          return Object.freeze({
            sessionId: 'g3-real-external-session',
            status: 'takenOver' as const,
          });
        },
      },
      followOperation: {
        async execute(request) {
          followRequests.push(request);
          setImmediate(() => {
            void Promise.resolve(request.listener({
              kind: 'data',
              items: [{
                id: 'g3-real-item',
                timestampMs: 11,
                kind: 'agent',
                data: {
                  type: 'text',
                  text: 'real child follow event',
                },
              }],
              fromCursor: 'g3-real-cursor-start',
              nextCursor: 'g3-real-cursor-next',
            })).then(
              async () => {
                await writeFile(`${resultPath}.follow-ack`, 'ack\n', 'utf8');
                resolveFollowEventAcknowledged();
              },
              rejectFollowEventAcknowledged,
            );
          });
          return Object.freeze({
            status: 'following' as const,
            startingCursor: 'g3-real-cursor-start',
            subscription: Object.freeze({
              async dispose() {
                followDisposeCount += 1;
              },
            }),
          });
        },
      },
    });
    try {
      const baseRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: configuration.happyHomeDir,
        pluginIds: ['happier.agent.grok'],
        generation: 31,
      });
      const registration = baseRegistry.agentRuntimesByAgentId.get('grok');
      if (!registration?.hasPrimaryRuntime) {
        throw new Error('Expected primary Grok Agent registration');
      }
      const registry = Object.freeze({
        ...baseRegistry,
        agentRuntimesByAgentId: new Map([['grok', Object.freeze({
          ...registration,
          retirementSignal: retirement.signal,
          isCurrent: () => !retirement.signal.aborted,
          async createRuntime() {
            return Object.freeze({
              sessions: Object.freeze({
                async open() {
                  return Object.freeze({
                    async send() {
                      return Object.freeze({ status: 'admitted' as const });
                    },
                    watch() {
                      return Object.freeze({ dispose() {} });
                    },
                    async dispose() {},
                  });
                },
              }),
            });
          },
        })]]),
      });
      const initialLease = await pluginReloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: async () => registry,
      });
      await initialLease.release();

      const prepared = await prepareAgentRuntimeSessionBridge({
        target: {
          kind: 'backend',
          backendId: 'grok',
          sourceKind: 'built_in',
        },
        pluginRuntimeLease: createSpawnPluginRuntimeLease(scope),
      });
      if (!prepared) {
        throw new Error('Expected real child Agent bridge authorization');
      }
      routes = createAgentRuntimeSessionBridgeRoutes({
        externalSessionHostOperationOwner: owner,
        externalSessionHostBindingContext: {
          machineId: 'external-real-machine',
          readAccountRevision: () => 'external-real-account-revision',
        },
      });
      app = createDaemonControlApp({
        getChildren: () => Array.from(pidToTrackedSession.values()),
        machineId: 'external-real-machine',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({
          type: 'success' as const,
          sessionId: 'unused',
        }),
        requestShutdown: () => {},
        onHappySessionWebhook: () => {},
        controlToken: 'external-real-control-token',
        agentRuntimeSessionBridge: routes,
      });
      app.addHook('preHandler', async (request) => {
        if (request.url !== '/agent-runtime/session/bridge') return;
        const kind = (
          request.body as { operation?: { kind?: unknown } } | undefined
        )?.operation?.kind;
        if (
          typeof kind === 'string'
          && (
            kind.startsWith('session.externalSession.')
            || kind === 'effect.complete'
          )
        ) {
          bridgeOperationKinds.push(kind);
        }
        if (kind === 'session.externalSession.follow.close') {
          await writeFile(`${resultPath}.follow-close-seen`, 'close\n', 'utf8');
        }
      });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      writeDaemonState({
        pid: process.pid,
        httpPort: Number(new URL(address).port),
        startedAt: Date.now(),
        startedWithCliVersion: 'external-real-source',
        controlToken: 'external-real-control-token',
      });

      const child = await spawnDaemonChild({
        role: 'external',
        authorization: prepared.authorization,
        bundlePath: childBundlePath,
        resultPath,
        readyPath,
        pidToTrackedSession,
        pidToAwaiter,
        pidToSpawnResultResolver,
        pidToSpawnWebhookTimeout,
        onChildExited: async (pid) => {
          const exited = pidToTrackedSession.get(pid);
          pidToTrackedSession.delete(pid);
          if (exited?.happySessionId) {
            await routes?.disposeSession(exited.happySessionId);
          }
        },
      });
      await child.exited;
      await followEventAcknowledged;
      const result = JSON.parse(await readFile(resultPath, 'utf8'));
      expect(result).toMatchObject({
        externalSessionTakeoverResult: {
          sessionId: 'g3-real-external-session',
          status: 'takenOver',
        },
        externalSessionFollowResult: {
          status: 'following',
          startingCursor: 'g3-real-cursor-start',
        },
        externalSessionFollowEvents: [{
          kind: 'data',
          fromCursor: 'g3-real-cursor-start',
          nextCursor: 'g3-real-cursor-next',
        }],
        externalSessionProjectedTranscript: [{
          provider: 'grok',
          body: {
            type: 'message',
            message: 'real child follow event',
          },
          options: {
            localId: 'g3-real-item',
            provenance: {
              kind: 'non_dependent',
              source: 'external',
            },
          },
        }],
      });
      expect(bridgeOperationKinds).toEqual(expect.arrayContaining([
        'session.externalSession.takeover',
        'session.externalSession.follow.open',
        'effect.complete',
        'session.externalSession.follow.close',
      ]));
      expect(takeoverRequests).toHaveLength(1);
      expect(takeoverRequests[0]).toMatchObject({
        pluginId: 'happier.agent.grok',
        contributionId: 'grok',
        sessionId: 'g3-real-session',
        machineId: 'external-real-machine',
        accountRevision: 'external-real-account-revision',
        ref: {
          agentId: 'grok',
          sourceId: 'fixture',
          remoteSessionId: 'g3-real-external-session',
        },
      });
      expect(followRequests).toHaveLength(1);
      expect(followDisposeCount).toBe(1);
    } finally {
      retirement.abort();
      await routes?.dispose();
      await app?.close();
      await installation.dispose();
      await owner.retire();
      await scope.release();
      await pluginReloadController.shutdown({ timeoutMs: 2_000 });
      await rm(root, { recursive: true, force: true });
      await rm(bundleRoot, { recursive: true, force: true });
    }
  }, 120_000);

  const installedPackedPluginRoot =
    process.env.HAPPIER_AGENT_RUNTIME_CONFORMANCE_PACKED_PLUGIN_ROOT;
  const packedDaemonChildTest = installedPackedPluginRoot ? it : it.skip;
  packedDaemonChildTest(
    'runs the installed packed third-party native Agent through the real daemon-child bridge',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'happier-packed-native-real-child-'));
      await mkdir(DAEMON_CHILD_BUNDLE_CACHE_ROOT, { recursive: true });
      const bundleRoot = await mkdtemp(
        join(DAEMON_CHILD_BUNDLE_CACHE_ROOT, 'packed-native-real-child-'),
      );
      const childBundlePath = join(bundleRoot, 'real-daemon-child-bridge.mjs');
      const resultPath = join(root, 'packed-result.json');
      const readyPath = join(root, 'packed-ready');
      await build({
        entryPoints: [fixturePath],
        outfile: childBundlePath,
        bundle: true,
        format: 'esm',
        platform: 'node',
        packages: 'external',
        target: 'node22',
        alias: { '@': resolve(process.cwd(), 'src') },
      });

      let app: ReturnType<typeof createDaemonControlApp> | null = null;
      let routes: ReturnType<typeof createAgentRuntimeSessionBridgeRoutes> | null = null;
      const scopes: ReturnType<typeof createProviderLaunchResourceScope>[] = [];
      const pidToTrackedSession = new Map<number, TrackedSession>();
      const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
      const pidToSpawnResultResolver =
        new Map<number, (result: SpawnSessionResult) => void>();
      const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
      const observedBridgeRequests: unknown[] = [];
      const observedBridgeResponses: unknown[] = [];
      const installReloadController = createPluginReloadController({
        happyHomeDir: configuration.happyHomeDir,
      });
      try {
        const pluginId = 'acme.native-runtime-proof';
        const agentId = 'novel-native-agent';
        const distribution =
          await createLocalPathPluginDistributionIdentity(installedPackedPluginRoot!);
        const trust = createPluginTrustRecord({
          pluginId,
          distribution,
          approvedAtMs: 1,
        });
        await createPluginRegistryStateStore({
          happyHomeDir: configuration.happyHomeDir,
          runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({
            happyHomeDir: configuration.happyHomeDir,
            reloadController: installReloadController,
          }),
        }).install({
          pluginId,
          sourceRootPath: installedPackedPluginRoot!,
          manifestRelativePath: '.happier-plugin/plugin.json',
          catalogRecord: {
            source: {
              kind: 'path',
              locator: installedPackedPluginRoot!,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: installedPackedPluginRoot!,
              manifestPath: join(
                installedPackedPluginRoot!,
                '.happier-plugin',
                'plugin.json',
              ),
            },
            compatibility: { status: 'compatible', diagnostics: [] },
            install: {
              mode: 'link',
              manifestVersion: '1.0.0',
              trust,
              updatePolicy: 'manual',
            },
            state: { enabled: true },
          },
          trust,
          updatePolicy: 'manual',
          optionalAccess: [],
        });
        await installReloadController.shutdown();

        const registry = await resolveExecutablePluginRuntimeRegistry({
          happyHomeDir: configuration.happyHomeDir,
          pluginIds: [pluginId],
          generation: 41,
        });
        const registration = registry.agentRuntimesByAgentId.get(agentId);
        if (
          !registration?.hasPrimaryRuntime
          || registration.pluginId !== pluginId
        ) {
          throw new Error(
            'Expected installed packed third-party native Agent registration',
          );
        }
        const initialLease = await pluginReloadController.acquireRuntimeRegistry({
          resolveRuntimeRegistry: async () => registry,
        });
        await initialLease.release();

        const prepare = async () => {
          const scope = createProviderLaunchResourceScope();
          scopes.push(scope);
          const prepared = await prepareAgentRuntimeSessionBridge({
            target: {
              kind: 'backend',
              backendId: agentId,
              sourceKind: 'configured',
            },
            pluginRuntimeLease: createSpawnPluginRuntimeLease(scope),
          });
          if (!prepared) {
            throw new Error(
              'Expected installed packed third-party Agent bridge authorization',
            );
          }
          expect(prepared.authorization.descriptor).toMatchObject({
            pluginId,
            agentId,
            backendId: agentId,
          });
          return prepared;
        };
        const prepared = await prepare();

        routes = createAgentRuntimeSessionBridgeRoutes();
        app = createDaemonControlApp({
          getChildren: () => Array.from(pidToTrackedSession.values()),
          machineId: 'packed-real-machine',
          stopSession: async () => ({ status: 'not_found' as const }),
          spawnSession: async () => ({
            type: 'success' as const,
            sessionId: 'unused',
          }),
          requestShutdown: () => {},
          onHappySessionWebhook: () => {},
          controlToken: 'packed-real-control-token',
          agentRuntimeSessionBridge: routes,
        });
        app.addHook('preHandler', async (request) => {
          if (request.url !== '/agent-runtime/session/bridge') return;
          const body = request.body as {
            context?: unknown;
            operation?: { kind?: unknown };
          };
          observedBridgeRequests.push({
            context: body.context,
            operationKind: body.operation?.kind,
          });
        });
        app.addHook('onSend', async (request, reply, payload) => {
          if (request.url !== '/agent-runtime/session/bridge') return payload;
          const response = JSON.parse(String(payload)) as {
            ok?: unknown;
            error?: unknown;
          };
          observedBridgeResponses.push({
            statusCode: reply.statusCode,
            ok: response.ok,
            error: response.error,
          });
          return payload;
        });
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        writeDaemonState({
          pid: process.pid,
          httpPort: Number(new URL(address).port),
          startedAt: Date.now(),
          startedWithCliVersion: 'packed-real-source',
          controlToken: 'packed-real-control-token',
        });

        const onChildExited = async (pid: number) => {
          const exited = pidToTrackedSession.get(pid);
          pidToTrackedSession.delete(pid);
          if (exited?.happySessionId) {
            await routes?.disposeSession(exited.happySessionId);
          }
        };
        const child = await spawnDaemonChild({
          role: 'packed',
          authorization: prepared.authorization,
          bundlePath: childBundlePath,
          resultPath,
          readyPath,
          pidToTrackedSession,
          pidToAwaiter,
          pidToSpawnResultResolver,
          pidToSpawnWebhookTimeout,
          onChildExited,
        });
        try {
          await child.exited;
        } catch (error) {
          const output = child.output();
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}`
            + `; bridgeRequests=${JSON.stringify(observedBridgeRequests)}`
            + `; bridgeResponses=${JSON.stringify(observedBridgeResponses)}`
            + `; stdout=${output.stdout}; stderr=${output.stderr}`,
          );
        }
        const result = JSON.parse(await readFile(resultPath, 'utf8'));
        expect(result).toMatchObject({
          role: 'packed',
          carrierCurrent: true,
          sessionIdentityAfterSubscribe: {
            sessionId: 'provider-g3-real-session',
          },
          providerSessionIdentityEventCount: 1,
          runtimeIdentityPublicationCount: 1,
        });
        expect(result.events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'input-accepted',
            inputIds: ['input-packed'],
          }),
          expect.objectContaining({
            kind: 'turn-start',
            turnId: 'turn-packed',
          }),
          expect.objectContaining({
            kind: 'message-delta',
            text: 'packed daemon-child bridge',
          }),
          expect.objectContaining({
            kind: 'turn-complete',
            turnId: 'turn-packed',
          }),
        ]));
        expect(result.durableTranscript).toEqual(expect.arrayContaining([
          expect.objectContaining({
            provider: agentId,
            body: {
              type: 'message',
              message: 'packed daemon-child bridge',
            },
          }),
        ]));

        await scopes[0]!.release();
        await registry.dispose();
        const restartRegistry = await resolveExecutablePluginRuntimeRegistry({
          happyHomeDir: configuration.happyHomeDir,
          pluginIds: [pluginId],
          generation: 42,
        });
        await pluginReloadController.adoptPreparedRuntimeRegistry({
          registry: restartRegistry,
          changedPluginIds: [pluginId],
          durableRevision: 1,
        });
        const restartedPrepared = await prepare();
        expect(restartedPrepared.authorization.descriptor.generation).toBe('42');
        const restartResultPath = join(root, 'packed-restart-result.json');
        const restartReadyPath = join(root, 'packed-restart-ready');
        const restarted = await spawnDaemonChild({
          role: 'packed-restart',
          authorization: restartedPrepared.authorization,
          bundlePath: childBundlePath,
          resultPath: restartResultPath,
          readyPath: restartReadyPath,
          pidToTrackedSession,
          pidToAwaiter,
          pidToSpawnResultResolver,
          pidToSpawnWebhookTimeout,
          onChildExited,
        });
        try {
          await restarted.exited;
        } catch (error) {
          const output = restarted.output();
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}`
            + `; bridgeRequests=${JSON.stringify(observedBridgeRequests)}`
            + `; bridgeResponses=${JSON.stringify(observedBridgeResponses)}`
            + `; stdout=${output.stdout}; stderr=${output.stderr}`,
          );
        }
        const restartResult =
          JSON.parse(await readFile(restartResultPath, 'utf8'));
        expect(restartResult).toMatchObject({
          role: 'packed-restart',
          carrierCurrent: true,
          sessionIdentityAfterSubscribe: {
            sessionId: 'provider-g3-composed',
          },
          providerSessionIdentityEventCount: 1,
          runtimeIdentityPublicationCount: 1,
        });
        expect(restartResult.events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'input-accepted',
            inputIds: ['input-packed-restart'],
          }),
          expect.objectContaining({
            kind: 'turn-start',
            turnId: 'turn-packed-restart',
          }),
          expect.objectContaining({
            kind: 'turn-complete',
            turnId: 'turn-packed-restart',
          }),
        ]));
      } finally {
        await installReloadController.shutdown();
        await routes?.dispose();
        await app?.close();
        for (const scope of scopes.reverse()) await scope.release();
        await pluginReloadController.shutdown({ timeoutMs: 2_000 });
        await rm(root, { recursive: true, force: true });
        await rm(bundleRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it('runs the real daemon route, child ACP composer, provider process, retirement, and restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-g3-real-composed-'));
    await mkdir(DAEMON_CHILD_BUNDLE_CACHE_ROOT, { recursive: true });
    const bundleRoot = await mkdtemp(
      join(DAEMON_CHILD_BUNDLE_CACHE_ROOT, 'g3-real-child-'),
    );
    const fakeBin = join(root, 'bin');
    const fakeGrokPath = join(
      fakeBin,
      process.platform === 'win32' ? 'grok.cmd' : 'grok',
    );
    const fakeGrokModulePath = join(fakeBin, 'grok.mjs');
    const providerLogPath = join(root, 'provider.jsonl');
    const childBundlePath = join(bundleRoot, 'real-daemon-child-bridge.mjs');
    await mkdir(fakeBin, { recursive: true });
    await build({
      entryPoints: [fixturePath],
      outfile: childBundlePath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      target: 'node22',
      alias: { '@': resolve(process.cwd(), 'src') },
    });
    await writeFile(fakeGrokModulePath, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const providerLogPath = ${JSON.stringify(providerLogPath)};
const log = (value) => appendFileSync(providerLogPath, JSON.stringify({ pid: process.pid, ...value }) + '\\n');
log({ kind: 'spawn', argv: process.argv.slice(2) });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  log({ kind: 'request', method: request.method });
  if (request.method === 'initialize') ok(request.id, {
    protocolVersion: 1,
    agentCapabilities: {},
    authMethods: [{ id: 'cached_token', name: 'Cached token' }],
  });
  else if (request.method === 'authenticate') ok(request.id, {});
  else if (request.method === 'session/new') ok(request.id, { sessionId: 'provider-g3-composed' });
  else if (request.method === 'session/load') ok(request.id, {});
  else if (request.method === 'session/prompt') {
    const text = JSON.stringify(request.params.prompt);
    if (text.includes('hang')) {
      send({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: request.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'holding' } },
      } });
      send({ jsonrpc: '2.0', method: 'x.ai/session/prompt_complete', params: {
        sessionId: request.params.sessionId,
        promptId: request.params._meta.promptId,
        stopReason: 'end_turn',
      } });
    } else {
      for (let index = 0; index < 42; index += 1) {
        send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: request.params.sessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '.' } },
        } });
      }
      for (const chunk of ['GRO', 'K', '_', 'CURRENT', '_', 'BYTES', '_', 'READY']) {
        send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: request.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
        } });
      }
      send({ jsonrpc: '2.0', method: 'x.ai/session/prompt_complete', params: {
        sessionId: request.params.sessionId,
        promptId: request.params._meta.promptId,
        stopReason: 'end_turn',
      } });
      ok(request.id, { stopReason: 'end_turn' });
    }
  } else if (request.method === 'session/cancel') ok(request.id, {});
  else ok(request.id, {});
}
`, 'utf8');
    await writeFile(
      fakeGrokPath,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${fakeGrokModulePath}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${fakeGrokModulePath}" "$@"\n`,
      'utf8',
    );
    if (process.platform !== 'win32') {
      await chmod(fakeGrokPath, 0o755);
    }

    const originalPath = process.env.PATH;
    const originalGrokPathOverride = process.env.HAPPIER_GROK_PATH;
    process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ''}`;
    process.env.HAPPIER_GROK_PATH = fakeGrokPath;
    let app: ReturnType<typeof createDaemonControlApp> | null = null;
    let routes: ReturnType<typeof createAgentRuntimeSessionBridgeRoutes> | null = null;
    const scopes: ReturnType<typeof createProviderLaunchResourceScope>[] = [];
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: SpawnSessionResult) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    const completedExitTeardowns = new Set<number>();
    const observedBridgeRequests: unknown[] = [];
    const observedBridgeResponses: Array<{
      operationKind?: unknown;
      events?: Array<{ sequence?: unknown; kind?: unknown }>;
    } & Record<string, unknown>> = [];
    let lastObservedBridgeRequestKind: unknown;
    let lastPollResponseFingerprint: string | null = null;
    let generationOneEventHeld = false;
    let generationTwoStarted = false;
    let lateGenerationOneEventCount = 0;
    let releaseHeldGenerationOneEvent: () => void = () => undefined;
    const heldGenerationOneEvent = new Promise<void>((resolveHeldEvent) => {
      releaseHeldGenerationOneEvent = resolveHeldEvent;
    });
    try {
      const firstRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: configuration.happyHomeDir,
        pluginIds: ['happier.agent.grok'],
        generation: 1,
      });
      const initialLease = await pluginReloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: async () => firstRegistry,
      });
      await initialLease.release();

      const prepare = async () => {
        const scope = createProviderLaunchResourceScope();
        scopes.push(scope);
        const prepared = await prepareAgentRuntimeSessionBridge({
          target: {
            kind: 'backend',
            backendId: 'grok',
            sourceKind: 'built_in',
          },
          pluginRuntimeLease: createSpawnPluginRuntimeLease(scope),
        });
        if (!prepared) throw new Error('Expected Grok daemon Agent bridge authorization');
        return prepared;
      };
      const first = await prepare();
      routes = createAgentRuntimeSessionBridgeRoutes();
      app = createDaemonControlApp({
        getChildren: () => Array.from(pidToTrackedSession.values()),
        machineId: 'g3-real-machine',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
        requestShutdown: () => {},
        onHappySessionWebhook: () => {},
        controlToken: 'g3-real-control-token',
        agentRuntimeSessionBridge: routes,
      });
      app.addHook('preHandler', async (request) => {
        if (request.url === '/agent-runtime/session/bridge') {
          const body = request.body as {
            context?: {
              sessionId?: unknown;
              pluginId?: unknown;
              agentId?: unknown;
              generation?: unknown;
            };
            operation?: {
              kind?: unknown;
              event?: { sequence?: unknown; kind?: unknown };
            };
          };
          if (
            body.operation?.kind !== 'channel.poll'
            || lastObservedBridgeRequestKind !== 'channel.poll'
          ) {
            observedBridgeRequests.push({
              context: body.context,
              operationKind: body.operation?.kind,
              ...(body.operation?.kind === 'acp.session.event'
                ? {
                    eventSequence: body.operation.event?.sequence,
                    eventKind: body.operation.event?.kind,
                  }
                : {}),
            });
          }
          lastObservedBridgeRequestKind = body.operation?.kind;
          if (
            generationTwoStarted
            && body.context?.generation === '1'
            && body.operation?.kind === 'acp.session.event'
          ) {
            lateGenerationOneEventCount += 1;
          }
          if (
            body.context?.generation === '1'
            && (
              (
                body.operation?.kind === 'acp.session.event'
                && body.operation.event?.sequence === 5
              )
              || body.operation?.kind === 'request.cancel'
            )
          ) {
            if (body.operation?.kind === 'acp.session.event') {
              generationOneEventHeld = true;
            }
            await heldGenerationOneEvent;
          }
          if (
            body.context?.generation === '2'
            && (
              (
                body.operation?.kind === 'acp.session.event'
                && body.operation.event?.sequence === 2
              )
              || body.operation?.kind === 'acp.callback.extension.notification'
            )
          ) {
            await new Promise<void>((resolveDelay) => {
              setTimeout(resolveDelay, 75);
            });
          }
        }
      });
      app.addHook('onSend', async (request, reply, payload) => {
        if (request.url === '/agent-runtime/session/bridge') {
          const operationKind = (
            request.body as { operation?: { kind?: unknown } } | undefined
          )?.operation?.kind;
          const response = JSON.parse(String(payload)) as {
            ok?: unknown;
            result?: {
              events?: Array<{ sequence?: unknown; kind?: unknown }>;
              effects?: Array<{ effectId?: unknown; kind?: unknown }>;
            };
            error?: unknown;
          };
          const summary = {
            operationKind,
            statusCode: reply.statusCode,
            ok: response.ok,
            ...(Array.isArray(response.result?.events)
              ? {
                  events: response.result.events.map((event) => ({
                    sequence: event.sequence,
                    kind: event.kind,
                  })),
                }
              : {}),
            ...(Array.isArray(response.result?.effects)
              ? {
                  effects: response.result.effects.map((effect) => ({
                    effectId: effect.effectId,
                    kind: effect.kind,
                  })),
                }
              : {}),
            ...(response.error === undefined ? {} : { error: response.error }),
          };
          const fingerprint = JSON.stringify(summary);
          if (
            operationKind !== 'channel.poll'
            || fingerprint !== lastPollResponseFingerprint
          ) {
            observedBridgeResponses.push(summary);
          }
          if (operationKind === 'channel.poll') {
            lastPollResponseFingerprint = fingerprint;
          }
        }
        return payload;
      });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const port = Number(new URL(address).port);
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'g3-real-source',
        controlToken: 'g3-real-control-token',
      });

      const firstResultPath = join(root, 'loss-result.json');
      const firstReadyPath = join(root, 'loss-ready');
      const onChildExited = async (pid: number) => {
        const exited = pidToTrackedSession.get(pid);
        pidToTrackedSession.delete(pid);
        if (
          exited?.happySessionId
          && !Array.from(pidToTrackedSession.values()).some(
            (session) => session.happySessionId === exited.happySessionId,
          )
        ) {
          await routes?.disposeSession(exited.happySessionId);
        }
        completedExitTeardowns.add(pid);
      };
      const firstChild = await spawnDaemonChild({
        role: 'loss',
        authorization: first.authorization,
        bundlePath: childBundlePath,
        resultPath: firstResultPath,
        readyPath: firstReadyPath,
        pidToTrackedSession,
        pidToAwaiter,
        pidToSpawnResultResolver,
        pidToSpawnWebhookTimeout,
        onChildExited,
      });
      try {
        await Promise.race([
          waitForCondition(
            () => generationOneEventHeld,
            {
              timeoutMs: 120_000,
              intervalMs: 25,
              label: 'held generation-one terminal ACP event',
            },
          ),
          firstChild.exited,
        ]);
      } catch (error) {
        const progress = await readFile(firstReadyPath, 'utf8').catch(() => 'no-progress');
        const providerLog = await readFile(providerLogPath, 'utf8').catch(() => 'no-provider-log');
        const output = firstChild.output();
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}`
          + `; progress=${progress.trim()}; provider=${providerLog.trim()}`
          + `; bridgeRequests=${JSON.stringify(observedBridgeRequests)}`
          + `; bridgeResponses=${JSON.stringify(observedBridgeResponses)}`
          + `; tracked=${JSON.stringify(Array.from(pidToTrackedSession.values()).map((session) => ({
            pid: session.pid,
            sessionId: session.happySessionId,
            pluginId: session.agentRuntimeBridgePluginId,
            agentId: session.agentRuntimeBridgeAgentId,
            backendId: session.agentRuntimeBridgeBackendId,
            generation: session.agentRuntimeBridgeGeneration,
            hasTokenHash: Boolean(session.agentRuntimeBridgeTokenHash),
          })))}`
          + `; stdout=${output.stdout}; stderr=${output.stderr}`,
        );
      }

      const deliveredGenerationOneEvents = () => observedBridgeResponses.flatMap(
        (response) => response.operationKind === 'channel.poll'
          ? response.events ?? []
          : [],
      );
      await waitForCondition(
        () => {
          const delivered = deliveredGenerationOneEvents();
          return delivered.some((event) => event.sequence === 2)
            && delivered.some((event) => event.sequence === 3)
            && delivered.some((event) => event.sequence === 4);
        },
        {
          timeoutMs: 20_000,
          intervalMs: 10,
          label: 'generation-one pre-terminal event delivery',
        },
      );
      expect(deliveredGenerationOneEvents()).toEqual(expect.arrayContaining([
        { sequence: 2, kind: 'input-accepted' },
        { sequence: 3, kind: 'turn-start' },
        { sequence: 4, kind: 'message-delta' },
      ]));
      await firstRegistry.dispose();
      let exitedBeforeHeldEventRelease = false;
      try {
        exitedBeforeHeldEventRelease = await Promise.race([
          firstChild.exited.then(() => true),
          new Promise<false>((resolveTimeout) => {
            setTimeout(() => resolveTimeout(false), 5_000);
          }),
        ]);
      } finally {
        releaseHeldGenerationOneEvent();
      }
      expect(exitedBeforeHeldEventRelease).toBe(true);
      await firstChild.exited;
      const loss = JSON.parse(await readFile(firstResultPath, 'utf8'));
      expect(loss.carrierCurrent).toBe(false);
      expect(loss.promptContributions).toMatchObject({
        kind: 'prompt',
        promptAssetBlocks: [],
      });
      expect(loss.transformedAgentContext).toMatchObject({
        prompt: 'bridge prompt',
      });
      expect(loss.sessionIdentityAfterSubscribe).toEqual({
        sessionId: 'provider-g3-composed',
      });
      expect(loss.providerSessionIdentityEventCount).toBe(1);
      expect(loss.runtimeIdentityPublicationCount).toBe(1);
      expect(loss.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-cancelled',
          turnId: 'turn-loss',
          cause: 'runtimeRecovery',
        }),
        expect.objectContaining({
          kind: 'runtime-ended',
          cause: 'protocolError',
          retryable: true,
        }),
      ]));
      await waitForCondition(
        () => completedExitTeardowns.has(firstChild.pid),
        { timeoutMs: 20_000, intervalMs: 10, label: 'daemon child-exit teardown' },
      );

      const secondRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: configuration.happyHomeDir,
        pluginIds: ['happier.agent.grok'],
        generation: 2,
      });
      await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: secondRegistry,
        changedPluginIds: ['happier.agent.grok'],
        durableRevision: 1,
      });
      const second = await prepare();
      const restartResultPath = join(root, 'restart-result.json');
      const restartReadyPath = join(root, 'restart-ready');
      generationTwoStarted = true;
      const restarted = await spawnDaemonChild({
        role: 'restart',
        authorization: second.authorization,
        bundlePath: childBundlePath,
        resultPath: restartResultPath,
        readyPath: restartReadyPath,
        pidToTrackedSession,
        pidToAwaiter,
        pidToSpawnResultResolver,
        pidToSpawnWebhookTimeout,
        onChildExited,
      });
      try {
        await restarted.exited;
      } catch (error) {
        const providerLog = await readFile(providerLogPath, 'utf8').catch(() => 'no-provider-log');
        const output = restarted.output();
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}`
          + `; provider=${providerLog.trim()}`
          + `; bridgeRequests=${JSON.stringify(observedBridgeRequests)}`
          + `; bridgeResponses=${JSON.stringify(observedBridgeResponses)}`
          + `; tracked=${JSON.stringify(Array.from(pidToTrackedSession.values()).map((session) => ({
            pid: session.pid,
            sessionId: session.happySessionId,
            pluginId: session.agentRuntimeBridgePluginId,
            agentId: session.agentRuntimeBridgeAgentId,
            backendId: session.agentRuntimeBridgeBackendId,
            generation: session.agentRuntimeBridgeGeneration,
            hasTokenHash: Boolean(session.agentRuntimeBridgeTokenHash),
          })))}`
          + `; stdout=${output.stdout}; stderr=${output.stderr}`,
        );
      }
      const restart = JSON.parse(await readFile(restartResultPath, 'utf8'));
      expect(restart.promptContributions).toMatchObject({
        kind: 'prompt',
        promptAssetBlocks: [],
      });
      expect(restart.transformedAgentContext).toMatchObject({
        prompt: 'bridge prompt',
      });
      expect(restart.sessionIdentityAfterSubscribe).toEqual({
        sessionId: 'provider-g3-composed',
      });
      expect(restart.providerSessionIdentityEventCount).toBe(1);
      expect(restart.runtimeIdentityPublicationCount).toBe(1);
      expect(restart.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'input-accepted', inputIds: ['input-restart'] }),
        expect.objectContaining({ kind: 'turn-start', turnId: 'turn-restart' }),
        expect.objectContaining({ kind: 'message-delta', text: 'GRO' }),
        expect.objectContaining({ kind: 'message-delta', text: 'READY' }),
        expect.objectContaining({ kind: 'turn-complete', turnId: 'turn-restart' }),
      ]));
      expect(restart.runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'message-delta',
          turnId: 'turn-restart',
          delta: { text: 'GRO', thinking: false },
        }),
        expect.objectContaining({
          kind: 'turn-complete',
          turnId: 'turn-restart',
        }),
      ]));
      expect(restart.transcriptProjectionResults).toEqual(expect.arrayContaining([
        { projected: true, kind: 'message-delta' },
        { projected: true, kind: 'turn-complete' },
      ]));
      expect(restart.durableCommitWasPendingAtTurnCompletion).toBe(true);
      expect(restart.disposalStartedBeforeDurableCommitReleased).toBe(false);
      expect(restart.durableTranscript).toEqual(expect.arrayContaining([
        expect.objectContaining({
          provider: 'grok',
          body: {
            type: 'message',
            message: 'GROK_CURRENT_BYTES_READY',
          },
          options: expect.objectContaining({
            meta: expect.objectContaining({
              happierStreamSegmentV1: expect.objectContaining({
                segmentKind: 'assistant',
                segmentState: 'complete',
              }),
            }),
          }),
        }),
      ]));
      const providerLog = (await readFile(providerLogPath, 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line));
      expect(new Set(providerLog.filter((entry) => entry.kind === 'spawn').map((entry) => entry.pid)).size).toBe(2);
      expect(providerLog).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'request', method: 'session/new' }),
        expect.objectContaining({ kind: 'request', method: 'session/load' }),
        expect.objectContaining({ kind: 'request', method: 'session/prompt' }),
        expect.objectContaining({ kind: 'request', method: 'session/cancel' }),
      ]));
      expect(lateGenerationOneEventCount).toBe(0);
    } finally {
      releaseHeldGenerationOneEvent();
      await routes?.dispose();
      await app?.close();
      for (const scope of scopes.reverse()) await scope.release();
      await pluginReloadController.shutdown({ timeoutMs: 2_000 });
      process.env.PATH = originalPath;
      if (originalGrokPathOverride === undefined) {
        delete process.env.HAPPIER_GROK_PATH;
      } else {
        process.env.HAPPIER_GROK_PATH = originalGrokPathOverride;
      }
      await rm(root, { recursive: true, force: true });
      await rm(bundleRoot, { recursive: true, force: true });
    }
  }, 240_000);
});

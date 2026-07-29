import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { StressConfig } from '../config/stressScenarioSchema';
import { startFullComposeStressTarget } from './startFullComposeStressTarget';

const config: StressConfig = {
  targetMode: 'full-compose',
  baseUrl: undefined,
  repeat: 1,
  seed: 42,
  flakeRetry: false,
  socketTransport: 'websocket',
  duration: {
    warmupMs: 1000,
    durationMs: 10000,
    cooldownMs: 1000,
    soakMs: 0,
  },
  load: {
    users: 25,
    machinesPerUser: 1,
    sessionsPerUser: 1,
    rpcListenersPerUser: 1,
    rpcCallsPerSecond: 2,
    messagesPerSecond: 5,
    reconnectRate: 0,
    mixedSessionMode: 'representative',
  },
  orchestration: {
    rollingRestartEnabled: true,
    killTarget: 'api',
    expectedApiReplicas: 3,
    expectedWorkerReplicas: 2,
  },
  compose: {
    apiReplicas: 3,
    workerReplicas: 2,
    imageBuildStrategy: 'if-missing',
    reuseRunningTopology: false,
    frontDoorMode: 'gateway',
    gatewayPort: undefined,
    apiDirectPort: undefined,
    postgresPort: undefined,
    redisPort: undefined,
    minioPort: undefined,
    minioConsolePort: undefined,
    metricsEnabled: true,
    filesBackend: 's3',
  },
  artifacts: {
    saveArtifactsOnSuccess: false,
    metricsScrapeEnabled: true,
    keepTopologyOnFailure: false,
    summaryOutputPath: undefined,
  },
};

describe('startFullComposeStressTarget', () => {
  it('renders the canonical topology files, launches compose, and returns resolved metadata', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const waitForComposeRpcGatewayReadiness = vi.fn(async () => {});
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      attestServicesUseImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      stopContainer: vi.fn(async () => {}),
      killContainer: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness,
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(runtime.buildServerImage).toHaveBeenCalledWith(
      'happier-stress-compose-server-repo-fingerprint-current-fingerprint',
      expect.objectContaining({
        labels: expect.objectContaining({
          'happier.stress.owner': 'stress-harness',
          'happier.stress.image-fingerprint': expect.any(String),
          'happier.stress.repo-root': expect.any(String),
        }),
      }),
    );
    expect(runtime.buildServerImage.mock.invocationCallOrder[0]).toBeLessThan(runtime.up.mock.invocationCallOrder[0]);
    expect(runtime.up).toHaveBeenCalledWith({ apiReplicas: 3, workerReplicas: 2 });
    expect(runtime.attestServicesUseImage).toHaveBeenCalledWith({
      services: ['api', 'worker'],
      imageName: 'happier-stress-compose-server-repo-fingerprint-current-fingerprint',
      expectedLabels: {
        'happier.stress.owner': 'stress-harness',
        'happier.stress.repo-root': 'repo-fingerprint',
        'happier.stress.image-fingerprint': 'current-fingerprint',
      },
    });
    expect(waitForComposeRpcGatewayReadiness).toHaveBeenCalledWith({
      attempts: 1,
      baseUrl: 'http://127.0.0.1:43080',
    });
    expect(result.mode).toBe('full-compose');
    expect(result.baseUrl).toBe('http://127.0.0.1:43080');
    expect(result.topology.composeProjectName).toContain('happier-stress-');
    expect(result.topology.resolvedApiReplicas).toBe(3);
    expect(result.topology.resolvedWorkerReplicas).toBe(2);
    expect(result.testRuntime?.peerMediation.allowedPorts).toEqual([3000]);
    expect(result.testRuntime?.peerMediation.routeGrantSigning.keyId).toBe('stress-route-grant');
    expect(result.testRuntime?.peerMediation.routeGrantSigning.privateKeySeedBase64Url).toEqual(
      expect.any(String),
    );
    expect(result.testRuntime?.peerMediation.routeGrantSigning.publicKeyBase64Url).toEqual(
      expect.any(String),
    );
    expect(Object.keys(result)).not.toContain('testRuntime');
    expect(JSON.stringify(result)).not.toContain(
      result.testRuntime?.peerMediation.routeGrantSigning.privateKeySeedBase64Url
        ?? 'missing-relay-key',
    );

    const composePath = join(testDir, 'topology', 'docker-compose.yml');
    const nginxPath = join(testDir, 'topology', 'nginx.conf');
    const generatedEnvPath = join(testDir, 'topology', 'env.generated.json');
    const generatedDockerfilePath = join(testDir, 'topology', 'Dockerfile.server-stress.generated');

    const composeYaml = readFileSync(composePath, 'utf8');
    expect(composeYaml).toContain('gateway:');
    expect(composeYaml).toContain('HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1"');
    expect(composeYaml).toContain(
      `HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: ${
        result.testRuntime?.peerMediation.routeGrantSigning.privateKeySeedBase64Url
      }`,
    );
    expect(readFileSync(generatedEnvPath, 'utf8')).not.toContain(
      result.testRuntime?.peerMediation.routeGrantSigning.privateKeySeedBase64Url ?? 'missing-relay-key',
    );
    expect(readFileSync(nginxPath, 'utf8')).toContain('location /v1/updates');
    const generatedDockerfile = readFileSync(generatedDockerfilePath, 'utf8');
    expect(generatedDockerfile).toContain('COPY package.json yarn.lock ./');
    expect(generatedDockerfile).toContain(
      'RUN mkdir -p apps/cli apps/server apps/ui packages/agents packages/cli-common packages/plugin-sdk packages/plugins/review-coderabbit packages/plugins/review-deepsec packages/protocol packages/release-runtime scripts/pipeline/expo scripts/workspaces',
    );
    expect(generatedDockerfile).toContain(
      'delete packageJson.dependencies?.[\'@happier-dev/cli\']',
    );
    expect(generatedDockerfile).toContain('COPY apps/server/package.json apps/server/');
    expect(generatedDockerfile).toContain('COPY apps/cli/package.json apps/cli/');
    expect(generatedDockerfile).toContain('COPY apps/ui/package.json apps/ui/');
    expect(generatedDockerfile).toContain(
      'COPY apps/stack/scripts/utils ./apps/stack/scripts/utils',
    );
    expect(generatedDockerfile).toContain(
      'COPY .github/feature-policy ./.github/feature-policy',
    );
    expect(generatedDockerfile).toContain('COPY packages/plugin-sdk/package.json packages/plugin-sdk/');
    expect(generatedDockerfile).toContain(
      'COPY packages/plugins/review-coderabbit/package.json packages/plugins/review-coderabbit/',
    );
    expect(generatedDockerfile).toContain(
      'COPY packages/plugins/review-deepsec/package.json packages/plugins/review-deepsec/',
    );
    expect(generatedDockerfile).toContain('COPY packages/protocol/package.json packages/protocol/');
    expect(generatedDockerfile).toContain('COPY scripts/workspaces ./scripts/workspaces');
    expect(generatedDockerfile).toContain('COPY apps/server ./apps/server');
    expect(generatedDockerfile).toContain('COPY packages/agents ./packages/agents');
    expect(generatedDockerfile).toContain('COPY packages/plugin-sdk ./packages/plugin-sdk');
    expect(generatedDockerfile).toContain(
      'COPY packages/plugins/review-coderabbit ./packages/plugins/review-coderabbit',
    );
    expect(generatedDockerfile).toContain(
      'COPY packages/plugins/review-deepsec ./packages/plugins/review-deepsec',
    );
    expect(generatedDockerfile).toContain('resolveWorkspaceDependencyBuildOrder');
    expect(generatedDockerfile).not.toContain('ensureWorkspacePackagesBuiltForComponent');
    expect(generatedDockerfile).not.toContain(
      'RUN yarn workspace @happier-dev/server build:shared',
    );
    expect(generatedDockerfile).not.toContain('postinstall:real');
    expect(generatedDockerfile).not.toContain('COPY . .');
    expect(generatedDockerfile).not.toContain('RUN yarn workspace @happier-dev/server build:runtime');
    expect(generatedDockerfile).not.toContain(
      'RUN yarn workspace @happier-dev/server postinstall:real',
    );
    expect(generatedDockerfile).toContain(
      'RUN yarn workspace @happier-dev/server generate:providers',
    );
    expect(generatedDockerfile).toContain(
      'ENV HAPPIER_INSTALL_SCOPE=server,protocol,agents,cli-common,release-runtime',
    );
    expect(generatedDockerfile).toContain('CMD ["/bin/sh", "/repo/apps/server/scripts/run-server.sh"]');
    expect(JSON.parse(readFileSync(generatedEnvPath, 'utf8'))).toMatchObject({
      publicBaseUrl: 'http://127.0.0.1:43080',
      composeProjectName: result.topology.composeProjectName,
      image: {
        name: 'happier-stress-compose-server-repo-fingerprint-current-fingerprint',
        freshnessFingerprint: expect.any(String),
      },
    });

    await result.collectDiagnostics();
    expect(runtime.logs).toHaveBeenCalledTimes(1);
    expect(typeof result.preserveForInspection).toBe('function');

    await result.restartService?.('api');
    expect(runtime.restart).toHaveBeenCalledWith('api');
    expect(waitForComposeRpcGatewayReadiness).toHaveBeenCalledTimes(2);

    expect(await result.admin?.listServiceContainers('api')).toEqual([]);
    const stickyConfigPath = await result.admin?.writeGatewayConfig(
      'sticky.good.nginx.conf',
      'server { listen 8080; }\n',
    );
    expect(stickyConfigPath).toContain('sticky.good.nginx.conf');
    await result.admin?.activateGatewayConfig(stickyConfigPath ?? '');
    expect(runtime.restart).toHaveBeenCalledWith('gateway');

    await result.stop();
    expect(runtime.down).toHaveBeenCalledTimes(1);
  });

  it('can expose a direct api front door for comparison runs when the topology uses a single api replica', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-direct-'));
    const directConfig: StressConfig = {
      ...config,
      orchestration: {
        ...config.orchestration,
        expectedApiReplicas: 1,
      },
      compose: {
        ...config.compose,
        apiReplicas: 1,
        frontDoorMode: 'api-direct',
      },
    };
    const waitForComposeRpcGatewayReadiness = vi.fn(async () => {});
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      stopContainer: vi.fn(async () => {}),
      killContainer: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config: directConfig,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(43081)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness,
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'api-direct', 'worker', 'gateway'],
          resolvedApiReplicas: 1,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            apiDirect: 43081,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(result.baseUrl).toBe('http://127.0.0.1:43081');
    expect(result.topology.baseUrl).toBe('http://127.0.0.1:43081');
    expect(result.topology.ports.apiDirect).toBe(43081);
    expect(waitForComposeRpcGatewayReadiness).toHaveBeenCalledWith({
      attempts: 1,
      baseUrl: 'http://127.0.0.1:43081',
    });
    expect(JSON.parse(readFileSync(join(testDir, 'topology', 'env.generated.json'), 'utf8'))).toMatchObject({
      publicBaseUrl: 'http://127.0.0.1:43081',
      compose: {
        frontDoorMode: 'api-direct',
      },
      ports: {
        gateway: 43080,
        apiDirect: 43081,
      },
    });
    expect(readFileSync(join(testDir, 'topology', 'docker-compose.yml'), 'utf8')).toContain('api-direct:');
  });

  it('rejects multi-replica api-direct runs because the direct front door publishes only one api container', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-direct-invalid-'));

    await expect(
      startFullComposeStressTarget(
        {
          config: {
            ...config,
            compose: {
              ...config.compose,
              apiReplicas: 4,
              frontDoorMode: 'api-direct',
            },
          },
          testDir,
        },
        {
          repoRootDir: () => '/repo/root',
          createRepoRootFingerprint: () => 'repo-fingerprint',
          computeComposeServerImageFingerprint: () => 'current-fingerprint',
          randomSecret: () => 'secret-token',
          pickAvailablePort: vi.fn(),
          createComposeRuntime: vi.fn(),
          waitForComposeTopology: vi.fn(),
          waitForComposeRpcGatewayReadiness: vi.fn(),
          inspectComposeTopology: vi.fn(),
        } as never,
      ),
    ).rejects.toThrow(/api-direct.*apiReplicas=1/i);
  });

  it('exposes replica metadata and service/container control hooks for failure-mode scenarios', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      stopContainer: vi.fn(async () => {}),
      killContainer: vi.fn(async () => {}),
      startContainer: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => ([
        {
          Name: '/happier-stress-run-api-1',
          Config: { Labels: { 'com.docker.compose.service': 'api' } },
          State: { Status: 'running', Health: { Status: 'healthy' } },
          NetworkSettings: {
            Networks: {
              happier: { IPAddress: '10.10.0.11' },
            },
          },
        },
        {
          Name: '/happier-stress-run-api-2',
          Config: { Labels: { 'com.docker.compose.service': 'api' } },
          State: { Status: 'running', Health: { Status: 'healthy' } },
          NetworkSettings: {
            Networks: {
              happier: { IPAddress: '10.10.0.12' },
            },
          },
        },
      ])),
      serviceContainerIds: vi.fn(async () => ['container-1', 'container-2']),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    await expect(result.admin?.listServiceContainers('api')).resolves.toEqual([
      {
        id: 'container-1',
        name: 'happier-stress-run-api-1',
        service: 'api',
        state: 'running',
        health: 'healthy',
        ipv4Addresses: ['10.10.0.11'],
      },
      {
        id: 'container-2',
        name: 'happier-stress-run-api-2',
        service: 'api',
        state: 'running',
        health: 'healthy',
        ipv4Addresses: ['10.10.0.12'],
      },
    ]);

    await result.admin?.stopService('worker');
    await result.admin?.startService('worker');
    await result.admin?.stopContainer('container-1');
    await result.admin?.killContainer('container-2');
    await result.admin?.startContainer?.('container-2');
    await result.admin?.execInService('redis', ['redis-cli', 'ping']);

    expect(runtime.stop).toHaveBeenCalledWith('worker');
    expect(runtime.start).toHaveBeenCalledWith('worker');
    expect(runtime.stopContainer).toHaveBeenCalledWith('container-1');
    expect(runtime.killContainer).toHaveBeenCalledWith('container-2');
    expect(runtime.startContainer).toHaveBeenCalledWith('container-2');
    expect(runtime.execCapture).toHaveBeenCalledWith('redis', ['redis-cli', 'ping']);
  });

  it('preserves the compose topology on stop after failure preservation is requested', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    result.preserveForInspection();
    await result.stop();

    expect(runtime.down).not.toHaveBeenCalled();
  });

  it('reuses the existing canonical image when the build strategy is if-missing and the image already exists', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => true),
      inspectImage: vi.fn(async () => ({
        labels: {
          'happier.stress.owner': 'stress-harness',
          'happier.stress.image-fingerprint': 'current-fingerprint',
          'happier.stress.repo-root': 'repo-fingerprint',
        },
      })),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(runtime.imageExists).toHaveBeenCalledWith(
      'happier-stress-compose-server-repo-fingerprint-current-fingerprint',
    );
    expect(runtime.inspectImage).toHaveBeenCalledWith(
      'happier-stress-compose-server-repo-fingerprint-current-fingerprint',
    );
    expect(runtime.buildServerImage).not.toHaveBeenCalled();
    expect(runtime.up).toHaveBeenCalledTimes(1);
  });

  it('derives distinct compose project names for different run directories that share the same leaf name', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-project-'));
    const firstTestDir = join(baseDir, 'run-a', 'compose-topology');
    const secondTestDir = join(baseDir, 'run-b', 'compose-topology');

    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const deps = {
      repoRootDir: () => '/repo/root',
      createRepoRootFingerprint: () => 'repo-fingerprint',
      computeComposeServerImageFingerprint: () => 'current-fingerprint',
      randomSecret: () => 'secret-token',
      pickAvailablePort: vi
        .fn()
        .mockResolvedValueOnce(43080)
        .mockResolvedValueOnce(45432)
        .mockResolvedValueOnce(46379)
        .mockResolvedValueOnce(49000)
        .mockResolvedValueOnce(49001)
        .mockResolvedValueOnce(43081)
        .mockResolvedValueOnce(45433)
        .mockResolvedValueOnce(46380)
        .mockResolvedValueOnce(49002)
        .mockResolvedValueOnce(49003),
      createComposeRuntime: vi.fn(() => runtime),
      waitForComposeTopology: vi.fn(async () => {}),
      waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
      inspectComposeTopology: vi.fn(async () => ({
        services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
        resolvedApiReplicas: 3,
        resolvedWorkerReplicas: 2,
        ports: {
          gateway: 43080,
          postgres: 45432,
          redis: 46379,
          minio: 49000,
          minioConsole: 49001,
        },
      })),
    };

    const first = await startFullComposeStressTarget(
      {
        config,
        testDir: firstTestDir,
      },
      deps,
    );

    const second = await startFullComposeStressTarget(
      {
        config,
        testDir: secondTestDir,
      },
      deps,
    );

    expect(first.topology.composeProjectName).not.toBe(second.topology.composeProjectName);
  });

  it('cleans up previous task-owned compose projects before launching a fresh topology', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi
        .fn()
        .mockResolvedValueOnce(['happier-stress-old-a', 'happier-stress-old-b'])
        .mockResolvedValueOnce([]),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(runtime.removeProjectResources).toHaveBeenCalledTimes(3);
    expect(runtime.removeProjectResources).toHaveBeenNthCalledWith(1, result.topology.composeProjectName);
    expect(runtime.removeProjectResources).toHaveBeenNthCalledWith(2, 'happier-stress-old-a');
    expect(runtime.removeProjectResources).toHaveBeenNthCalledWith(3, 'happier-stress-old-b');
    expect(runtime.removeProjectResources.mock.invocationCallOrder[2]).toBeLessThan(runtime.up.mock.invocationCallOrder[0]);
  });

  it('cleans the current project leftovers but does not delete other active stress topologies', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi
        .fn()
        .mockResolvedValueOnce(['happier-stress-old-running', 'happier-stress-old-stopped'])
        .mockResolvedValueOnce([]),
      projectHasRunningContainers: vi
        .fn()
        .mockImplementation(async (projectName: string) => projectName === 'happier-stress-old-running'),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(runtime.removeProjectResources).toHaveBeenCalledWith(result.topology.composeProjectName);
    expect(runtime.removeProjectResources).toHaveBeenCalledWith('happier-stress-old-stopped');
    expect(runtime.removeProjectResources).not.toHaveBeenCalledWith('happier-stress-old-running');
  });

  it('rebuilds the canonical image when an existing image is stale for the current freshness fingerprint', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => true),
      inspectImage: vi
        .fn()
        .mockResolvedValueOnce({
          labels: {
            'happier.stress.owner': 'stress-harness',
            'happier.stress.image-fingerprint': 'stale-fingerprint',
            'happier.stress.repo-root': 'repo-fingerprint',
          },
        })
        .mockResolvedValueOnce({
          labels: {
            'happier.stress.owner': 'stress-harness',
            'happier.stress.image-fingerprint': 'current-fingerprint',
            'happier.stress.repo-root': 'repo-fingerprint',
          },
        }),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(runtime.buildServerImage).toHaveBeenCalledTimes(1);
    expect(runtime.up).toHaveBeenCalledTimes(1);
    await result.stop();
  });

  it('reuses an existing canonical image when the image build strategy is never even if the repo fingerprint drifted', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => true),
      inspectImage: vi.fn(async () => ({
        createdAt: '2026-04-19T07:00:00.000Z',
        labels: {
          'happier.stress.owner': 'stress-harness',
          'happier.stress.repo-root': 'repo-fingerprint',
          'happier.stress.image-fingerprint': 'stale-fingerprint',
        },
      })),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      stopContainer: vi.fn(async () => {}),
      killContainer: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config: {
          ...config,
          compose: {
            ...config.compose,
            imageBuildStrategy: 'never',
          },
        },
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
          },
        })),
      },
    );

    expect(runtime.buildServerImage).not.toHaveBeenCalled();
    expect(runtime.up).toHaveBeenCalledTimes(1);
    await result.stop();
  });

  it('tears down a partially started topology when readiness fails', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    await expect(
      startFullComposeStressTarget(
        {
          config,
          testDir,
        },
        {
          repoRootDir: () => '/repo/root',
          createRepoRootFingerprint: () => 'repo-fingerprint',
          computeComposeServerImageFingerprint: () => 'current-fingerprint',
          randomSecret: () => 'secret-token',
          pickAvailablePort: vi
            .fn()
            .mockResolvedValueOnce(43080)
            .mockResolvedValueOnce(45432)
            .mockResolvedValueOnce(46379)
            .mockResolvedValueOnce(49000)
            .mockResolvedValueOnce(49001),
          createComposeRuntime: vi.fn(() => runtime),
          waitForComposeTopology: vi.fn(async () => {
            throw new Error('topology did not become ready');
          }),
          waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
          inspectComposeTopology: vi.fn(async () => ({
            services: [],
            resolvedApiReplicas: 0,
            resolvedWorkerReplicas: 0,
            ports: {},
          })),
        },
      ),
    ).rejects.toThrow('topology did not become ready');

    expect(runtime.down).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(testDir, 'topology', 'docker-compose.startup-failure.logs.txt'), 'utf8')).toContain('compose logs');
    expect(readFileSync(join(testDir, 'topology', 'docker-compose.startup-failure.ps.txt'), 'utf8')).toContain('ps output');
  });

  it('retries startup readiness once when flakeRetry is enabled and the first topology wait times out', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };
    const waitForComposeTopology = vi
      .fn<typeof import('../docker/waitForComposeTopology').waitForComposeTopology>()
      .mockRejectedValueOnce(new Error('Timed out waiting for full-compose stress topology at http://127.0.0.1:43080'))
      .mockResolvedValueOnce(undefined);

    const result = await startFullComposeStressTarget(
      {
        config: {
          ...config,
          flakeRetry: true,
        },
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology,
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(waitForComposeTopology).toHaveBeenCalledTimes(2);
    expect(runtime.up).toHaveBeenCalledTimes(2);
    expect(runtime.down).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(testDir, 'topology', 'docker-compose.startup-failure.logs.txt'), 'utf8')).toContain('compose logs');

    await result.stop();
    expect(runtime.down).toHaveBeenCalledTimes(2);
  });

  it('tears down the topology when image prebuild fails during startup', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {
        throw new Error('build server image failed');
      }),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    await expect(
      startFullComposeStressTarget(
        {
          config,
          testDir,
        },
        {
          repoRootDir: () => '/repo/root',
          createRepoRootFingerprint: () => 'repo-fingerprint',
          computeComposeServerImageFingerprint: () => 'current-fingerprint',
          randomSecret: () => 'secret-token',
          pickAvailablePort: vi
            .fn()
            .mockResolvedValueOnce(43080)
            .mockResolvedValueOnce(45432)
            .mockResolvedValueOnce(46379)
            .mockResolvedValueOnce(49000)
            .mockResolvedValueOnce(49001),
          createComposeRuntime: vi.fn(() => runtime),
          waitForComposeTopology: vi.fn(async () => {}),
          waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
          inspectComposeTopology: vi.fn(async () => ({
            services: [],
            resolvedApiReplicas: 0,
            resolvedWorkerReplicas: 0,
            ports: {},
          })),
        },
      ),
    ).rejects.toThrow('build server image failed');

    expect(runtime.down).toHaveBeenCalledTimes(1);
  });

  it('tears down the topology when docker compose up fails during startup', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {
        throw new Error('compose up failed');
      }),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    await expect(
      startFullComposeStressTarget(
        {
          config,
          testDir,
        },
        {
          repoRootDir: () => '/repo/root',
          createRepoRootFingerprint: () => 'repo-fingerprint',
          computeComposeServerImageFingerprint: () => 'current-fingerprint',
          randomSecret: () => 'secret-token',
          pickAvailablePort: vi
            .fn()
            .mockResolvedValueOnce(43080)
            .mockResolvedValueOnce(45432)
            .mockResolvedValueOnce(46379)
            .mockResolvedValueOnce(49000)
            .mockResolvedValueOnce(49001),
          createComposeRuntime: vi.fn(() => runtime),
          waitForComposeTopology: vi.fn(async () => {}),
          waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
          inspectComposeTopology: vi.fn(async () => ({
            services: [],
            resolvedApiReplicas: 0,
            resolvedWorkerReplicas: 0,
            ports: {},
          })),
        },
      ),
    ).rejects.toThrow('compose up failed');

    expect(runtime.down).toHaveBeenCalledTimes(1);
  });
});

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

import { repoRootDir } from '../../paths';
import { computeComposeServerImageFingerprint } from '../docker/computeComposeServerImageFingerprint';
import {
  createRepoRootFingerprint,
  stressComposeImageFingerprintLabelKey,
  stressComposeOwnerLabelKey,
  stressComposeOwnerLabelValue,
  stressComposeRepoRootLabelKey,
} from '../docker/composeOwnership';
import { createComposeRuntime, type ComposeRuntime } from '../docker/composeRuntime';
import { inspectComposeTopology, type ComposeTopologySnapshot } from '../docker/inspectComposeTopology';
import { renderStressComposeYaml } from '../docker/renderStressComposeYaml';
import { renderStressGatewayNginxConf } from '../docker/renderStressGatewayNginxConf';
import { waitForComposeTopology } from '../docker/waitForComposeTopology';
import { waitForComposeRpcGatewayReadiness } from '../docker/waitForComposeRpcGatewayReadiness';
import type {
  StartedStressTarget,
  StartStressTargetParams,
  StressTargetServiceContainer,
} from './stressTargetTypes';

const canonicalStressServerImageName = 'happier-stress-compose-topology-canonical-server';

function randomSecret(): string {
  return randomBytes(18).toString('hex');
}

async function pickAvailablePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to resolve an ephemeral port'));
          return;
        }
        resolvePromise(address.port);
      });
    });
    server.once('error', reject);
  });
}

function createComposeProjectName(testDir: string): string {
  const leaf = basename(testDir).replace(/[^a-zA-Z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const suffix = createHash('sha1')
    .update(resolve(testDir))
    .digest('hex')
    .slice(0, 8);
  return `happier-stress-${leaf || 'run'}-${suffix}`;
}

type StartFullComposeDeps = Readonly<{
  repoRootDir: typeof repoRootDir;
  createRepoRootFingerprint: typeof createRepoRootFingerprint;
  computeComposeServerImageFingerprint: typeof computeComposeServerImageFingerprint;
  randomSecret: () => string;
  pickAvailablePort: () => Promise<number>;
  createComposeRuntime: (params: { composeFilePath: string; composeProjectName: string; cwd: string }) => ComposeRuntime;
  waitForComposeTopology: typeof waitForComposeTopology;
  waitForComposeRpcGatewayReadiness: typeof waitForComposeRpcGatewayReadiness;
  inspectComposeTopology: typeof inspectComposeTopology;
}>;

const defaultDeps: StartFullComposeDeps = {
  repoRootDir,
  createRepoRootFingerprint,
  computeComposeServerImageFingerprint,
  randomSecret,
  pickAvailablePort,
  createComposeRuntime,
  waitForComposeTopology,
  waitForComposeRpcGatewayReadiness,
  inspectComposeTopology,
};

async function resolvePort(value: number | undefined, picker: () => Promise<number>): Promise<number> {
  return value ?? await picker();
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function renderGeneratedStressServerDockerfile(): string {
    return `FROM node:22 AS server-stress
RUN apt-get update && apt-get install -y python3 ffmpeg make g++ build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
RUN corepack enable && corepack prepare yarn@1.22.22 --activate
ENV HAPPIER_INSTALL_SCOPE=server,protocol,agents,cli-common,release-runtime
COPY package.json yarn.lock ./
RUN mkdir -p apps/server packages/agents packages/cli-common packages/protocol packages/release-runtime scripts/pipeline/expo scripts/workspaces
COPY apps/server/package.json apps/server/
COPY packages/agents/package.json packages/agents/
COPY packages/cli-common/package.json packages/cli-common/
COPY packages/protocol/package.json packages/protocol/
COPY packages/release-runtime/package.json packages/release-runtime/
COPY scripts/pipeline/expo/eas-postinstall.mjs scripts/pipeline/expo/
COPY scripts/workspaces ./scripts/workspaces
RUN yarn install --frozen-lockfile --ignore-engines --network-timeout 600000 --prefer-offline --non-interactive
COPY apps/server ./apps/server
COPY packages/agents ./packages/agents
COPY packages/cli-common ./packages/cli-common
COPY packages/protocol ./packages/protocol
COPY packages/release-runtime ./packages/release-runtime
RUN yarn workspace @happier-dev/protocol postinstall:real && yarn workspace @happier-dev/agents postinstall:real
RUN yarn workspace @happier-dev/release-runtime postinstall:real
RUN yarn workspace @happier-dev/server postinstall:real
ENV NODE_ENV=production
ENV PORT=3005
ENV RUN_MIGRATIONS=1
CMD ["/bin/sh", "/repo/apps/server/scripts/run-server.sh"]
`;
}

function parseServiceContainers(params: {
  containerIds: readonly string[];
  inspectEntries: readonly unknown[];
}): StressTargetServiceContainer[] {
  return params.containerIds.flatMap((containerId, index) => {
    const inspectEntry = params.inspectEntries[index];
    if (!inspectEntry || typeof inspectEntry !== 'object') {
      return [];
    }

    const raw = inspectEntry as {
      Name?: string;
      Config?: { Labels?: Record<string, string> };
      State?: { Status?: string; Health?: { Status?: string } };
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
    };

    const ipv4Addresses = Object.values(raw.NetworkSettings?.Networks ?? {})
      .map((network) => network?.IPAddress?.trim())
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    return [{
      id: containerId,
      name: raw.Name?.replace(/^\//u, '') ?? containerId,
      service: raw.Config?.Labels?.['com.docker.compose.service'] ?? 'unknown',
      state: raw.State?.Status ?? 'unknown',
      health: raw.State?.Health?.Status,
      ipv4Addresses,
    }];
  });
}

async function writeStartupFailureDiagnostics(params: {
  runtime: ComposeRuntime;
  logsPath: string;
  psPath: string;
}): Promise<void> {
  await Promise.all([
    params.runtime.logs()
      .then((value) => writeFileSync(params.logsPath, `${value}\n`, 'utf8'))
      .catch(() => undefined),
    params.runtime.ps()
      .then((value) => writeFileSync(params.psPath, `${value}\n`, 'utf8'))
      .catch(() => undefined),
  ]);
}

async function cleanupOwnedStressComposeProjects(runtime: ComposeRuntime, currentProjectName: string): Promise<void> {
  await runtime.removeProjectResources(currentProjectName);

  const staleProjectNames = (await runtime.listOwnedProjects()).filter((projectName) => projectName !== currentProjectName);
  for (const projectName of staleProjectNames) {
    if (await runtime.projectHasRunningContainers(projectName)) {
      continue;
    }
    await runtime.removeProjectResources(projectName);
  }

  const blockingProjectNames: string[] = [];
  for (const projectName of await runtime.listOwnedProjects()) {
    if (projectName === currentProjectName) {
      blockingProjectNames.push(projectName);
      continue;
    }
    if (!(await runtime.projectHasRunningContainers(projectName))) {
      blockingProjectNames.push(projectName);
    }
  }

  if (blockingProjectNames.length > 0) {
    throw new Error(
      `Failed to clean up previous task-owned stress compose projects before launch: ${blockingProjectNames.join(', ')}`,
    );
  }
}

function assertFreshReusableImage(params: {
  serverImageName: string;
  imageMetadata: Awaited<ReturnType<ComposeRuntime['inspectImage']>>;
  expectedImageFingerprint: string;
  expectedRepoRootFingerprint: string;
}): void {
  const { serverImageName, imageMetadata, expectedImageFingerprint, expectedRepoRootFingerprint } = params;
  const actualLabels = imageMetadata?.labels ?? {};

  if (
    actualLabels[stressComposeOwnerLabelKey] === stressComposeOwnerLabelValue
    && actualLabels[stressComposeImageFingerprintLabelKey] === expectedImageFingerprint
    && actualLabels[stressComposeRepoRootLabelKey] === expectedRepoRootFingerprint
  ) {
    return;
  }

  const createdAtSuffix = imageMetadata?.createdAt ? ` (created ${imageMetadata.createdAt})` : '';
  throw new Error(
    `Canonical stress compose image ${serverImageName} is stale for the current repo snapshot${createdAtSuffix}. `
    + `Expected ${stressComposeImageFingerprintLabelKey}=${expectedImageFingerprint} and `
    + `${stressComposeRepoRootLabelKey}=${expectedRepoRootFingerprint}. `
    + `Rebuild with HAPPIER_STRESS_COMPOSE_IMAGE_BUILD_STRATEGY=always or remove the stale image before rerunning.`,
  );
}

function imageMatchesFreshness(params: {
  imageMetadata: Awaited<ReturnType<ComposeRuntime['inspectImage']>>;
  expectedImageFingerprint: string;
  expectedRepoRootFingerprint: string;
}): boolean {
  const { imageMetadata, expectedImageFingerprint, expectedRepoRootFingerprint } = params;
  const actualLabels = imageMetadata?.labels ?? {};

  return (
    actualLabels[stressComposeOwnerLabelKey] === stressComposeOwnerLabelValue
    && actualLabels[stressComposeImageFingerprintLabelKey] === expectedImageFingerprint
    && actualLabels[stressComposeRepoRootLabelKey] === expectedRepoRootFingerprint
  );
}

export async function startFullComposeStressTarget(
  params: StartStressTargetParams,
  deps: StartFullComposeDeps = defaultDeps,
): Promise<StartedStressTarget> {
  const topologyDir = resolve(params.testDir, 'topology');
  mkdirSync(topologyDir, { recursive: true });
  const frontDoorMode = params.config.compose.frontDoorMode ?? 'gateway';
  if (frontDoorMode === 'api-direct' && params.config.compose.apiReplicas !== 1) {
    throw new Error(
      `Unsupported full-compose direct front door: api-direct currently requires apiReplicas=1, `
      + `received apiReplicas=${params.config.compose.apiReplicas}.`,
    );
  }
  const resolvedRepoRootDir = deps.repoRootDir();
  const repoRootFingerprint = deps.createRepoRootFingerprint(resolvedRepoRootDir);
  const imageFreshnessFingerprint = deps.computeComposeServerImageFingerprint(resolvedRepoRootDir);

  const gatewayPort = await resolvePort(params.config.compose.gatewayPort, deps.pickAvailablePort);
  const apiDirectPort = frontDoorMode === 'api-direct'
    ? await resolvePort(params.config.compose.apiDirectPort, deps.pickAvailablePort)
    : undefined;
  const postgresPort = await resolvePort(params.config.compose.postgresPort, deps.pickAvailablePort);
  const redisPort = await resolvePort(params.config.compose.redisPort, deps.pickAvailablePort);
  const minioPort = await resolvePort(params.config.compose.minioPort, deps.pickAvailablePort);
  const minioConsolePort = await resolvePort(params.config.compose.minioConsolePort, deps.pickAvailablePort);
  const frontDoorPort = frontDoorMode === 'api-direct'
    ? apiDirectPort
    : gatewayPort;
  const publicBaseUrl = `http://127.0.0.1:${frontDoorPort}`;
  const composeProjectName = createComposeProjectName(params.testDir);
  const serverImageName = canonicalStressServerImageName;

  const secrets = {
    postgresDb: 'stressdb',
    postgresUser: 'stress',
    postgresPassword: deps.randomSecret(),
    masterSecret: deps.randomSecret(),
    minioAccessKey: `minio-${deps.randomSecret().slice(0, 8)}`,
    minioSecretKey: deps.randomSecret(),
    s3Bucket: `stress-${deps.randomSecret().slice(0, 8)}`,
  };

  const composeFilePath = join(topologyDir, 'docker-compose.yml');
  const gatewayConfigPath = join(topologyDir, 'nginx.conf');
  const generatedEnvPath = join(topologyDir, 'env.generated.json');
  const generatedStressDockerfilePath = join(topologyDir, 'Dockerfile.server-stress.generated');
  const startupFailureLogsPath = join(topologyDir, 'docker-compose.startup-failure.logs.txt');
  const startupFailurePsPath = join(topologyDir, 'docker-compose.startup-failure.ps.txt');

  writeFileSync(
    gatewayConfigPath,
    renderStressGatewayNginxConf({
      workerConnections: params.config.compose.gatewayWorkerConnections,
      workerRlimitNoFile: params.config.compose.gatewayWorkerRlimitNoFile,
    }),
    'utf8',
  );
  writeFileSync(generatedStressDockerfilePath, renderGeneratedStressServerDockerfile(), 'utf8');
  writeFileSync(
    composeFilePath,
    renderStressComposeYaml({
      repoRootDir: resolvedRepoRootDir,
      repoRootFingerprint,
      composeDir: topologyDir,
      serverImageName,
      gatewayConfigPath,
      publicBaseUrl,
      config: {
        ...params.config.compose,
        gatewayPort,
        apiDirectPort,
        postgresPort,
        redisPort,
        minioPort,
        minioConsolePort,
      },
      secrets,
    }),
    'utf8',
  );

  writeJsonFile(generatedEnvPath, {
    composeProjectName,
    publicBaseUrl,
    compose: {
      apiReplicas: params.config.compose.apiReplicas,
      workerReplicas: params.config.compose.workerReplicas,
      frontDoorMode,
      dbConnectionLimit: params.config.compose.dbConnectionLimit,
      authLoginEligibilityAccountSnapshotCacheTtlMs:
        params.config.compose.authLoginEligibilityAccountSnapshotCacheTtlMs,
      gatewayWorkerConnections: params.config.compose.gatewayWorkerConnections,
      gatewayWorkerRlimitNoFile: params.config.compose.gatewayWorkerRlimitNoFile,
      metricsEnabled: params.config.compose.metricsEnabled,
      filesBackend: params.config.compose.filesBackend,
    },
    image: {
      name: serverImageName,
      freshnessFingerprint: imageFreshnessFingerprint,
      repoRootFingerprint,
    },
    ports: {
      gateway: gatewayPort,
      apiDirect: apiDirectPort,
      postgres: postgresPort,
      redis: redisPort,
      minio: minioPort,
      minioConsole: minioConsolePort,
    },
    secrets,
  });

  const runtime = deps.createComposeRuntime({
    composeFilePath,
    composeProjectName,
    cwd: resolvedRepoRootDir,
  });

  let topologyIsRunning = false;
  let startupAttemptActive = false;
  let startupFailureCleanedUp = false;

  try {
    await cleanupOwnedStressComposeProjects(runtime, composeProjectName);

    const imageExists = await runtime.imageExists(serverImageName);
    const existingImageMetadata = imageExists ? await runtime.inspectImage(serverImageName) : null;
    const existingImageIsFresh = imageMatchesFreshness({
      imageMetadata: existingImageMetadata,
      expectedImageFingerprint: imageFreshnessFingerprint,
      expectedRepoRootFingerprint: repoRootFingerprint,
    });
    if (params.config.compose.imageBuildStrategy === 'never') {
      if (!imageExists || !existingImageMetadata) {
        throw new Error(
          `Canonical stress compose image ${serverImageName} is missing. `
          + 'Build it first or switch HAPPIER_STRESS_COMPOSE_IMAGE_BUILD_STRATEGY away from never.',
        );
      }
    } else {
    const shouldBuildImage =
      params.config.compose.imageBuildStrategy === 'always'
      || !imageExists
      || !existingImageIsFresh;
      if (shouldBuildImage) {
        await runtime.buildServerImage(serverImageName, {
          labels: {
            [stressComposeOwnerLabelKey]: stressComposeOwnerLabelValue,
            [stressComposeRepoRootLabelKey]: repoRootFingerprint,
            [stressComposeImageFingerprintLabelKey]: imageFreshnessFingerprint,
          },
          dockerfilePath: generatedStressDockerfilePath,
          contextDir: resolvedRepoRootDir,
        });
        if (imageExists && !existingImageIsFresh) {
          assertFreshReusableImage({
            serverImageName,
            imageMetadata: await runtime.inspectImage(serverImageName),
            expectedImageFingerprint: imageFreshnessFingerprint,
            expectedRepoRootFingerprint: repoRootFingerprint,
          });
        }
      } else {
        assertFreshReusableImage({
          serverImageName,
          imageMetadata: existingImageMetadata,
          expectedImageFingerprint: imageFreshnessFingerprint,
          expectedRepoRootFingerprint: repoRootFingerprint,
        });
      }
    }
    const expectedPorts = {
      gateway: gatewayPort,
      apiDirect: apiDirectPort,
      postgres: postgresPort,
      redis: redisPort,
      minio: minioPort,
      minioConsole: minioConsolePort,
    };
    const startupAttempts = params.config.flakeRetry ? 2 : 1;

    for (let attempt = 1; attempt <= startupAttempts; attempt += 1) {
      try {
        startupAttemptActive = true;
        await runtime.up({
          apiReplicas: params.config.compose.apiReplicas,
          workerReplicas: params.config.compose.workerReplicas,
        });
        topologyIsRunning = true;

        await deps.waitForComposeTopology({
          runtime,
          baseUrl: publicBaseUrl,
          expectedApiReplicas: params.config.compose.apiReplicas,
          expectedWorkerReplicas: params.config.compose.workerReplicas,
          ports: expectedPorts,
          metricsEnabled: params.config.compose.metricsEnabled,
        });
        await deps.waitForComposeRpcGatewayReadiness({
          baseUrl: publicBaseUrl,
          attempts: params.config.flakeRetry ? 2 : 1,
        });
        startupAttemptActive = false;
        break;
      } catch (error) {
        await writeStartupFailureDiagnostics({
          runtime,
          logsPath: startupFailureLogsPath,
          psPath: startupFailurePsPath,
        });

        if (startupAttemptActive || topologyIsRunning) {
          await runtime.down().catch(() => undefined);
          startupFailureCleanedUp = true;
          topologyIsRunning = false;
          startupAttemptActive = false;
        }

        if (attempt === startupAttempts) {
          throw error;
        }
      }
    }

    const topology: ComposeTopologySnapshot = await deps.inspectComposeTopology({
      runtime,
      expectedPorts,
    });

    const logsPath = join(topologyDir, 'docker-compose.logs.txt');
    const psPath = join(topologyDir, 'docker-compose.ps.txt');
    let preserveTopologyOnStop = false;

    return {
      mode: 'full-compose',
      baseUrl: publicBaseUrl,
      topology: {
        kind: 'full-compose',
        composeProjectName,
        services: topology.services,
        expectedApiReplicas: params.config.orchestration.expectedApiReplicas,
        expectedWorkerReplicas: params.config.orchestration.expectedWorkerReplicas,
        resolvedApiReplicas: topology.resolvedApiReplicas,
        resolvedWorkerReplicas: topology.resolvedWorkerReplicas,
        baseUrl: publicBaseUrl,
        ports: topology.ports,
      },
      artifacts: {
        composeFile: composeFilePath,
        gatewayConfigFile: gatewayConfigPath,
        generatedEnvFile: generatedEnvPath,
        dockerLogsFile: logsPath,
        dockerPsFile: psPath,
      },
      restartService: async (service) => {
        await runtime.restart(service);
        await deps.waitForComposeTopology({
          runtime,
          baseUrl: publicBaseUrl,
          expectedApiReplicas: params.config.compose.apiReplicas,
          expectedWorkerReplicas: params.config.compose.workerReplicas,
          ports: expectedPorts,
          metricsEnabled: params.config.compose.metricsEnabled,
        });
        await deps.waitForComposeRpcGatewayReadiness({
          baseUrl: publicBaseUrl,
          attempts: params.config.flakeRetry ? 2 : 1,
        });
      },
      admin: {
        listServiceContainers: async (service) => {
          const containerIds = await runtime.serviceContainerIds(service);
          return parseServiceContainers({
            containerIds,
            inspectEntries: await runtime.inspectContainers(containerIds),
          });
        },
        writeGatewayConfig: async (fileName, contents) => {
          const outputPath = join(topologyDir, fileName);
          writeFileSync(outputPath, contents, 'utf8');
          return outputPath;
        },
        activateGatewayConfig: async (configPath) => {
          writeFileSync(gatewayConfigPath, readFileSync(configPath, 'utf8'), 'utf8');
          await runtime.restart('gateway');
          await deps.waitForComposeRpcGatewayReadiness({
            baseUrl: publicBaseUrl,
            attempts: params.config.flakeRetry ? 2 : 1,
          });
        },
        startService: async (service) => {
          if (!runtime.start) {
            throw new Error(`Compose runtime does not support start(${service})`);
          }
          await runtime.start(service);
        },
        stopService: async (service) => {
          if (!runtime.stop) {
            throw new Error(`Compose runtime does not support stop(${service})`);
          }
          await runtime.stop(service);
        },
        stopContainer: async (containerId) => {
          if (!runtime.stopContainer) {
            throw new Error(`Compose runtime does not support stopContainer(${containerId})`);
          }
          await runtime.stopContainer(containerId);
        },
        killContainer: async (containerId) => {
          if (!runtime.killContainer) {
            throw new Error(`Compose runtime does not support killContainer(${containerId})`);
          }
          await runtime.killContainer(containerId);
        },
        execInService: async (service, command) => {
          return await runtime.execCapture(service, command);
        },
      },
      preserveForInspection: () => {
        preserveTopologyOnStop = true;
      },
      stop: async () => {
        if (preserveTopologyOnStop) {
          return;
        }
        await runtime.down();
        topologyIsRunning = false;
      },
      collectDiagnostics: async () => {
        writeFileSync(logsPath, `${await runtime.logs()}\n`, 'utf8');
        writeFileSync(psPath, `${await runtime.ps()}\n`, 'utf8');
      },
    };
  } catch (error) {
    if (!startupFailureCleanedUp || startupAttemptActive || topologyIsRunning) {
      await runtime.down().catch(() => undefined);
    }
    throw error;
  }
}

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRootDir } from '../../paths';
import { latestComposeStatePath, readLatestComposeState } from '../cli/latestComposeState';
import { createComposeRuntime, type ComposeRuntime } from '../docker/composeRuntime';
import { inspectComposeTopology, type ComposeTopologySnapshot } from '../docker/inspectComposeTopology';
import { waitForComposeRpcGatewayReadiness } from '../docker/waitForComposeRpcGatewayReadiness';
import { waitForComposeTopology } from '../docker/waitForComposeTopology';
import type {
  StartedStressTarget,
  StartStressTargetParams,
  StressTargetServiceContainer,
} from './stressTargetTypes';

type AttachRunningFullComposeDeps = Readonly<{
  latestComposeStatePath: typeof latestComposeStatePath;
  readLatestComposeState: typeof readLatestComposeState;
  createComposeRuntime: (params: { composeFilePath: string; composeProjectName: string; cwd: string }) => ComposeRuntime;
  waitForComposeTopology: typeof waitForComposeTopology;
  waitForComposeRpcGatewayReadiness: typeof waitForComposeRpcGatewayReadiness;
  inspectComposeTopology: typeof inspectComposeTopology;
  repoRootDir: typeof repoRootDir;
}>;

const defaultDeps: AttachRunningFullComposeDeps = {
  latestComposeStatePath,
  readLatestComposeState,
  createComposeRuntime,
  waitForComposeTopology,
  waitForComposeRpcGatewayReadiness,
  inspectComposeTopology,
  repoRootDir,
};

type GeneratedEnvShape = Readonly<{
  compose?: Readonly<{
    apiReplicas?: number;
    workerReplicas?: number;
    frontDoorMode?: 'gateway' | 'api-direct';
    metricsEnabled?: boolean;
    filesBackend?: string;
  }>;
  ports?: Partial<Record<'gateway' | 'apiDirect' | 'postgres' | 'redis' | 'minio' | 'minioConsole', number>>;
}>;

function readGeneratedComposeMetadata(generatedEnvFile: string | undefined, fallbackGatewayPort: number): Readonly<{
  ports: Record<string, number | undefined>;
  compose?: GeneratedEnvShape['compose'];
}> {
  if (!generatedEnvFile || !existsSync(generatedEnvFile)) {
    return {
      ports: {
        gateway: fallbackGatewayPort,
      },
    };
  }

  const parsed = JSON.parse(readFileSync(generatedEnvFile, 'utf8')) as GeneratedEnvShape;
  return {
    compose: parsed.compose,
    ports: {
      gateway: parsed.ports?.gateway ?? fallbackGatewayPort,
      apiDirect: parsed.ports?.apiDirect,
      postgres: parsed.ports?.postgres,
      redis: parsed.ports?.redis,
      minio: parsed.ports?.minio,
      minioConsole: parsed.ports?.minioConsole,
    },
  };
}

function assertRequestedComposeShapeMatchesRunning(params: Readonly<{
  requested: StartStressTargetParams['config']['compose'];
  generated: GeneratedEnvShape['compose'] | undefined;
}>): void {
  const generated = params.generated;
  if (!generated) {
    return;
  }

  const mismatches: string[] = [];
  if (typeof generated.apiReplicas === 'number' && generated.apiReplicas !== params.requested.apiReplicas) {
    mismatches.push(`apiReplicas requested=${params.requested.apiReplicas} running=${generated.apiReplicas}`);
  }
  if (typeof generated.workerReplicas === 'number' && generated.workerReplicas !== params.requested.workerReplicas) {
    mismatches.push(`workerReplicas requested=${params.requested.workerReplicas} running=${generated.workerReplicas}`);
  }
  const requestedFrontDoorMode = params.requested.frontDoorMode ?? 'gateway';
  if (typeof generated.frontDoorMode === 'string' && generated.frontDoorMode !== requestedFrontDoorMode) {
    mismatches.push(`frontDoorMode requested=${requestedFrontDoorMode} running=${generated.frontDoorMode}`);
  }
  if (typeof generated.metricsEnabled === 'boolean' && generated.metricsEnabled !== params.requested.metricsEnabled) {
    mismatches.push(`metricsEnabled requested=${params.requested.metricsEnabled} running=${generated.metricsEnabled}`);
  }
  if (typeof generated.filesBackend === 'string' && generated.filesBackend !== params.requested.filesBackend) {
    mismatches.push(`filesBackend requested=${params.requested.filesBackend} running=${generated.filesBackend}`);
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Running full-compose topology shape does not match the requested config: ${mismatches.join(', ')}. `
      + 'Rebuild or relaunch the topology before attaching.',
    );
  }
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

export async function attachRunningFullComposeStressTarget(
  params: StartStressTargetParams,
  deps: AttachRunningFullComposeDeps = defaultDeps,
): Promise<StartedStressTarget> {
  const state = deps.readLatestComposeState(deps.latestComposeStatePath());
  if (state.status !== 'running') {
    throw new Error('Latest full-compose stress topology is not running');
  }

  const currentRepoRootDir = deps.repoRootDir();
  if (state.repoRootDir !== currentRepoRootDir) {
    throw new Error(`Latest full-compose stress topology belongs to a different repo root: ${state.repoRootDir}`);
  }

  const baseUrl = state.baseUrl;
  const gatewayPort = Number.parseInt(baseUrl.split(':').at(-1) ?? '0', 10);
  const generatedMetadata = readGeneratedComposeMetadata(state.generatedEnvFile, gatewayPort);
  assertRequestedComposeShapeMatchesRunning({
    requested: params.config.compose,
    generated: generatedMetadata.compose,
  });
  const expectedPorts = generatedMetadata.ports;

  const runtime = deps.createComposeRuntime({
    composeFilePath: state.composeFilePath,
    composeProjectName: state.composeProjectName,
    cwd: state.repoRootDir,
  });

  await deps.waitForComposeTopology({
    runtime,
    baseUrl,
    expectedApiReplicas: params.config.compose.apiReplicas,
    expectedWorkerReplicas: params.config.compose.workerReplicas,
    ports: expectedPorts,
    metricsEnabled: params.config.compose.metricsEnabled,
  });
  await deps.waitForComposeRpcGatewayReadiness({
    baseUrl,
    attempts: params.config.flakeRetry ? 2 : 1,
  });

  const topology: ComposeTopologySnapshot = await deps.inspectComposeTopology({
    runtime,
    expectedPorts,
  });

  const dockerPsFile = state.dockerPsFile ?? join(params.testDir, 'attached-compose.ps.txt');
  const dockerLogsFile = state.dockerLogsFile ?? join(params.testDir, 'attached-compose.logs.txt');
  let preserveTopologyOnStop = true;

  return {
    mode: 'full-compose',
    baseUrl,
    topology: {
      kind: 'full-compose',
      composeProjectName: state.composeProjectName,
      services: topology.services,
      expectedApiReplicas: params.config.orchestration.expectedApiReplicas,
      expectedWorkerReplicas: params.config.orchestration.expectedWorkerReplicas,
      resolvedApiReplicas: topology.resolvedApiReplicas,
      resolvedWorkerReplicas: topology.resolvedWorkerReplicas,
      baseUrl,
      ports: topology.ports,
    },
    artifacts: {
      composeFile: state.composeFilePath,
      gatewayConfigFile: state.gatewayConfigFile,
      generatedEnvFile: state.generatedEnvFile,
      dockerLogsFile,
      dockerPsFile,
    },
    restartService: async (service) => {
      await runtime.restart(service);
      await deps.waitForComposeTopology({
        runtime,
        baseUrl,
        expectedApiReplicas: params.config.compose.apiReplicas,
        expectedWorkerReplicas: params.config.compose.workerReplicas,
        ports: expectedPorts,
        metricsEnabled: params.config.compose.metricsEnabled,
      });
      await deps.waitForComposeRpcGatewayReadiness({
        baseUrl,
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
        const configPath = join(params.testDir, fileName);
        writeFileSync(configPath, contents, 'utf8');
        return configPath;
      },
      activateGatewayConfig: async (configPath) => {
        if (!state.gatewayConfigFile) {
          throw new Error('Running full-compose target does not expose a gateway config file');
        }
        writeFileSync(state.gatewayConfigFile, readFileSync(configPath, 'utf8'), 'utf8');
        await runtime.restart('gateway');
        await deps.waitForComposeRpcGatewayReadiness({
          baseUrl,
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
    },
    collectDiagnostics: async () => {
      writeFileSync(dockerLogsFile, `${await runtime.logs()}\n`, 'utf8');
      writeFileSync(dockerPsFile, `${await runtime.ps()}\n`, 'utf8');
    },
  };
}

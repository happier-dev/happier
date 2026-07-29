import type { StressConfig, StressTargetMode } from '../config/stressScenarioSchema';

export type StressTestPeerMediationTopology = Readonly<{
  allowedPorts: readonly number[];
  routeGrantSigning: Readonly<{
    keyId: string;
    privateKeySeedBase64Url: string;
    publicKeyBase64Url: string;
    expiresAt: string;
  }>;
}>;

export type StressTargetTopology = Readonly<{
  kind: StressTargetMode;
  composeProjectName?: string;
  services: string[];
  expectedApiReplicas: number;
  expectedWorkerReplicas: number;
  resolvedApiReplicas: number;
  resolvedWorkerReplicas: number;
  baseUrl: string;
  ports: Record<string, number | undefined>;
}>;

export type StressTargetServiceContainer = Readonly<{
  id: string;
  name: string;
  service: string;
  state: string;
  health?: string;
  ipv4Addresses: string[];
}>;

export type StartedStressTarget = Readonly<{
  mode: StressTargetMode;
  baseUrl: string;
  topology: StressTargetTopology;
  testRuntime?: Readonly<{
    peerMediation: StressTestPeerMediationTopology;
  }>;
  artifacts?: {
    composeFile?: string;
    gatewayConfigFile?: string;
    generatedEnvFile?: string;
    dockerLogsFile?: string;
    dockerPsFile?: string;
  };
  restartService?: (service: 'api' | 'worker') => Promise<void>;
  admin?: {
    listServiceContainers: (service: string) => Promise<readonly StressTargetServiceContainer[]>;
    writeGatewayConfig: (fileName: string, contents: string) => Promise<string>;
    activateGatewayConfig: (configPath: string) => Promise<void>;
    startService: (service: string) => Promise<void>;
    stopService: (service: string) => Promise<void>;
    stopContainer: (containerId: string) => Promise<void>;
    killContainer: (containerId: string) => Promise<void>;
    startContainer?: (containerId: string) => Promise<void>;
    execInService: (service: string, command: readonly string[]) => Promise<string>;
    execInContainer?: (containerId: string, command: readonly string[]) => Promise<string>;
  };
  preserveForInspection: () => void;
  stop: () => Promise<void>;
  collectDiagnostics: () => Promise<void>;
}>;

export type StartStressTargetParams = Readonly<{
  config: StressConfig;
  testDir: string;
}>;

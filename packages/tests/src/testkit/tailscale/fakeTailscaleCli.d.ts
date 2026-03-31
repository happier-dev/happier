export type FakeTailscaleLoginOutput = Readonly<{
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}>;

export type FakeTailscaleCliScenario = Readonly<{
  statusJsons?: readonly Record<string, unknown>[];
  loginOutputs?: readonly FakeTailscaleLoginOutput[];
  serveStatuses?: readonly string[];
  serveEnableOutputs?: readonly FakeTailscaleLoginOutput[];
}>;

export type FakeTailscaleCli = Readonly<{
  cliPath: string;
  cleanup: () => void;
  readInvocations: () => string[][];
}>;

export declare function createFakeTailscaleCli(scenario?: FakeTailscaleCliScenario): FakeTailscaleCli;

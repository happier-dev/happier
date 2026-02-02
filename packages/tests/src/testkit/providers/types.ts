export type ProviderId = 'opencode' | (string & {});

export type ProviderProtocol = 'acp' | 'codex' | 'claude';

export type ProviderUnderTest = {
  id: ProviderId;
  enableEnvVar: string;
  protocol: ProviderProtocol;
  traceProvider: string;
  requiresBinaries?: string[];
  // How to spawn the provider through the Happy CLI (workspace-local).
  cli: {
    // `happier dev <subcommand> ...`
    subcommand: string;
    extraArgs?: string[];
    // Most providers need a TTY for rich UI; our tests should be headless.
    env?: Record<string, string>;
  };
};

export type ProviderScenario = {
  id: string;
  title: string;
  // Prompt text that will be sent as a user message.
  prompt: (ctx: { workspaceDir: string }) => string;
  // Optional grouping for selective runs.
  tier?: 'smoke' | 'extended';
  // Optional override for whether the CLI should be started in YOLO mode for this scenario.
  // When undefined, falls back to `HAPPY_E2E_PROVIDER_YOLO_DEFAULT` (default: true).
  yolo?: boolean;
  // Optional per-scenario setup hook (create files, seed workspace, etc.).
  setup?: (ctx: { workspaceDir: string }) => Promise<void>;
  // Tool-trace fixture keys that must exist after running the scenario.
  requiredFixtureKeys: string[];
  // Optional alternative keys: if any of these are present, treat as satisfying that requirement bucket.
  // This allows a scenario to accept “edit OR write” style tool selection differences.
  requiredAnyFixtureKeys?: string[][];
  // Substrings that must appear somewhere in the raw trace payloads (quick smoke invariants).
  requiredTraceSubstrings?: string[];
  // Optional extra validations using the workspace + extracted fixtures.
  verify?: (ctx: {
    workspaceDir: string;
    fixtures: any;
    traceEvents: any[];
  }) => Promise<void>;
};

export type ProviderContractMatrixResult = {
  ok: true;
  skipped?: { reason: string };
} | {
  ok: false;
  error: string;
};

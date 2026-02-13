export type KnownProviderId = 'opencode' | 'codex' | 'claude' | 'kilo' | 'qwen' | 'kimi' | 'gemini' | 'auggie' | 'pi';
export type ProviderId = KnownProviderId | (string & { readonly __providerIdBrand?: unique symbol });

export type ProviderProtocol = 'acp' | 'codex' | 'claude';
export type AcpPermissionMode = 'default' | 'safe-yolo' | 'read-only' | 'yolo' | 'plan';

export type ProviderFixtureEvent = {
  payload?: unknown;
  [key: string]: unknown;
};

export type ProviderFixtureExamples = Record<string, ProviderFixtureEvent[]>;

export type ProviderFixtures = {
  examples?: ProviderFixtureExamples;
  [key: string]: unknown;
};

export type ProviderTraceEvent = {
  v: number;
  sessionId: string;
  protocol: string;
  provider?: string;
  kind: string;
  payload: unknown;
  ts?: number;
  direction?: string;
  localId?: string;
};

export type ProviderUnderTest = {
  id: ProviderId;
  enableEnvVar: string;
  protocol: ProviderProtocol;
  traceProvider: string;
  /**
   * Environment variables that must be present for this provider to run.
   *
   * These are evaluated by the harness after applying the provider's `cli.envFrom`
   * and `cli.env` to the spawned CLI environment.
   */
  requiredEnv?: string[];
  /**
   * Optional auth selection policy for the provider.
   *
   * This allows local runs to reuse user CLI auth state (host mode) while CI runs
   * remain hermetic via API keys (env mode).
   */
  auth?: {
    mode?: 'auto' | 'env' | 'host';
    env?: {
      requiredAll?: string[];
      requiredAnyOf?: string[][];
      env?: Record<string, string>;
      envUnset?: string[];
    };
    host?: {
      requiredAll?: string[];
      requiredAnyOf?: string[][];
      env?: Record<string, string>;
      envUnset?: string[];
    };
  };
  permissions?: {
    v: 1;
    acp?: {
      toolPermissionPromptsByMode?: Partial<Record<AcpPermissionMode, boolean>>;
      outsideWorkspaceWriteAllowedByMode?: Partial<Record<AcpPermissionMode, boolean>>;
      outsideWorkspaceWriteMustCompleteByMode?: Partial<Record<AcpPermissionMode, boolean>>;
      outsideWorkspaceRequireTaskCompleteByMode?: Partial<Record<AcpPermissionMode, boolean>>;
      expectToolPermissionPrompts?: boolean;
      permissionSurfaceOutsideWorkspaceYolo?: boolean;
    };
  };
  scenarioRegistry: {
    v: 1;
    tiers: {
      smoke: string[];
      extended: string[];
    };
  };
  requiresBinaries?: Array<
    | string
    | {
        bin: string;
        envOverride?: string;
        requireExists?: boolean;
      }
  >;
  // How to spawn the provider through the Happy CLI (workspace-local).
  cli: {
    // `happier dev <subcommand> ...`
    subcommand: string;
    extraArgs?: string[];
    // Most providers need a TTY for rich UI; our tests should be headless.
    env?: Record<string, string>;
    // Allow provider-specific mapping from test env vars to CLI env vars.
    // Key = CLI env var name; value = env var name to read from process.env in the test runner.
    envFrom?: Record<string, string>;
  };
};

export type ProviderScenario = {
  id: string;
  title: string;
  // Optional per-scenario max wait for trace satisfaction loop.
  // Falls back to global HAPPIER_E2E_PROVIDER_WAIT_MS when undefined.
  waitMs?: number;
  // Optional per-scenario inactivity timeout for provider activity polling.
  // Falls back to resolveProviderInactivityTimeoutMs defaults when undefined.
  inactivityTimeoutMs?: number;
  // Prompt text that will be sent as a user message (single-step scenarios).
  // For multi-step scenarios, use `steps` instead.
  prompt?: (ctx: { workspaceDir: string }) => string;
  // Optional provider-specific message meta to attach to every prompt for this scenario.
  // Useful for enabling experimental provider features (e.g. Claude Agent SDK).
  messageMeta?: Record<string, unknown> | ((ctx: { workspaceDir: string }) => Record<string, unknown>);
  // Optional multi-step prompt flow (sent within a single running CLI session).
  steps?: Array<{
    id: string;
    /**
     * When true, the harness is allowed to enqueue the *next* step while the current turn is still running.
     *
     * Default is false to avoid accidental "in-flight steer" routing in normal multi-step scenarios.
     */
    allowInFlightSteer?: boolean;
    prompt: (ctx: { workspaceDir: string }) => string;
    messageMeta?: Record<string, unknown> | ((ctx: { workspaceDir: string }) => Record<string, unknown>);
    satisfaction?: {
      requiredFixtureKeys?: string[];
      requiredAnyFixtureKeys?: string[][];
      requiredTraceSubstrings?: string[];
      /**
       * Substrings that must appear somewhere in the decrypted session messages (user/assistant payloads).
       *
       * This is intentionally separate from tool-trace matching: some scenarios (like ACP in-flight steer)
       * need to gate on assistant text chunks before any tool calls occur.
       */
      requiredMessageSubstrings?: string[];
    };
  }>;
  // Optional grouping for selective runs.
  tier?: 'smoke' | 'extended';
  // Optional override for whether the CLI should be started in YOLO mode for this scenario.
  // When undefined, falls back to `HAPPIER_E2E_PROVIDER_YOLO_DEFAULT` (default: true).
  yolo?: boolean;
  // Optional caps for the amount of provider activity allowed (helps catch accidental extra tool calls).
  // These are enforced on the raw trace events (not fixtures) because fixtures are capped per key.
  maxTraceEvents?: {
    toolCalls?: number;
    toolResults?: number;
    permissionRequests?: number;
  };
  // When YOLO is disabled, the harness will auto-respond to permission requests via `${sessionId}:permission`.
  // Defaults to `approved`.
  permissionAutoDecision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
  // Optional override for YOLO scenarios: when true, the harness will auto-respond to provider
  // permission requests even in YOLO mode. This is useful for providers that occasionally surface
  // external-directory prompts despite running with a permissive policy.
  allowPermissionAutoApproveInYolo?: boolean;
  // Optional per-scenario setup hook (create files, seed workspace, etc.).
  setup?: (ctx: { workspaceDir: string }) => Promise<void>;
  // Tool-trace fixture keys that must exist after running the scenario.
  requiredFixtureKeys?: string[];
  // Optional alternative keys: if any of these are present, treat as satisfying that requirement bucket.
  // This allows a scenario to accept “edit OR write” style tool selection differences.
  requiredAnyFixtureKeys?: string[][];
  // Substrings that must appear somewhere in the raw trace payloads (quick smoke invariants).
  requiredTraceSubstrings?: string[];
  /**
   * Substrings that must appear somewhere in the decrypted session messages (user/assistant payloads).
   *
   * This is used sparingly for scenarios where tool trace may be empty or delayed, but server messages
   * provide a reliable observable.
   */
  requiredMessageSubstrings?: string[];
  // Optional override for pending queue drain assertions.
  // Defaults to true (subject to global env flag), but scenarios can disable it
  // when the behavior under test intentionally leaves async side-effects pending.
  assertPendingDrain?: boolean;
  /**
   * Optional "keep the provider alive" post-satisfaction waiting logic.
   *
   * Some behaviors (like ACP sidechain replay imports) are triggered asynchronously after the
   * primary tool-result is emitted; if the harness terminates the provider immediately, those
   * side effects may never complete.
   */
  postSatisfy?: {
    /**
     * Optional hook that runs immediately after the scenario is satisfied, while the provider
     * process + daemon are still running.
     *
     * This is useful for validating machine-scoped capabilities (e.g. `capabilities.invoke`) that
     * depend on the daemon being connected.
     */
    run?: (ctx: {
      workspaceDir: string;
      baseUrl: string;
      token: string;
      sessionId: string;
      secret: Uint8Array;
      cliHome: string;
    }) => Promise<void>;
    /**
     * Optional ACP-only wait: after satisfaction, locate a tool-call id and wait for sidechain
     * replay/import messages to land before terminating the provider.
     */
    waitForAcpSidechainFromToolName?: string;
    timeoutMs: number;
  };
  // Optional extra validations using the workspace + extracted fixtures.
  // Optional second-phase run to validate ACP resume flows (attach to the same Happier session twice).
  // The harness will:
  //  - run the scenario once (phase 1)
  //  - read the resume id from decrypted session metadata (metadataKey)
  //  - run the provider again with `--resume <id>` and send `resume.prompt` (phase 2)
  //  - merge tool traces from both phases for fixture extraction + baseline drift checks
  resume?: {
    metadataKey: string;
    prompt: (ctx: { workspaceDir: string }) => string;
    requiredTraceSubstrings?: string[];
    /**
     * When true, the second phase will attach to a *new* Happier session id
     * (fresh session), while still resuming the same remote provider session id.
     *
     * This is the most realistic end-user resume flow (resume into a new session).
     */
    freshSession?: boolean;
  };
  verify?: (ctx: {
    workspaceDir: string;
    fixtures: ProviderFixtures;
    traceEvents: ProviderTraceEvent[];
    baseUrl: string;
    token: string;
    sessionId: string;
    resumeSessionId: string | null;
    secret: Uint8Array;
    resumeId: string | null;
  }) => Promise<void>;
};

export type ProviderContractMatrixResult = {
  ok: true;
  skipped?: { reason: string };
} | {
  ok: false;
  error: string;
};

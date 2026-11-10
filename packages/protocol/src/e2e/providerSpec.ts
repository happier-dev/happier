import { z } from '../zodRuntimePolicy.js';

export const E2eProviderProtocolSchema = z.enum(['acp', 'claude', 'codex']);

export const E2eRequiredBinarySchema = z.union([
  z.string(),
  z.object({
    bin: z.string().check(z.minLength(1)),
    envOverride: z.optional(z.string().check(z.minLength(1))),
    requireExists: z.optional(z.boolean()),
  }),
]);

export const E2eCliSpecSchema = z.object({
  subcommand: z.string().check(z.minLength(1)),
  extraArgs: z.optional(z.array(z.string())),
  env: z.optional(z.record(z.string(), z.string())),
  // Map CLI env var -> test-runner env var
  envFrom: z.optional(z.record(z.string(), z.string())),
});

export const E2eCliProviderAuthOverlaySchema = z.object({
  /**
   * Env vars that must exist to select this auth mode.
   *
   * When provided, every env var in the list must be present (non-empty).
   */
  requiredAll: z.optional(z.array(z.string().check(z.minLength(1)))),
  /**
   * Env vars that must exist to select this auth mode (any-of buckets).
   *
   * When provided, at least one bucket must match, and a bucket matches when
   * every env var in that bucket is present (non-empty).
   *
   * Example: [["OPENAI_API_KEY"], ["CODEX_API_KEY"]] means "OPENAI_API_KEY OR CODEX_API_KEY".
   */
  requiredAnyOf: z.optional(z.array(z.array(z.string().check(z.minLength(1))).check(z.minLength(1)))),
  /**
   * Additional env vars to apply for this auth mode.
   *
   * These are merged on top of the base CLI env computed by the E2E harness.
   */
  env: z.optional(z.record(z.string(), z.string())),
  /**
   * Env vars to remove for this auth mode.
   *
   * Useful for enabling interactive auth mechanisms in local runs (e.g. Codex ChatGPT auth)
   * while keeping CI hermetic via API keys.
   */
  envUnset: z.optional(z.array(z.string().check(z.minLength(1)))),
});

export const E2eCliProviderAuthSchema = z.object({
  /**
   * How the harness should select an auth mode.
   *
   * - "auto": choose "env" when its required env vars are present, else fall back to "host"
   * - "env": always use "env" (fail-fast if required env vars are missing)
   * - "host": always use "host" (may rely on user-local CLI auth state)
   */
  mode: z.optional(z.enum(['auto', 'env', 'host'])),
  env: z.optional(E2eCliProviderAuthOverlaySchema),
  host: z.optional(E2eCliProviderAuthOverlaySchema),
});

export const E2eCliProviderPermissionsV1Schema = z.object({
  v: z.literal(1),
  acp: z.optional(z
    .object({
      /**
       * Mode-aware expectation for ACP permission prompts.
       *
       * This enables provider contract tests to validate prompt surfacing per
       * selected permission mode, rather than a single provider-wide boolean.
       */
      toolPermissionPromptsByMode: z.optional(z
        .object({
          default: z.optional(z.boolean()),
          'safe-yolo': z.optional(z.boolean()),
          'read-only': z.optional(z.boolean()),
          yolo: z.optional(z.boolean()),
          plan: z.optional(z.boolean()),
        })),
      /**
       * Mode-aware expectation for outside-workspace writes used by ACP
       * permission contract scenarios.
       *
       * `true` means the scenario should auto-approve and assert the write
       * succeeds. `false` means the scenario should deny/assert no write.
       */
      outsideWorkspaceWriteAllowedByMode: z.optional(z
        .object({
          default: z.optional(z.boolean()),
          'safe-yolo': z.optional(z.boolean()),
          'read-only': z.optional(z.boolean()),
          yolo: z.optional(z.boolean()),
          plan: z.optional(z.boolean()),
        })),
      /**
       * Optional mode-aware requirement for outside-workspace write completion.
       *
       * When false, scenarios still validate prompt/tool-attempt behavior but do
       * not require the provider to emit a successful tool-result or write file
       * content (useful for providers with known completion stalls after prompt
       * handling).
       */
      outsideWorkspaceWriteMustCompleteByMode: z.optional(z
        .object({
          default: z.optional(z.boolean()),
          'safe-yolo': z.optional(z.boolean()),
          'read-only': z.optional(z.boolean()),
          yolo: z.optional(z.boolean()),
          plan: z.optional(z.boolean()),
        })),
      /**
       * Optional mode-aware toggle for whether restrictive scenarios must emit a
       * `task_complete` trace when no tool attempt is expected.
       */
      outsideWorkspaceRequireTaskCompleteByMode: z.optional(z
        .object({
          default: z.optional(z.boolean()),
          'safe-yolo': z.optional(z.boolean()),
          'read-only': z.optional(z.boolean()),
          yolo: z.optional(z.boolean()),
          plan: z.optional(z.boolean()),
        })),
      /**
       * When true, ACP providers are expected to emit `permission-request` trace
       * events for tool calls that require user approval.
       *
       * Some ACP providers may still honor sandbox policies internally while not
       * surfacing explicit permission prompts in the trace. This is retained as a
       * legacy fallback when `toolPermissionPromptsByMode` is not set.
       */
      expectToolPermissionPrompts: z.optional(z.boolean()),
      /**
       * Some providers require YOLO mode for deterministic E2E runs when they do not
       * emit ACP permission prompts (the host would otherwise block the tool call).
       *
       * This is currently only used by the shared permission_surface_outside_workspace
       * scenario.
       */
      permissionSurfaceOutsideWorkspaceYolo: z.optional(z.boolean()),
    })),
});

export const E2eCliProviderSpecV1Schema = z.object({
  v: z.literal(1),
  id: z.string().check(z.minLength(1)),
  enableEnvVar: z.string().check(z.minLength(1)),
  protocol: E2eProviderProtocolSchema,
  traceProvider: z.string().check(z.minLength(1)),
  /**
   * Environment variables that must be present for this provider to run.
   *
   * These are evaluated by the E2E harness after applying `cli.envFrom` and `cli.env`.
   * When missing, the harness should fail fast with a clear error rather than hanging.
   */
  requiredEnv: z.optional(z.array(z.string().check(z.minLength(1)))),
  /**
   * Optional auth selection policy for the provider.
   *
   * This is useful when:
   * - local runs should reuse user CLI auth (host mode), but
   * - CI runs should be hermetic via API keys (env mode).
   */
  auth: z.optional(E2eCliProviderAuthSchema),
  permissions: z.optional(E2eCliProviderPermissionsV1Schema),
  requiredBinaries: z.optional(z.array(E2eRequiredBinarySchema)),
  cli: E2eCliSpecSchema,
});

export type E2eCliProviderSpecV1 = z.infer<typeof E2eCliProviderSpecV1Schema>;

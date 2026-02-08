import { z } from 'zod';

export const E2eProviderProtocolSchema = z.enum(['acp', 'claude', 'codex']);

export const E2eRequiredBinarySchema = z.union([
  z.string(),
  z.object({
    bin: z.string().min(1),
    envOverride: z.string().min(1).optional(),
    requireExists: z.boolean().optional(),
  }),
]);

export const E2eCliSpecSchema = z.object({
  subcommand: z.string().min(1),
  extraArgs: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  // Map CLI env var -> test-runner env var
  envFrom: z.record(z.string()).optional(),
});

export const E2eCliProviderAuthOverlaySchema = z.object({
  /**
   * Env vars that must exist to select this auth mode.
   *
   * When provided, every env var in the list must be present (non-empty).
   */
  requiredAll: z.array(z.string().min(1)).optional(),
  /**
   * Env vars that must exist to select this auth mode (any-of buckets).
   *
   * When provided, at least one bucket must match, and a bucket matches when
   * every env var in that bucket is present (non-empty).
   *
   * Example: [["OPENAI_API_KEY"], ["CODEX_API_KEY"]] means "OPENAI_API_KEY OR CODEX_API_KEY".
   */
  requiredAnyOf: z.array(z.array(z.string().min(1)).min(1)).optional(),
  /**
   * Additional env vars to apply for this auth mode.
   *
   * These are merged on top of the base CLI env computed by the E2E harness.
   */
  env: z.record(z.string()).optional(),
  /**
   * Env vars to remove for this auth mode.
   *
   * Useful for enabling interactive auth mechanisms in local runs (e.g. Codex ChatGPT auth)
   * while keeping CI hermetic via API keys.
   */
  envUnset: z.array(z.string().min(1)).optional(),
});

export const E2eCliProviderAuthSchema = z.object({
  /**
   * How the harness should select an auth mode.
   *
   * - "auto": choose "env" when its required env vars are present, else fall back to "host"
   * - "env": always use "env" (fail-fast if required env vars are missing)
   * - "host": always use "host" (may rely on user-local CLI auth state)
   */
  mode: z.enum(['auto', 'env', 'host']).optional(),
  env: E2eCliProviderAuthOverlaySchema.optional(),
  host: E2eCliProviderAuthOverlaySchema.optional(),
});

export const E2eCliProviderPermissionsV1Schema = z.object({
  v: z.literal(1),
  acp: z
    .object({
      /**
       * Mode-aware expectation for ACP permission prompts.
       *
       * This enables provider contract tests to validate prompt surfacing per
       * selected permission mode, rather than a single provider-wide boolean.
       */
      toolPermissionPromptsByMode: z
        .object({
          default: z.boolean().optional(),
          'safe-yolo': z.boolean().optional(),
          'read-only': z.boolean().optional(),
          yolo: z.boolean().optional(),
          plan: z.boolean().optional(),
        })
        .optional(),
      /**
       * Mode-aware expectation for outside-workspace writes used by ACP
       * permission contract scenarios.
       *
       * `true` means the scenario should auto-approve and assert the write
       * succeeds. `false` means the scenario should deny/assert no write.
       */
      outsideWorkspaceWriteAllowedByMode: z
        .object({
          default: z.boolean().optional(),
          'safe-yolo': z.boolean().optional(),
          'read-only': z.boolean().optional(),
          yolo: z.boolean().optional(),
          plan: z.boolean().optional(),
        })
        .optional(),
      /**
       * Optional mode-aware requirement for outside-workspace write completion.
       *
       * When false, scenarios still validate prompt/tool-attempt behavior but do
       * not require the provider to emit a successful tool-result or write file
       * content (useful for providers with known completion stalls after prompt
       * handling).
       */
      outsideWorkspaceWriteMustCompleteByMode: z
        .object({
          default: z.boolean().optional(),
          'safe-yolo': z.boolean().optional(),
          'read-only': z.boolean().optional(),
          yolo: z.boolean().optional(),
          plan: z.boolean().optional(),
        })
        .optional(),
      /**
       * Optional mode-aware toggle for whether restrictive scenarios must emit a
       * `task_complete` trace when no tool attempt is expected.
       */
      outsideWorkspaceRequireTaskCompleteByMode: z
        .object({
          default: z.boolean().optional(),
          'safe-yolo': z.boolean().optional(),
          'read-only': z.boolean().optional(),
          yolo: z.boolean().optional(),
          plan: z.boolean().optional(),
        })
        .optional(),
      /**
       * When true, ACP providers are expected to emit `permission-request` trace
       * events for tool calls that require user approval.
       *
       * Some ACP providers may still honor sandbox policies internally while not
       * surfacing explicit permission prompts in the trace. This is retained as a
       * legacy fallback when `toolPermissionPromptsByMode` is not set.
       */
      expectToolPermissionPrompts: z.boolean().optional(),
      /**
       * Some providers require YOLO mode for deterministic E2E runs when they do not
       * emit ACP permission prompts (the host would otherwise block the tool call).
       *
       * This is currently only used by the shared permission_surface_outside_workspace
       * scenario.
       */
      permissionSurfaceOutsideWorkspaceYolo: z.boolean().optional(),
    })
    .optional(),
});

export const E2eCliProviderSpecV1Schema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  enableEnvVar: z.string().min(1),
  protocol: E2eProviderProtocolSchema,
  traceProvider: z.string().min(1),
  /**
   * Environment variables that must be present for this provider to run.
   *
   * These are evaluated by the E2E harness after applying `cli.envFrom` and `cli.env`.
   * When missing, the harness should fail fast with a clear error rather than hanging.
   */
  requiredEnv: z.array(z.string().min(1)).optional(),
  /**
   * Optional auth selection policy for the provider.
   *
   * This is useful when:
   * - local runs should reuse user CLI auth (host mode), but
   * - CI runs should be hermetic via API keys (env mode).
   */
  auth: E2eCliProviderAuthSchema.optional(),
  permissions: E2eCliProviderPermissionsV1Schema.optional(),
  requiredBinaries: z.array(E2eRequiredBinarySchema).optional(),
  cli: E2eCliSpecSchema,
});

export type E2eCliProviderSpecV1 = z.infer<typeof E2eCliProviderSpecV1Schema>;

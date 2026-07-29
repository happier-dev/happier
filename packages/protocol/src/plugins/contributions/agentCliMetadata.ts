import { z } from 'zod';

const NonEmptyStringSchema = z.string().trim().min(1);
const UniqueNonEmptyStringsSchema = z.array(NonEmptyStringSchema)
  .min(1)
  .refine((values) => new Set(values).size === values.length, 'Entries must be unique.');

export const PluginAgentCliSourcePreferenceSchema = z.enum(['system-first', 'managed-first']);
export type PluginAgentCliSourcePreference = z.infer<typeof PluginAgentCliSourcePreferenceSchema>;

export const PluginAgentCliExecutableMetadataSchema = z.object({
  binaryName: NonEmptyStringSchema,
  alternativeBinaryNames: UniqueNonEmptyStringsSchema.optional(),
  alternativeBinaryFallbackEnabledEnvVar: NonEmptyStringSchema.optional(),
  knownUserBinDirSuffixes: UniqueNonEmptyStringsSchema.nullable().optional(),
  sourcePreference: PluginAgentCliSourcePreferenceSchema,
  acceptsJavaScriptFileOverride: z.boolean().optional(),
  systemCommandResolutionStrategy: z.enum(['path-first', 'known-user-first-runnable']).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.alternativeBinaryNames?.includes(value.binaryName)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['alternativeBinaryNames'],
      message: 'Alternative binary names must not duplicate the primary binary name.',
    });
  }
});
export type PluginAgentCliExecutableMetadata = z.infer<typeof PluginAgentCliExecutableMetadataSchema>;

export const PluginAgentCliInstallCommandSchema = z.object({
  cmd: NonEmptyStringSchema,
  args: z.array(z.string()),
  requiresAdmin: z.boolean().optional(),
  note: NonEmptyStringSchema.nullable().optional(),
}).strict();
export type PluginAgentCliInstallCommand = z.infer<typeof PluginAgentCliInstallCommandSchema>;

export const PluginAgentCliManualInstallRecipesSchema = z.object({
  darwin: z.array(PluginAgentCliInstallCommandSchema).min(1).optional(),
  linux: z.array(PluginAgentCliInstallCommandSchema).min(1).optional(),
  win32: z.array(PluginAgentCliInstallCommandSchema).min(1).optional(),
}).strict().refine(
  (value) => value.darwin !== undefined || value.linux !== undefined || value.win32 !== undefined,
  'At least one platform recipe is required.',
);
export type PluginAgentCliManualInstallRecipes = z.infer<typeof PluginAgentCliManualInstallRecipesSchema>;

export const PluginAgentCliManagedInstallSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('github_release_binary'),
    githubRepo: NonEmptyStringSchema,
    binaryName: NonEmptyStringSchema,
  }).strict(),
  z.object({
    kind: z.literal('managed_package'),
    packageName: NonEmptyStringSchema,
    binaryName: NonEmptyStringSchema,
    packageBinarySetup: z.object({ kind: z.literal('opencode_platform_binary') }).strict().nullable().optional(),
  }).strict(),
]);
export type PluginAgentCliManagedInstall = z.infer<typeof PluginAgentCliManagedInstallSchema>;

export const PluginAgentCliInstallMetadataSchema = z.object({
  managed: PluginAgentCliManagedInstallSchema.nullable().optional(),
  manual: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({
      kind: z.enum(['command', 'vendor_recipe']),
      recipes: PluginAgentCliManualInstallRecipesSchema.optional(),
    }).strict(),
  ]),
  recommendationOrder: z.number().int().nonnegative().max(1_000_000).optional(),
  guideUrl: z.url().nullable().optional(),
  docsUrl: z.url().nullable().optional(),
}).strict();
export type PluginAgentCliInstallMetadata = z.infer<typeof PluginAgentCliInstallMetadataSchema>;

export const PluginAgentCliAuthProbeMetadataSchema = z.object({
  parser: z.enum([
    'none',
    'unknown',
    'envOnly',
    'claudeCredentialsFile',
    'codexLoginStatus',
    'geminiCredentialFiles',
    'opencodeAuthList',
    'piEnvOnly',
    'copilotGhAuth',
    'kiroWhoamiJson',
    'cursorAboutJson',
  ]),
  backgroundChecks: z.enum(['safe', 'manual_only']),
  statusArgs: z.array(z.string()).nullable().optional(),
  envVars: UniqueNonEmptyStringsSchema.optional(),
  credentialPaths: UniqueNonEmptyStringsSchema.optional(),
}).strict();
export type PluginAgentCliAuthProbeMetadata = z.infer<typeof PluginAgentCliAuthProbeMetadataSchema>;

export const PluginAgentCliLoginLaunchSchema = z.object({
  kind: z.enum(['primary', 'device_code']),
  args: z.array(z.string()),
  initialInput: z.string().nullable().optional(),
}).strict();
export type PluginAgentCliLoginLaunch = z.infer<typeof PluginAgentCliLoginLaunchSchema>;

export const PluginAgentCliAuthMetadataSchema = z.object({
  support: z.enum(['login_terminal', 'status_only', 'manual_only', 'unsupported']),
  machineLoginKey: NonEmptyStringSchema.optional(),
  probe: PluginAgentCliAuthProbeMetadataSchema,
  loginLaunches: z.array(PluginAgentCliLoginLaunchSchema).max(2)
    .refine(
      (launches) => new Set(launches.map((launch) => launch.kind)).size === launches.length,
      'Login launch kinds must be unique.',
    ),
}).strict().superRefine((value, ctx) => {
  if (value.support === 'login_terminal' && !value.loginLaunches.some((launch) => launch.kind === 'primary')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['loginLaunches'],
      message: 'Login-terminal support requires a primary login launch.',
    });
  }
  if (value.support !== 'login_terminal' && value.loginLaunches.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['loginLaunches'],
      message: 'Only login-terminal support may declare login launches.',
    });
  }
});
export type PluginAgentCliAuthMetadata = z.infer<typeof PluginAgentCliAuthMetadataSchema>;

export const PluginAgentCliMetadataSchema = z.object({
  displayName: NonEmptyStringSchema.optional(),
  executable: PluginAgentCliExecutableMetadataSchema,
  install: PluginAgentCliInstallMetadataSchema,
  auth: PluginAgentCliAuthMetadataSchema,
}).strict();
export type PluginAgentCliMetadata = z.infer<typeof PluginAgentCliMetadataSchema>;

import { PLUGIN_DEVELOPMENT_INPUT_FIELDS } from './pluginDevelopmentInputHints.js';
import { EmptyObjectSchema } from './common.js';
import type { PreNormalizedActionSpec } from './definition.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginUpdatePolicyV1Schema } from '../../marketplace/pluginUpdatePolicyV1.js';
import { ManagedResourceDispositionV1Schema } from '../../machines/managed/managedDependencyV1.js';
import { z } from 'zod/mini';
import { type ActionCliBindContext } from '../actionCliProjection.js';
import { type PluginDevLoopActionIdV1 } from '../actionIds.js';


/**
 * The single vocabulary for the plugin scaffold's UI mode. Every surface that
 * accepts `--ui` (CLI parser, `plugins.scaffold` action input, scaffold engine,
 * and the Settings Create form) resolves the mode through this schema; no
 * consumer may enumerate a second mode list.
 *
 * `declarative` is first because it is the default a scaffold receives when the
 * author expresses no preference: a declarative surface is projected from the
 * manifest, so it needs no bundler, no UI dependency tree and no build step,
 * and a fresh plugin therefore renders its first surface on every platform
 * immediately. The executable arms are opt-in.
 */
export const PluginScaffoldUiModeSchema = lazyZodSchema(() => z.enum(['declarative', 'hostedWeb', 'reactNative']));
export type PluginScaffoldUiMode = z.infer<typeof PluginScaffoldUiModeSchema>;

/**
 * The mode a scaffold receives when the author expresses no preference. The
 * scaffold engine applies it and the Settings Create form preselects it, so the
 * command line and the app cannot start a plugin from different shapes.
 */
export const DEFAULT_PLUGIN_SCAFFOLD_UI_MODE: PluginScaffoldUiMode = 'declarative';

/** Optional first-party starting shape; omission retains the generic scaffold. */
export const PluginScaffoldTemplateSchema = lazyZodSchema(() => z.enum(['session-agent']));
export type PluginScaffoldTemplate = z.infer<typeof PluginScaffoldTemplateSchema>;

export const PluginScaffoldActionInputSchema = lazyZodSchema(() => z.strictObject({
  targetDir: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  id: z.string().check(z.trim(), z.minLength(1)),
  name: z.string().check(z.trim(), z.minLength(1)),
  ui: z.optional(PluginScaffoldUiModeSchema),
  template: z.optional(PluginScaffoldTemplateSchema),
}));

export const PluginLocalInstallActionInputSchema = lazyZodSchema(() => z.strictObject({
  path: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  kind: z.optional(z.enum(['path', 'archive', 'npm'])),
  selector: z.optional(z.string().check(z.trim(), z.minLength(1))),
  integrity: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sdkRegistryOrigin: z.optional(z.string().check(z.trim(), z.minLength(1))),
  dev: z.optional(z.boolean()),
  dryRun: z.optional(z.boolean()),
  force: z.optional(z.boolean()),
}));

export const PluginMarketplaceInstallActionInputSchema = lazyZodSchema(() => z.strictObject({
  source: z.strictObject({
    kind: z.literal('marketplace'),
    sourceId: z.string().check(z.trim(), z.minLength(1)),
    pluginId: z.string().check(z.trim(), z.minLength(1)),
    version: z.string().check(z.trim(), z.minLength(1)),
    packageName: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
  machineId: z.string().check(z.trim(), z.minLength(1)),
}));

export const PluginInstallActionInputSchema = lazyZodSchema(() => z.union([
  PluginLocalInstallActionInputSchema,
  PluginMarketplaceInstallActionInputSchema,
  z.strictObject({
    source: z.strictObject({ kind: z.literal('installed'), pluginId: z.string().check(z.trim(), z.minLength(1)) }),
    machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
]));

export const PluginInstallCliInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.partial(PluginLocalInstallActionInputSchema), {
  sourceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  pluginId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  version: z.optional(z.string().check(z.trim(), z.minLength(1))),
  packageName: z.optional(z.string().check(z.trim(), z.minLength(1))),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
})));

export const PluginUninstallActionInputSchema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
  deleteData: z.optional(z.boolean()),
}));

export const PluginLifecycleActionInputSchema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export const PluginEnableActionInputSchema = lazyZodSchema(() => z.strictObject({
  ...PluginLifecycleActionInputSchema.shape,
  scope: z.optional(z.enum(['account', 'machine'])),
}));
export const PluginDisableActionInputSchema = lazyZodSchema(() => z.strictObject({
  ...PluginEnableActionInputSchema.shape,
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
}));
export const PluginUpdatePolicyActionInputSchema = lazyZodSchema(() => z.strictObject({
  ...PluginLifecycleActionInputSchema.shape,
  policy: PluginUpdatePolicyV1Schema,
}));

export const PluginReloadActionInputSchema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.trim(), z.minLength(1)),
}));

export const PluginDevActionInputSchema = lazyZodSchema(() => z.strictObject({
  projectRoot: z.string().check(z.trim(), z.minLength(1)),
  sdkRegistryOrigin: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const PluginAuthorActionInputSchema = lazyZodSchema(() => z.strictObject({
  projectRoot: z.string().check(z.trim(), z.minLength(1)),
  sdkRegistryOrigin: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const PluginDoctorActionInputSchema = lazyZodSchema(() => z.strictObject({
  locator: z.string().check(z.trim(), z.minLength(1)),
}));

export const PluginPackActionInputSchema = lazyZodSchema(() => z.strictObject({
  locator: z.string().check(z.trim(), z.minLength(1)),
  outPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sdkRegistryOrigin: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const PluginListActionInputSchema = EmptyObjectSchema;

export const PluginChangeStatusActionInputSchema = lazyZodSchema(() => z.strictObject({
  pendingChangeId: z.string().check(z.trim(), z.minLength(1)),
}));

export const PluginDevLoopActionInputSchemas = {
  'plugins.scaffold': PluginScaffoldActionInputSchema,
  'plugins.install': PluginInstallActionInputSchema,
  'plugins.uninstall': PluginUninstallActionInputSchema,
  'plugins.enable': PluginEnableActionInputSchema,
  'plugins.disable': PluginDisableActionInputSchema,
  'plugins.rollback': PluginLifecycleActionInputSchema,
  'plugins.trust.forget': PluginLifecycleActionInputSchema,
  'plugins.update_policy.set': PluginUpdatePolicyActionInputSchema,
  'plugins.dev.submit': PluginDevActionInputSchema,
  'plugins.dev.unregister': lazyZodSchema(() => z.omit(PluginDevActionInputSchema, { sdkRegistryOrigin: true })),
  'plugins.dev.install': PluginAuthorActionInputSchema,
  'plugins.dev.typecheck': PluginAuthorActionInputSchema,
  'plugins.dev.build': PluginAuthorActionInputSchema,
  'plugins.dev.test': PluginAuthorActionInputSchema,
  'plugins.doctor': PluginDoctorActionInputSchema,
  'plugins.pack': PluginPackActionInputSchema,
  'plugins.reload': PluginReloadActionInputSchema,
  'plugins.list': PluginListActionInputSchema,
  'plugins.change.status': PluginChangeStatusActionInputSchema,
} as const satisfies Readonly<Record<PluginDevLoopActionIdV1, z.ZodMiniType>>;

export const PluginDevLoopActionResultKindSchema = lazyZodSchema(() => z.enum([
  'plugins_scaffold',
  'plugins_install',
  'plugins_uninstall',
  'plugins_enable',
  'plugins_disable',
  'plugins_rollback',
  'plugins_trust_forget',
  'plugins_update_policy_set',
  'plugins_dev_submit',
  'plugins_dev_unregister',
  'plugins_dev_install',
  'plugins_dev_typecheck',
  'plugins_dev_build',
  'plugins_dev_test',
  'plugins_doctor',
  'plugins_pack',
  'plugins_reload',
  'plugins_list',
  'plugins_change_status',
]));

export const PluginDevLoopPendingReviewSchema = lazyZodSchema(() => z.looseObject({
  kind: z.literal('reviewRequired'),
  reviewKind: z.enum(['projectTrust', 'installation']),
  pendingChangeId: z.string().check(z.trim(), z.minLength(1)),
  // The daemon/CLI change owner retains the review payload contract. Action
  // consumers receive it only as an opaque, nested projection.
  review: z.looseObject({}),
}));

export const PluginDevLoopReviewRequiredActionOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.literal(false),
  kind: z.enum(['plugins_install', 'plugins_dev_submit', 'plugins_reload']),
  outcome: z.literal('reviewRequired'),
  // Public/headless callers receive the daemon candidate as one nested value.
  // A human UI host may retain the invocation through its existing private
  // review boundary; neither public input nor this envelope supplies consent.
  pendingReview: PluginDevLoopPendingReviewSchema,
  pendingChangeId: z.optional(z.never()),
  review: z.optional(z.never()),
}));

export const PluginDevLoopChangeStatusActionOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.literal(true),
  kind: z.literal('plugins_change_status'),
  // Status is daemon-lifetime state owned by the CLI change client. Keep its
  // state/result payload opaque here instead of introducing a second owner.
  status: z.looseObject({}),
}));

export const PluginDevLoopOrdinaryActionOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.boolean(),
  kind: z.enum(PluginDevLoopActionResultKindSchema.options.filter((value): value is Exclude<(typeof PluginDevLoopActionResultKindSchema.options)[number], 'plugins_change_status'> => !(['plugins_change_status'] as readonly string[]).includes(value))),
  // Only install currently emits an ordinary outcome. Keeping this bounded
  // prevents a review-required result from bypassing its typed envelope.
  outcome: z.optional(z.enum(['applied', 'failed'])),
  pendingReview: z.optional(z.never()),
  pendingChangeId: z.optional(z.never()),
  review: z.optional(z.never()),
}));

export const PluginDevLoopActionOutputSchema = lazyZodSchema(() => z.union([
  PluginDevLoopReviewRequiredActionOutputSchema,
  PluginDevLoopChangeStatusActionOutputSchema,
  PluginDevLoopOrdinaryActionOutputSchema,
]));

export const PLUGIN_DEV_LOOP_ACTION_TITLES: Readonly<Record<PluginDevLoopActionIdV1, string>> = Object.freeze({
  'plugins.scaffold': 'Scaffold plugin',
  'plugins.install': 'Install plugin',
  'plugins.uninstall': 'Uninstall plugin',
  'plugins.enable': 'Enable plugin',
  'plugins.disable': 'Disable plugin',
  'plugins.rollback': 'Roll back plugin',
  'plugins.trust.forget': 'Forget plugin trust',
  'plugins.update_policy.set': 'Set plugin update policy',
  'plugins.dev.submit': 'Start plugin development',
  'plugins.dev.unregister': 'Stop plugin development',
  'plugins.dev.install': 'Install plugin dependencies',
  'plugins.dev.typecheck': 'Typecheck plugin',
  'plugins.dev.build': 'Build plugin',
  'plugins.dev.test': 'Test plugin',
  'plugins.doctor': 'Diagnose plugin',
  'plugins.pack': 'Pack plugin',
  'plugins.reload': 'Reload plugin',
  'plugins.list': 'List plugins',
  'plugins.change.status': 'Get plugin change status',
});

export const PLUGIN_DEV_LOOP_ACTION_DESCRIPTIONS: Readonly<Record<PluginDevLoopActionIdV1, string>> = Object.freeze({
  'plugins.scaffold': 'Create a local plugin scaffold from the first-party template.',
  'plugins.install': 'Request approval to install and trust an exact marketplace or local plugin; the daemon retains custody of the install effect.',
  'plugins.uninstall': 'Remove a plugin installed from a local folder on a machine.',
  'plugins.enable': 'Enable a plugin for the Account or this Machine. Machine scope is the default.',
  'plugins.disable': 'Disable a plugin for the Account or this Machine, preserving retained data and resource review. Machine scope is the default.',
  'plugins.rollback': 'Restore the previous installed plugin version through its machine lifecycle owner.',
  'plugins.trust.forget': 'Remove the machine’s retained trust for an installed plugin.',
  'plugins.update_policy.set': 'Change whether an installed plugin admits explicit updates.',
  'plugins.dev.submit': 'Register a local plugin source with the daemon-owned development cycle, which watches and applies source changes.',
  'plugins.dev.unregister': 'Unregister an exact explicit source root from the daemon-owned development cycle.',
  'plugins.dev.install': 'Prepare external plugin-author dependencies through the managed runtime.',
  'plugins.dev.typecheck': 'Run the managed TypeScript check for an external plugin-author source.',
  'plugins.dev.build': 'Build an external plugin-author source through the managed runtime.',
  'plugins.dev.test': 'Run the external plugin-author test command through the managed runtime.',
  'plugins.doctor': 'Evaluate and diagnose an external plugin-author source.',
  'plugins.pack': 'Validate and package a local plugin into an installable archive.',
  'plugins.reload': 'Load a plugin you are developing again, so your latest changes take effect.',
  'plugins.list': 'List installed plugins plus daemon-owned pending changes with the issued ids needed to rejoin them.',
  'plugins.change.status': 'Read one daemon-issued pending plugin change without creating or deciding it.',
});

/**
 * What a present user is confirming, named by the exact source or plugin it acts on. Without it the
 * confirmation fell back to the Action title and asked "Submit plugin development snapshot." about
 * a folder it never named.
 */
export const PLUGIN_DEV_LOOP_APPROVAL_SUMMARIES: Readonly<Partial<Record<PluginDevLoopActionIdV1, (subject: string) => string>>> = Object.freeze({
  'plugins.scaffold': (subject) => `Create a new plugin in ${subject}`,
  'plugins.uninstall': (subject) => `Remove ${subject} from this machine`,
  'plugins.trust.forget': (subject) => `Forget this machine’s trust for ${subject}`,
  'plugins.dev.submit': (subject) => `Build and run the plugin in ${subject}, and reload it whenever its files change`,
  'plugins.dev.unregister': (subject) => `Stop developing the plugin in ${subject}`,
  'plugins.dev.install': (subject) => `Install the dependencies of the plugin in ${subject}`,
  'plugins.dev.typecheck': (subject) => `Typecheck the plugin in ${subject}`,
  'plugins.dev.build': (subject) => `Build the plugin in ${subject}`,
  'plugins.dev.test': (subject) => `Run the tests of the plugin in ${subject}`,
  'plugins.doctor': (subject) => `Diagnose the plugin in ${subject}`,
  'plugins.pack': (subject) => `Package the plugin in ${subject} into an installable archive`,
  'plugins.reload': (subject) => `Reload ${subject} so its latest changes take effect`,
});

export function readPluginDevLoopApprovalSubject(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  for (const key of ['projectRoot', 'locator', 'targetDir', 'pluginId'] as const) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function createPluginDevLoopActionSpec(actionId: PluginDevLoopActionIdV1): PreNormalizedActionSpec {
  const describeApproval = PLUGIN_DEV_LOOP_APPROVAL_SUMMARIES[actionId];
  const isRead = actionId === 'plugins.list' || actionId === 'plugins.change.status';
  const isLifecycle = actionId === 'plugins.enable' || actionId === 'plugins.disable' || actionId === 'plugins.rollback'
    || actionId === 'plugins.trust.forget' || actionId === 'plugins.update_policy.set';
  const isInspectorUiAction = actionId === 'plugins.list'
    || actionId === 'plugins.scaffold'
    || actionId === 'plugins.uninstall'
    || isLifecycle
    || actionId === 'plugins.install'
    || actionId === 'plugins.reload'
    || actionId === 'plugins.change.status'
    || actionId === 'plugins.dev.submit'
    || actionId === 'plugins.dev.unregister'
    || actionId === 'plugins.dev.test'
    || actionId === 'plugins.pack';
  const inputSchema = PluginDevLoopActionInputSchemas[actionId];

  return {
    id: actionId, executionPlacement: 'machine',
    ...(actionId === 'plugins.enable' || actionId === 'plugins.disable' ? {
      executionPlacementForInput: (input: unknown) => (actionId === 'plugins.disable'
        ? PluginDisableActionInputSchema.parse(input) : PluginEnableActionInputSchema.parse(input)).scope === 'account'
        ? 'account' as const : 'machine' as const,
    } : {}),
    approval: isRead
      ? { result: 'required' }
      : { result: 'optional', flow: 'deferred' },
    title: PLUGIN_DEV_LOOP_ACTION_TITLES[actionId],
    ...(actionId === 'plugins.uninstall' ? { confirmVerb: { key: 'settingsPlugins.uninstall', fallback: 'Uninstall' }, irreversible: true as const }
      : actionId === 'plugins.trust.forget' ? { confirmVerb: { key: 'settingsPlugins.forgetTrust', fallback: 'Forget trust' }, irreversible: true as const }
        : actionId === 'plugins.install' ? { confirmVerb: { key: 'common.install', fallback: 'Install' } } : {}),
    description: PLUGIN_DEV_LOOP_ACTION_DESCRIPTIONS[actionId],
    ...(describeApproval ? { approvalPresentation: { summary: (input: unknown) => {
      const subject = readPluginDevLoopApprovalSubject(input);
      return subject ? describeApproval(subject) : null;
    } } } : {}),
    safety: isRead ? 'safe' : 'danger',
    placements: [],
    bindings: {
      mcpToolName: actionId.replaceAll('.', '_'),
    },
    surfaces: {
      ui: isInspectorUiAction,
      ...(actionId === 'plugins.install' ? { api: false } : {}),
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    sideEffectClass: actionId === 'plugins.uninstall' || actionId === 'plugins.trust.forget' ? 'danger' : isRead ? 'read' : 'write',
    ...(actionId === 'plugins.reload' || actionId === 'plugins.scaffold' || isLifecycle && actionId !== 'plugins.trust.forget'
      ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    ...(actionId === 'plugins.uninstall' || actionId === 'plugins.trust.forget' ? { approvalPolicy: { uiConfirmation: 'policy' as const } } : {}),
    ...(actionId === 'plugins.install' ? {
      // Install & Trust defaults to one ordinary approval Artifact on every
      // caller surface; users can change that policy through Action settings.
      approvalPolicy: {
        uiConfirmation: 'policy' as const,
      },
      cli: {
        acceptsServerId: true as const,
        commands: [
          { path: ['plugins', 'install'], positionals: ['path'], visibility: 'canonical' as const },
          { path: ['plugins', 'update'], positionals: ['pluginId'], visibility: 'alias' as const },
          { path: ['plugins', 'marketplace', 'install'], positionals: ['sourceId', 'pluginId'], visibility: 'alias' as const },
        ],
        inputSchema: PluginInstallCliInputSchema,
        flagAliases: [{ path: 'sdkRegistryOrigin', aliases: ['--sdk-registry'] }, { path: 'packageName', aliases: ['--package'] }, { path: 'machineId', aliases: ['--machine'] }],
        bindInput: (value: unknown, context: ActionCliBindContext) => {
          const input = PluginInstallCliInputSchema.parse(value);
          if (context.commandPath?.[1] === 'update') {
            if (!input.pluginId || input.path !== undefined || input.sourceId !== undefined || input.version !== undefined
              || input.packageName !== undefined || input.kind !== undefined || input.dev !== undefined || input.dryRun !== undefined
              || input.force !== undefined || input.selector !== undefined || input.integrity !== undefined || input.sdkRegistryOrigin !== undefined) {
              throw new Error('Plugin updates accept an installed plugin id and optional Machine selection.');
            }
            return { source: { kind: 'installed', pluginId: input.pluginId }, ...(input.machineId ? { machineId: input.machineId } : {}) };
          }
          if (context.commandPath?.includes('marketplace')) {
            if (input.path !== undefined || input.kind !== undefined || input.dev !== undefined
              || input.dryRun !== undefined || input.force !== undefined || input.selector !== undefined
              || input.integrity !== undefined || input.sdkRegistryOrigin !== undefined) {
              throw new Error('Marketplace installs accept an exact source, plugin, version and Machine selection.');
            }
            return { machineId: input.machineId, source: {
              kind: 'marketplace', sourceId: input.sourceId, pluginId: input.pluginId, version: input.version,
              ...(input.packageName ? { packageName: input.packageName } : {}),
            } };
          }
          if (input.sourceId !== undefined || input.pluginId !== undefined || input.version !== undefined || input.packageName !== undefined) {
            throw new Error('Marketplace listing fields require plugins marketplace install.');
          }
          const { sourceId: _sourceId, pluginId: _pluginId, version: _version, packageName: _packageName, ...local } = input;
          if (!local.kind && local.path) {
            let archivePath = local.path;
            try { archivePath = new URL(local.path).pathname; } catch { /* Local paths have no URL pathname. */ }
            if (/\.(?:tar\.gz|tgz|tar\.xz|zip)$/iu.test(archivePath)) return { ...local, kind: 'archive' };
          }
          return local;
        },
      },
    } : actionId === 'plugins.uninstall' ? {
      cli: {
        acceptsServerId: true as const,
        commands: [{ path: ['plugins', 'uninstall'], positionals: ['pluginId'], visibility: 'canonical' as const }],
        inputSchema: lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginUninstallActionInputSchema, { yes: z.optional(z.boolean()) }))),
        flagAliases: [{ path: 'yes', aliases: ['-y'] }],
        bindInput: (value: unknown) => {
          const input = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginUninstallActionInputSchema, { yes: z.optional(z.boolean()) }))).parse(value);
          if (input.deleteData && !input.yes) throw new Error('Destructive plugin data removal requires --yes confirmation.');
          const { yes: _yes, ...canonical } = input;
          return canonical;
        },
      },
    } : isLifecycle ? {
      cli: {
        acceptsServerId: true as const,
        commands: [{ path: actionId.split('.').map(segment => segment.replaceAll('_', '-')), positionals: ['pluginId'], visibility: 'canonical' as const }],
        flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
      },
    } : {}),
    outputSchema: PluginDevLoopActionOutputSchema,
    inputSchema,
    inputHints: { fields: PLUGIN_DEVELOPMENT_INPUT_FIELDS[actionId] },
  };
}

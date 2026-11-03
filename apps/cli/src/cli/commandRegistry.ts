import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import type {
  ActionDefinitionV1,
  ConnectedServiceBindingsV2,
  SessionProviderBindingMetadataV1,
  SessionProviderBindingSecurityChangeConfirmationV1,
} from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { resolvePluginCommandProjection, type PluginCommandProjection } from '@/cli/pluginCommandProjection';
import {
  createCommandDispatchRegistry,
  type CommandDispatchPolicy,
  type CommandDispatchDescriptor as RuntimeCommandDispatchDescriptor,
  type CommandDispatchRegistry as RuntimeCommandDispatchRegistry,
  type CommandSurfaceDescriptorInput,
} from '@/agent/runtime/registry/commandContracts';
import {
  DEFAULT_COMMAND_SURFACE,
  lazyCommandHandler,
  assertActionCommandPathsFitStaticRegistry,
  isStaticCommandSurfaceReserved,
  isStaticCommandSurfaceProviderPlaceholder,
  projectActionCommandSurface,
  projectAgentCommandSurface,
  resolveAdmittedAgentCommandMetadata,
  staticCommandDescriptors,
} from './commandDescriptors';
import { BUNDLED_ACTION_CLI_COMMAND_PATHS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import type { CompiledActionCliCommand } from '@/cli/actions/compiledCommands';
import { resolveCommandPathCompletionCandidates } from './commandCompletionPaths';
import { findActionCliCommandPattern, resolveActionCliCommandPathCompletionCandidates } from './actions/commandPatterns';
import { findPluginCommandCompletionCommand } from './pluginCommandMetadata';
import type { PluginCommandActionInputRegistry } from './pluginCommandFields';
import type { EphemeralResolvedServerSelection } from '@/server/serverSelection';
export { assertComposedCommandPathsAreUnambiguous, isStaticCommandSurfaceReserved, isStaticCommandSurfaceProviderPlaceholder, listCollidingAgentCommandRoots } from './commandDescriptors';

export type CommandContext = Readonly<{
  args: string[];
  rawArgv: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
  signal?: AbortSignal;
  /** Trusted explicit invocation provenance; contains neither credentials nor persistence authority. */
  explicitServerSelection?: EphemeralResolvedServerSelection;
  /** In-memory only; carries launch-scoped values without argv or process.env. */
  scopedEnvironment?: Readonly<{
    env: Readonly<Record<string, string>>;
    unsetEnvKeys?: readonly string[];
  }>;
  /** Non-secret persisted lifecycle facts for a direct resume/fork boundary. */
  directSessionLaunch?: Readonly<{
    providerBinding?: SessionProviderBindingMetadataV1 | null;
    confirmProviderSecurityChange?: (
      confirmation: SessionProviderBindingSecurityChangeConfirmationV1,
    ) => Promise<boolean>;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    sessionAttachFilePath?: string;
  }>;
}>;

export type CommandHandler = (context: CommandContext) => Promise<void>;
export type CommandDispatchDescriptor = RuntimeCommandDispatchDescriptor<CommandHandler>;
export type CommandDispatchRegistry = RuntimeCommandDispatchRegistry<CommandHandler>;

type CommandRegistryEntry = Readonly<{
  handler?: CommandHandler;
  policy?: CommandDispatchPolicy;
  surface: Readonly<Omit<CommandSurfaceDescriptorInput, 'command'>>;
}>;

function lazyPluginCommandHandler(root: string): CommandHandler {
  return lazyCommandHandler(async () => {
    const { handlePluginCommandCliCommand } = await import('./pluginCommandContributions');
    return async (context) => {
      await handlePluginCommandCliCommand(root, context);
    };
  });
}

function lazyActionCliRootHandler(root: string): CommandHandler {
  return lazyCommandHandler(async () => {
    const { handleActionCliRootCommand } = await import('@/cli/actions/rootCommand');
    return async (context) => {
      await handleActionCliRootCommand(root, context);
    };
  });
}

const staticCommandRegistryEntries: Readonly<Record<string, CommandRegistryEntry>> = staticCommandDescriptors;
const staticCommandRegistry: Readonly<Record<string, CommandHandler>> = Object.freeze(
  Object.fromEntries(
    Object.entries(staticCommandRegistryEntries)
      .filter((entry): entry is [string, CommandRegistryEntry & Readonly<{ handler: CommandHandler }>] => Boolean(entry[1].handler))
      .map(([command, entry]) => [command, entry.handler]),
  ) as Record<string, CommandHandler>,
);

const mutableCommandRegistry: Record<string, CommandHandler> = { ...staticCommandRegistry };
const mutableCommandPolicies: Record<string, CommandDispatchPolicy | undefined> = Object.fromEntries(
  Object.entries(staticCommandRegistryEntries)
    .filter(([, entry]) => entry.policy)
    .map(([command, entry]) => [command, entry.policy]),
) as Record<string, CommandDispatchPolicy | undefined>;
const mutableCommandSurfaceEntries: Record<string, CommandSurfaceDescriptorInput> = Object.fromEntries(
  Object.entries(staticCommandRegistryEntries).map(([command, entry]) => [command, {
    command,
    ...entry.surface,
  }]),
) as Record<string, CommandSurfaceDescriptorInput>;

const dynamicAgentCommandKeys = new Set<string>();

/** Agent roots admitted by the merged command registry, not arbitrary plugin commands. */
export function isAgentCliCommandRoot(root: string): boolean {
  return dynamicAgentCommandKeys.has(root);
}
const dynamicPluginCommandKeys = new Set<string>();
let dynamicPluginCompletionPaths: readonly (readonly string[])[] = Object.freeze([]);
/**
 * The last synchronized plugin command sources. Completion derives one command's
 * invocation options from its canonical contributed Action definition on demand,
 * so a cold dispatch never pays for compiling every plugin command's fields.
 */
let dynamicPluginCommandSources: Readonly<{
  registry: ResolvedContributionRegistry;
  projection: PluginCommandProjection;
}> | null = null;

const PLUGIN_COMMAND_COMPATIBILITY_OPTIONS: readonly string[] = Object.freeze(['--help', '--input', '--json']);

async function readPluginCommandCompletionCandidates(
  committed: readonly string[],
  prefix: string,
  resolveDynamicOptions?: import('@/cli/actions/commandCompletion').ActionCliDynamicOptionsResolver,
  sources: Readonly<{ registry: PluginCommandActionInputRegistry; projection: PluginCommandProjection }> | null = dynamicPluginCommandSources,
): Promise<readonly string[]> {
  if (!sources || !findPluginCommandCompletionCommand(sources.projection, committed)) return Object.freeze([]);
  const completion = await import('@/cli/pluginCommandFields');
  const params = {
    registry: sources.registry,
    projection: sources.projection,
    committed,
    prefix,
    fallback: PLUGIN_COMMAND_COMPATIBILITY_OPTIONS,
  };
  if (!resolveDynamicOptions) return completion.resolvePluginCommandCompletionCandidates(params);
  try {
    return await completion.resolvePluginCommandCompletionCandidatesWithDynamicOptions({
      ...params,
      resolveDynamicOptions,
    });
  } catch {
    return completion.resolvePluginCommandCompletionCandidates(params);
  }
}
let dynamicPluginCommandTmuxEntries: readonly Readonly<{
  path: readonly string[];
  mode: 'inherit' | 'required' | 'forbidden';
  available: boolean;
}>[] = Object.freeze([]);
let mergedAgentCommandRegistryPromise: Promise<void> | null = null;

export function listRegisteredCommandSurfaceEntries(): readonly CommandSurfaceDescriptorInput[] {
  const staticRoots = new Set(Object.keys(staticCommandDescriptors));
  return Object.freeze([
    DEFAULT_COMMAND_SURFACE,
    ...Object.keys(staticCommandDescriptors).flatMap((root) => (
      mutableCommandSurfaceEntries[root] ? [mutableCommandSurfaceEntries[root]] : []
    )),
    ...Object.entries(mutableCommandSurfaceEntries).flatMap(([root, surface]) => (
      staticRoots.has(root) ? [] : [surface]
    )),
  ]);
}

function syncAgentCommandRegistryFromCatalogSnapshot(registry: ResolvedContributionRegistry): void {
  for (const key of dynamicAgentCommandKeys) {
    delete mutableCommandRegistry[key];
    delete mutableCommandPolicies[key];
    delete mutableCommandSurfaceEntries[key];
  }
  dynamicAgentCommandKeys.clear();

  const agentEntries = Object.values(registry.catalogEntriesById)
    .filter((entry) => Boolean(entry.getCliCommandHandler))
    .map((entry) => ({ ...entry, title: registry.agentDefinitionsById.get(entry.id)?.runtimeSpec?.title }));

  for (const entry of resolveAdmittedAgentCommandMetadata(agentEntries, dynamicActionCommandKeys)) {
    if (!entry.getCliCommandHandler) continue;
    mutableCommandRegistry[entry.cliSubcommand] = async (context) => {
      const handler = await entry.getCliCommandHandler!();
      await handler(context);
    };
    if (entry.cliCommandPolicy) {
      mutableCommandPolicies[entry.cliSubcommand] = entry.cliCommandPolicy;
    } else {
      delete mutableCommandPolicies[entry.cliSubcommand];
    }
    mutableCommandSurfaceEntries[entry.cliSubcommand] = projectAgentCommandSurface(entry);
    dynamicAgentCommandKeys.add(entry.cliSubcommand);
  }
}

export function synchronizePluginCommandContributions(registry: ResolvedContributionRegistry): void {
  for (const key of dynamicPluginCommandKeys) {
    delete mutableCommandRegistry[key];
    delete mutableCommandPolicies[key];
    delete mutableCommandSurfaceEntries[key];
  }
  dynamicPluginCommandKeys.clear();

  const reservedRoots = new Set<string>([
    ...Object.keys(staticCommandRegistry),
    ...dynamicAgentCommandKeys,
    // A root the Action catalog owns is reserved for the same reason a static
    // root is: one admitted owner per path, decided here rather than at dispatch.
    ...dynamicActionCommandKeys,
  ]);
  for (const action of registry.actions) {
    const cli = action.admittedTarget?.declaration.cli;
    for (const path of cli ? [cli.path, ...(cli.aliases ?? [])] : []) {
      const root = path[0];
      if (root && isStaticCommandSurfaceReserved(root)) reservedRoots.add(root);
    }
  }
  const projection = resolvePluginCommandProjection({ registry, reservedRoots });
  dynamicPluginCompletionPaths = Object.freeze(projection.commands
    .filter((command) => command.status === 'available')
    .map((command) => Object.freeze([...command.path])));
  dynamicPluginCommandTmuxEntries = Object.freeze(projection.commands.map((command) => Object.freeze({
    path: command.path,
    mode: command.tmux,
    available: command.status === 'available',
  })));
  dynamicPluginCommandSources = Object.freeze({ registry, projection });
  // Plugin roots changed, so the admitted Action set has to be recomputed
  // against the current reservations rather than reused.
  admittedActionCliCommandsCache = null;

  for (const root of projection.roots) {
    mutableCommandRegistry[root] = lazyPluginCommandHandler(root);
    mutableCommandPolicies[root] = undefined;
    const rootHelpEntry = projection.rootHelpEntries.find((entry) => entry.command === root);
    mutableCommandSurfaceEntries[root] = rootHelpEntry ?? { command: root, allowTmux: false };
    dynamicPluginCommandKeys.add(root);
  }
}

const dynamicActionCommandKeys = new Set<string>();
let admittedActionCliCommandsCache: readonly CompiledActionCliCommand[] | null = null;

/**
 * The compiled Action command paths this registry admits, plus the root entries
 * they need.
 *
 * There is no second path map: Action paths, plugin paths and static roots are
 * resolved by the same collision rules here. An Agent or plugin root owns its
 * whole subtree, so a declared Action path underneath one is not admitted; every
 * other declared path is admitted, and a leaf under an existing static root wins
 * only for its exact spelling while the root handler keeps everything else.
 */
let actionCliRootsRegistered = false;

/**
 * Claims the roots the Action catalog owns. This runs before Agent and plugin
 * synchronization so those sources see the Action roots as reserved, and it
 * reads only the declared paths — compiling every command's fields is deferred
 * to the first invocation or completion that actually needs them.
 */
async function ensureActionCliRootsRegistered(): Promise<void> {
  if (actionCliRootsRegistered) return;
  assertActionCommandPathsFitStaticRegistry(BUNDLED_ACTION_CLI_COMMAND_PATHS);
  for (const declaration of BUNDLED_ACTION_CLI_COMMAND_PATHS) {
    const root = declaration.path[0];
    if (root === undefined) continue;
    dynamicActionCommandKeys.add(root);
    if (Object.prototype.hasOwnProperty.call(mutableCommandRegistry, root)) continue;
    mutableCommandRegistry[root] = lazyActionCliRootHandler(root);
    mutableCommandSurfaceEntries[root] = projectActionCommandSurface(root);
  }
  actionCliRootsRegistered = true;
}

async function loadAdmittedActionCliCommands(): Promise<readonly CompiledActionCliCommand[]> {
  if (admittedActionCliCommandsCache) return admittedActionCliCommandsCache;
  await ensureActionCliRootsRegistered();
  const { listCompiledActionCliCommands } = await import('@/cli/actions/compiledCommands');
  const compiledCommands = listCompiledActionCliCommands();
  assertActionCommandPathsFitStaticRegistry(compiledCommands);
  admittedActionCliCommandsCache = Object.freeze(compiledCommands.filter((command) => {
    const root = command.path[0];
    return !dynamicAgentCommandKeys.has(root) && !dynamicPluginCommandKeys.has(root);
  }));
  return admittedActionCliCommandsCache;
}

/** Command-path words, stopping at the first option token. */
function readLeadingCommandWords(args: readonly string[]): readonly string[] {
  const words: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) break;
    words.push(token);
  }
  return words;
}

/**
 * The compiled Action command this argv names, or `null` when a dedicated
 * command owns the path. Dispatch consults this before the root handler so a
 * migrated leaf reaches its canonical Action, while every unmigrated spelling
 * still falls through to its existing owner.
 */
export async function resolveAdmittedActionCliCommand(
  args: readonly string[],
): Promise<CompiledActionCliCommand | null> {
  const words = readLeadingCommandWords(args);
  if (words.length === 0) return null;
  if (!BUNDLED_ACTION_CLI_COMMAND_PATHS.some(({ path }) => (
    path[0] === words[0]
  ))) return null;
  const { findCompiledActionCliCommand } = await import('@/cli/actions/compiledCommands');
  return findCompiledActionCliCommand(words, await loadAdmittedActionCliCommands());
}

export async function resolveCommandCompletionCandidates(
  words: readonly string[],
  options: Readonly<{
    resolveDynamicOptions?: import('@/cli/actions/commandCompletion').ActionCliDynamicOptionsResolver;
    resolveDynamicActionDefinition?: (
      actionId: string,
      argv: readonly string[],
    ) => Promise<ActionDefinitionV1 | null>;
    /** Admitted listing declarations never install executable handlers. */
    declarations?: Readonly<{
      paths: readonly (readonly string[])[];
      pluginSources: Readonly<{ registry: PluginCommandActionInputRegistry; projection: PluginCommandProjection }>;
    }>;
  }> = {},
): Promise<readonly string[]> {
  const prefix = words.at(-1) ?? '';
  const committed = words.length > 0 ? words.slice(0, -1) : [];
  const candidates = new Set<string>();
  const actionPaths = options.declarations ? BUNDLED_ACTION_CLI_COMMAND_PATHS : BUNDLED_ACTION_CLI_COMMAND_PATHS.filter((command) => (
    !dynamicAgentCommandKeys.has(command.path[0]!) && !dynamicPluginCommandKeys.has(command.path[0]!)
  ));
  for (const candidate of resolveActionCliCommandPathCompletionCandidates({ commands: actionPaths, committed, prefix })) candidates.add(candidate);
  const matchedAction = findActionCliCommandPattern(committed, actionPaths);
  let actionCommands: readonly CompiledActionCliCommand[] = [];
  if (matchedAction) {
    if (options.declarations) {
      const [{ compileActionCliCommands }, { listActionCliCommandDeclarations }] = await Promise.all([
        import('@/cli/actions/compiledCommands'), import('@happier-dev/protocol/actions/actionSpecs'),
      ]);
      actionCommands = compileActionCliCommands(listActionCliCommandDeclarations().filter(({ spec, binding }) => (
        spec.id === matchedAction.actionId && binding.path.length === matchedAction.path.length
        && binding.path.every((segment, index) => segment === matchedAction.path[index])
      )));
    } else {
      actionCommands = await loadAdmittedActionCliCommands();
    }
  }
  const allPaths: readonly (readonly string[])[] = options.declarations?.paths ?? [
    ...Object.keys(mutableCommandRegistry).map((command) => [command] as const),
    ...dynamicPluginCompletionPaths,
  ];
  for (const candidate of resolveCommandPathCompletionCandidates(allPaths, words)) candidates.add(candidate);
  const genericAction = Boolean(options.resolveDynamicActionDefinition && committed[0] === 'actions' && committed[1] === 'invoke' && committed[2]);
  const completion = actionCommands.length > 0 || genericAction ? await import('@/cli/actions/commandCompletion') : null;

  // `actions invoke` is intentionally a dynamic generic workflow, not a
  // friendly command path. Once its exact Action id is known, completion uses
  // the same published definition and field compiler as execution rather than
  // introducing a second command registry or a plugin-only flag grammar.
  if (
    completion && options.resolveDynamicActionDefinition
    && committed[0] === 'actions'
    && committed[1] === 'invoke'
    && typeof committed[2] === 'string'
  ) {
    try {
      const definition = await options.resolveDynamicActionDefinition(committed[2], committed);
      if (definition) {
        const { compileActionCliFieldsFromJsonSchema } = await import('@/cli/actions/compiledCommands');
        const target = {
          fields: compileActionCliFieldsFromJsonSchema({
            jsonSchema: definition.inputSchema,
            hints: definition.inputHints ?? undefined,
            reservedFlags: ['--machine-id', '--request-id', '--server-id'],
          }),
          positionals: Object.freeze([]),
        };
        const inputWords = committed.slice(3);
        const invokeCandidates = options.resolveDynamicOptions
          ? await completion.resolveActionCliInputCompletionCandidatesWithDynamicOptions({
              target,
              actionId: definition.id,
              committed: inputWords,
              prefix,
              resolveDynamicOptions: options.resolveDynamicOptions,
              cliOwnedFlags: {
                valueFlags: ['--server-id', '--machine-id', '--request-id'],
              },
            })
          : completion.resolveActionCliInputCompletionCandidates({
              target,
              committed: inputWords,
              prefix,
            });
        for (const candidate of invokeCandidates) candidates.add(candidate);
        if (!inputWords.includes('--')) {
          for (const flag of ['--server-id', '--machine-id', '--request-id']) {
            if (prefix === '' || flag.startsWith(prefix)) candidates.add(flag);
          }
        }
      }
    } catch {
      // Completion is advisory. Discovery/authentication/connectivity failures
      // retain static candidates and never reinterpret availability.
    }
  }
  const staticActionCandidates = completion?.resolveCompiledActionCliCompletionCandidates({
    committed,
    prefix,
    commands: actionCommands,
  }) ?? [];
  for (const candidate of staticActionCandidates) {
    candidates.add(candidate);
  }
  if (completion && options.resolveDynamicOptions) {
    try {
      for (const candidate of await completion.resolveCompiledActionCliCompletionCandidatesWithDynamicOptions({
        committed,
        prefix,
        commands: actionCommands,
        resolveDynamicOptions: options.resolveDynamicOptions,
      })) {
        candidates.add(candidate);
      }
    } catch {
      // Completion is advisory. Authentication, connectivity, and option-source
      // failures retain the compiler's static candidates rather than breaking
      // the user's shell or inventing a local options registry.
    }
  }
  for (const candidate of await readPluginCommandCompletionCandidates(
    committed,
    prefix,
    options.resolveDynamicOptions,
    options.declarations?.pluginSources,
  )) {
    candidates.add(candidate);
  }
  return Object.freeze([...candidates].sort());
}

export function resolvePluginCommandTmuxMode(args: readonly string[]): 'inherit' | 'required' | 'forbidden' | null {
  const path: string[] = [];
  for (const token of args) {
    // Plugin command declarations own a fixed path and expose Action input as
    // options. Once options begin, their values cannot become command words.
    if (token.startsWith('-')) break;
    path.push(token);
  }
  const exact = dynamicPluginCommandTmuxEntries.filter((entry) => (
    entry.path.length === path.length
    && entry.path.every((segment, index) => path[index] === segment)
  ));
  if (exact.length === 0) return null;
  if (exact.length !== 1 || !exact[0]!.available) return 'forbidden';
  return exact[0]!.mode;
}

export const commandRegistry: Readonly<Record<string, CommandHandler>> = mutableCommandRegistry;

export function findCommandDispatchDescriptor(command: string): CommandDispatchDescriptor | null {
  const handler = mutableCommandRegistry[command];
  if (!handler) return null;
  const policy = mutableCommandPolicies[command];
  return Object.freeze({
    id: command,
    command,
    handler,
    ...(policy ? { policy } : {}),
  });
}

export function resolveCommandDispatchRegistry(): CommandDispatchRegistry {
  return createCommandDispatchRegistry(
    Object.keys(mutableCommandRegistry).map((command) => findCommandDispatchDescriptor(command)!),
  );
}

export async function ensureMergedAgentCommandRegistryLoaded(params: Readonly<{ happyHomeDir?: string }> = {}): Promise<void> {
  if (mergedAgentCommandRegistryPromise) {
    return await mergedAgentCommandRegistryPromise;
  }
  const pending = (async () => {
    const { configuration } = await import('@/configuration');
    const { resolveMergedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    // Explicit ephemeral merged snapshot for the standalone CLI command
    // surface: it feeds only this command registry and is never written back
    // into any shared registry authority.
    const registry = await resolveMergedContributionRegistry({ happyHomeDir: params.happyHomeDir ?? configuration.happyHomeDir });
    // Some command-registry harnesses intentionally replace only the Agent catalog boundary.
    // Production always resolves the merged snapshot; absent snapshots cannot admit plugin roots.
    // Action-owned roots are claimed first so Agent and plugin synchronization
    // both see one complete reservation set. Compilation stays deferred until
    // an Action invocation or completion needs the admitted command fields.
    await ensureActionCliRootsRegistered();
    if (registry) {
      syncAgentCommandRegistryFromCatalogSnapshot(registry);
      synchronizePluginCommandContributions(registry);
    }
  })();
  mergedAgentCommandRegistryPromise = pending;
  try {
    await pending;
  } finally {
    if (mergedAgentCommandRegistryPromise === pending) {
      mergedAgentCommandRegistryPromise = null;
    }
  }
}

import { randomUUID } from 'node:crypto';

import { PluginSettingsAdministrationActionOutputV1Schema } from '@happier-dev/protocol/plugins/settingsAdministration';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { ActionExecuteResult, ActionSpec, PluginSettingsAdministrationActionIdV1, PluginSettingsAdministrationActionOutputV1, PluginSettingsAdministrationDaemonTargetV1 } from '@happier-dev/protocol';
import { renderHelpPage } from '@happier-dev/cli-common/output';

import {
  compileActionCliFieldsFromJsonSchema,
  type ActionCliField,
} from '@/cli/actions/compiledCommands';
import {
  composeActionCliInput,
  parseActionCliInput,
  stripCliOwnedFlags,
  type ActionCliParseTarget,
} from '@/cli/actions/parseCommandInput';
import { argvBeforeOptionTerminator } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope, wantsJson, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { resolveInvokerName } from '@/cli/runtime/resolveInvokerName';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
  type NormalizedCliActionExecuteResult,
} from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import {
  resolvePluginInvocationLogTarget,
  type PluginInvocationLogTargetResolution,
} from './pluginInvocationLogsMachine';
import type { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

type Executor = Pick<ReturnType<typeof createCliActionExecutorFromCredentials>, 'execute'>;
type ExecutorParams = Parameters<typeof createCliActionExecutorFromCredentials>[0];
import { errorFrame } from '@happier-dev/cli-common/output';

export type PluginsSettingsCommandDeps = Readonly<{
  readCredentialsFn?: () => Promise<StoredCredentials | null>;
  createExecutorFn?: (params: ExecutorParams) => Executor | Promise<Executor>;
  resolvePluginInvocationLogTarget?: (params: Readonly<{
    requestedMachineId?: string;
    signal?: AbortSignal;
  }>) => Promise<PluginInvocationLogTargetResolution>;
}>;

export type PluginsSettingsCommandRuntime = Readonly<{
  signal?: AbortSignal;
}>;

const DEFAULT_EXECUTION_DEPS = {
  readCredentialsFn: readStoredCredentials,
  createExecutorFn: async (params: ExecutorParams) => (
    await import('@/session/actions/createCliActionExecutorFromCredentials')
  ).createCliActionExecutorFromCredentials(params),
} as const;

export function pluginSettingsHelpRows(pluginCommand: string): readonly Readonly<{
  label: string;
  description: string;
}>[] {
  return Object.freeze([
    { label: `${pluginCommand} settings list <pluginId> --scope <account|daemon> [--machine <id>] [--json]`, description: 'List declared Plugin Settings from one exact Account or daemon scope' },
    { label: `${pluginCommand} settings get <pluginId> <localId> --scope <account|daemon> [--machine <id>] [--json]`, description: 'Read one declared non-secret Plugin Setting' },
    { label: `${pluginCommand} settings set <pluginId> <localId> --scope <account|daemon> --value <json> [--expected-revision <revision>] [--machine <id>] [--json]`, description: 'Compare-and-set one declared non-secret Plugin Setting' },
    { label: `${pluginCommand} settings reset <pluginId> <localId> --scope <account|daemon> [--expected-revision <revision>] [--machine <id>] [--json]`, description: 'Reset one declared non-secret Plugin Setting to its default' },
    { label: `${pluginCommand} settings secret status <pluginId> <localId> [--scope <account|daemon>] [--machine <id>] [--json]`, description: 'Read safe configured status for one declared Plugin secret' },
    { label: `${pluginCommand} settings secret bind <pluginId> <localId> --saved-secret-id <id> [--scope <account|daemon>] [--expected-revision <revision>] [--json]`, description: 'Bind an Account-custodied Plugin secret to an existing Saved Secret' },
    { label: `${pluginCommand} settings secret unbind <pluginId> <localId> [--scope <account|daemon>] [--expected-revision <revision>] [--json]`, description: 'Remove an Account-custodied Plugin secret binding' },
    { label: `${pluginCommand} settings secret delete <pluginId> <localId> [--scope <account|daemon>] [--machine <id>] [--expected-revision <revision>] [--json]`, description: 'Delete a declared Plugin secret through its existing custody owner' },
  ]);
}

function renderPluginSettingsHelp(): string {
  const pluginCommand = `${resolveInvokerName() ?? 'happier'} plugins`;
  return renderHelpPage({
    title: `${pluginCommand} settings`,
    subtitle: 'Read and update declared Plugin Settings through canonical Actions',
    usage: [...pluginSettingsHelpRows(pluginCommand)],
    notes: [
      'Daemon Settings require one exact --machine target.',
      'Secret commands never accept raw secret material.',
    ],
  });
}

class PluginSettingsCommandInputError extends Error {
  constructor(
    readonly actionId: PluginSettingsAdministrationActionIdV1,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginSettingsCommandInputError';
  }
}

/**
 * The exact `{serverIdentityId, machineId}` daemon target needs the existing
 * asynchronous Machine resolver, which the intentionally pure/synchronous
 * `ActionSpec.cli.bindInput` contract may never run. These canonical fields are
 * therefore workflow-owned in this adapter: no argv flag supplies them (their
 * compiled `--…-json` spellings stay rejected), the resolver runs here, and the
 * resolved values are handed to the shared binder after resolution.
 */
const WORKFLOW_TARGET_FIELD_PATHS: ReadonlySet<string> = new Set(['scope', 'target', 'secretDaemonTarget']);

/**
 * The established caller spelling of the JSON `value` field, declared to the
 * shared compiler through its alias parameter rather than a local parser.
 */
const SETTINGS_FIELD_FLAG_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['value', Object.freeze(['--value'])],
]);

/** Workflow-only target-selection options; they never become Action input. */
const WORKFLOW_VALUE_FLAGS: readonly string[] = Object.freeze(['--scope', '--machine']);

type SettingsCommandShape = ActionCliParseTarget & Readonly<{
  actionId: PluginSettingsAdministrationActionIdV1;
  spec: ActionSpec;
}>;

const SECRET_SETTING_COMMANDS = ['status', 'bind', 'unbind', 'delete'] as const;

type SecretSettingCommand = typeof SECRET_SETTING_COMMANDS[number];

function isSecretSettingCommand(value: string | undefined): value is SecretSettingCommand {
  return (SECRET_SETTING_COMMANDS as readonly string[]).includes(value ?? '');
}

function settingsActionIdForCommand(
  command: string,
  secretCommand: SecretSettingCommand | null,
): PluginSettingsAdministrationActionIdV1 | null {
  if (secretCommand) return `plugins.settings.secret.${secretCommand}`;
  switch (command) {
    case 'list': return 'plugins.settings.list';
    case 'get': return 'plugins.settings.get';
    case 'set': return 'plugins.settings.set';
    case 'reset': return 'plugins.settings.reset';
    default: return null;
  }
}

function compileSettingsCommand(
  actionId: PluginSettingsAdministrationActionIdV1,
  positionalPaths: readonly string[],
): SettingsCommandShape {
  const spec = getActionSpec(actionId);
  const fields = compileActionCliFieldsFromJsonSchema({
    jsonSchema: zodSchemaToJsonSchemaObject(spec.inputSchema),
    hints: spec.inputHints,
    aliasesByPath: SETTINGS_FIELD_FLAG_ALIASES,
  }).filter((field) => !WORKFLOW_TARGET_FIELD_PATHS.has(field.path));
  const fieldsByPath = new Map(fields.map((field) => [field.path, field]));
  const positionals = positionalPaths.map((path): ActionCliField => {
    const field = fieldsByPath.get(path);
    if (!field) {
      throw new Error(`Plugin Settings positional ${path} is not a compiled field of ${actionId}.`);
    }
    return field;
  });
  return Object.freeze({
    actionId,
    spec,
    fields: Object.freeze(fields),
    positionals: Object.freeze(positionals),
  });
}

let settingsCommandShapesCache: ReadonlyMap<string, SettingsCommandShape> | null = null;

/** One compiled shape per settings command, derived from the canonical Action specs. */
function settingsCommandShapes(): ReadonlyMap<string, SettingsCommandShape> {
  settingsCommandShapesCache ??= new Map(Object.entries({
    'list': compileSettingsCommand('plugins.settings.list', ['pluginId']),
    'get': compileSettingsCommand('plugins.settings.get', ['pluginId', 'localId']),
    'set': compileSettingsCommand('plugins.settings.set', ['pluginId', 'localId']),
    'reset': compileSettingsCommand('plugins.settings.reset', ['pluginId', 'localId']),
    'secret status': compileSettingsCommand('plugins.settings.secret.status', ['pluginId', 'localId']),
    'secret bind': compileSettingsCommand('plugins.settings.secret.bind', ['pluginId', 'localId']),
    'secret unbind': compileSettingsCommand('plugins.settings.secret.unbind', ['pluginId', 'localId']),
    'secret delete': compileSettingsCommand('plugins.settings.secret.delete', ['pluginId', 'localId']),
  }));
  return settingsCommandShapesCache;
}

/**
 * Reads one workflow-only target-selection option. Action fields are never read
 * here: from the compiled shape down, they belong to the shared parser.
 */
function readWorkflowFlagValue(
  args: readonly string[],
  actionId: PluginSettingsAdministrationActionIdV1,
  flag: '--scope' | '--machine',
): string | null {
  const exactIndexes = args.flatMap((value, index) => value === flag ? [index] : []);
  const inlineValues = args.flatMap((value) => value.startsWith(`${flag}=`) ? [value.slice(flag.length + 1)] : []);
  if (exactIndexes.length + inlineValues.length > 1) {
    throw new PluginSettingsCommandInputError(actionId, 'invalid_arguments', `${flag} may be supplied only once.`);
  }
  if (exactIndexes.length === 0 && inlineValues.length === 0) return null;
  const raw = exactIndexes.length === 1 ? args[exactIndexes[0]! + 1] : inlineValues[0]!;
  if (typeof raw !== 'string' || !raw.trim() || raw.startsWith('--')) {
    throw new PluginSettingsCommandInputError(actionId, 'invalid_arguments', `${flag} requires a value.`);
  }
  return raw.trim();
}

function requireScope(
  scope: 'account' | 'daemon' | null,
  actionId: PluginSettingsAdministrationActionIdV1,
): 'account' | 'daemon' {
  if (scope) return scope;
  throw new PluginSettingsCommandInputError(
    actionId,
    'scope_required',
    'Select one Settings scope with --scope <account|daemon>.',
  );
}

async function resolveDaemonTarget(params: Readonly<{
  actionId: PluginSettingsAdministrationActionIdV1;
  machineId: string | null;
  resolveTarget: NonNullable<PluginsSettingsCommandDeps['resolvePluginInvocationLogTarget']>;
  signal?: AbortSignal;
}>): Promise<PluginSettingsAdministrationDaemonTargetV1> {
  if (!params.machineId) {
    throw new PluginSettingsCommandInputError(
      params.actionId,
      'machine_selection_required',
      'Daemon Settings require one exact current machine: --machine <id>.',
    );
  }
  params.signal?.throwIfAborted();
  const resolution = await params.resolveTarget({
    requestedMachineId: params.machineId,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();
  if (resolution.kind === 'selected') {
    return Object.freeze({
      kind: 'daemon',
      serverIdentityId: resolution.target.serverIdentityId,
      machineId: resolution.target.machineId,
    });
  }
  if (resolution.kind === 'selection_required') {
    throw new PluginSettingsCommandInputError(
      params.actionId,
      'machine_selection_required',
      'Daemon Settings require one exact current machine: --machine <id>.',
    );
  }
  throw new PluginSettingsCommandInputError(params.actionId, resolution.code, resolution.message);
}

async function targetForScope(params: Readonly<{
  actionId: PluginSettingsAdministrationActionIdV1;
  scope: 'account' | 'daemon';
  machineId: string | null;
  resolveTarget: NonNullable<PluginsSettingsCommandDeps['resolvePluginInvocationLogTarget']>;
  signal?: AbortSignal;
}>): Promise<PluginSettingsAdministrationDaemonTargetV1 | { kind: 'account' }> {
  if (params.scope === 'account') return Object.freeze({ kind: 'account' as const });
  return await resolveDaemonTarget({
    actionId: params.actionId,
    machineId: params.machineId,
    resolveTarget: params.resolveTarget,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

function actionFailure(
  kind: PluginSettingsAdministrationActionIdV1,
  code: string,
  message: string,
): PluginSettingsAdministrationActionOutputV1 {
  return {
    ok: false,
    kind,
    errorCode: code,
    error: message,
  };
}

async function executeThroughCanonicalActionExecutor(params: Readonly<{
  actionId: PluginSettingsAdministrationActionIdV1;
  input: unknown;
  deps: PluginsSettingsCommandDeps;
  signal?: AbortSignal;
}>): Promise<NormalizedCliActionExecuteResult> {
  params.signal?.throwIfAborted();
  const readCredentialsFn = params.deps.readCredentialsFn ?? DEFAULT_EXECUTION_DEPS.readCredentialsFn;
  const credentials = await readCredentialsFn();
  params.signal?.throwIfAborted();
  if (!credentials) {
    return {
      ok: false,
      errorCode: 'not_authenticated',
      errorMessage: 'Sign in before administering Plugin Settings.',
    };
  }

  const createExecutorFn = params.deps.createExecutorFn ?? DEFAULT_EXECUTION_DEPS.createExecutorFn;
  const executor = await createExecutorFn({ credentials });
  params.signal?.throwIfAborted();
  const actionResult: ActionExecuteResult = await executor.execute(params.actionId, params.input, {
    surface: 'cli',
    defaultSessionId: null,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();

  return normalizeActionExecuteResult(actionResult);
}

async function printOutcome(args: readonly string[], outcome: PluginSettingsAdministrationActionOutputV1): Promise<void> {
  if (wantsJson(args)) {
    if (outcome.ok) {
      await printJsonEnvelope({ ok: true, kind: outcome.kind, data: outcome.data ?? null });
      return;
    }
    await printJsonEnvelope({
      ok: false,
      kind: outcome.kind,
      error: {
        code: outcome.errorCode ?? 'plugin_settings_unavailable',
        message: outcome.error ?? 'Plugin Settings administration is unavailable.',
      },
    }, { exitCode: 1 });
    return;
  }
  if (!outcome.ok) {
    console.error(errorFrame(outcome.error ?? 'Plugin Settings administration is unavailable.'));
    process.exitCode = 1;
    return;
  }
  await writeJsonStdout(outcome.data ?? {}, { pretty: true });
}

async function parseSettingsInvocation(params: Readonly<{
  args: readonly string[];
  resolveTarget: NonNullable<PluginsSettingsCommandDeps['resolvePluginInvocationLogTarget']>;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  actionId: PluginSettingsAdministrationActionIdV1;
  input: Readonly<Record<string, unknown>>;
}>> {
  const args = params.args;
  const command = args[0];
  if (!command) {
    throw new PluginSettingsCommandInputError('plugins.settings.list', 'invalid_arguments', 'Select a Plugin Settings command.');
  }

  // Command-word dispatch stays workflow-owned; the selected canonical Action
  // owns every remaining Action field through the shared compiled parser below.
  const secretCommand = command === 'secret' && isSecretSettingCommand(args[1]) ? args[1] : null;
  if (command === 'secret' && !secretCommand) {
    throw new PluginSettingsCommandInputError(
      'plugins.settings.secret.status',
      'invalid_arguments',
      `Unknown Plugin Settings secret command: ${args[1] ?? ''}`,
    );
  }
  const actionId = settingsActionIdForCommand(command, secretCommand);
  if (!actionId) {
    throw new PluginSettingsCommandInputError('plugins.settings.list', 'invalid_arguments', `Unknown Plugin Settings command: ${command}`);
  }
  const shape = settingsCommandShapes().get(secretCommand ? `secret ${secretCommand}` : command);
  if (!shape) throw new Error(`Uncompiled Plugin Settings command: ${secretCommand ? `secret ${secretCommand}` : command}`);

  // Workflow-only target selection stays visibly separate from Action fields.
  // Option scanning stops at the first `--`, exactly like the shared parser.
  const optionArgs = argvBeforeOptionTerminator(args);
  const scopeValue = readWorkflowFlagValue(optionArgs, actionId, '--scope');
  if (scopeValue !== null && scopeValue !== 'account' && scopeValue !== 'daemon') {
    throw new PluginSettingsCommandInputError(actionId, 'invalid_scope', '--scope must be account or daemon.');
  }
  const scope: 'account' | 'daemon' | null = scopeValue;
  const machineId = readWorkflowFlagValue(optionArgs, actionId, '--machine');

  // Unknown flags, duplicate sources, surplus positionals, inline values and
  // the JSON escape hatches are owned by the shared compiled field parser.
  const parsed = parseActionCliInput(
    shape,
    stripCliOwnedFlags(args.slice(secretCommand ? 2 : 1), { valueFlags: WORKFLOW_VALUE_FLAGS }),
  );
  if (!parsed.ok) {
    throw new PluginSettingsCommandInputError(actionId, parsed.code, parsed.message);
  }

  // Resolve the exact daemon target through the existing asynchronous resolver,
  // then hand the workflow-owned canonical fields to the shared binder.
  const overlay: Record<string, unknown> = { ...parsed.callerOverlay };
  if (command === 'secret') {
    const target = scope
      ? await targetForScope({
        actionId,
        scope,
        machineId,
        resolveTarget: params.resolveTarget,
        ...(params.signal ? { signal: params.signal } : {}),
      })
      : undefined;
    const secretDaemonTarget = scope !== 'daemon' && machineId
      ? await resolveDaemonTarget({
        actionId,
        machineId,
        resolveTarget: params.resolveTarget,
        ...(params.signal ? { signal: params.signal } : {}),
      })
      : undefined;
    if (scope) overlay.scope = { kind: scope };
    if (target) overlay.target = target;
    if (secretDaemonTarget) overlay.secretDaemonTarget = secretDaemonTarget;
  } else {
    const selectedScope = requireScope(scope, actionId);
    overlay.scope = { kind: selectedScope };
    overlay.target = await targetForScope({
      actionId,
      scope: selectedScope,
      machineId,
      resolveTarget: params.resolveTarget,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  }

  // The shared binder validates the friendly overlay and the whole-input JSON
  // escape hatch and composes one canonical input; no local validation remains.
  const composed = composeActionCliInput({
    parsed: { ok: true, canonicalBase: parsed.canonicalBase, callerOverlay: overlay },
    canonicalSchema: shape.spec.inputSchema,
    callerSchema: shape.spec.inputSchema,
    context: {
      actionId,
      invocationId: randomUUID(),
      output: wantsJson(args) ? 'json' : 'human',
    },
  });
  if (!composed.ok) {
    throw new PluginSettingsCommandInputError(actionId, composed.code, composed.message);
  }
  return { actionId, input: composed.input };
}

export async function handlePluginsSettingsCommand(
  args: readonly string[],
  deps: PluginsSettingsCommandDeps = {},
  runtime: PluginsSettingsCommandRuntime = {},
): Promise<void> {
  if (runtime.signal?.aborted) return;
  if (
    args.length === 0
    || args[0] === 'help'
    || args.includes('--help')
    || args.includes('-h')
  ) {
    const help = renderPluginSettingsHelp();
    if (wantsJson(args)) {
      await printJsonEnvelope({ ok: true, kind: 'plugins.settings', data: { help } });
      return;
    }
    console.log(help);
    return;
  }
  const resolveTarget = deps.resolvePluginInvocationLogTarget ?? resolvePluginInvocationLogTarget;
  let invocation: Awaited<ReturnType<typeof parseSettingsInvocation>>;
  try {
    invocation = await parseSettingsInvocation({
      args,
      resolveTarget,
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    });
  } catch (error) {
    if (runtime.signal?.aborted) return;
    if (error instanceof PluginSettingsCommandInputError) {
      await printOutcome(args, actionFailure(error.actionId, error.code, error.message));
      return;
    }
    await printOutcome(args, actionFailure('plugins.settings.list', 'plugin_settings_unavailable', 'Plugin Settings target resolution is unavailable.'));
    return;
  }
  if (runtime.signal?.aborted) return;
  let outcome: PluginSettingsAdministrationActionOutputV1;
  try {
    const result = await executeThroughCanonicalActionExecutor({
      actionId: invocation.actionId,
      input: invocation.input,
      deps,
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    });
    if (!result.ok) {
      outcome = actionFailure(
        invocation.actionId,
        result.errorCode,
        result.errorMessage ?? 'Plugin Settings administration is unavailable.',
      );
    } else {
      const approvalPayload = unwrapCliActionSuccessPayload(result.data);
      if (await tryHandleApprovalRequestCreated({
        envelopeKind: invocation.actionId,
        json: wantsJson(args),
        result: approvalPayload,
      })) return;
      const parsedOutput = PluginSettingsAdministrationActionOutputV1Schema.safeParse(result.data);
      outcome = parsedOutput.success
        ? parsedOutput.data
        : actionFailure(
          invocation.actionId,
          'plugin_settings_unavailable',
          'Plugin Settings administration returned an invalid result.',
        );
    }
  } catch {
    if (runtime.signal?.aborted) return;
    outcome = actionFailure(invocation.actionId, 'plugin_settings_unavailable', 'Plugin Settings administration is unavailable.');
  }
  if (runtime.signal?.aborted) return;
  await printOutcome(args, outcome);
}

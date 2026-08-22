import type {
  PluginSettingsAdministrationActionIdV1,
  PluginSettingsAdministrationActionOutputV1,
  PluginSettingsAdministrationDaemonTargetV1,
} from '@happier-dev/protocol';

import { printJsonEnvelope, wantsJson, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import {
  resolvePluginInvocationLogTarget,
  type PluginInvocationLogTargetResolution,
} from './pluginInvocationLogsMachine';
import {
  executePluginSettingsAdministrationAction,
  type ExecutePluginSettingsAdministrationAction,
} from '@/plugins/settings/administration';

export type PluginsSettingsCommandDeps = Readonly<{
  executeSettingsAdministrationAction?: ExecutePluginSettingsAdministrationAction;
  resolvePluginInvocationLogTarget?: (params: Readonly<{
    requestedMachineId?: string;
    signal?: AbortSignal;
  }>) => Promise<PluginInvocationLogTargetResolution>;
}>;

export type PluginsSettingsCommandRuntime = Readonly<{
  signal?: AbortSignal;
}>;

class PluginSettingsCommandInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginSettingsCommandInputError';
  }
}

type ParsedFlags = Readonly<{
  json: boolean;
  scope: 'account' | 'daemon' | null;
  machineId: string | null;
  expectedRevision: string | null;
  value: string | null;
  savedSecretId: string | null;
}>;

function readFlagValue(args: readonly string[], flag: string): string | null {
  const indexes = args.flatMap((value, index) => value === flag ? [index] : []);
  if (indexes.length > 1) {
    throw new PluginSettingsCommandInputError('invalid_arguments', `${flag} may be supplied only once.`);
  }
  const index = indexes[0];
  if (index === undefined) return null;
  const value = args[index + 1];
  if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
    throw new PluginSettingsCommandInputError('invalid_arguments', `${flag} requires a value.`);
  }
  return value.trim();
}

function parseFlags(args: readonly string[]): ParsedFlags {
  const allowedValueFlags = new Set([
    '--scope',
    '--machine',
    '--expected-revision',
    '--value',
    '--saved-secret-id',
  ]);
  const allowedFlags = new Set([...allowedValueFlags, '--json']);
  for (const value of args) {
    if (value.startsWith('--') && !allowedFlags.has(value)) {
      throw new PluginSettingsCommandInputError('invalid_arguments', `Unknown Settings option: ${value}`);
    }
  }
  const scopeValue = readFlagValue(args, '--scope');
  if (scopeValue !== null && scopeValue !== 'account' && scopeValue !== 'daemon') {
    throw new PluginSettingsCommandInputError('invalid_scope', '--scope must be account or daemon.');
  }
  return Object.freeze({
    json: args.includes('--json'),
    scope: scopeValue,
    machineId: readFlagValue(args, '--machine'),
    expectedRevision: readFlagValue(args, '--expected-revision'),
    value: readFlagValue(args, '--value'),
    savedSecretId: readFlagValue(args, '--saved-secret-id'),
  });
}

function positionalArgs(args: readonly string[]): readonly string[] {
  const valueFlags = new Set([
    '--scope',
    '--machine',
    '--expected-revision',
    '--value',
    '--saved-secret-id',
  ]);
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === '--json') continue;
    if (valueFlags.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith('--')) positional.push(value);
  }
  return Object.freeze(positional);
}

function requireScope(flags: ParsedFlags): 'account' | 'daemon' {
  if (flags.scope) return flags.scope;
  throw new PluginSettingsCommandInputError(
    'scope_required',
    'Select one Settings scope with --scope <account|daemon>.',
  );
}

async function resolveDaemonTarget(params: Readonly<{
  machineId: string | null;
  resolveTarget: NonNullable<PluginsSettingsCommandDeps['resolvePluginInvocationLogTarget']>;
  signal?: AbortSignal;
}>): Promise<PluginSettingsAdministrationDaemonTargetV1> {
  if (!params.machineId) {
    throw new PluginSettingsCommandInputError(
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
      'machine_selection_required',
      'Daemon Settings require one exact current machine: --machine <id>.',
    );
  }
  throw new PluginSettingsCommandInputError(resolution.code, resolution.message);
}

async function targetForScope(params: Readonly<{
  scope: 'account' | 'daemon';
  flags: ParsedFlags;
  resolveTarget: NonNullable<PluginsSettingsCommandDeps['resolvePluginInvocationLogTarget']>;
  signal?: AbortSignal;
}>) {
  if (params.scope === 'account') return Object.freeze({ kind: 'account' as const });
  return await resolveDaemonTarget({
    machineId: params.flags.machineId,
    resolveTarget: params.resolveTarget,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

function expectedRevision(flags: ParsedFlags): Readonly<Record<string, string>> {
  return flags.expectedRevision === null ? {} : { expectedRevision: flags.expectedRevision };
}

function actionFailure(
  kind: string,
  code: string,
  message: string,
): PluginSettingsAdministrationActionOutputV1 {
  return {
    ok: false,
    kind: kind as PluginSettingsAdministrationActionIdV1,
    errorCode: code,
    error: message,
  };
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
    console.error(`Error: ${outcome.error ?? 'Plugin Settings administration is unavailable.'}`);
    process.exitCode = 1;
    return;
  }
  await writeJsonStdout(outcome.data ?? {}, { pretty: true });
}

function parseJsonValue(raw: string | null): unknown {
  if (raw === null) {
    throw new PluginSettingsCommandInputError('value_required', 'Setting a value requires --value <JSON>.');
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new PluginSettingsCommandInputError('invalid_json', '--value must be valid JSON.');
  }
}

function requirePositionals(
  positional: readonly string[],
  expected: number,
  usage: string,
): void {
  if (positional.length === expected && positional.every((value) => value.trim().length > 0)) return;
  throw new PluginSettingsCommandInputError('invalid_arguments', usage);
}

async function parseSettingsAction(params: Readonly<{
  args: readonly string[];
  flags: ParsedFlags;
  resolveTarget: NonNullable<PluginsSettingsCommandDeps['resolvePluginInvocationLogTarget']>;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  actionId: PluginSettingsAdministrationActionIdV1;
  input: unknown;
}>> {
  const positional = positionalArgs(params.args);
  const command = positional[0];
  if (!command) {
    throw new PluginSettingsCommandInputError('invalid_arguments', 'Select a Plugin Settings command.');
  }

  if (command === 'list') {
    requirePositionals(positional, 2, 'Usage: happier plugins settings list <pluginId> --scope <account|daemon>.');
    const scope = requireScope(params.flags);
    if (params.flags.value || params.flags.savedSecretId || params.flags.expectedRevision) {
      throw new PluginSettingsCommandInputError('invalid_arguments', 'list accepts only target-selection options.');
    }
    return {
      actionId: 'plugins.settings.list',
      input: {
        pluginId: positional[1],
        scope: { kind: scope },
        target: await targetForScope({ scope, flags: params.flags, resolveTarget: params.resolveTarget, signal: params.signal }),
      },
    };
  }

  if (command === 'get' || command === 'set' || command === 'reset') {
    requirePositionals(positional, 3, `Usage: happier plugins settings ${command} <pluginId> <localId> --scope <account|daemon>.`);
    const scope = requireScope(params.flags);
    if (params.flags.savedSecretId) {
      throw new PluginSettingsCommandInputError('invalid_arguments', '--saved-secret-id is only valid for secret bind.');
    }
    if (command !== 'set' && params.flags.value !== null) {
      throw new PluginSettingsCommandInputError('invalid_arguments', '--value is only valid for settings set.');
    }
    if (command === 'get' && params.flags.expectedRevision !== null) {
      throw new PluginSettingsCommandInputError('invalid_arguments', '--expected-revision is only valid for mutations.');
    }
    const base = {
      pluginId: positional[1],
      scope: { kind: scope },
      target: await targetForScope({ scope, flags: params.flags, resolveTarget: params.resolveTarget, signal: params.signal }),
      localId: positional[2],
    };
    if (command === 'get') return { actionId: 'plugins.settings.get', input: base };
    if (command === 'set') {
      return {
        actionId: 'plugins.settings.set',
        input: { ...base, value: parseJsonValue(params.flags.value), ...expectedRevision(params.flags) },
      };
    }
    return {
      actionId: 'plugins.settings.reset',
      input: { ...base, ...expectedRevision(params.flags) },
    };
  }

  if (command !== 'secret') {
    throw new PluginSettingsCommandInputError('invalid_arguments', `Unknown Plugin Settings command: ${command}`);
  }

  const secretCommand = positional[1];
  requirePositionals(
    positional,
    4,
    'Usage: happier plugins settings secret status|bind|unbind|delete <pluginId> <localId> [--scope <account|daemon>] [--machine <id>].',
  );
  if (!['status', 'bind', 'unbind', 'delete'].includes(secretCommand ?? '')) {
    throw new PluginSettingsCommandInputError('invalid_arguments', `Unknown Plugin Settings secret command: ${secretCommand ?? ''}`);
  }
  if (params.flags.value !== null) {
    throw new PluginSettingsCommandInputError(
      'secret_material_not_accepted',
      'Secret material cannot be supplied to Plugin Settings administration.',
    );
  }
  if (secretCommand !== 'bind' && params.flags.savedSecretId !== null) {
    throw new PluginSettingsCommandInputError('invalid_arguments', '--saved-secret-id is only valid for secret bind.');
  }
  if (secretCommand === 'bind' && params.flags.savedSecretId === null) {
    throw new PluginSettingsCommandInputError('saved_secret_id_required', 'secret bind requires --saved-secret-id <id>.');
  }
  if (secretCommand === 'status' && params.flags.expectedRevision !== null) {
    throw new PluginSettingsCommandInputError('invalid_arguments', '--expected-revision is only valid for secret mutations.');
  }

  const scope = params.flags.scope;
  const target = scope
    ? await targetForScope({ scope, flags: params.flags, resolveTarget: params.resolveTarget, signal: params.signal })
    : undefined;
  const secretDaemonTarget = scope !== 'daemon' && params.flags.machineId
    ? await resolveDaemonTarget({
      machineId: params.flags.machineId,
      resolveTarget: params.resolveTarget,
      ...(params.signal ? { signal: params.signal } : {}),
    })
    : undefined;
  const base = {
    pluginId: positional[2],
    localId: positional[3],
    ...(scope ? { scope: { kind: scope } } : {}),
    ...(target ? { target } : {}),
    ...(secretDaemonTarget ? { secretDaemonTarget } : {}),
    ...expectedRevision(params.flags),
  };
  if (secretCommand === 'status') return { actionId: 'plugins.settings.secret.status', input: base };
  if (secretCommand === 'bind') {
    return {
      actionId: 'plugins.settings.secret.bind',
      input: { ...base, savedSecretId: params.flags.savedSecretId! },
    };
  }
  return {
    actionId: secretCommand === 'unbind'
      ? 'plugins.settings.secret.unbind'
      : 'plugins.settings.secret.delete',
    input: base,
  };
}

export async function handlePluginsSettingsCommand(
  args: readonly string[],
  deps: PluginsSettingsCommandDeps = {},
  runtime: PluginsSettingsCommandRuntime = {},
): Promise<void> {
  if (runtime.signal?.aborted) return;
  const flags = parseFlags(args);
  const resolveTarget = deps.resolvePluginInvocationLogTarget ?? resolvePluginInvocationLogTarget;
  let parsed: Awaited<ReturnType<typeof parseSettingsAction>>;
  try {
    parsed = await parseSettingsAction({
      args,
      flags,
      resolveTarget,
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    });
  } catch (error) {
    if (runtime.signal?.aborted) return;
    if (error instanceof PluginSettingsCommandInputError) {
      await printOutcome(args, actionFailure('plugins.settings.list', error.code, error.message));
      return;
    }
    await printOutcome(args, actionFailure('plugins.settings.list', 'plugin_settings_unavailable', 'Plugin Settings target resolution is unavailable.'));
    return;
  }
  if (runtime.signal?.aborted) return;
  const execute = deps.executeSettingsAdministrationAction ?? executePluginSettingsAdministrationAction;
  let outcome: PluginSettingsAdministrationActionOutputV1;
  try {
    outcome = await execute({
      actionId: parsed.actionId,
      input: parsed.input,
      signal: runtime.signal,
    });
  } catch {
    if (runtime.signal?.aborted) return;
    outcome = actionFailure(parsed.actionId, 'plugin_settings_unavailable', 'Plugin Settings administration is unavailable.');
  }
  if (runtime.signal?.aborted) return;
  await printOutcome(args, outcome);
}

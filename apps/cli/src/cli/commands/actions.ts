import { randomUUID } from 'node:crypto';
import { definitionList, fail, renderHelpPage, sectionTitle } from '@happier-dev/cli-common/output';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { actionSpecToActionDefinitionV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ExternalActionRequestIdV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { getActionSpec, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ActionDefinitionV1, ActionExecuteFailure, ActionExecuteResult, SignedRootActionId } from '@happier-dev/protocol';
import { FilesystemUploadInputSchema, FilesystemDownloadInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createCredentialedFilesystemTransferClient } from '@/machines/transfer/createCredentialedFilesystemTransferClient';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

import {
  compileActionCliFields,
  compileActionCliFieldsFromJsonSchema,
  findCompiledActionCliCommand,
  listCompiledActionCliCommands,
} from '@/cli/actions/compiledCommands';
import {
  buildActionCliCommandUsageLine,
  buildActionCliInvokeHelpModel,
  renderActionCliHelpModel,
} from '@/cli/actions/commandHelp';
import {
  runCompiledActionCliCommand,
  confirmCliRequesterCredentialDisclosure,
  type ActionCliExecutionDeps,
} from '@/cli/actions/executeCommand';
import {
  ACTION_CLI_HELP_FLAGS,
  ACTION_CLI_JSON_OUTPUT_FLAG,
  ACTION_CLI_MACHINE_ID_FLAG,
  ACTION_CLI_REQUEST_ID_FLAG,
  ACTION_CLI_WHOLE_INPUT_FLAG,
  describeActionCliCommandFlags,
  composeActionCliInput,
  parseActionCliInput,
  stripCliOwnedFlags,
} from '@/cli/actions/parseCommandInput';
import type { CommandContext } from '@/cli/commandRegistry';
import { assertCommandArguments, argvBeforeOptionTerminator, readFlagValue, readRawFlagValue } from '@/cli/commands/shared/argvFlags';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { printJsonEnvelope, wantsJson, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { readStoredCredentials, readStoredCredentialsForServerId } from '@/persistence';
import { getServerProfile } from '@/server/serverProfiles';
import { createServerUrlServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import {
  ACTION_CLI_SERVER_ID_FLAG,
  readActionCliServerId,
  resolveActionCliCredentialTarget,
} from '@/cli/actions/actionServerTarget';

const ACTION_CLI_PROJECT_DIRECTORY_FLAG = '--project-directory' as const;
const ACTION_CLI_WORKSPACE_REF_ID_FLAG = '--workspace-ref-id' as const;
const ACTION_CLI_SOURCE_PATH_FLAG = '--source-path' as const;
const ACTION_CLI_DESTINATION_PATH_FLAG = '--destination-path' as const;
const INVOKE_USAGE = 'Usage: happier actions invoke <action-id> [--<field> <value>...] [--input-json <json>] [--request-id <id>] [--server-id <id>] [--machine-id <id>] [--project-directory <path>] [--workspace-ref-id <id>] [--json]';

/** CLI-owned transport flags; they never become Action input. */
const INVOKE_TRANSPORT_VALUE_FLAGS = [
  ACTION_CLI_MACHINE_ID_FLAG,
  ACTION_CLI_REQUEST_ID_FLAG,
  ACTION_CLI_SERVER_ID_FLAG,
  ACTION_CLI_PROJECT_DIRECTORY_FLAG,
  ACTION_CLI_WORKSPACE_REF_ID_FLAG,
  ACTION_CLI_SOURCE_PATH_FLAG,
  ACTION_CLI_DESTINATION_PATH_FLAG,
] as const;

type ActionsDeps = ActionCliExecutionDeps;
type ActionCommandError = Error & Readonly<{
  actionFailure?: boolean;
  expectedFailure?: boolean;
  code?: unknown;
  candidates?: unknown;
  details?: unknown;
}>;
const DEFAULT_DEPS: ActionsDeps = {
  readCredentialsFn: readStoredCredentials,
  readCredentialsForServerIdFn: readStoredCredentialsForServerId,
  getServerProfileFn: getServerProfile,
  createServerFeaturesSnapshotStoreFn: createServerUrlServerFeaturesSnapshotStore,
  createExecutorFn: async (params) => (
    await import('@/session/actions/createCliActionExecutorFromCredentials')
  ).createCliActionExecutorFromCredentials(params),
};

function showHelp(): void {
  const discoveryCommands = listCompiledActionCliCommands().filter((command) => (
    command.path[0] === 'actions' && command.visibility !== 'hidden'
  ));
  console.log(renderHelpPage({
    title: 'happier actions',
    subtitle: 'Discover and invoke built-in and contributed Actions',
    usage: [
      ...discoveryCommands.map((command) => ({
        label: buildActionCliCommandUsageLine(command),
        description: command.spec.title,
      })),
      { label: 'happier actions invoke <action-id> [options]', description: 'Invoke an Action' },
    ],
    sections: [
      { title: 'Options:', rows: [
        { label: '--server-id <id>', description: 'Use credentials and endpoint for an exact saved Home' },
        { label: '--machine-id <id>', description: 'Target an exact machine' },
        { label: '--project-directory <path>', description: 'Bind a Machine-local Workflow project directory' },
        { label: '--workspace-ref-id <id>', description: 'Bind the saved Workspace reference for the project' },
        { label: '--source-path <path>', description: 'Local prepared filesystem upload source (never sent as Action input)' },
        { label: '--destination-path <path>', description: 'Local prepared filesystem download destination (never sent as Action input)' },
        { label: '--<field> <value>', description: 'Ordinary Action input field for invoke' },
        { label: '--<field>-json <json>', description: 'One nested Action input field for invoke' },
        { label: '--input-json <json>', description: 'Whole Action input for invoke' },
        { label: '--request-id <id>', description: 'Request correlation identifier' },
        { label: '--limit <n>', description: 'Bound search results' },
        { label: ACTION_CLI_JSON_OUTPUT_FLAG, description: 'Stable JSON envelope' },
      ] },
    ],
    notes: ['Use a query and --limit for a concise catalog search.', 'Contributed IDs use <pluginId>/actions/<localId>.', 'Authentication may come from happier auth login or HAPPIER_TOKEN.'],
  }));
}

function invalidInvokeArguments(message: string): never {
  throw Object.assign(new Error(`${message}\n${INVOKE_USAGE}`), { code: 'invalid_arguments' });
}

function hasInvokeOption(args: readonly string[], ...flags: readonly string[]): boolean {
  for (const token of args) {
    if (token === '--') return false;
    if (flags.includes(token)) return true;
  }
  return false;
}

type InvokeCompiledFields =
  | Readonly<{
      kind: 'local';
      fields: ReturnType<typeof compileActionCliFieldsFromJsonSchema>;
      actionId: SignedRootActionId;
      spec: ReturnType<typeof getActionSpec>;
      callerSchema: ReturnType<typeof compileActionCliFields>['callerSchema'];
      wholeInputSchema: ReturnType<typeof compileActionCliFields>['wholeInputSchema'];
      bindInput?: ReturnType<typeof compileActionCliFields>['bindInput'];
    }>
  | Readonly<{
      kind: 'definition';
      fields: ReturnType<typeof compileActionCliFieldsFromJsonSchema>;
    }>;

/**
 * The generic invocation reads ordinary fields of the selected Action through
 * the same compiled descriptor a friendly command uses, so an Action's flags,
 * coercion and duplicate-source rules do not depend on whether it happens to own
 * a dedicated command path. Whole-input JSON stays available for nested values.
 * A discovered contributed definition supplies only canonical data fields: it
 * never receives a host-executable input binder.
 */
function resolveInvokeActionInput(
  args: readonly string[],
  compiled: InvokeCompiledFields,
): unknown {
  const target = { fields: compiled.fields, positionals: [] as const };
  const flags = describeActionCliCommandFlags(target);
  // Unknown flags, missing values and surplus positionals fail here, before any
  // credential read or executor construction.
  assertCommandArguments(args, {
    usage: INVOKE_USAGE,
    startIndex: 1,
    booleanFlags: [ACTION_CLI_JSON_OUTPUT_FLAG, ...flags.booleanFlags],
    valueFlags: [...INVOKE_TRANSPORT_VALUE_FLAGS, ACTION_CLI_WHOLE_INPUT_FLAG, ...flags.valueFlags],
    literalValueFlags: [ACTION_CLI_SOURCE_PATH_FLAG, ACTION_CLI_DESTINATION_PATH_FLAG],
    maxPositionals: 1,
  });
  const stripped = stripCliOwnedFlags(args.slice(1), { valueFlags: [...INVOKE_TRANSPORT_VALUE_FLAGS] });
  // The exact Action id is the first positional after `invoke`. Removing that
  // exact slot, rather than searching by value, preserves a field value that
  // happens to equal the Action id.
  const tokens = stripped.slice(1);
  const parsed = parseActionCliInput(target, tokens);
  if (!parsed.ok) invalidInvokeArguments(parsed.message);
  if (compiled.kind === 'local') {
    const composed = composeActionCliInput({
      parsed,
      canonicalSchema: compiled.spec.inputSchema,
      wholeInputSchema: compiled.wholeInputSchema,
      callerSchema: compiled.callerSchema,
      bindInput: compiled.bindInput,
      context: {
        actionId: compiled.actionId,
        invocationId: randomUUID(),
        output: wantsJson(args) ? 'json' : 'human',
      },
    });
    if (!composed.ok) invalidInvokeArguments(composed.message);
    return composed.input;
  }
  // A discovered definition publishes canonical top-level data fields only and
  // has no caller binder that could rename one, so `parseActionCliInput` has
  // already refused a field supplied by both `--input-json` and a friendly
  // flag. Composition here is therefore a merge of two disjoint sources, and
  // the published schema itself stays the executor's to validate.
  return Object.freeze({ ...(parsed.canonicalBase ?? {}), ...parsed.callerOverlay });
}

function compileDiscoveredActionFields(definition: ActionDefinitionV1): InvokeCompiledFields {
  return Object.freeze({
    kind: 'definition',
    fields: compileActionCliFieldsFromJsonSchema({
      jsonSchema: definition.inputSchema,
      hints: definition.inputHints ?? undefined,
      reservedFlags: INVOKE_TRANSPORT_VALUE_FLAGS,
    }),
  });
}

export function readDiscoveredActionDefinition(
  result: ActionExecuteResult,
  expectedActionId?: string,
): ActionDefinitionV1 {
  const payload = unwrapOuterActionResult(result);
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Readonly<Record<string, unknown>>).actionSpec
    : undefined;
  const parsed = ActionDefinitionV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw Object.assign(new Error('Action discovery returned an invalid definition.'), {
      code: 'invalid_action_definition',
    });
  }
  if (expectedActionId !== undefined && parsed.data.id !== expectedActionId) {
    throw Object.assign(new Error('Action discovery returned a definition for a different Action.'), {
      code: 'invalid_action_definition',
    });
  }
  return parsed.data;
}

/** Best-effort discovery for shell completion; invocation retains typed errors. */
export async function resolveActionDefinitionForCliCompletion(
  actionId: string,
  argv: readonly string[],
  overrides: Partial<ActionsDeps> = {},
): Promise<ActionDefinitionV1 | null> {
  try {
    const deps = { ...DEFAULT_DEPS, ...overrides };
    const builtIn = SignedRootActionIdSchema.safeParse(actionId);
    if (builtIn.success) {
      return actionSpecToActionDefinitionV1(getActionSpec(builtIn.data), { surface: 'cli' });
    }
    if (!parseQualifiedPluginActionId(actionId)) return null;
    const requestedServerId = readActionCliServerId(argv, true);
    const { credentials, fixedServer, serverIdentityId } = await resolveActionCliCredentialTarget({ requestedServerId, deps });
    if (!credentials) return null;
    const executorOptions = { credentials, externalActionClient: true as const,
      ...(serverIdentityId ? { serverIdentityId } : {}) };
    const executor = await deps.createExecutorFn(fixedServer
      ? { ...executorOptions, ...fixedServer }
      : executorOptions);
    return readDiscoveredActionDefinition(
      await executor.execute(
        'action.spec.get',
        { id: actionId },
        { ...actionContext(), ...(fixedServer ? { serverId: fixedServer.serverId } : {}),
          ...(serverIdentityId ? { serverIdentityId } : {}) },
      ),
      actionId,
    );
  } catch {
    return null;
  }
}

function validateDiscoveredActionInput(definition: ActionDefinitionV1, input: unknown): void {
  let validate: ReturnType<typeof compilePluginJsonSchema>;
  try {
    validate = compilePluginJsonSchema(definition.inputSchema);
  } catch {
    throw Object.assign(new Error('The contributed Action published an invalid input schema.'), {
      code: 'invalid_action_definition',
    });
  }
  if (!isValidPluginJsonSchemaValue(validate, input)) {
    invalidInvokeArguments(`Invalid input for ${definition.id}.`);
  }
}

function renderInvokeDefinitionHelp(definition: ActionDefinitionV1, compiled: InvokeCompiledFields): void {
  console.log(renderActionCliHelpModel(buildActionCliInvokeHelpModel({
    actionId: definition.id,
    definition,
    fields: compiled.fields,
  })));
}

function renderMissingInvokeDefinitionHelp(actionId: string): void {
  console.log(renderActionCliHelpModel(buildActionCliInvokeHelpModel({
    actionId,
    fields: Object.freeze([]),
  })));
}

function emitLegacyJsonOnlyDiagnostic(actionId: string): void {
  console.error(
    `Warning: ${actionId} is using the legacy JSON-only Action adapter because this runtime cannot publish Action definitions. Use --input-json or update the runtime for field flags and generated help.`,
  );
}

function throwActionFailure(result: ActionExecuteFailure): never {
  throw Object.assign(new Error(result.error), {
    actionFailure: true,
    code: result.errorCode,
    ...(result.details !== undefined ? { details: result.details } : {}),
  });
}

function actionContext(signal?: AbortSignal) {
  return {
    surface: 'cli' as const,
    ...(signal ? { signal } : {}),
  };
}

function unwrapOuterActionResult(result: ActionExecuteResult): unknown {
  if (!result.ok) throwActionFailure(result);
  return result.result;
}

async function execute(args: string[], deps: ActionsDeps, signal?: AbortSignal): Promise<void> {
  const subcommand = args[0];
  if (
    !subcommand
    || subcommand === 'help'
    || ACTION_CLI_HELP_FLAGS.includes(subcommand as typeof ACTION_CLI_HELP_FLAGS[number])
  ) { showHelp(); return; }
  const json = wantsJson(args);
  if (subcommand !== 'invoke') throw Object.assign(new Error(`Unknown actions subcommand: ${subcommand}\n${INVOKE_USAGE}`), { code: 'unknown_subcommand' });
  const requested = args[1];
  if (!requested || requested.startsWith('-')) throw Object.assign(new Error(INVOKE_USAGE), { code: 'invalid_arguments' });

  // The invoked Action, its request identity and its input are resolved before
  // authentication so an argument defect never constructs an executor.
  const requestId = readRawFlagValue(args, ACTION_CLI_REQUEST_ID_FLAG) ?? randomUUID();
  if (!ExternalActionRequestIdV1Schema.safeParse(requestId).success) {
    throw Object.assign(new Error('Invalid --request-id.'), { code: 'invalid_arguments' });
  }
  const contributed = parseQualifiedPluginActionId(requested);
  const localInvocation = contributed
    ? null
    : (() => {
        const signedRootActionId = SignedRootActionIdSchema.safeParse(requested);
        if (!signedRootActionId.success) throw Object.assign(new Error(`Unknown Action id: ${requested}`), { code: 'invalid_arguments' });
        const spec = getActionSpec(signedRootActionId.data);
        const compiled = compileActionCliFields(spec, {
          reservedFlags: INVOKE_TRANSPORT_VALUE_FLAGS,
        });
        const invokeFields: InvokeCompiledFields = {
          kind: 'local',
          fields: compiled.fields,
          actionId: signedRootActionId.data,
          spec,
          callerSchema: compiled.callerSchema,
          wholeInputSchema: compiled.wholeInputSchema,
          bindInput: compiled.bindInput,
        };
        if (hasInvokeOption(args, ...ACTION_CLI_HELP_FLAGS)) {
          renderInvokeDefinitionHelp(
            actionSpecToActionDefinitionV1(spec, { surface: 'cli' }),
            invokeFields,
          );
          return null;
        }
        return {
          actionId: signedRootActionId.data,
          input: resolveInvokeActionInput(args, invokeFields),
          requestId,
          requiresServerId: spec.cli?.requiresServerId === true,
        };
      })();
  if (!contributed && localInvocation === null) return;

  const localPath = (flag: string) => {
    const options = argvBeforeOptionTerminator(args);
    const occurrences = options.filter(value => value === flag || value.startsWith(`${flag}=`));
    if (occurrences.length > 1) invalidInvokeArguments(`Provide ${flag} once.`);
    const value = readRawFlagValue(options, flag);
    return value === null ? null : expandHomeDirPath(value);
  };
  const sourcePath = localPath(ACTION_CLI_SOURCE_PATH_FLAG);
  const destinationPath = localPath(ACTION_CLI_DESTINATION_PATH_FLAG);
  const isUpload = localInvocation?.actionId === 'daemon.filesystem.upload';
  const isDownload = localInvocation?.actionId === 'daemon.filesystem.download';
  if (sourcePath !== null && !isUpload) invalidInvokeArguments(`${ACTION_CLI_SOURCE_PATH_FLAG} is only valid for filesystem upload.`);
  if (destinationPath !== null && !isDownload) invalidInvokeArguments(`${ACTION_CLI_DESTINATION_PATH_FLAG} is only valid for filesystem download.`);
  if (isUpload && !sourcePath) invalidInvokeArguments(`${ACTION_CLI_SOURCE_PATH_FLAG} is required for filesystem upload.`);
  if (isDownload && !destinationPath) invalidInvokeArguments(`${ACTION_CLI_DESTINATION_PATH_FLAG} is required for filesystem download.`);
  if ((isUpload || isDownload) && !readFlagValue(args, ACTION_CLI_MACHINE_ID_FLAG)) invalidInvokeArguments(`${ACTION_CLI_MACHINE_ID_FLAG} is required for filesystem transfer.`);

  const requestedServerId = readActionCliServerId(args, true);
  if ((isUpload || isDownload) && requestedServerId === null) invalidInvokeArguments(`${ACTION_CLI_SERVER_ID_FLAG} is required for filesystem transfer.`);
  if (localInvocation?.requiresServerId && requestedServerId === null) {
    throw Object.assign(
      new Error(`Option ${ACTION_CLI_SERVER_ID_FLAG} is required for this Home-scoped Action.`),
      { code: 'invalid_arguments' },
    );
  }
  const { credentials, fixedServer, serverIdentityId } = await resolveActionCliCredentialTarget({
    requestedServerId,
    requireServerIdentityId: localInvocation?.requiresServerId === true,
    deps,
  });
  if ((isUpload || isDownload) && !fixedServer) invalidInvokeArguments(`${ACTION_CLI_SERVER_ID_FLAG} is required for filesystem transfer.`);
  if (!credentials) throw Object.assign(new Error('Not authenticated. Run "happier auth login" first.'), { code: 'not_authenticated' });
  const machineId = readFlagValue(args, ACTION_CLI_MACHINE_ID_FLAG) ?? undefined;
  const projectDirectory = readFlagValue(args, ACTION_CLI_PROJECT_DIRECTORY_FLAG) ?? undefined;
  const workspaceRefId = readFlagValue(args, ACTION_CLI_WORKSPACE_REF_ID_FLAG) ?? undefined;
  if ((projectDirectory || workspaceRefId) && !machineId) {
    invalidInvokeArguments(`${ACTION_CLI_MACHINE_ID_FLAG} is required for a Workflow project target.`);
  }
  if (workspaceRefId && !projectDirectory) {
    invalidInvokeArguments(`${ACTION_CLI_PROJECT_DIRECTORY_FLAG} is required with ${ACTION_CLI_WORKSPACE_REF_ID_FLAG}.`);
  }
  const executorOptions = {
    credentials,
    ...(serverIdentityId ? { serverIdentityId } : {}),
    onRequesterSessionCredentialDisclosure: (disclosure: Parameters<typeof confirmCliRequesterCredentialDisclosure>[0]) =>
      confirmCliRequesterCredentialDisclosure(disclosure, { json, ...(signal ? { signal } : {}) }),
    readCredentials: fixedServer
      ? () => deps.readCredentialsForServerIdFn(fixedServer.serverId)
      : deps.readCredentialsFn,
    externalActionClient: true as const,
    ...(machineId ? { machineId } : {}),
  };
  const executor = await deps.createExecutorFn(fixedServer
    ? { ...executorOptions, ...fixedServer }
    : executorOptions);
  const context = { ...actionContext(signal),
    ...(fixedServer ? { serverId: fixedServer.serverId } : {}),
    ...(serverIdentityId ? { serverIdentityId } : {}) };
  let invocation: Readonly<{ actionId: SignedRootActionId; input: unknown; requestId: string }>;
  if (contributed) {
    const discovery = await executor.execute(
      'action.spec.get',
      { id: requested },
      { ...context, actionRequestId: requestId },
    );
    let compiled: InvokeCompiledFields;
    let input: unknown;
    if (!discovery.ok && discovery.errorCode === 'unsupported_action') {
      emitLegacyJsonOnlyDiagnostic(requested);
      if (hasInvokeOption(args, ...ACTION_CLI_HELP_FLAGS)) {
        renderMissingInvokeDefinitionHelp(requested);
        return;
      }
      compiled = Object.freeze({ kind: 'definition', fields: Object.freeze([]) });
      input = resolveInvokeActionInput(args, compiled);
    } else {
      const definition = readDiscoveredActionDefinition(discovery, requested);
      compiled = compileDiscoveredActionFields(definition);
      if (hasInvokeOption(args, ...ACTION_CLI_HELP_FLAGS)) {
        renderInvokeDefinitionHelp(definition, compiled);
        return;
      }
      input = resolveInvokeActionInput(args, compiled);
      validateDiscoveredActionInput(definition, input);
    }
    invocation = {
      actionId: 'action.invoke',
      input: { action: contributed, input },
      requestId,
    };
  } else {
    invocation = localInvocation!;
  }
  let resolvedInput = invocation.input;
  let defaultSessionId: string | null = null;
  if (!contributed && resolvedInput && typeof resolvedInput === 'object' && !Array.isArray(resolvedInput)) {
    const candidateSessionId = (resolvedInput as Readonly<Record<string, unknown>>).sessionId;
    if (typeof candidateSessionId === 'string') {
      const resolved = await executor.resolveSessionTarget(candidateSessionId);
      if (!resolved.ok) {
        throw Object.assign(new Error(`Could not resolve Session: ${candidateSessionId}`), {
          expectedFailure: true,
          code: resolved.code,
          candidates: resolved.candidates,
        });
      }
      defaultSessionId = resolved.sessionId;
      resolvedInput = Object.freeze({ ...resolvedInput, sessionId: resolved.sessionId });
    }
  }
  const invocationOptions = {
    ...context,
    actionRequestId: invocation.requestId,
    ...(defaultSessionId ? { defaultSessionId } : {}),
    ...(machineId ? {
      externalActionTarget: {
        kind: 'machine' as const,
        machineId,
        ...(projectDirectory ? {
          project: {
            machineId,
            directory: projectDirectory,
            ...(workspaceRefId ? { workspaceRefId } : {}),
          },
        } : {}),
      },
    } : {}),
  };
  let data: unknown;
  if ((isUpload || isDownload) && machineId && fixedServer) {
    const transfer = await createCredentialedFilesystemTransferClient({ credentials, ...fixedServer,
      executeAction: async (actionId, input, context) => await executor.execute(actionId, input, { ...invocationOptions, ...context }),
      ...(signal ? { signal } : {}),
    });
    try {
      const outcome = isUpload
        ? await transfer.client.upload({ ...FilesystemUploadInputSchema.parse(resolvedInput), sourcePath: sourcePath!, targetMachineId: machineId,
            serverId: fixedServer.serverId, ...(signal ? { signal } : {}) })
        : await transfer.client.download({ ...FilesystemDownloadInputSchema.parse(resolvedInput), destinationId: FilesystemDownloadInputSchema.parse(resolvedInput).destination.destinationId,
            destinationPath: destinationPath!, targetMachineId: machineId, serverId: fixedServer.serverId, ...(signal ? { signal } : {}) });
      data = unwrapOuterActionResult('kind' in outcome || outcome.success ? { ok: true, result: outcome }
        : { ok: false, error: outcome.error, errorCode: outcome.errorCode ?? 'filesystem_transfer_failed', details: outcome });
    } finally { await transfer.close(); }
  } else {
    data = unwrapOuterActionResult(await executor.execute(invocation.actionId, resolvedInput, invocationOptions));
  }
  if (json) await printJsonEnvelope({ ok: true, kind: 'actions_invoke', data }); else await writeJsonStdout(data, { pretty: true });
}

export async function handleActionsCommand(
  args: string[],
  deps: Partial<ActionsDeps & ActionCliExecutionDeps> = {},
  signal?: AbortSignal,
): Promise<void> {
  const subcommand = args[0];
  if (subcommand === 'search' || subcommand === 'get') {
    const command = findCompiledActionCliCommand(
      ['actions', subcommand],
      listCompiledActionCliCommands(),
    );
    if (!command) throw new Error(`Missing compiled actions ${subcommand} command.`);
    await runCompiledActionCliCommand({
      command,
      argv: ['actions', ...args],
      ...(signal ? { signal } : {}),
      deps,
    });
    return;
  }
  try { await execute(args, { ...DEFAULT_DEPS, ...deps }, signal); }
  catch (error) {
    const candidate = error instanceof Error ? error as ActionCommandError : null;
    const mapped = candidate?.actionFailure === true || candidate?.expectedFailure === true
      ? { code: String(candidate.code ?? 'action_failed'), unexpected: false, message: candidate.message }
      : mapUnknownErrorToControlError(error);
    const structured = {
      code: mapped.code,
      ...(mapped.message ? { message: mapped.message } : {}),
      ...(Array.isArray(candidate?.candidates) ? { candidates: candidate.candidates } : {}),
      ...(candidate?.actionFailure === true && candidate.details !== undefined ? { details: candidate.details } : {}),
    };
    if (wantsJson(args)) await printJsonEnvelope({ ok: false, kind: `actions_${args[0] ?? 'help'}`, error: structured }, { exitCode: mapped.unexpected ? 2 : 1 });
    else {
      console.error(fail(mapped.message ?? mapped.code));
      if ('candidates' in structured && Array.isArray(structured.candidates)) {
        console.error(`Candidates: ${structured.candidates.join(', ')}`);
      }
      if (mapped.code === 'invalid_arguments' || mapped.code === 'unknown_subcommand') showHelp();
      process.exitCode = mapped.unexpected ? 2 : 1;
    }
  }
}

export async function handleActionsCliCommand(context: CommandContext): Promise<void> {
  await handleActionsCommand(context.args.slice(1), DEFAULT_DEPS, context.signal);
}

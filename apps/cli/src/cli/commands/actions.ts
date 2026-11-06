import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { showHelp } from '../actions/discoveryHelp';
import { randomUUID } from 'node:crypto';
import type { CliApprovalRequestedHandler } from '@/session/actions/approvals/deferredResult';
import { definitionList, fail, renderHelpPage, sectionTitle } from '@happier-dev/cli-common/output';
import { actionSpecToActionDefinitionV1, readCompleteActionSpecV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ExternalActionRequestIdV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { getActionSpec, resolveActionExecutionPlacementForInput, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { readMissingActionSecretInputPaths } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ActionDefinitionV1, ActionExecuteFailure, ActionExecuteResult, SignedRootActionId } from '@happier-dev/protocol';
import { normalizeActionExecuteResult, normalizeCliActionThrownError, projectCliActionFailure, throwCliActionFailure as throwActionFailure } from './session/shared/normalizeActionExecuteResult';
import { FilesystemUploadInputSchema, FilesystemDownloadInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createCredentialedFilesystemTransferClient } from '@/machines/transfer/createCredentialedFilesystemTransferClient';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { finiteActionExitCode, supportsFiniteActionOutcome, readFiniteActionOutcome, readFiniteActionOperationAddress } from '@/cli/actions/finiteOutcome';
import {
  isPrivateSecretCliWrite, needsSavedSecretsInputPreparation, prepareSavedSecretsCliInput,
  SavedSecretsInputFailure, SavedSecretsInputReadApproval,
} from '@/cli/actions/adapters/savedSecretsInput';

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
function invokeUsage(actionId?: string): string {
  const wait = actionId && supportsFiniteActionOutcome(actionId) ? ' [--wait]' : '';
  return `Usage: happier actions invoke <action-id> [--<field> <value>...] [--input-json <json>] [--request-id <id>] [--server-id <id>] [--machine-id <id>] [--project-directory <path>] [--workspace-ref-id <id>] [--yes]${wait} [--json]`;
}
const INVOKE_WAIT_FLAG = '--wait' as const;
const INVOKE_YES_FLAG = '--yes' as const;

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
  actionFailure?: ActionExecuteFailure;
  expectedFailure?: boolean;
  code?: unknown;
  candidates?: unknown;
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


function invalidInvokeArguments(message: string, actionId?: string): never {
  throw Object.assign(new Error(`${message}\n${invokeUsage(actionId)}`), { code: 'invalid_arguments' });
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
  if (compiled.kind === 'local' && isPrivateSecretCliWrite(compiled.actionId)
    && hasInvokeOption(args, ACTION_CLI_WHOLE_INPUT_FLAG)) {
    invalidInvokeArguments('Secret values are read from stdin or a hidden prompt. --input-json is unavailable for this command.', args[1]);
  }
  const target = { fields: compiled.fields, positionals: [] as const };
  const flags = describeActionCliCommandFlags(target);
  const finiteFlags = compiled.kind === 'local' && supportsFiniteActionOutcome(compiled.actionId) ? [INVOKE_WAIT_FLAG] : [];
  // Unknown flags, missing values and surplus positionals fail here, before any
  // credential read or executor construction.
  assertCommandArguments(args, {
    usage: invokeUsage(args[1]),
    startIndex: 1,
    booleanFlags: [ACTION_CLI_JSON_OUTPUT_FLAG, INVOKE_YES_FLAG, ...finiteFlags, ...flags.booleanFlags],
    valueFlags: [...INVOKE_TRANSPORT_VALUE_FLAGS, ACTION_CLI_WHOLE_INPUT_FLAG, ...flags.valueFlags],
    literalValueFlags: [ACTION_CLI_SOURCE_PATH_FLAG, ACTION_CLI_DESTINATION_PATH_FLAG],
    maxPositionals: 1,
  });
  const stripped = stripCliOwnedFlags(args.slice(1), { booleanFlags: [INVOKE_YES_FLAG, ...finiteFlags], valueFlags: [...INVOKE_TRANSPORT_VALUE_FLAGS] });
  // The exact Action id is the first positional after `invoke`. Removing that
  // exact slot, rather than searching by value, preserves a field value that
  // happens to equal the Action id.
  const tokens = stripped.slice(1);
  const parsed = parseActionCliInput(target, tokens);
  if (!parsed.ok) invalidInvokeArguments(parsed.message, args[1]);
  if (compiled.kind === 'local') {
    const composed = composeActionCliInput({
      parsed,
      canonicalSchema: needsSavedSecretsInputPreparation(compiled.actionId) ? compiled.callerSchema : compiled.spec.inputSchema,
      wholeInputSchema: compiled.wholeInputSchema,
      callerSchema: compiled.callerSchema,
      bindInput: compiled.bindInput,
      secretInput: compiled.spec,
      context: {
        actionId: compiled.actionId,
        invocationId: randomUUID(),
        output: wantsJson(args) ? 'json' : 'human',
      },
    });
    if (!composed.ok) invalidInvokeArguments(composed.message, args[1]);
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
      reservedFlags: [...INVOKE_TRANSPORT_VALUE_FLAGS, INVOKE_YES_FLAG],
    }),
  });
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
    return await readCompleteActionSpecV1({ actionId,
      read: async input => unwrapOuterActionResult(await executor.execute(
        'action.spec.get',
        input,
        { ...actionContext(), ...(fixedServer ? { serverId: fixedServer.serverId } : {}),
          ...(serverIdentityId ? { serverIdentityId } : {}) },
      )),
    });
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
    invalidInvokeArguments(`Invalid input for ${definition.id}.`, definition.id);
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

async function execute(args: string[], deps: ActionsDeps, signal?: AbortSignal, requestId?: string): Promise<void> {
  const subcommand = args[0];
  if (
    !subcommand
    || subcommand === 'help'
    || ACTION_CLI_HELP_FLAGS.includes(subcommand as typeof ACTION_CLI_HELP_FLAGS[number])
  ) { showHelp(); return; }
  const json = wantsJson(args);
  if (subcommand !== 'invoke') throw Object.assign(new Error(`Unknown actions subcommand: ${subcommand}\n${invokeUsage()}`), { code: 'unknown_subcommand' });
  const requested = args[1];
  if (!requested || requested.startsWith('-')) throw Object.assign(new Error(invokeUsage()), { code: 'invalid_arguments' });
  const wait = supportsFiniteActionOutcome(requested) && hasInvokeOption(args, INVOKE_WAIT_FLAG);

  // The invoked Action, its request identity and its input are resolved before
  // authentication so an argument defect never constructs an executor.
  if (!requestId || !ExternalActionRequestIdV1Schema.safeParse(requestId).success) {
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
          reservedFlags: [...INVOKE_TRANSPORT_VALUE_FLAGS, INVOKE_YES_FLAG, ...(supportsFiniteActionOutcome(signedRootActionId.data) ? [INVOKE_WAIT_FLAG] : [])],
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
        let input: unknown;
        try { input = resolveInvokeActionInput(args, invokeFields); }
        catch (error) {
          if (isPrivateSecretCliWrite(signedRootActionId.data)) {
            invalidInvokeArguments('Invalid secret arguments. Values are read from stdin or a hidden prompt.', requested);
          }
          throw error;
        }
        return {
          actionId: signedRootActionId.data,
          input: wait && signedRootActionId.data === 'action.operations.get'
            ? { ...(input as Readonly<Record<string, unknown>>), waitForTerminal: true } : input,
          requestId,
          requiresServerId: spec.cli?.requiresServerId === true,
        };
      })();
  if (!contributed && localInvocation === null) return;

  const localPath = (flag: string) => {
    const options = argvBeforeOptionTerminator(args);
    const occurrences = options.filter(value => value === flag || value.startsWith(`${flag}=`));
    if (occurrences.length > 1) invalidInvokeArguments(`Provide ${flag} once.`, requested);
    const value = readRawFlagValue(options, flag);
    return value === null ? null : expandHomeDirPath(value);
  };
  const sourcePath = localPath(ACTION_CLI_SOURCE_PATH_FLAG);
  const destinationPath = localPath(ACTION_CLI_DESTINATION_PATH_FLAG);
  const isUpload = localInvocation?.actionId === 'daemon.filesystem.upload';
  const isDownload = localInvocation?.actionId === 'daemon.filesystem.download';
  if (sourcePath !== null && !isUpload) invalidInvokeArguments(`${ACTION_CLI_SOURCE_PATH_FLAG} is only valid for filesystem upload.`, requested);
  if (destinationPath !== null && !isDownload) invalidInvokeArguments(`${ACTION_CLI_DESTINATION_PATH_FLAG} is only valid for filesystem download.`, requested);
  if (isUpload && !sourcePath) invalidInvokeArguments(`${ACTION_CLI_SOURCE_PATH_FLAG} is required for filesystem upload.`, requested);
  if (isDownload && !destinationPath) invalidInvokeArguments(`${ACTION_CLI_DESTINATION_PATH_FLAG} is required for filesystem download.`, requested);
  if ((isUpload || isDownload) && !readFlagValue(args, ACTION_CLI_MACHINE_ID_FLAG)) invalidInvokeArguments(`${ACTION_CLI_MACHINE_ID_FLAG} is required for filesystem transfer.`, requested);

  const requestedServerId = readActionCliServerId(args, true);
  if ((isUpload || isDownload) && requestedServerId === null) invalidInvokeArguments(`${ACTION_CLI_SERVER_ID_FLAG} is required for filesystem transfer.`, requested);
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
  if ((isUpload || isDownload) && !fixedServer) invalidInvokeArguments(`${ACTION_CLI_SERVER_ID_FLAG} is required for filesystem transfer.`, requested);
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
    onApprovalRequested: async (artifactId: string, confirmationSignal: AbortSignal,
      decide: Parameters<CliApprovalRequestedHandler>[2]): Promise<ActionExecuteResult> => {
      console.error(`Waiting for approval: ${artifactId}`);
      let approve = hasInvokeOption(args, INVOKE_YES_FLAG);
      if (!approve) {
        try {
          approve = await promptConfirmYesNo('Approve this Action?', { default: 'no', signal: confirmationSignal });
        } catch (error) {
          if (confirmationSignal.aborted) throw error;
        }
      }
      const decision = await decide(approve ? 'approve' : 'reject');
      return !approve && decision.ok
        ? { ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' } : decision;
    },
    ...(machineId ? { machineId } : {}),
  };
  const executor = await deps.createExecutorFn(fixedServer
    ? { ...executorOptions, ...fixedServer }
    : executorOptions);
  const context = { ...actionContext(signal),
    ...(fixedServer ? { serverId: fixedServer.serverId } : {}),
    ...(serverIdentityId ? { serverIdentityId } : {}) };
  let invocation: Readonly<{ actionId: SignedRootActionId; input: unknown; requestId: string }>;
  let contributedExecutionPlacement: ActionDefinitionV1['executionPlacement'];
  if (contributed) {
    const discoveryContext = { ...context, actionRequestId: requestId };
    const discovery = await executor.execute(
      'action.spec.get',
      { id: requested, includeOutputSchema: true },
      discoveryContext,
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
      const definition = await readCompleteActionSpecV1({ actionId: requested, ...(signal ? { signal } : {}),
        read: async input => unwrapOuterActionResult(input.schemaPath === undefined
          ? discovery
          : await executor.execute('action.spec.get', input, discoveryContext)),
      });
      contributedExecutionPlacement = definition.executionPlacement;
      compiled = compileDiscoveredActionFields(definition);
      if (hasInvokeOption(args, ...ACTION_CLI_HELP_FLAGS)) {
        renderInvokeDefinitionHelp(definition, compiled);
        return;
      }
      input = resolveInvokeActionInput(args, compiled);
      if (!input || typeof input !== 'object' || Array.isArray(input)) invalidInvokeArguments('Action input must be an object.', requested);
      input = await prepareSavedSecretsCliInput({ actionId: requested,
        input: input as Readonly<Record<string, unknown>>, secretInput: definition, signal,
        execute: (actionId, readInput) => executor.execute(actionId, readInput, { ...context, actionRequestId: randomUUID() }),
      });
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
  if (!contributed && (needsSavedSecretsInputPreparation(invocation.actionId)
    || readMissingActionSecretInputPaths(getActionSpec(invocation.actionId), resolvedInput).length > 0)) {
    if (!resolvedInput || typeof resolvedInput !== 'object' || Array.isArray(resolvedInput)) invalidInvokeArguments('Action input must be an object.', requested);
    try {
      resolvedInput = await prepareSavedSecretsCliInput({ actionId: invocation.actionId,
        input: resolvedInput as Readonly<Record<string, unknown>>, signal,
        secretInput: getActionSpec(invocation.actionId),
        execute: (actionId, input) => executor.execute(actionId, input, { ...context, actionRequestId: randomUUID() }),
      });
    } catch (error) {
      if (error instanceof SavedSecretsInputReadApproval) {
        await tryHandleApprovalRequestCreated({ envelopeKind: 'actions_invoke', json, result: error.result, executionPlacement: 'account' });
        return;
      }
      throw error;
    }
    const validated = getActionSpec(invocation.actionId).inputSchema.safeParse(resolvedInput);
    if (!validated.success) invalidInvokeArguments('Invalid prepared Action input.', requested);
    resolvedInput = validated.data;
  }
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
  if (wait) {
    const address = invocation.actionId === 'action.operations.get' ? null : await readFiniteActionOperationAddress(resolvedInput, data);
    if (address) {
      // Environment-token admission consumes the submitted protected scope;
      // operation custody remains the exact returned address, not placement.
      const environmentId = invocation.actionId === 'deployments.deploy'
        && resolvedInput && typeof resolvedInput === 'object' && 'environmentId' in resolvedInput
        ? resolvedInput.environmentId : undefined;
      const observationInput = { ...address,
        ...(typeof environmentId === 'string' ? { environmentId } : {}), waitForTerminal: true };
      const observed = unwrapOuterActionResult(await executor.execute('action.operations.get', observationInput,
        { ...invocationOptions, actionRequestId: randomUUID() }));
      data = readFiniteActionOutcome({ actionId: 'action.operations.get', input: observationInput, result: observed });
    } else data = readFiniteActionOutcome({ actionId: invocation.actionId, input: resolvedInput, result: data });
  }
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'actions_invoke', json, result: data,
    executionPlacement: localInvocation ? resolveActionExecutionPlacementForInput(
      getActionSpec(localInvocation.actionId), resolvedInput) : contributedExecutionPlacement,
  })) return;
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
  // This producer supplies the same identity to dispatch and every failure,
  // including argument/authentication failures before an executor exists.
  const requestId = args[0] === 'invoke' ? readRawFlagValue(args, ACTION_CLI_REQUEST_ID_FLAG) ?? randomUUID() : undefined;
  try { await execute(args, { ...DEFAULT_DEPS, ...deps }, signal, requestId); }
  catch (error) {
    const candidate = error instanceof Error ? error as ActionCommandError : null;
    const normalized = candidate?.actionFailure ? normalizeActionExecuteResult(candidate.actionFailure) : null;
    const mapped = error instanceof SavedSecretsInputFailure
      ? { failure: { ...error.failure, errorMessage: error.message }, unexpected: false }
      : normalized && !normalized.ok ? { failure: normalized, unexpected: false }
      : candidate?.expectedFailure ? { failure: { errorCode: String(candidate.code ?? 'action_failed'), errorMessage: candidate.message,
        ...(Array.isArray(candidate.candidates) ? { candidates: candidate.candidates.filter((value): value is string => typeof value === 'string') } : {}) }, unexpected: false }
      : normalizeCliActionThrownError(error);
    const structured = projectCliActionFailure(mapped.failure, requestId);
    const exitCode = hasInvokeOption(args, INVOKE_WAIT_FLAG) && supportsFiniteActionOutcome(args[1] ?? '')
      ? finiteActionExitCode(mapped.failure.errorCode, mapped.unexpected) : mapped.unexpected ? 2 : 1;
    if (wantsJson(args)) await printJsonEnvelope({ ok: false, kind: `actions_${args[0] ?? 'help'}`, error: structured }, { exitCode });
    else {
      console.error(fail(mapped.failure.errorMessage ?? mapped.failure.errorCode));
      if ('candidates' in structured && Array.isArray(structured.candidates)) {
        console.error(`Candidates: ${structured.candidates.join(', ')}`);
      }
      if (mapped.failure.errorCode === 'invalid_arguments' || mapped.failure.errorCode === 'unknown_subcommand') showHelp();
      process.exitCode = exitCode;
    }
  }
}

export async function handleActionsCliCommand(context: CommandContext): Promise<void> {
  await handleActionsCommand(context.args.slice(1), DEFAULT_DEPS, context.signal);
}

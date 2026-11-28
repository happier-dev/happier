import { randomUUID } from 'node:crypto';

import chalk from 'chalk';

import type { ActionExecuteResult } from '@happier-dev/protocol';
import { resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { readMissingActionSecretInputPaths } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { isManagedWorkspaceRefV2, type WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import {
  isWorkspacePathWithinRootV1,
  normalizeWorkspaceRootPathV1,
  workspaceAddressFromRefV1,
} from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { z } from 'zod/mini';

import {
  bindContextualActionToolInput,
  projectSessionBoundActionToolInputSchema,
} from '@/agent/tools/happierTools/actionToolContext';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readActiveMachineId, readRegisteredMachineId } from '@/daemon/machineIdentity/machineRegistrationStore';
import { printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { executeSessionMcpAction, hasSessionMcpContext } from '@/cli/commands/toolsSessionMcp';
import {
  formatCliActionFailureText,
  normalizeActionExecuteResult,
  normalizeCliActionThrownError,
  projectCliActionFailure,
  unwrapCliActionSuccessPayload,
} from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import {
  readStoredCredentials,
  readStoredCredentialsForServerId,
  type StoredCredentials,
} from '@/persistence';
import { getServerProfile, resolveServerProfileHomeIdentityId, type ServerProfile } from '@/server/serverProfiles';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import {
  createServerUrlServerFeaturesSnapshotStore,
  type ServerFeaturesSnapshotStore,
} from '@/features/serverFeaturesSnapshotStore';
import type { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

import type { CompiledActionCliCommand } from './compiledCommands';
import { renderActionCliCommandHelp } from './commandHelp';
import { createCliActionApprovalPresenter } from './approvalPrompt';
import { isWorkflowActionCliCommand, readActionCliExecutionTarget } from './executionTarget';
import {
  actionCliEnvelopeKind,
  loadActionCliPresentation,
  type ActionCliFailure,
  type ActionCliPresentationContext,
} from './commandPresentation';
import {
  ACTION_CLI_HELP_FLAGS,
  ACTION_CLI_JSON_OUTPUT_FLAG,
  ACTION_CLI_MACHINE_ID_FLAG,
  ACTION_CLI_WHOLE_INPUT_FLAG,
  actionCliCommandInputArgv,
  composeActionCliInput,
  describeActionCliCommandFlags,
  parseActionCliInput,
} from './parseCommandInput';
import {
  ACTION_CLI_SERVER_ID_FLAG,
  readActionCliServerId,
  resolveActionCliCredentialTarget,
  type ActionCliFixedServerTarget,
} from './actionServerTarget';
import {
  secretCliArgumentError, needsSavedSecretsInputPreparation, prepareSavedSecretsCliInput, SavedSecretsInputFailure, SavedSecretsInputReadApproval,
} from './adapters/savedSecretsInput';

type Executor = Pick<
  ReturnType<typeof createCliActionExecutorFromCredentials>,
  'execute' | 'resolveSessionTarget'
>;
type ExecutorParams = Parameters<typeof createCliActionExecutorFromCredentials>[0];

export type ActionCliWorkspaceResolutionResult =
  | Readonly<{ ok: true; workspace: WorkspaceAddressV1 }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string }>;

export type ActionCliExecutionDeps = Readonly<{
  readCredentialsFn: () => Promise<StoredCredentials | null>;
  readCredentialsForServerIdFn: (serverId: string) => Promise<StoredCredentials | null>;
  getServerProfileFn: (serverId: string) => Promise<ServerProfile>;
  createServerFeaturesSnapshotStoreFn: (params: Readonly<{
    serverUrl: string;
    token: string;
  }>) => ServerFeaturesSnapshotStore;
  createExecutorFn: (params: ExecutorParams) => Executor | Promise<Executor>;
  resolveWorkspaceForCwdFn: (params: Readonly<{
    cwd: string;
    credentials: StoredCredentials;
    serverId: string;
    serverIdentityId?: string;
    serverApiUrl?: string;
    machineId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<ActionCliWorkspaceResolutionResult>;
  executeSessionMcpActionFn: typeof executeSessionMcpAction;
  hasSessionMcpContextFn: typeof hasSessionMcpContext;
  getCwdFn: () => string;
}>;

const PLACEHOLDER_CONTEXTUAL_WORKSPACE: WorkspaceAddressV1 = Object.freeze({
  serverId: 'pending',
  workspaceId: 'pending',
  machineId: 'pending',
  rootPath: '/',
});

async function resolveDefaultCliWorkspaceForCwd(params: Readonly<{
  cwd: string;
  credentials: StoredCredentials;
  serverId: string;
  serverIdentityId?: string;
  serverApiUrl?: string;
  machineId?: string | null;
  signal?: AbortSignal;
}>): Promise<ActionCliWorkspaceResolutionResult> {
  const accountId = readAccountIdFromToken(params.credentials.token);
  const resolvedMachineId = params.machineId
    ?? await readRegisteredMachineId(params.serverId, accountId)
    ?? await readActiveMachineId();
  if (!resolvedMachineId) {
    return {
      ok: false,
      errorCode: 'invalid_arguments',
      errorMessage: 'No registered machine found for the current directory. Pass --workspace-json or run inside a registered project checkout.',
    };
  }
  const homeId = params.serverIdentityId ?? await resolveServerProfileHomeIdentityId(params.serverId) ?? params.serverId;
  const serverHttpBaseUrl = params.serverApiUrl ?? resolveServerHttpBaseUrl();
  const rows = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => readProjectAccountRows({
    credentials: params.credentials,
    serverId: homeId,
    ...(params.signal ? { signal: params.signal } : {}),
    selection: { kinds: ['workspace-ref'], serverId: homeId },
  }));
  const matching = rows.workspaceRefs.filter((ref) => (
    !isManagedWorkspaceRefV2(ref)
    && ref.machineId === resolvedMachineId
    && isWorkspacePathWithinRootV1(params.cwd, ref.rootPath)
  ));
  if (matching.length === 0) {
    return {
      ok: false,
      errorCode: 'invalid_arguments',
      errorMessage: 'No registered project checkout found for the current directory. Pass --workspace-json or run inside a registered project checkout.',
    };
  }
  const ranked = matching
    .map((ref) => ({ ref, depth: normalizeWorkspaceRootPathV1(ref.rootPath)?.length ?? 0 }))
    .sort((left, right) => right.depth - left.depth);
  if (ranked.length > 1 && ranked[0]!.depth === ranked[1]!.depth) {
    return {
      ok: false,
      errorCode: 'invalid_arguments',
      errorMessage: 'Multiple registered project checkouts match the current directory. Pass --workspace-json to select one.',
    };
  }
  return { ok: true, workspace: workspaceAddressFromRefV1(ranked[0]!.ref) };
}

const DEFAULT_DEPS: ActionCliExecutionDeps = {
  readCredentialsFn: readStoredCredentials,
  readCredentialsForServerIdFn: readStoredCredentialsForServerId,
  getServerProfileFn: getServerProfile,
  createServerFeaturesSnapshotStoreFn: createServerUrlServerFeaturesSnapshotStore,
  createExecutorFn: async (params) => (
    await import('@/session/actions/createCliActionExecutorFromCredentials')
  ).createCliActionExecutorFromCredentials(params),
  resolveWorkspaceForCwdFn: resolveDefaultCliWorkspaceForCwd,
  executeSessionMcpActionFn: executeSessionMcpAction,
  hasSessionMcpContextFn: hasSessionMcpContext,
  getCwdFn: () => process.cwd(),
};

/**
 * CLI-owned transport flags. They route the invocation and never become Action
 * input, so they are removed before the Action parser sees a single token.
 */
const SERVER_TRANSPORT_VALUE_FLAG = ACTION_CLI_SERVER_ID_FLAG;

function isHelpRequest(argv: readonly string[]): boolean {
  return hasFlagBeforeTerminator(argv, new Set(ACTION_CLI_HELP_FLAGS));
}

function hasFlagBeforeTerminator(argv: readonly string[], flags: ReadonlySet<string>): boolean {
  for (const token of argv) {
    if (token === '--') return false;
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (flags.has(name)) return true;
  }
  return false;
}

/** The exact Machine transport value, read without disturbing Action input. */
export function readTransportMachineId(command: CompiledActionCliCommand, argv: readonly string[]): string | null {
  if (!command.routesByTransportMachineId) return null;
  let selected: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') break;
    let value: string | null = null;
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (!command.transportMachineIdFlags.includes(name)) continue;
    if (token === name) {
      const next = argv[index + 1];
      if (typeof next !== 'string' || next.startsWith('--')) {
        throw Object.assign(new Error(`Option ${name} requires a value.`), { code: 'invalid_arguments' });
      }
      value = next;
      index += 1;
    } else {
      value = token.slice(name.length + 1);
      if (!value) {
        throw Object.assign(new Error(`Option ${name} requires a value.`), { code: 'invalid_arguments' });
      }
    }
    if (value === null) continue;
    if (selected !== null) {
      throw Object.assign(new Error(`Provide ${ACTION_CLI_MACHINE_ID_FLAG} once.`), { code: 'invalid_arguments' });
    }
    selected = value;
  }
  return selected;
}

function requestSignalForCommand(
  command: CompiledActionCliCommand,
  callerSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (command.requestTimeout !== 'session_control') return callerSignal;
  const deadline = AbortSignal.timeout(configuration.sessionControlHttpTimeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
}

/**
 * Removes CLI-owned tokens while preserving argv order and every remaining byte.
 * `--` and everything after it survives, so a flag-looking literal message stays
 * a literal.
 */
export function stripTransportTokens(
  command: CompiledActionCliCommand,
  tokens: readonly string[],
): readonly string[] {
  const transportValueFlags = commandTransportValueFlags(command);
  const kept: string[] = [];
  let positionalOnly = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (positionalOnly) { kept.push(token); continue; }
    if (token === '--') { positionalOnly = true; kept.push(token); continue; }
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (name === ACTION_CLI_JSON_OUTPUT_FLAG || ACTION_CLI_HELP_FLAGS.includes(name as typeof ACTION_CLI_HELP_FLAGS[number])) continue;
    if (transportValueFlags.includes(name)) {
      if (!token.includes('=')) index += 1;
      continue;
    }
    kept.push(token);
  }
  return kept;
}

function commandTransportValueFlags(command: CompiledActionCliCommand): readonly string[] {
  return [
    ...(command.routesByTransportMachineId ? [...command.transportMachineIdFlags, ...command.transportProjectTargetFlags] : []),
    ...(command.acceptsServerId ? [SERVER_TRANSPORT_VALUE_FLAG] : []),
  ];
}

async function reportFailure(params: Readonly<{
  json: boolean;
  kind: string;
  failure: ActionCliFailure;
  extraFields: Readonly<Record<string, unknown>> | null;
  humanSuffix: string | null;
  unexpected: boolean;
  help: string | null;
}>): Promise<void> {
  if (params.json) {
    await printJsonEnvelope(
      {
        ok: false,
        kind: params.kind,
        ...(params.failure.automationNotices ? { automationNotices: params.failure.automationNotices } : {}),
        error: {
          ...(params.extraFields ?? {}),
          ...projectCliActionFailure(params.failure),
        },
      },
      { exitCode: params.unexpected ? 2 : 1 },
    );
    return;
  }
  console.error(chalk.red('Error:'), formatCliActionFailureText(undefined, params.failure, { suffix: params.humanSuffix }));
  if (params.failure.candidates?.length) {
    console.error(`Candidates: ${params.failure.candidates.join(', ')}`);
  }
  if (params.help) console.error(params.help);
  process.exitCode = params.unexpected ? 2 : 1;
}

/**
 * Runs one compiled friendly Action command end to end: parse, bind, canonical
 * validation, invocation, presentation.
 *
 * Friendly input is validated before authentication. Inputs that require live
 * secret custody or authenticated metadata are prepared with that same executor
 * and validated canonically before invocation. The command's presenter only
 * sees an already executed canonical result.
 */
export async function runCompiledActionCliCommand(params: Readonly<{
  command: CompiledActionCliCommand;
  /** Full argv for this command, starting at its first path segment. */
  argv: readonly string[];
  signal?: AbortSignal;
  deps?: Partial<ActionCliExecutionDeps>;
  /** Consume one already validated success without changing or replaying the Action. */
  consumeSuccess?: (payload: unknown) => boolean | Promise<boolean>;
  /** The generated shell-bridge marker, resolved to this exact Session before invocation. */
  agentBridgeSessionId?: string;
}>): Promise<void> {
  const { command } = params;
  const json = hasFlagBeforeTerminator(params.argv, new Set([ACTION_CLI_JSON_OUTPUT_FLAG]));
  const presentation = await loadActionCliPresentation(command.actionId);
  const kind = presentation?.envelopeKind?.(command) ?? actionCliEnvelopeKind(command.path);
  const help = renderActionCliCommandHelp(command);

  if (isHelpRequest(params.argv)) {
    if (json) {
      await printJsonEnvelope({ ok: true, kind, data: { help } });
      return;
    }
    console.log(help);
    return;
  }
  const inputTokens = stripTransportTokens(command, actionCliCommandInputArgv(command, params.argv));
  const secretError = secretCliArgumentError(command.spec, command, inputTokens);
  if (secretError) {
    await reportFailure({ json, kind, failure: { errorCode: 'invalid_arguments', errorMessage: secretError },
      extraFields: null, humanSuffix: null, unexpected: false, help: json ? null : help });
    return;
  }

  const parsed = parseActionCliInput(command, inputTokens);
  if (!parsed.ok) {
    await reportFailure({
      json,
      kind,
      failure: { errorCode: parsed.code, errorMessage: parsed.message },
      extraFields: null,
      humanSuffix: null,
      unexpected: false,
      help: json ? null : help,
    });
    return;
  }

  const deps: ActionCliExecutionDeps = { ...DEFAULT_DEPS, ...params.deps };
  const invocationId = randomUUID();
  const prepareSavedInput = needsSavedSecretsInputPreparation(command.actionId);
  const workspaceContextualDefault = command.spec.contextualDefaults?.workspace ?? null;
  const workspaceSuppliedInInput = (parsed.canonicalBase !== null && Object.prototype.hasOwnProperty.call(parsed.canonicalBase, 'workspace'))
    || Object.prototype.hasOwnProperty.call(parsed.callerOverlay, 'workspace');
  const needsContextualWorkspaceResolution = workspaceContextualDefault !== null && !workspaceSuppliedInInput;
  const cwdSuppliedInInput = (parsed.canonicalBase !== null && Object.prototype.hasOwnProperty.call(parsed.canonicalBase, 'cwd'))
    || Object.prototype.hasOwnProperty.call(parsed.callerOverlay, 'cwd');
  const shouldDefaultComputeExecCwd = needsContextualWorkspaceResolution
    && command.actionId === 'projects.compute.exec'
    && !cwdSuppliedInInput;
  const effectiveParsed = shouldDefaultComputeExecCwd
    ? { ...parsed, callerOverlay: Object.freeze({ ...parsed.callerOverlay, cwd: deps.getCwdFn() }) }
    : parsed;
  const preTransportCanonicalSchema = prepareSavedInput && parsed.canonicalBase === null
    ? command.callerSchema
    : needsContextualWorkspaceResolution
      ? projectSessionBoundActionToolInputSchema({
          actionId: command.actionId,
          inputSchema: command.spec.inputSchema,
          contextualDefaults: command.spec.contextualDefaults,
          context: { defaultSessionWorkspace: PLACEHOLDER_CONTEXTUAL_WORKSPACE },
        }) as z.ZodMiniType
      : command.spec.inputSchema;
  const composed = composeActionCliInput({
    parsed: effectiveParsed,
    canonicalSchema: preTransportCanonicalSchema,
    wholeInputSchema: command.wholeInputSchema,
    callerSchema: command.callerSchema,
    bindInput: command.spec.cli?.bindInput,
    secretInput: command.spec,
    context: {
      actionId: command.actionId,
      invocationId,
      commandPath: command.path,
      output: json ? 'json' : 'human',
    },
  });
  if (!composed.ok) {
    await reportFailure({
      json,
      kind,
      failure: { errorCode: composed.code, errorMessage: composed.message,
        ...(composed.details === undefined ? {} : { details: composed.details }) },
      extraFields: null,
      humanSuffix: null,
      unexpected: false,
      help: json ? null : help,
    });
    return;
  }
  let input = composed.input;
  const prepareInput = prepareSavedInput || readMissingActionSecretInputPaths(command.spec, input).length > 0;
  const callerInput = composed.callerInput;
  let context: ActionCliPresentationContext = { command, json, input, callerInput };

  let result: ActionExecuteResult;
  let bridgeSessionId = params.agentBridgeSessionId;
  if (params.agentBridgeSessionId !== undefined || deps.hasSessionMcpContextFn()) {
    if (hasFlagBeforeTerminator(actionCliCommandInputArgv(command, params.argv), new Set(commandTransportValueFlags(command)))) {
      await reportFailure({ json, kind, failure: { errorCode: 'invalid_arguments',
        errorMessage: 'Session MCP selects the Home and execution context. Supply resource targets in the Action input.' },
        extraFields: null, humanSuffix: null, unexpected: false, help: null });
      return;
    }
    // This argument records provenance only. The admitted MCP endpoint owns
    // Session authority; neither it nor Action input is resolved via an Account.
    const observation = command.binding.observation ? new AbortController() : null;
    const onInterrupt = () => observation?.abort();
    if (observation) process.on('SIGINT', onInterrupt);
    const callerSignal = observation
      ? params.signal ? AbortSignal.any([params.signal, observation.signal]) : observation.signal
      : params.signal;
    const requestSignal = requestSignalForCommand(command, callerSignal);
    const execute = (actionId: Parameters<typeof prepareSavedSecretsCliInput>[0]['actionId'], actionInput: unknown) =>
      deps.executeSessionMcpActionFn(actionId, actionInput, { ...(requestSignal ? { signal: requestSignal } : {}) });
    try {
      if (prepareInput) {
        input = await prepareSavedSecretsCliInput({ actionId: command.actionId, input, signal: requestSignal,
          secretInput: command.spec, execute });
        const validated = preTransportCanonicalSchema.safeParse(input);
        if (!validated.success) throw new SavedSecretsInputFailure({ errorCode: 'invalid_arguments', errorMessage: 'Invalid prepared Action input.' });
        input = validated.data as Readonly<Record<string, unknown>>;
        context = { command, json, input, callerInput };
      }
      result = await execute(command.actionId, input);
    } catch (error) {
      if (error instanceof SavedSecretsInputReadApproval) {
        await tryHandleApprovalRequestCreated({ envelopeKind: kind, json, result: error.result, executionPlacement: 'account' });
        return;
      }
      if (error instanceof SavedSecretsInputFailure) {
        await reportFailure({ json, kind, failure: error.failure, extraFields: null, humanSuffix: null,
          unexpected: false, help: null });
        return;
      }
      const mapped = normalizeCliActionThrownError(error);
      await reportFailure({ json, kind, failure: mapped.failure,
        extraFields: null, humanSuffix: null, unexpected: mapped.unexpected, help: null });
      return;
    } finally { if (observation) process.removeListener('SIGINT', onInterrupt); }
  } else {
  let credentials: StoredCredentials | null;
  let fixedServer: ActionCliFixedServerTarget | null = null;
  let serverIdentityId: string | undefined;
  let machineId: string | null;
  let executionTarget: ReturnType<typeof readActionCliExecutionTarget>;
  try {
    machineId = readTransportMachineId(command, params.argv);
    executionTarget = readActionCliExecutionTarget(
      command.transportProjectTargetFlags.length ? params.argv : [], machineId,
    );
    const requestedServerId = readActionCliServerId(params.argv, command.acceptsServerId);
    if (command.requiresServerId && requestedServerId === null) {
      throw Object.assign(
        new Error(`Option ${ACTION_CLI_SERVER_ID_FLAG} is required for this Home-scoped command.`),
        { code: 'invalid_arguments' },
      );
    }
    ({ credentials, fixedServer, serverIdentityId } = await resolveActionCliCredentialTarget({
      requestedServerId,
      requireServerIdentityId: command.requiresServerId,
      deps,
    }));
  } catch (error) {
    const mapped = normalizeCliActionThrownError(error);
    await reportFailure({
      json,
      kind,
      failure: mapped.failure,
      extraFields: null,
      humanSuffix: null,
      unexpected: mapped.unexpected,
      help: mapped.failure.errorCode === 'invalid_arguments' && !json ? help : null,
    });
    return;
  }
  if (!credentials) {
    await reportFailure({
      json,
      kind,
      failure: {
        errorCode: 'not_authenticated',
        errorMessage: 'Not authenticated. Run "happier auth login" first.',
      },
      extraFields: presentation?.failureFields?.({ errorCode: 'not_authenticated' }, context) ?? null,
      humanSuffix: null,
      unexpected: false,
      help: null,
    });
    return;
  }

  const observation = command.binding.observation ? new AbortController() : null;
  const onInterrupt = () => observation?.abort();
  if (observation) process.on('SIGINT', onInterrupt);
  const callerSignal = observation
    ? params.signal ? AbortSignal.any([params.signal, observation.signal]) : observation.signal
    : params.signal;
  const requestSignal = requestSignalForCommand(command, callerSignal);
  try {
    const serverFeaturesStore = deps.createServerFeaturesSnapshotStoreFn({
      serverUrl: fixedServer?.serverApiUrl ?? resolveServerHttpBaseUrl(),
      token: credentials.token,
    });
    let serverFeaturesSnapshotPromise: ReturnType<ServerFeaturesSnapshotStore['refresh']> | null = null;
    const resolveServerFeaturesSnapshot = () => {
      serverFeaturesSnapshotPromise ??= serverFeaturesStore.refresh();
      return serverFeaturesSnapshotPromise;
    };
    const executorOptions = {
      credentials,
      onApprovalRequested: createCliActionApprovalPresenter({ actionId: command.actionId, json, envelopeKind: kind }),
      ...(serverIdentityId ? { serverIdentityId } : {}),
      readCredentials: fixedServer
        ? () => deps.readCredentialsForServerIdFn(fixedServer.serverId)
        : deps.readCredentialsFn,
      resolveServerFeaturesSnapshot,
      ...(machineId !== null ? { machineId } : {}),
      // Workflow admission needs the daemon's executable registry; mounted
      // client Actions and discovery use that same external ingress. The CLI
      // compiler projects commands without becoming another runtime owner.
      ...(command.actionId === 'action.spec.search'
        || command.actionId === 'action.spec.get'
        || isWorkflowActionCliCommand(command.actionId)
        || resolveActionExecutionPlacementForInput(command.spec, input, undefined, params.agentBridgeSessionId ? 'agent' : 'cli') === 'client'
        ? { externalActionClient: true as const }
        : {}),
    };
    if (needsContextualWorkspaceResolution) {
      const resolvedWorkspace = await deps.resolveWorkspaceForCwdFn({
        cwd: deps.getCwdFn(),
        credentials,
        serverId: fixedServer?.serverId ?? configuration.activeServerId,
        ...(serverIdentityId ? { serverIdentityId } : {}),
        ...(fixedServer?.serverApiUrl ? { serverApiUrl: fixedServer.serverApiUrl } : {}),
        ...(machineId !== null ? { machineId } : {}),
        ...(requestSignal ? { signal: requestSignal } : {}),
      });
      if (!resolvedWorkspace.ok) {
        await reportFailure({
          json,
          kind,
          failure: { errorCode: resolvedWorkspace.errorCode, errorMessage: resolvedWorkspace.errorMessage },
          extraFields: null,
          humanSuffix: null,
          unexpected: false,
          help: null,
        });
        return;
      }
      const boundInput = bindContextualActionToolInput({
        actionId: command.actionId,
        input,
        contextualDefaults: command.spec.contextualDefaults,
        context: { defaultSessionWorkspace: resolvedWorkspace.workspace },
      });
      const validated = command.spec.inputSchema.safeParse(boundInput);
      if (!validated.success) {
        await reportFailure({
          json,
          kind,
          failure: { errorCode: 'invalid_arguments', errorMessage: 'Invalid Action input after resolving workspace.' },
          extraFields: null,
          humanSuffix: null,
          unexpected: false,
          help: null,
        });
        return;
      }
      input = Object.freeze(validated.data as Record<string, unknown>);
      context = { command, json, input, callerInput };
    }
    const executor = await deps.createExecutorFn(fixedServer
      ? { ...executorOptions, ...fixedServer }
      : executorOptions);
    // Friendly Session commands accept ids, tags and unambiguous prefixes. Do
    // that resolution once at the CLI transport boundary so execution and the
    // typed presenter both receive the immutable Session id. The Action binder
    // stays pure and cannot accidentally become another Session resolver.
    if (typeof input.sessionId === 'string') {
      const resolved = await executor.resolveSessionTarget(input.sessionId);
      if (!resolved.ok) {
        await reportFailure({
          json,
          kind,
          failure: {
            errorCode: resolved.code,
            ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
          },
          extraFields: null,
          humanSuffix: null,
          unexpected: false,
          help: null,
        });
        return;
      }
      input = Object.freeze({ ...input, sessionId: resolved.sessionId });
      context = { command, json, input, callerInput };
    }
    if (params.agentBridgeSessionId) {
      const resolved = await executor.resolveSessionTarget(params.agentBridgeSessionId);
      if (!resolved.ok) throw Object.assign(new Error(resolved.code), { code: resolved.code });
      bridgeSessionId = resolved.sessionId;
    }
    if (prepareInput) {
      input = await prepareSavedSecretsCliInput({ actionId: command.actionId, input, signal: requestSignal,
        secretInput: command.spec,
        execute: (actionId, readInput) => executor.execute(actionId, readInput, {
          surface: bridgeSessionId ? 'agent' : 'cli', actionRequestId: randomUUID(),
          defaultSessionId: bridgeSessionId ?? null,
          ...(requestSignal ? { signal: requestSignal } : {}),
          ...(fixedServer ? { serverId: fixedServer.serverId } : {}),
          ...(serverIdentityId ? { serverIdentityId } : {}),
        }),
      });
      const validated = command.spec.inputSchema.safeParse(input);
      if (!validated.success) throw new SavedSecretsInputFailure({ errorCode: 'invalid_arguments', errorMessage: 'Invalid prepared Action input.' });
      input = validated.data as Readonly<Record<string, unknown>>;
      context = { command, json, input, callerInput };
    }
    result = await executor.execute(command.actionId, input, {
      surface: bridgeSessionId ? 'agent' : 'cli',
      actionRequestId: invocationId,
      defaultSessionId: bridgeSessionId ?? (typeof input.sessionId === 'string' ? input.sessionId : null),
      ...(requestSignal ? { signal: requestSignal } : {}),
      ...(fixedServer ? { serverId: fixedServer.serverId } : {}),
      ...(serverIdentityId ? { serverIdentityId } : {}),
      // Workflow aliases retain the generic invocation's complete target;
      // Account Actions also retain their exact execution Machine selector.
      ...(executionTarget && (isWorkflowActionCliCommand(command.actionId)
        || resolveActionExecutionPlacementForInput(command.spec, input, undefined, bridgeSessionId ? 'agent' : 'cli') === 'account')
        ? { externalActionTarget: executionTarget } : {}),
      ...(command.binding.observation === 'changes' ? {
        onWaitSnapshot: async (snapshot: unknown) => writeJsonStdout({
          kind, target: input.target, condition: input.condition, snapshot,
        }),
      } : {}),
    });
  } catch (error) {
    if (error instanceof SavedSecretsInputReadApproval) {
      await tryHandleApprovalRequestCreated({ envelopeKind: kind, json, result: error.result, executionPlacement: 'account' });
      return;
    }
    if (error instanceof SavedSecretsInputFailure) {
      await reportFailure({ json, kind, failure: error.failure, extraFields: null, humanSuffix: null,
        unexpected: false, help: null });
      return;
    }
    const mapped = normalizeCliActionThrownError(error);
    await reportFailure({
      json,
      kind,
      failure: mapped.failure,
      extraFields: presentation?.failureFields?.(mapped.failure, context) ?? null,
      humanSuffix: null,
      unexpected: mapped.unexpected,
      help: null,
    });
    return;
  } finally {
    if (observation) process.removeListener('SIGINT', onInterrupt);
  }
  }

  const payload = result.ok ? unwrapCliActionSuccessPayload(result.result) : undefined;
  if (result.ok) {
    if (await tryHandleApprovalRequestCreated({ envelopeKind: kind, json, result: payload, automationNotices: result.automationNotices,
      executionPlacement: resolveActionExecutionPlacementForInput(command.spec, input, undefined, bridgeSessionId ? 'agent' : 'cli') })) return;
    // The Action succeeded; its outcome union may still report a pending or
    // refused operation. Classify that canonical payload before generic nested
    // failure normalization discards the domain-specific receipt.
    const classified = presentation?.classifyResult?.(payload, context) ?? null;
    if (classified) {
      await reportFailure({
        json,
        kind,
        failure: { ...classified, ...(result.automationNotices ? { automationNotices: result.automationNotices } : {}) },
        extraFields: presentation?.failureFields?.(classified, context) ?? null,
        humanSuffix: presentation?.describeFailure?.(classified, context) ?? null,
        unexpected: false,
        help: null,
      });
      return;
    }
  }

  const normalized = normalizeActionExecuteResult(result);
  if (!normalized.ok) {
    const failure: ActionCliFailure = normalized;
    await reportFailure({
      json,
      kind,
      failure,
      extraFields: presentation?.failureFields?.(failure, context) ?? null,
      humanSuffix: presentation?.describeFailure?.(failure, context) ?? null,
      unexpected: false,
      help: null,
    });
    return;
  }

  if (params.consumeSuccess) {
    try {
      if (await params.consumeSuccess(payload)) return;
    } catch (error) {
      const mapped = normalizeCliActionThrownError(error);
      await reportFailure({ json, kind,
        failure: mapped.failure,
        extraFields: null, humanSuffix: null, unexpected: mapped.unexpected, help: null });
      return;
    }
  }
  if (presentation?.presentSuccess) {
    try {
      if (await presentation.presentSuccess(payload, context)) return;
    } catch {
      // Presentation is deliberately downstream of the completed Action. A
      // stale or stricter friendly presenter must never reinterpret or replay
      // a successful effect. JSON retains the canonical success payload. Human
      // output cannot safely dump an unexpected payload, so report only the
      // local presentation failure and deliberately discard both the payload
      // and the thrown value (which may contain secrets).
      if (!json) {
        await reportFailure({
          json: false,
          kind,
          failure: { errorCode: 'presentation_failed' },
          extraFields: null,
          humanSuffix: 'The Action completed, but its result could not be displayed.',
          unexpected: true,
          help: null,
        });
        return;
      }
    }
  }

  if (json) {
    await printJsonEnvelope({ ok: true, kind, data: payload,
      ...(result.automationNotices ? { automationNotices: result.automationNotices } : {}) });
    return;
  }
  await writeJsonStdout(payload, { pretty: true });
}

/**
 * The argv policy one compiled command accepts, exposed so an outer argument
 * assertion never restates a flag list the compiler already owns.
 */
export function describeCompiledActionCliCommandArgvPolicy(command: CompiledActionCliCommand): Readonly<{
  booleanFlags: readonly string[];
  valueFlags: readonly string[];
}> {
  const flags = describeActionCliCommandFlags(command);
  return Object.freeze({
    booleanFlags: Object.freeze([ACTION_CLI_JSON_OUTPUT_FLAG, ...ACTION_CLI_HELP_FLAGS, ...flags.booleanFlags]),
    valueFlags: Object.freeze([
      ...command.transportMachineIdFlags,
      ...command.transportProjectTargetFlags,
      ...(command.acceptsServerId ? [SERVER_TRANSPORT_VALUE_FLAG] : []),
      ACTION_CLI_WHOLE_INPUT_FLAG,
      ...flags.valueFlags,
    ]),
  });
}

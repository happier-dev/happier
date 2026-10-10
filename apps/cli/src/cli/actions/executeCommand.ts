import { randomUUID } from 'node:crypto';

import chalk from 'chalk';

import type { ActionExecuteResult } from '@happier-dev/protocol';

import { printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { configuration } from '@/configuration';
import {
  readStoredCredentials,
  readStoredCredentialsForServerId,
  type StoredCredentials,
} from '@/persistence';
import { getServerProfile, type ServerProfile } from '@/server/serverProfiles';
import {
  createServerUrlServerFeaturesSnapshotStore,
  type ServerFeaturesSnapshotStore,
} from '@/features/serverFeaturesSnapshotStore';
import type { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { projectRequesterSessionCredentialDisclosure } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';

import type { CompiledActionCliCommand } from './compiledCommands';
import { renderActionCliCommandHelp } from './commandHelp';
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

type Executor = Pick<
  ReturnType<typeof createCliActionExecutorFromCredentials>,
  'execute' | 'resolveSessionTarget'
>;
type ExecutorParams = Parameters<typeof createCliActionExecutorFromCredentials>[0];

export type ActionCliExecutionDeps = Readonly<{
  readCredentialsFn: () => Promise<StoredCredentials | null>;
  readCredentialsForServerIdFn: (serverId: string) => Promise<StoredCredentials | null>;
  getServerProfileFn: (serverId: string) => Promise<ServerProfile>;
  createServerFeaturesSnapshotStoreFn: (params: Readonly<{
    serverUrl: string;
    token: string;
  }>) => ServerFeaturesSnapshotStore;
  createExecutorFn: (params: ExecutorParams) => Executor | Promise<Executor>;
}>;

const DEFAULT_DEPS: ActionCliExecutionDeps = {
  readCredentialsFn: readStoredCredentials,
  readCredentialsForServerIdFn: readStoredCredentialsForServerId,
  getServerProfileFn: getServerProfile,
  createServerFeaturesSnapshotStoreFn: createServerUrlServerFeaturesSnapshotStore,
  createExecutorFn: async (params) => (
    await import('@/session/actions/createCliActionExecutorFromCredentials')
  ).createCliActionExecutorFromCredentials(params),
};

/** CLI confidentiality consent precedes private custody; target Action approval remains separate. */
export async function confirmCliRequesterCredentialDisclosure(
  disclosure: ReturnType<typeof projectRequesterSessionCredentialDisclosure>,
  options: Readonly<{ json?: boolean; signal?: AbortSignal }> = {},
): Promise<boolean> {
  if (options.json || options.signal?.aborted || !isInteractiveTerminal()) return false;
  const custodian = disclosure.custodian?.displayName?.trim() || disclosure.custodian?.accountId;
  return await promptConfirmYesNo(
    `Machine ${disclosure.machineId}${custodian ? ` (owned by ${custodian})` : ''} will receive your full Happier sign-in and can use it to access your Account. `
    + 'Its owner and anyone with terminal or agent access can read local files, output and sign-ins used by work there. '
    + 'Allow this sign-in to be shared for this action?',
    { default: 'no', ...(options.signal ? { signal: options.signal } : {}) },
  );
}

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
function readTransportMachineId(command: CompiledActionCliCommand, argv: readonly string[]): string | null {
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
function stripTransportTokens(
  command: CompiledActionCliCommand,
  tokens: readonly string[],
): readonly string[] {
  const transportValueFlags: readonly string[] = command.routesByTransportMachineId
    ? [...command.transportMachineIdFlags, ...(command.acceptsServerId ? [SERVER_TRANSPORT_VALUE_FLAG] : [])]
    : command.acceptsServerId ? [SERVER_TRANSPORT_VALUE_FLAG] : [];
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
        error: {
          code: params.failure.errorCode,
          ...(params.extraFields ?? {}),
          ...(params.failure.candidates ? { candidates: params.failure.candidates } : {}),
          ...(params.failure.errorMessage ? { message: params.failure.errorMessage } : {}),
          ...(params.failure.details !== undefined ? { details: params.failure.details } : {}),
        },
      },
      { exitCode: params.unexpected ? 2 : 1 },
    );
    return;
  }
  const message = [params.failure.errorMessage ?? params.failure.errorCode, params.humanSuffix]
    .filter((part): part is string => Boolean(part))
    .join(' ');
  console.error(chalk.red('Error:'), message);
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
 * Everything before the executor is argument work, so an unknown flag, a
 * duplicate source or an input the Action schema rejects fails before any
 * credential is read. The command's own presenter, when it has one, only ever
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

  const parsed = parseActionCliInput(
    command,
    stripTransportTokens(command, params.argv.slice(command.path.length)),
  );
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

  const invocationId = randomUUID();
  const composed = composeActionCliInput({
    parsed,
    canonicalSchema: command.spec.inputSchema,
    wholeInputSchema: command.wholeInputSchema,
    callerSchema: command.callerSchema,
    bindInput: command.spec.cli?.bindInput,
    context: {
      actionId: command.actionId,
      invocationId,
      output: json ? 'json' : 'human',
    },
  });
  if (!composed.ok) {
    await reportFailure({
      json,
      kind,
      failure: { errorCode: composed.code, errorMessage: composed.message },
      extraFields: null,
      humanSuffix: null,
      unexpected: false,
      help: json ? null : help,
    });
    return;
  }
  let input = composed.input;
  const callerInput = composed.callerInput;
  let context: ActionCliPresentationContext = { command, json, input, callerInput };

  const deps: ActionCliExecutionDeps = { ...DEFAULT_DEPS, ...params.deps };
  let credentials: StoredCredentials | null;
  let fixedServer: ActionCliFixedServerTarget | null = null;
  let serverIdentityId: string | undefined;
  let machineId: string | null;
  try {
    machineId = readTransportMachineId(command, params.argv);
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
    const mapped = mapUnknownErrorToControlError(error);
    await reportFailure({
      json,
      kind,
      failure: { errorCode: mapped.code, ...(mapped.message ? { errorMessage: mapped.message } : {}) },
      extraFields: null,
      humanSuffix: null,
      unexpected: mapped.unexpected,
      help: mapped.code === 'invalid_arguments' && !json ? help : null,
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
  let result: ActionExecuteResult;
  try {
    const serverFeaturesStore = deps.createServerFeaturesSnapshotStoreFn({
      serverUrl: fixedServer?.serverApiUrl ?? configuration.apiServerUrl,
      token: credentials.token,
    });
    let serverFeaturesSnapshotPromise: ReturnType<ServerFeaturesSnapshotStore['refresh']> | null = null;
    const resolveServerFeaturesSnapshot = () => {
      serverFeaturesSnapshotPromise ??= serverFeaturesStore.refresh();
      return serverFeaturesSnapshotPromise;
    };
    const executorOptions = {
      credentials,
      ...(serverIdentityId ? { serverIdentityId } : {}),
      onRequesterSessionCredentialDisclosure: (disclosure: ReturnType<typeof projectRequesterSessionCredentialDisclosure>) =>
        confirmCliRequesterCredentialDisclosure(disclosure, { json, ...(requestSignal ? { signal: requestSignal } : {}) }),
      readCredentials: fixedServer
        ? () => deps.readCredentialsForServerIdFn(fixedServer.serverId)
        : deps.readCredentialsFn,
      resolveServerFeaturesSnapshot,
      ...(machineId !== null ? { machineId } : {}),
      // Discovery reads the daemon's committed contributed Action registry as
      // well as bundled specs. Preserve the former actions host's signed-client
      // transport while the shared compiler owns its argv/help/completion.
      ...(command.actionId === 'action.spec.search'
        || command.actionId === 'action.spec.get'
        ? { externalActionClient: true as const }
        : {}),
    };
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
    result = await executor.execute(command.actionId, input, {
      surface: 'cli',
      actionRequestId: invocationId,
      defaultSessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
      ...(requestSignal ? { signal: requestSignal } : {}),
      ...(fixedServer ? { serverId: fixedServer.serverId } : {}),
      ...(serverIdentityId ? { serverIdentityId } : {}),
      ...(command.binding.observation === 'changes' ? {
        onWaitSnapshot: async (snapshot: unknown) => writeJsonStdout({
          kind, target: input.target, condition: input.condition, snapshot,
        }),
      } : {}),
    });
  } catch (error) {
    const mapped = mapUnknownErrorToControlError(error);
    await reportFailure({
      json,
      kind,
      failure: { errorCode: mapped.code, ...(mapped.message ? { errorMessage: mapped.message } : {}) },
      extraFields: presentation?.failureFields?.({ errorCode: mapped.code }, context) ?? null,
      humanSuffix: null,
      unexpected: mapped.unexpected,
      help: null,
    });
    return;
  } finally {
    if (observation) process.removeListener('SIGINT', onInterrupt);
  }

  const normalized = normalizeActionExecuteResult(result);
  if (!normalized.ok) {
    const failure: ActionCliFailure = {
      errorCode: normalized.errorCode,
      ...(normalized.errorMessage ? { errorMessage: normalized.errorMessage } : {}),
      ...(normalized.candidates ? { candidates: normalized.candidates } : {}),
      ...(normalized.details !== undefined ? { details: normalized.details } : {}),
    };
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

  const payload = unwrapCliActionSuccessPayload(normalized.data);
  if (await tryHandleApprovalRequestCreated({ envelopeKind: kind, json, result: payload })) return;
  // The Action succeeded; the operation may still not have taken effect. The
  // presenter classifies that once, over the canonical payload, and the result
  // is reported with the same vocabulary as every other failure.
  const classified = presentation?.classifyResult?.(payload, context) ?? null;
  if (classified) {
    await reportFailure({
      json,
      kind,
      failure: classified,
      extraFields: presentation?.failureFields?.(classified, context) ?? null,
      humanSuffix: presentation?.describeFailure?.(classified, context) ?? null,
      unexpected: false,
      help: null,
    });
    return;
  }
  if (params.consumeSuccess && await params.consumeSuccess(payload)) return;
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
    await printJsonEnvelope({ ok: true, kind, data: payload });
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
      ...(command.acceptsServerId ? [SERVER_TRANSPORT_VALUE_FLAG] : []),
      ACTION_CLI_WHOLE_INPUT_FLAG,
      ...flags.valueFlags,
    ]),
  });
}

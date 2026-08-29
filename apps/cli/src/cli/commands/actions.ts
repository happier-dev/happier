import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { definitionList, renderHelpPage, sectionTitle } from '@happier-dev/cli-common/output';
import {
  ExternalActionRequestIdV1Schema,
  parseQualifiedPluginActionId,
  PublicActionIdSchema,
  type ActionExecuteFailure,
  type ActionExecuteResult,
  type PublicActionId,
  type PublicActionResultById,
} from '@happier-dev/protocol';

import type { CommandContext } from '@/cli/commandRegistry';
import { assertCommandArguments, readCommandPositionals, readFlagValue, readIntFlagValue, readRawFlagValue } from '@/cli/commands/shared/argvFlags';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { printJsonEnvelope, wantsJson, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import type { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

const SEARCH_USAGE = 'Usage: happier actions search [query...] [--limit <n>] [--machine-id <id>] [--json]';
const GET_USAGE = 'Usage: happier actions get <action-id> [--machine-id <id>] [--json]';
const INVOKE_USAGE = 'Usage: happier actions invoke <action-id> [--input-json <json>] [--request-id <id>] [--machine-id <id>] [--json]';

type Executor = Pick<ReturnType<typeof createCliActionExecutorFromCredentials>, 'execute'>;
type ExecutorParams = Parameters<typeof createCliActionExecutorFromCredentials>[0];
type ActionsDeps = Readonly<{
  readCredentialsFn: () => Promise<StoredCredentials | null>;
  createExecutorFn: (params: ExecutorParams) => Executor | Promise<Executor>;
}>;
type ActionCommandError = Error & Readonly<{
  actionFailure?: boolean;
  code?: unknown;
  candidates?: unknown;
  details?: unknown;
}>;
const DEFAULT_DEPS: ActionsDeps = {
  readCredentialsFn: readStoredCredentials,
  createExecutorFn: async (params) => (
    await import('@/session/actions/createCliActionExecutorFromCredentials')
  ).createCliActionExecutorFromCredentials(params),
};

function showHelp(): void {
  console.log(renderHelpPage({
    title: 'happier actions',
    subtitle: 'Discover and invoke built-in and contributed Actions',
    usage: [
      { label: 'happier actions search [query...] [options]', description: 'Search the Action catalog' },
      { label: 'happier actions get <action-id> [options]', description: 'Show one Action specification' },
      { label: 'happier actions invoke <action-id> [options]', description: 'Invoke an Action' },
    ],
    sections: [
      { title: 'Options:', rows: [
        { label: '--machine-id <id>', description: 'Target an exact machine' },
        { label: '--input-json <json>', description: 'Action input for invoke' },
        { label: '--request-id <id>', description: 'Request correlation identifier' },
        { label: '--limit <n>', description: 'Bound search results' },
        { label: '--json', description: 'Stable JSON envelope' },
      ] },
    ],
    notes: ['Use a query and --limit for a concise catalog search.', 'Contributed IDs use <pluginId>/actions/<localId>.', 'Authentication may come from happier auth login or HAPPIER_TOKEN.'],
  }));
}

function parseInput(raw: string | null): unknown {
  if (raw === null) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Invalid --input-json: expected JSON.'), { code: 'invalid_arguments' }); }
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
    surface: 'api' as const,
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
    || args.includes('--help')
    || args.includes('-h')
  ) { showHelp(); return; }
  const json = wantsJson(args);
  const usage = subcommand === 'search' ? SEARCH_USAGE : subcommand === 'get' ? GET_USAGE : INVOKE_USAGE;
  if (!['search', 'get', 'invoke'].includes(subcommand)) throw Object.assign(new Error(`Unknown actions subcommand: ${subcommand}\n${usage}`), { code: 'unknown_subcommand' });
  assertCommandArguments(args, {
    usage,
    startIndex: 1,
    booleanFlags: ['--json'],
    valueFlags: subcommand === 'search' ? ['--limit', '--machine-id'] : subcommand === 'get' ? ['--machine-id'] : ['--machine-id', '--input-json', '--request-id'],
    maxPositionals: subcommand === 'search' ? undefined : 1,
  });
  const positionals = readCommandPositionals(args, { startIndex: 1, valueFlags: ['--limit', '--machine-id', '--input-json', '--request-id'] });
  if (subcommand !== 'search' && !positionals[0]) throw Object.assign(new Error(usage), { code: 'invalid_arguments' });
  const credentials = await deps.readCredentialsFn();
  if (!credentials) throw Object.assign(new Error('Not authenticated. Run "happier auth login" first.'), { code: 'not_authenticated' });
  const machineId = readFlagValue(args, '--machine-id') ?? undefined;
  const executor = await deps.createExecutorFn({ credentials, externalActionClient: true, ...(machineId ? { machineId } : {}) });
  let actionId: PublicActionId;
  let input: unknown;
  if (subcommand === 'search') {
    actionId = 'action.spec.search';
    const limit = readIntFlagValue(args, '--limit', { min: 1, max: 100 });
    input = { query: positionals.join(' '), ...(limit === null ? {} : { limit }) };
  } else if (subcommand === 'get') {
    actionId = 'action.spec.get'; input = { id: positionals[0] };
  } else {
    const requested = positionals[0]!;
    const requestId = readRawFlagValue(args, '--request-id') ?? randomUUID();
    if (!ExternalActionRequestIdV1Schema.safeParse(requestId).success) {
      throw Object.assign(new Error('Invalid --request-id.'), { code: 'invalid_arguments' });
    }
    const contributed = parseQualifiedPluginActionId(requested);
    if (contributed) { actionId = 'action.invoke'; input = { action: contributed, input: parseInput(readFlagValue(args, '--input-json')) }; }
    else {
      const publicActionId = PublicActionIdSchema.safeParse(requested);
      if (!publicActionId.success) throw Object.assign(new Error(`Unknown Action id: ${requested}`), { code: 'invalid_arguments' });
      actionId = publicActionId.data;
      input = parseInput(readFlagValue(args, '--input-json'));
    }
    const options = { ...actionContext(signal), actionRequestId: requestId };
    const data = unwrapOuterActionResult(await executor.execute(actionId, input, options));
    if (json) await printJsonEnvelope({ ok: true, kind: 'actions_invoke', data }); else await writeJsonStdout(data, { pretty: true });
    return;
  }
  const data = unwrapOuterActionResult(await executor.execute(actionId, input, actionContext(signal)));
  if (json) { await printJsonEnvelope({ ok: true, kind: `actions_${subcommand}`, data }); return; }
  if (subcommand === 'search') {
    const rows = (data as PublicActionResultById['action.spec.search']).actionSpecs;
    console.log(rows.length ? definitionList(rows.map((row) => ({ label: row.id, value: [row.title, row.description].filter(Boolean).join(' — ') }))) : '(no matching Actions)');
    return;
  }
  const spec = (data as PublicActionResultById['action.spec.get']).actionSpec;
  console.log(sectionTitle('Action'));
  console.log(definitionList([
    { label: 'ID', value: spec.id },
    { label: 'Title', value: spec.title },
    { label: 'Description', value: spec.description ?? '' },
    { label: 'Safety', value: spec.safety },
  ].filter((row) => row.value)));
  console.log(sectionTitle('Input schema'));
  await writeJsonStdout(spec.inputSchema, { pretty: true });
}

export async function handleActionsCommand(args: string[], deps: Partial<ActionsDeps> = {}, signal?: AbortSignal): Promise<void> {
  try { await execute(args, { ...DEFAULT_DEPS, ...deps }, signal); }
  catch (error) {
    const candidate = error instanceof Error ? error as ActionCommandError : null;
    const mapped = candidate?.actionFailure === true
      ? { code: String(candidate.code ?? 'action_failed'), unexpected: false, message: candidate.message }
      : mapUnknownErrorToControlError(error);
    const structured = {
      code: mapped.code,
      ...(mapped.message ? { message: mapped.message } : {}),
      ...(candidate?.actionFailure === true && Array.isArray(candidate.candidates) ? { candidates: candidate.candidates } : {}),
      ...(candidate?.actionFailure === true && candidate.details !== undefined ? { details: candidate.details } : {}),
    };
    if (wantsJson(args)) await printJsonEnvelope({ ok: false, kind: `actions_${args[0] ?? 'help'}`, error: structured }, { exitCode: mapped.unexpected ? 2 : 1 });
    else {
      console.error(chalk.red('Error:'), mapped.message ?? mapped.code);
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

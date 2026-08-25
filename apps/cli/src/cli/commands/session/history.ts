import chalk from 'chalk';
import { randomUUID } from 'node:crypto';

import { ok } from '@happier-dev/cli-common/output';

import type { StoredCredentials } from '@/persistence';
import { readIntFlagValue, readFlagValue, hasFlag, hasFlagValue, readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeTranscriptHistoryResult } from '@/session/services/transcript/transcriptHistoryRows';
import {
  normalizeActionExecuteResult,
  type NormalizedCliActionExecuteResult,
} from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';
import { assertSessionCommandArguments } from './shared/assertSessionCommandArguments';
import { SESSION_HELP_LINES } from './shared/sessionCommandUsage';

const SESSION_HISTORY_FOLLOW_POLL_MS = 250;
const SESSION_HISTORY_USAGE = `Usage: ${SESSION_HELP_LINES.history}`;
const MAX_COMPACT_HISTORY_MESSAGE_CHARS = 2_000;
const MAX_COMPACT_HISTORY_MESSAGE_LINES = 24;
const COMPACT_HISTORY_TRUNCATION_SUFFIX = '… [truncated; use --json for full text]';

type SessionHistoryDependencies = Readonly<{
  readCredentialsFn: () => Promise<StoredCredentials | null>;
  signal?: AbortSignal;
}>;

type SessionActionExecutor = Pick<ReturnType<typeof createCliActionExecutorFromCredentials>, 'execute'>;

function throwNormalizedActionError(
  result: Extract<NormalizedCliActionExecuteResult, { ok: false }>,
): never {
  throw Object.assign(new Error(result.errorMessage ?? result.errorCode), {
    code: result.errorCode,
  });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function truncateCompactHistoryText(text: string): string {
  let end = Math.min(text.length, MAX_COMPACT_HISTORY_MESSAGE_CHARS);
  let lines = 1;
  for (let index = 0; index < end; index += 1) {
    if (text[index] !== '\n') continue;
    lines += 1;
    if (lines > MAX_COMPACT_HISTORY_MESSAGE_LINES) {
      end = index;
      break;
    }
  }
  if (end === text.length) return text;
  return `${text.slice(0, end).trimEnd()}\n${COMPACT_HISTORY_TRUNCATION_SUFFIX}`;
}

function formatCompactHistoryMessage(value: unknown): string {
  const message = readRecord(value);
  const role = typeof message?.role === 'string' && message.role.trim().length > 0
    ? message.role
    : 'unknown';
  const text = typeof message?.text === 'string' ? message.text : '';
  if (text.length > 0) {
    return `${role}: ${truncateCompactHistoryText(text)}`;
  }
  const kind = typeof message?.kind === 'string' && message.kind.trim().length > 0
    ? message.kind
    : null;
  return kind ? `${role} (${kind})` : role;
}

function readFollowPage(value: unknown): Readonly<{
  items: unknown[];
  nextCursor: string | null;
  truncated: boolean;
}> {
  const result = readRecord(value);
  if (!result || !Array.isArray(result.items)) {
    throw new Error('invalid_transcript_follow_result');
  }
  return {
    items: result.items,
    nextCursor: typeof result.nextCursor === 'string' && result.nextCursor.trim().length > 0
      ? result.nextCursor
      : null,
    truncated: result.truncated === true,
  };
}

function isSessionActive(value: unknown): boolean {
  const result = readRecord(value);
  const session = readRecord(result?.session);
  return session?.active === true;
}

async function waitForHistoryFollowPoll(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, SESSION_HISTORY_FOLLOW_POLL_MS);
    const onAbort = () => finish();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function followSessionHistory(params: Readonly<{
  sessionId: string;
  format: 'compact' | 'raw';
  includeMeta: boolean;
  includeStructuredPayload: boolean;
  jsonl: boolean;
  signal?: AbortSignal;
  executor: SessionActionExecutor;
}>): Promise<void> {
  const leaseId = randomUUID();
  const { followTranscriptSourceWithFiniteActions } = await import(
    '@happier-dev/agents/runtime/facets/transcriptSource'
  );
  await followTranscriptSourceWithFiniteActions({
    initialCursor: 'tail',
    leaseId,
    follow: async ({ cursor, leaseId: activeLeaseId }) => {
      const normalized = normalizeActionExecuteResult(await params.executor.execute(
        'transcript.follow',
        { sessionId: params.sessionId, cursor, leaseId: activeLeaseId },
        { surface: 'cli', defaultSessionId: null },
      ));
      if (!normalized.ok) {
        throwNormalizedActionError(normalized);
      }
      return readFollowPage(normalized.data);
    },
    release: async ({ leaseId: activeLeaseId }) => {
      const normalized = normalizeActionExecuteResult(await params.executor.execute(
        'transcript.unfollow',
        { sessionId: params.sessionId, leaseId: activeLeaseId },
        { surface: 'cli', defaultSessionId: null },
      ));
      if (!normalized.ok) {
        throwNormalizedActionError(normalized);
      }
    },
    isSessionActive: async () => {
      const normalized = normalizeActionExecuteResult(await params.executor.execute(
        'session.status.get',
        { sessionId: params.sessionId },
        { surface: 'cli', defaultSessionId: null },
      ));
      if (!normalized.ok) {
        throwNormalizedActionError(normalized);
      }
      return isSessionActive(normalized.data);
    },
    waitForNextPoll: async () => await waitForHistoryFollowPoll(params.signal),
    shouldContinue: () => !params.signal?.aborted,
    onItems: async (page) => {
      const result = normalizeTranscriptHistoryResult({
        sessionId: params.sessionId,
        format: params.format,
        items: page.items,
      }, params.format, {
        includeMeta: params.includeMeta,
        includeStructuredPayload: params.includeStructuredPayload,
      });
      for (const message of result.messages) {
        if (params.jsonl || params.format === 'raw') {
          await writeJsonStdout(message, { pretty: !params.jsonl && process.stdout.isTTY === true });
        } else {
          console.log(formatCompactHistoryMessage(message));
        }
      }
    },
  });
}

export async function cmdSessionHistory(
  argv: string[],
  deps: SessionHistoryDependencies,
): Promise<void> {
  assertSessionCommandArguments(argv, {
    usage: SESSION_HISTORY_USAGE,
    startIndex: 1,
    booleanFlags: ['--raw', '--include-meta', '--include-structured-payload', '--json', '--follow', '--jsonl'],
    valueFlags: ['--tail', '--limit', '--format', '--machine-id'],
    maxPositionals: 1,
  });
  const json = wantsJson(argv);
  const follow = hasFlag(argv, '--follow');
  const jsonl = hasFlag(argv, '--jsonl');

  const [idOrPrefix = ''] = readCommandPositionals(argv, { startIndex: 1, valueFlags: ['--tail', '--limit', '--format', '--machine-id'] });
  if (!idOrPrefix) {
    throw new Error(SESSION_HISTORY_USAGE);
  }

  if (hasFlagValue(argv, '--tail') && hasFlagValue(argv, '--limit')) {
    throw Object.assign(new Error('--tail conflicts with --limit; provide only one transcript limit.'), {
      code: 'invalid_arguments',
    });
  }
  if (follow && (hasFlagValue(argv, '--tail') || hasFlagValue(argv, '--limit'))) {
    throw Object.assign(new Error('--tail and --limit are only supported for snapshot history.'), {
      code: 'invalid_arguments',
    });
  }
  const limitRaw = readIntFlagValue(argv, '--tail', { min: 1 })
    ?? readIntFlagValue(argv, '--limit', { min: 1 });
  const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 250) : 50;
  const formatFlag = (readFlagValue(argv, '--format') ?? 'compact').trim();
  if (formatFlag !== 'compact' && formatFlag !== 'raw') {
    throw new Error(`Invalid --format value "${formatFlag}". Expected one of: compact, raw.`);
  }
  const format = hasFlag(argv, '--raw') ? 'raw' : formatFlag;
  const includeMeta = hasFlag(argv, '--include-meta');
  const includeStructuredPayload = hasFlag(argv, '--include-structured-payload');
  const machineId = readFlagValue(argv, '--machine-id');

  if (follow && json) {
    await printJsonEnvelope({
      ok: false,
      kind: 'session_history',
      error: { code: 'invalid_arguments', message: '--follow requires --jsonl instead of --json.' },
    }, { exitCode: 1 });
    return;
  }
  if (jsonl && !follow) {
    throw new Error('Usage: happier session history <session-id-or-prefix> --follow --jsonl');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json || jsonl) {
      await printJsonEnvelope({ ok: false, kind: 'session_history', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const actionExecutor = createCliActionExecutorFromCredentials({
    credentials,
    ...(machineId !== null ? { machineId } : {}),
  });
  const executor = deps.signal ? actionExecutor.bindInvocation(deps.signal) : actionExecutor;
  if (follow) {
    await followSessionHistory({
      sessionId: idOrPrefix,
      format,
      includeMeta,
      includeStructuredPayload,
      jsonl,
      ...(deps.signal ? { signal: deps.signal } : {}),
      executor,
    });
    return;
  }
  const actionRes = await executor.execute(
    'session.transcript.get',
    {
      sessionId: idOrPrefix,
      limit: Math.min(limit, 100),
      scope: 'all',
      includeTools: true,
      includeReasoning: true,
      includeEvents: true,
      includeRaw: true,
      maxRawPayloadChars: 32768,
      ...(includeMeta ? { includeMeta: true } : {}),
      ...(includeStructuredPayload ? { includeStructuredPayload: true } : {}),
    },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes as any);
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_history',
        error: {
          code: normalized.errorCode,
          ...(normalized.candidates ? { candidates: normalized.candidates } : {}),
          ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}),
        },
      });
      return;
    }
    throw new Error(normalized.errorCode);
  }

  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'session_history', json, result: normalized.data })) {
    return;
  }

  const result = normalizeTranscriptHistoryResult(normalized.data, format, {
    includeMeta,
    includeStructuredPayload,
  });
  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'session_history',
      data: { sessionId: result.sessionId, format: result.format, messages: result.messages },
    });
    return;
  }

  if (result.format === 'raw') {
    for (const message of result.messages) {
      await writeJsonStdout(message, { pretty: true });
    }
  } else {
    for (const message of result.messages) {
      console.log(formatCompactHistoryMessage(message));
    }
  }
  console.log(ok(`History fetched (${result.messages.length} messages)`));
}

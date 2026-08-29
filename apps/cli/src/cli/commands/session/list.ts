import type { StoredCredentials } from '@/persistence';
import { readFlagValue, readIntFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { renderSessionListTable } from '@/ui/renderSessionListTable';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { assertSessionCommandArguments } from '@/cli/commands/session/shared/assertSessionCommandArguments';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { configuration } from '@/configuration';
import { cmd, errorFrame, gray, yellow } from '@happier-dev/cli-common/output';
import { SessionListResultSchema } from '@happier-dev/protocol';

const SESSION_LIST_USAGE = `Usage: ${SESSION_HELP_LINES.list}`;
const SESSION_LIST_BOOLEAN_FLAGS = ['--active', '--archived', '--include-system', '--resumable', '--plain', '--json'] as const;
const SESSION_LIST_VALUE_FLAGS = ['--limit', '--cursor', '--machine-id'] as const;

function assertValidSessionListArguments(argv: readonly string[]): void {
  assertSessionCommandArguments(argv, {
    usage: SESSION_LIST_USAGE,
    startIndex: 1,
    booleanFlags: SESSION_LIST_BOOLEAN_FLAGS,
    valueFlags: SESSION_LIST_VALUE_FLAGS,
    inlineValueFlags: [],
    maxPositionals: 0,
  });
}

export async function cmdSessionList(
  argv: string[],
  deps: Readonly<{
    readCredentialsFn: () => Promise<StoredCredentials | null>;
    signal?: AbortSignal;
  }>,
): Promise<void> {
  assertValidSessionListArguments(argv);

  const json = wantsJson(argv);
  const activeOnly = hasFlag(argv, '--active');
  const archivedOnly = hasFlag(argv, '--archived');
  const includeSystem = hasFlag(argv, '--include-system');
  const plain = hasFlag(argv, '--plain');
  const resumableOnly = hasFlag(argv, '--resumable');
  const limitRaw = readIntFlagValue(argv, '--limit', { min: 1 });
  const limit = limitRaw !== null ? Math.min(limitRaw, 200) : undefined;
  const cursor = (readFlagValue(argv, '--cursor') ?? '').trim();
  const machineId = readFlagValue(argv, '--machine-id');

  if (hasFlag(argv, '--cursor') && !cursor) {
    throw new Error(SESSION_LIST_USAGE);
  }

  if (activeOnly && archivedOnly) {
    throw new Error(SESSION_LIST_USAGE);
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_list', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(errorFrame('Error:', [`Not authenticated. Run ${cmd('happier auth login')} first.`]));
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({
    credentials,
    ...(machineId !== null ? { machineId } : {}),
  });
  // The public PAT Action relay deliberately permits caller-owned lifetimes
  // for long-running Actions. Session listing is finite, so retain the same
  // bounded HTTP lifetime as the stored-credential list path instead of
  // leaving a disconnected daemon relay pending indefinitely.
  const requestSignal = deps.signal
    ? AbortSignal.any([deps.signal, AbortSignal.timeout(configuration.sessionControlHttpTimeoutMs)])
    : AbortSignal.timeout(configuration.sessionControlHttpTimeoutMs);
  const actionRes = await executor.execute(
    'session.list',
    {
      ...(activeOnly ? { activeOnly: true } : {}),
      ...(archivedOnly ? { archivedOnly: true } : {}),
      ...(includeSystem ? { includeSystem: true } : {}),
      ...(resumableOnly ? { resumableOnly: true } : {}),
      ...(limit ? { limit } : {}),
      ...(cursor ? { cursor } : {}),
      ...(!json ? { includeRows: true } : {}),
    },
    { surface: 'cli', defaultSessionId: null, signal: requestSignal },
  );
  const result = normalizeActionExecuteResult(actionRes);
  if (!result.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_list',
        error: {
          code: result.errorCode,
          ...(result.errorMessage ? { message: result.errorMessage } : {}),
          ...(result.candidates ? { candidates: result.candidates } : {}),
        },
      });
      return;
    }
    throw new Error(result.errorMessage ?? result.errorCode);
  }
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'session_list', json, result: result.data })) {
    return;
  }
  const payload = SessionListResultSchema.parse(result.data);
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const nextCursor = typeof payload?.nextCursor === 'string' ? payload.nextCursor : payload?.nextCursor === null ? null : null;
  const hasNext = payload?.hasNext === true;

  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'session_list',
      data: {
        sessions,
        nextCursor,
        hasNext,
      },
    });
    return;
  }

  if (plain) {
    for (const row of rows) {
      const systemSuffix =
        includeSystem && row.isSystem
          ? ` ${yellow(`[system${row.systemPurpose ? `:${row.systemPurpose}` : ''}]`)}`
          : '';
      console.log(`${row.id}${systemSuffix}${row.tag ? ` ${gray(row.tag)}` : ''}${row.path ? ` ${gray(row.path)}` : ''}`);
    }
    if (rows.length === 0) {
      for (const session of sessions) {
        const id = typeof session?.id === 'string' ? session.id : '';
        if (id) console.log(id);
      }
    }
    return;
  }

  for (const line of renderSessionListTable({ rows })) {
    console.log(line);
  }
}

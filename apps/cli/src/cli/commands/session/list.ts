import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { readFlagValue, readIntFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { renderSessionListTable } from '@/ui/renderSessionListTable';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';

const SESSION_LIST_USAGE = 'Usage: happier session list [--active] [--archived] [--limit N] [--cursor C] [--include-system] [--resumable] [--plain] [--json]';
const SESSION_LIST_BOOLEAN_FLAGS = new Set(['--active', '--archived', '--include-system', '--resumable', '--plain', '--json']);
const SESSION_LIST_VALUE_FLAGS = new Set(['--limit', '--cursor']);

function assertValidSessionListArguments(argv: readonly string[]): void {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (SESSION_LIST_BOOLEAN_FLAGS.has(argument)) continue;
    if (SESSION_LIST_VALUE_FLAGS.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error(SESSION_LIST_USAGE);
      index += 1;
      continue;
    }
    throw new Error(SESSION_LIST_USAGE);
  }
}

export async function cmdSessionList(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
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
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
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
    { surface: 'cli', defaultSessionId: null },
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
  const payload = result.data as any;
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'session_list', json, result: payload })) {
    return;
  }
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
          ? ` ${chalk.yellow(`[system${row.systemPurpose ? `:${row.systemPurpose}` : ''}]`)}`
          : '';
      console.log(`${row.id}${systemSuffix}${row.tag ? ` ${chalk.gray(row.tag)}` : ''}${row.path ? ` ${chalk.gray(row.path)}` : ''}`);
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

import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { readIntFlagValue, readFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { renderSessionListTable } from '@/ui/renderSessionListTable';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';

export async function cmdSessionList(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const activeOnly = hasFlag(argv, '--active');
  const archivedOnly = hasFlag(argv, '--archived');
  const includeSystem = hasFlag(argv, '--include-system');
  const plain = hasFlag(argv, '--plain');
  const resumableOnly = hasFlag(argv, '--resumable');
  const limitRaw = readIntFlagValue(argv, '--limit');
  const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : undefined;
  const cursor = (readFlagValue(argv, '--cursor') ?? '').trim();

  if (activeOnly && archivedOnly) {
    throw new Error('Usage: happier session list [--active] [--archived] [--limit N] [--cursor C] [--include-system] [--resumable] [--plain] [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_list', error: { code: 'not_authenticated' } });
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
    },
    { surface: 'cli', defaultSessionId: null },
  );
  const result = normalizeActionExecuteResult(actionRes);
  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
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
  if (tryHandleApprovalRequestCreated({ envelopeKind: 'session_list', json, result: payload })) {
    return;
  }
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const nextCursor = typeof payload?.nextCursor === 'string' ? payload.nextCursor : payload?.nextCursor === null ? null : null;
  const hasNext = payload?.hasNext === true;

  if (json) {
    printJsonEnvelope({
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

import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { readIntFlagValue, readFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { renderSessionListTable } from '@/ui/renderSessionListTable';
import { listSessions } from '@/session/services/listSessions';

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
  const cursor = readFlagValue(argv, '--cursor') ?? '';

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

  const result = await listSessions({
    credentials,
    activeOnly,
    archivedOnly,
    includeSystem,
    resumableOnly,
    ...(cursor ? { cursor } : {}),
    ...(limit ? { limit } : {}),
  });

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_list',
      data: {
        sessions: result.sessions,
        nextCursor: result.nextCursor,
        hasNext: result.hasNext,
      },
    });
    return;
  }

  if (plain) {
    for (const row of result.rows) {
      const systemSuffix =
        includeSystem && row.isSystem
          ? ` ${chalk.yellow(`[system${row.systemPurpose ? `:${row.systemPurpose}` : ''}]`)}`
          : '';
      console.log(`${row.id}${systemSuffix}${row.tag ? ` ${chalk.gray(row.tag)}` : ''}${row.path ? ` ${chalk.gray(row.path)}` : ''}`);
    }
    return;
  }

  for (const line of renderSessionListTable({ rows: result.rows })) {
    console.log(line);
  }
}

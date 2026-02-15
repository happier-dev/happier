import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { fetchSessionsPage } from '@/sessionControl/sessionsHttp';
import { readIntFlagValue, readFlagValue, hasFlag } from '@/sessionControl/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { summarizeSessionRow } from '@/sessionControl/sessionSummary';

export async function cmdSessionList(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const activeOnly = hasFlag(argv, '--active');
  const limitRaw = readIntFlagValue(argv, '--limit');
  const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : undefined;
  const cursor = readFlagValue(argv, '--cursor') ?? '';

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_list', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const page = await fetchSessionsPage({
    token: credentials.token,
    ...(cursor ? { cursor } : {}),
    ...(limit ? { limit } : {}),
    activeOnly,
  });

  const sessions = page.sessions.map((row) => summarizeSessionRow({ credentials, row }));

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_list',
      data: {
        sessions,
        nextCursor: page.nextCursor,
        hasNext: page.hasNext,
      },
    });
    return;
  }

  for (const s of sessions) {
    console.log(`${s.id}${s.tag ? ` ${chalk.gray(s.tag)}` : ''}${s.path ? ` ${chalk.gray(s.path)}` : ''}`);
  }
}


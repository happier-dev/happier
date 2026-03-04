import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { fetchSessionsPage } from '@/sessionControl/sessionsHttp';
import { readIntFlagValue, readFlagValue, hasFlag } from '@/sessionControl/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { summarizeSessionRow } from '@/sessionControl/sessionSummary';
import { buildCliSessionRowModel } from '@/sessionControl/buildCliSessionRowModel';
import { renderSessionListTable } from '@/ui/renderSessionListTable';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

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

  const page = await fetchSessionsPage({
    token: credentials.token,
    ...(cursor ? { cursor } : {}),
    ...(limit ? { limit } : {}),
    activeOnly,
    archivedOnly,
  });

  const accountSettingsContext = await bootstrapAccountSettingsContext({ credentials, mode: 'fast' });
  const rowModels = page.sessions
    .map((row) => buildCliSessionRowModel({ credentials, rawSession: row, accountSettings: accountSettingsContext.settings }))
    .filter((row) => includeSystem || row.isSystem !== true);

  const filteredRows = resumableOnly
    ? rowModels.filter((row) => row.vendorResume.eligible === true && row.archivedAt === null && row.active !== true)
    : rowModels;

  if (json) {
    const allowedSessionIds = resumableOnly ? new Set(filteredRows.map((row) => row.id)) : null;
    const sessions = page.sessions
      .map((row) => summarizeSessionRow({ credentials, row }))
      .filter((session) => includeSystem || session.isSystem !== true)
      .filter((session) => !allowedSessionIds || allowedSessionIds.has(session.id));
    const rowById = new Map(filteredRows.map((row) => [row.id, row] as const));
    printJsonEnvelope({
      ok: true,
      kind: 'session_list',
      data: {
        sessions: sessions.map((session) => {
          const row = rowById.get(session.id);
          if (!row) return session;
          return {
            ...session,
            agentId: row.agentId,
            vendorResumeEligible: row.vendorResume.eligible,
            ...(row.vendorResume.eligible ? {} : { vendorResumeReasonCode: row.vendorResume.reasonCode }),
          };
        }),
        nextCursor: page.nextCursor,
        hasNext: page.hasNext,
      },
    });
    return;
  }

  if (plain) {
    for (const row of filteredRows) {
      const systemSuffix =
        includeSystem && row.isSystem
          ? ` ${chalk.yellow(`[system${row.systemPurpose ? `:${row.systemPurpose}` : ''}]`)}`
          : '';
      console.log(`${row.id}${systemSuffix}${row.tag ? ` ${chalk.gray(row.tag)}` : ''}${row.path ? ` ${chalk.gray(row.path)}` : ''}`);
    }
    return;
  }

  for (const line of renderSessionListTable({ rows: filteredRows })) {
    console.log(line);
  }
}

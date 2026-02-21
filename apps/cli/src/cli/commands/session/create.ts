import chalk from 'chalk';
import os from 'node:os';

import type { Credentials } from '@/persistence';
import { fetchSessionsPage, getOrCreateSessionByTag } from '@/sessionControl/sessionsHttp';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { summarizeSessionRecord } from '@/sessionControl/sessionSummary';
import { readFlagValue, hasFlag } from '@/sessionControl/argvFlags';
import { tryDecryptSessionMetadata } from '@/sessionControl/sessionEncryptionContext';

async function tagExists(params: Readonly<{ credentials: Credentials; tag: string }>): Promise<boolean> {
  const maxPagesRaw = (process.env.HAPPIER_SESSION_ID_PREFIX_SCAN_MAX_PAGES ?? '').trim();
  const maxPagesParsed = maxPagesRaw ? Number.parseInt(maxPagesRaw, 10) : NaN;
  const maxPages = Number.isFinite(maxPagesParsed) && maxPagesParsed > 0 ? Math.min(50, maxPagesParsed) : 10;

  const scan = async (archivedOnly: boolean): Promise<boolean> => {
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await fetchSessionsPage({ token: params.credentials.token, cursor, limit: 200, archivedOnly });
      for (const row of page.sessions) {
        const meta = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: row });
        const rowTag = typeof (meta as any)?.tag === 'string' ? String((meta as any).tag).trim() : '';
        if (rowTag && rowTag === params.tag) return true;
      }
      if (!page.hasNext || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return false;
  };

  if (await scan(false)) return true;
  return await scan(true);
}

export async function cmdSessionCreate(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const tag = (readFlagValue(argv, '--tag') ?? '').trim();
  const path = (readFlagValue(argv, '--path') ?? process.cwd()).trim();
  const host = (readFlagValue(argv, '--host') ?? os.hostname()).trim();
  const title = (readFlagValue(argv, '--title') ?? '').trim();
  const noLoadExisting = hasFlag(argv, '--no-load-existing');

  if (!tag) {
    throw new Error(
      'Usage: happier session create --tag <tag> [--title <text>] [--path <path>] [--host <host>] [--no-load-existing] [--json]',
    );
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_create', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const existed = await tagExists({ credentials, tag });
  if (existed && noLoadExisting) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_create', error: { code: 'already_exists' } });
      return;
    }
    console.error(chalk.red('Error:'), `Session tag already exists: ${tag}`);
    process.exit(1);
  }

  const { session } = await getOrCreateSessionByTag({
    credentials,
    tag,
    metadata: {
      tag,
      path,
      host,
      ...(title ? { summary: { text: title, updatedAt: Date.now() } } : {}),
    },
    agentState: null,
  });

  const summary = summarizeSessionRecord({ credentials, session });
  const created = !existed;

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_create', data: { session: summary, created } });
    return;
  }

  console.log(chalk.green('✓'), created ? 'session created' : 'session loaded');
  console.log(JSON.stringify({ created, session: summary }, null, 2));
}

import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { readIntFlagValue, readFlagValue, hasFlag, readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeTranscriptHistoryResult } from '@/session/services/transcript/transcriptHistoryRows';
import { normalizeActionExecuteResult } from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';

export async function cmdSessionHistory(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);

  const [idOrPrefix = ''] = readCommandPositionals(argv, { startIndex: 1, valueFlags: ['--limit', '--format'] });
  if (!idOrPrefix) {
    throw new Error('Usage: happier session history <session-id-or-prefix> [--limit <n>] [--format <compact|raw>] [--raw] [--json]');
  }

  const limitRaw = readIntFlagValue(argv, '--limit', { min: 1 });
  const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 250) : 50;
  const formatFlag = (readFlagValue(argv, '--format') ?? 'compact').trim();
  if (formatFlag !== 'compact' && formatFlag !== 'raw') {
    throw new Error(`Invalid --format value "${formatFlag}". Expected one of: compact, raw.`);
  }
  const format = hasFlag(argv, '--raw') ? 'raw' : formatFlag;
  const includeMeta = hasFlag(argv, '--include-meta');
  const includeStructuredPayload = hasFlag(argv, '--include-structured-payload');

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_history', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
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

  console.log(chalk.green('✓'), `history fetched (${result.messages.length} messages)`);
  await writeJsonStdout({ sessionId: result.sessionId, messages: result.messages }, { pretty: true });
}

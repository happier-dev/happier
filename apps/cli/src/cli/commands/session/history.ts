import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { readIntFlagValue, readFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';

export async function cmdSessionHistory(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);

  const idOrPrefix = String(argv[1] ?? '').trim();
  if (!idOrPrefix) {
    throw new Error('Usage: happier session history <session-id-or-prefix> [--limit <n>] [--format <compact|raw>] [--json]');
  }

  const limitRaw = readIntFlagValue(argv, '--limit');
  const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 250) : 50;
  const format = (readFlagValue(argv, '--format') ?? 'compact').trim();
  const includeMeta = hasFlag(argv, '--include-meta');
  const includeStructuredPayload = hasFlag(argv, '--include-structured-payload');

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_history', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const normalizedFormat = format === 'raw' ? 'raw' : 'compact';
  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'session.history.get',
    {
      sessionId: idOrPrefix,
      limit,
      format: normalizedFormat,
      ...(includeMeta ? { includeMeta: true } : {}),
      ...(includeStructuredPayload ? { includeStructuredPayload: true } : {}),
    },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes as any);
  if (!normalized.ok) {
    if (json) {
      printJsonEnvelope({
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

  const result = normalized.data as any;
  if (tryHandleApprovalRequestCreated({ envelopeKind: 'session_history', json, result })) {
    return;
  }

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_history',
      data: { sessionId: result.sessionId, format: result.format, messages: result.messages },
    });
    return;
  }

  console.log(chalk.green('✓'), `history fetched (${result.messages.length} messages)`);
  console.log(JSON.stringify({ sessionId: result.sessionId, messages: result.messages }, null, 2));
}

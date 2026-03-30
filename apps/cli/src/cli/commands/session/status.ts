import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { hasFlag } from '@/cli/commands/shared/argvFlags';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';

export async function cmdSessionStatus(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const live = hasFlag(argv, '--live');
  const idOrPrefix = String(argv[1] ?? '').trim();
  if (!idOrPrefix) {
    throw new Error('Usage: happier session status <session-id-or-prefix> [--live] [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_status', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'session.status.get',
    { sessionId: idOrPrefix, ...(live ? { live: true } : {}) },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes as any);
  if (!normalized.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_status',
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
  if (tryHandleApprovalRequestCreated({ envelopeKind: 'session_status', json, result })) {
    return;
  }

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_status',
      data: { session: result.session, ...(result.agentState ? { agentState: result.agentState } : {}) },
    });
    return;
  }

  console.log(chalk.green('✓'), 'status fetched');
  console.log(JSON.stringify({ session: result.session, agentState: result.agentState }, null, 2));
}

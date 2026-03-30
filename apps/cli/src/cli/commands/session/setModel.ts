import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';

function normalizeModelIdOrThrow(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    const err = new Error('Missing model id');
    (err as any).code = 'invalid_arguments';
    throw err;
  }
  return trimmed;
}

export async function cmdSessionSetModel(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[1] ?? '').trim();
  const rawModelId = String(argv[2] ?? '').trim();
  if (!idOrPrefix || !rawModelId) {
    throw new Error('Usage: happier session set-model <session-id-or-prefix> <model-id> [--json]');
  }

  const modelId = normalizeModelIdOrThrow(rawModelId);

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_set_model', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'session.model.set',
    { sessionId: idOrPrefix, modelId },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes as any);
  if (!normalized.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_set_model',
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
  if (tryHandleApprovalRequestCreated({ envelopeKind: 'session_set_model', json, result })) {
    return;
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_set_model', data: { sessionId: result.sessionId, modelId: result.modelId ?? modelId, updatedAt: result.updatedAt ?? null } });
    return;
  }

  console.log(chalk.green('✓'), `model set for ${result.sessionId}: ${result.modelId ?? modelId}`);
}

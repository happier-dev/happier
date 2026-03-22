import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { setSessionModel } from '@/session/services/setSessionModel';

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

  const updatedAt = Date.now();
  const result = await setSessionModel({
    credentials,
    idOrPrefix,
    modelId,
    updatedAt,
  });
  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_set_model',
        error: { code: result.code, ...(result.candidates ? { candidates: result.candidates } : {}) },
      });
      return;
    }
    throw new Error(result.code);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_set_model', data: { sessionId: result.sessionId, modelId, updatedAt } });
    return;
  }

  console.log(chalk.green('✓'), `model set for ${result.sessionId}: ${modelId}`);
}

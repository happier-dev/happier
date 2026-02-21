import chalk from 'chalk';

import { computeNextMetadataStringOverrideV1 } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { updateSessionMetadataWithRetry } from '@/sessionControl/updateSessionMetadataWithRetry';

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

  const resolved = await resolveSessionIdOrPrefix({ credentials, idOrPrefix });
  if (!resolved.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_set_model',
        error: { code: resolved.code, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
      });
      return;
    }
    throw new Error(resolved.code);
  }
  const sessionId = resolved.sessionId;

  const rawSession = await fetchSessionById({ token: credentials.token, sessionId });
  if (!rawSession) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_set_model', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const updatedAt = Date.now();
  await updateSessionMetadataWithRetry({
    token: credentials.token,
    credentials,
    sessionId,
    rawSession,
    updater: (metadata) =>
      computeNextMetadataStringOverrideV1({
        metadata,
        overrideKey: 'modelOverrideV1',
        valueKey: 'modelId',
        value: modelId,
        updatedAt,
      }),
  });

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_set_model', data: { sessionId, modelId, updatedAt } });
    return;
  }

  console.log(chalk.green('✓'), `model set for ${sessionId}: ${modelId}`);
}


import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { readProviderConnectionFlag } from './shared/readProviderConnectionFlag';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';

const SESSION_SET_MODEL_USAGE =
  'Usage: happier session set-model <session-id-or-prefix> <model-id> [--provider-connection <id|native>] [--json]';

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
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = '', rawModelId = ''] = readCommandPositionals(argv, {
    startIndex: 1,
    valueFlags: ['--provider-connection'],
  });
  if (!idOrPrefix || !rawModelId) {
    throw new Error(SESSION_SET_MODEL_USAGE);
  }

  const modelId = normalizeModelIdOrThrow(rawModelId);
  const providerConnectionId = readProviderConnectionFlag(argv);

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_set_model', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'session.model.set',
    {
      sessionId: idOrPrefix,
      modelId,
      ...(providerConnectionId !== undefined ? { providerConnectionId } : {}),
    },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes as any);
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_set_model',
        error: {
          code: normalized.errorCode,
          ...(normalized.candidates ? { candidates: normalized.candidates } : {}),
          ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}),
          ...(normalized.details !== undefined ? { details: normalized.details } : {}),
        },
      });
      return;
    }
    throw new Error(normalized.errorCode);
  }

  const result = unwrapCliActionSuccessPayload(normalized.data) as any;
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'session_set_model', json, result })) {
    return;
  }

  const selection = result.activeSelection ?? result.selection ?? null;
  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'session_set_model',
      data: {
        ...result,
        modelId: selection?.modelId ?? modelId,
        updatedAt: result.updatedAt ?? null,
      },
    });
    return;
  }

  console.log(
    chalk.green('✓'),
    `model ${result.status ?? 'updated'} for ${result.sessionId}: ${selection?.modelId ?? modelId}`,
  );
}

import { errorFrame, ok } from '@happier-dev/cli-common/output';

import type { StoredCredentials } from '@/persistence';
import { readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';

export async function cmdSessionSetTitle(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = '', title = ''] = readCommandPositionals(argv, { startIndex: 1 });
  if (!idOrPrefix || !title) {
    throw new Error('Usage: happier session set-title <session-id-or-prefix> <title> [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_set_title', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(errorFrame('Error:', ['Not authenticated. Run "happier auth login" first.']));
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'session.title.set',
    { sessionId: idOrPrefix, title },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes as any);
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_set_title',
        error: { code: normalized.errorCode, ...(normalized.candidates ? { candidates: normalized.candidates } : {}), ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(normalized.errorCode);
  }

  const result = normalized.data as any;
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'session_set_title', json, result })) {
    return;
  }
  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_set_title', data: { sessionId: result.sessionId, title } });
    return;
  }
  console.log(ok(`Title set for ${result.sessionId}`));
}

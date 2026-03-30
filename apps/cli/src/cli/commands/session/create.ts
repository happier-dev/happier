import chalk from 'chalk';

import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';
import { readFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { normalizeBackendTargetKeysFromCsv } from '@/cli/commands/session/shared/normalizeBackendTargetKeys';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import type { Credentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { resolveRequestedSessionDirectory } from '@/agent/runtime/resolveRequestedSessionDirectory';

export async function cmdSessionCreate(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const path = resolveRequestedSessionDirectory({
    requestedDirectory: readFlagValue(argv, '--path') ?? null,
  });
  const tag = (readFlagValue(argv, '--tag') ?? '').trim();
  const title = (readFlagValue(argv, '--title') ?? '').trim();
  const initialPrompt = (readFlagValue(argv, '--message') ?? readFlagValue(argv, '--prompt') ?? '').trim();
  const backendRaw = (readFlagValue(argv, '--backend') ?? '').trim();
  const backendTargetKeys = normalizeBackendTargetKeysFromCsv(backendRaw);
  const backendTargetKey = backendTargetKeys.length === 1 ? backendTargetKeys[0] : null;
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    throw new Error(
      'Usage: happier session create [--path <path>] [--backend <backend-target>] [--title <text>] [--tag <tag>] [--prompt <text>|--message <text>] [--json]',
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

  if (backendRaw && !backendTargetKey) {
    throw new Error(
      'Usage: happier session create [--path <path>] [--backend <backend-target>] [--title <text>] [--tag <tag>] [--prompt <text>|--message <text>] [--json]',
    );
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  let actionRes;
  try {
    actionRes = await executor.execute(
      'session.spawn_new',
      {
        path,
        ...(backendTargetKey ? { backendTargetKey } : { agentId: DEFAULT_CATALOG_AGENT_ID }),
        ...(title ? { title } : {}),
        ...(tag ? { tag } : {}),
        ...(initialPrompt ? { initialMessage: initialPrompt } : {}),
      },
      { surface: 'cli', defaultSessionId: null },
    );
  } catch (error) {
    const mapped = mapUnknownErrorToControlError(error);
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_create',
        error: {
          code: mapped.code,
          ...(mapped.message ? { message: mapped.message } : {}),
          ...(((error as { details?: unknown })?.details !== undefined) ? { details: (error as { details?: unknown }).details } : {}),
        },
      });
      return;
    }
    throw Object.assign(new Error(mapped.message ?? (error instanceof Error ? error.message : 'Failed to create session')), {
      code: mapped.code,
    });
  }

  const result = normalizeActionExecuteResult(actionRes);
  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_create',
        error: {
          code: result.errorCode,
          ...(result.errorMessage ? { message: result.errorMessage } : {}),
          ...(result.candidates ? { candidates: result.candidates } : {}),
        },
      });
      return;
    }
    throw Object.assign(new Error(result.errorMessage ?? result.errorCode), { code: result.errorCode });
  }
  const created = result.data as any;
  if (tryHandleApprovalRequestCreated({ envelopeKind: 'session_create', json, result: created })) {
    return;
  }
  if (!created || typeof created !== 'object') {
    throw new Error('session_create_failed');
  }
  if (created.type === 'error') {
    const code = typeof created.errorCode === 'string' ? created.errorCode : 'session_create_failed';
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_create',
        error: {
          code,
          ...(typeof created.errorMessage === 'string' && created.errorMessage.trim().length > 0 ? { message: created.errorMessage } : {}),
          ...(typeof created.host === 'string' && created.host.trim().length > 0 ? { host: created.host } : {}),
        },
      });
      return;
    }
    throw Object.assign(new Error(code), { code });
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_create', data: { session: created.session, created: created.created } });
    return;
  }

  console.log(chalk.green('✓'), 'session created');
  console.log(JSON.stringify({ created: true, session: created.session }, null, 2));
}

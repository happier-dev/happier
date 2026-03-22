import chalk from 'chalk';

import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';
import { readFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { parseSingleBackendTargetFromFlag } from '@/cli/commands/session/shared/parseSingleBackendTargetFromFlag';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import type { Credentials } from '@/persistence';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';

export async function cmdSessionCreate(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const path = (readFlagValue(argv, '--path') ?? process.cwd()).trim();
  const tag = (readFlagValue(argv, '--tag') ?? '').trim();
  const title = (readFlagValue(argv, '--title') ?? '').trim();
  const initialPrompt = (readFlagValue(argv, '--message') ?? readFlagValue(argv, '--prompt') ?? '').trim();
  const backendRaw = (readFlagValue(argv, '--backend') ?? '').trim();
  if (hasFlag(argv, '--host') || hasFlag(argv, '--no-load-existing')) {
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

  const backendTarget = (() => {
    if (!backendRaw) {
      return { kind: 'builtInAgent', agentId: DEFAULT_CATALOG_AGENT_ID } as const;
    }
    return parseSingleBackendTargetFromFlag(backendRaw);
  })();
  if (!backendTarget) {
    throw new Error(
      'Usage: happier session create [--path <path>] [--backend <backend-target>] [--title <text>] [--tag <tag>] [--prompt <text>|--message <text>] [--json]',
    );
  }

  let created: Awaited<ReturnType<typeof createSpawnedSession>>;
  try {
    created = await createSpawnedSession({
      credentials,
      directory: path,
      backendTarget,
      ...(title ? { title } : {}),
      ...(tag ? { tag } : {}),
      ...(initialPrompt ? { initialMessage: initialPrompt } : {}),
    });
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

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_create', data: { session: created.session, created: created.created } });
    return;
  }

  console.log(chalk.green('✓'), 'session created');
  console.log(JSON.stringify({ created: true, session: created.session }, null, 2));
}

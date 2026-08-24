import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import {
  hasBackendTargetSelectionFromCsv,
  resolveBackendTargetKeysFromCsv,
} from '../shared/normalizeBackendTargetKeys';
import { SESSION_HELP_LINES } from '../shared/sessionCommandUsage';
import { normalizeSessionStartActionResults } from '../shared/sessionStartActionResults';

export async function cmdSessionVoiceAgentStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = ''] = readCommandPositionals(argv, {
    startIndex: 2,
    valueFlags: ['--backends', '--backend', '--instructions', '--permission-mode', '--retention', '--run-class', '--io-mode'],
  });
  if (!idOrPrefix) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.voiceAgentStart}`);
  }

  const backendsRaw = readFlagValue(argv, '--backends') ?? readFlagValue(argv, '--backend');
  const instructions = readFlagValue(argv, '--instructions') ?? '';

  const permissionMode = readFlagValue(argv, '--permission-mode') ?? undefined;
  const retentionPolicy = readFlagValue(argv, '--retention') ?? undefined;
  const runClass = readFlagValue(argv, '--run-class') ?? undefined;
  const ioMode = readFlagValue(argv, '--io-mode') ?? undefined;

  if (!hasBackendTargetSelectionFromCsv(backendsRaw) || !instructions.trim()) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.voiceAgentStart}`);
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_voice_agent_start', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const sessionTarget = await executor.resolveSessionTarget(idOrPrefix);
  if (!sessionTarget.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_voice_agent_start',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId } = sessionTarget;

  const backendTargetKeys = await resolveBackendTargetKeysFromCsv({
    value: backendsRaw,
    actionId: 'voice_agent.start',
    sessionId,
    executor,
  });
  const input = {
    backendTargetKeys,
    instructions,
    ...(permissionMode ? { permissionMode } : null),
    ...(retentionPolicy ? { retentionPolicy } : null),
    ...(runClass ? { runClass } : null),
    ...(ioMode ? { ioMode } : null),
  };
  const started = await executor.execute('voice_agent.start', input, { defaultSessionId: sessionId });
  const normalized = normalizeSessionStartActionResults(started);

  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_voice_agent_start',
        error: {
          code: normalized.errorCode,
          ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}),
          ...(normalized.candidates ? { candidates: normalized.candidates } : {}),
        },
      });
      return;
    }
    console.error(chalk.red('Error:'), normalized.errorMessage ?? normalized.errorCode);
    process.exit(1);
  }

  const results = normalized.results;

  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'session_voice_agent_start',
      data: { sessionId, results },
    });
    return;
  }

  console.log(chalk.green('✓'), 'voice agent started');
  await writeJsonStdout({ sessionId, results }, { pretty: true });
}

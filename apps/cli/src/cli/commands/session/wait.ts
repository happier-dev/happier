import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { readIntFlagValue } from '@/sessionControl/argvFlags';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { resolveSessionEncryptionContextFromCredentials } from '@/sessionControl/sessionEncryptionContext';
import { waitForIdleViaSocket } from '@/sessionControl/sessionSocketAgentState';

export async function cmdSessionWait(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[1] ?? '').trim();
  if (!idOrPrefix) {
    throw new Error('Usage: happier session wait <session-id-or-prefix> [--timeout <seconds>] [--json]');
  }

  const timeoutSecondsRaw = readIntFlagValue(argv, '--timeout');
  const timeoutSeconds =
    typeof timeoutSecondsRaw === 'number' && Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
      ? Math.min(3600, timeoutSecondsRaw)
      : 300;

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_wait', error: { code: 'not_authenticated' } });
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
        kind: 'session_wait',
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
      printJsonEnvelope({ ok: false, kind: 'session_wait', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
  const agentStateCiphertext =
    typeof (rawSession as any).agentState === 'string' ? String((rawSession as any).agentState).trim() : null;

  try {
    const res = await waitForIdleViaSocket({
      token: credentials.token,
      sessionId,
      ctx,
      timeoutMs: timeoutSeconds * 1000,
      initialAgentStateCiphertextBase64: agentStateCiphertext && agentStateCiphertext.length > 0 ? agentStateCiphertext : null,
    });
    if (json) {
      printJsonEnvelope({ ok: true, kind: 'session_wait', data: { sessionId, ...res } });
      return;
    }
    console.log(chalk.green('✓'), 'session idle');
    console.log(JSON.stringify({ sessionId, ...res }, null, 2));
  } catch (error) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_wait', error: { code: 'timeout' } });
      return;
    }
    throw error;
  }
}


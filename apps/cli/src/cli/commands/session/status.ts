import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { summarizeSessionRecord } from '@/sessionControl/sessionSummary';
import { resolveSessionEncryptionContextFromCredentials, decryptSessionPayload } from '@/sessionControl/sessionEncryptionContext';
import { summarizeAgentState, readLatestAgentStateSummaryViaSocket } from '@/sessionControl/sessionSocketAgentState';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import { hasFlag } from '@/sessionControl/argvFlags';

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

  const resolved = await resolveSessionIdOrPrefix({ credentials, idOrPrefix });
  if (!resolved.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_status',
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
      printJsonEnvelope({ ok: false, kind: 'session_status', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const summary = summarizeSessionRecord({ credentials, session: rawSession });

  const agentStateCiphertext = typeof (rawSession as any).agentState === 'string' ? String((rawSession as any).agentState).trim() : '';
  let agentStateSummary = (() => {
    if (!agentStateCiphertext) return null;
    const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
    try {
      const decrypted = decryptSessionPayload({ ctx, ciphertextBase64: agentStateCiphertext });
      return summarizeAgentState(decrypted);
    } catch {
      return null;
    }
  })();

  if (live) {
    const liveWaitRaw = String(process.env.HAPPIER_SESSION_STATUS_LIVE_WAIT_MS ?? '').trim();
    const liveWaitParsed = liveWaitRaw ? Number.parseInt(liveWaitRaw, 10) : NaN;
    const liveWaitMs = Number.isFinite(liveWaitParsed) && liveWaitParsed > 0 ? Math.min(30_000, liveWaitParsed) : 3_000;
    const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
    try {
      const liveSummary = await readLatestAgentStateSummaryViaSocket({
        token: credentials.token,
        sessionId,
        ctx,
        timeoutMs: liveWaitMs,
      });
      if (liveSummary) {
        agentStateSummary = liveSummary;
      }
    } catch {
      // Best-effort only; fall back to snapshot state.
    }
  }

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_status',
      data: { session: summary, ...(agentStateSummary ? { agentState: agentStateSummary } : {}) },
    });
    return;
  }

  console.log(chalk.green('✓'), 'status fetched');
  console.log(JSON.stringify({ session: summary, agentState: agentStateSummary }, null, 2));
}

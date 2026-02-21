import chalk from 'chalk';
import { randomUUID } from 'node:crypto';

import { parsePermissionIntentAlias, resolveMetadataStringOverrideV1, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import type { PermissionIntent } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { resolveSessionEncryptionContextFromCredentials, encryptSessionPayload, resolveSessionStoredContentEncryptionMode, tryDecryptSessionMetadata } from '@/sessionControl/sessionEncryptionContext';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import { hasFlag, readIntFlagValue, readFlagValue } from '@/sessionControl/argvFlags';
import { waitForIdleViaSocket } from '@/sessionControl/sessionSocketAgentState';
import { sendSessionMessageViaSocketCommitted } from '@/sessionControl/sessionSocketSendMessage';

function parsePermissionIntentOrThrow(raw: string): PermissionIntent {
  const parsed = parsePermissionIntentAlias(raw);
  if (!parsed) {
    const err = new Error(`Invalid permission mode: ${raw}`);
    (err as any).code = 'invalid_arguments';
    throw err;
  }
  return parsed;
}

export async function cmdSessionSend(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[1] ?? '').trim();
  const message = String(argv[2] ?? '').trim();
  const wait = hasFlag(argv, '--wait');
  const timeoutSecondsRaw = readIntFlagValue(argv, '--timeout');
  const permissionModeFlag = (readFlagValue(argv, '--permission-mode') ?? '').trim();
  const modelFlagRaw = readFlagValue(argv, '--model');
  const hasModelFlag = modelFlagRaw !== null;
  const modelFlag = typeof modelFlagRaw === 'string' ? modelFlagRaw.trim() : '';
  const timeoutSeconds =
    typeof timeoutSecondsRaw === 'number' && Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
      ? Math.min(3600, timeoutSecondsRaw)
      : 300;

  if (!idOrPrefix || !message) {
    throw new Error('Usage: happier session send <session-id-or-prefix> <message> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_send', error: { code: 'not_authenticated' } });
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
        kind: 'session_send',
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
      printJsonEnvelope({ ok: false, kind: 'session_send', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
  const storedMode = resolveSessionStoredContentEncryptionMode(rawSession as any);
  const localId = randomUUID();

  const decryptedMetadata = tryDecryptSessionMetadata({ credentials, rawSession });

  const permissionIntent = (() => {
    if (permissionModeFlag) return parsePermissionIntentOrThrow(permissionModeFlag);
    const resolved = resolvePermissionIntentFromSessionMetadata(decryptedMetadata);
    return resolved?.intent ?? 'default';
  })();

  const modelId = (() => {
    if (hasModelFlag) {
      if (!modelFlag) {
        const err = new Error('Invalid --model');
        (err as any).code = 'invalid_arguments';
        throw err;
      }
      return modelFlag;
    }
    const resolved = resolveMetadataStringOverrideV1(decryptedMetadata, 'modelOverrideV1', 'modelId');
    return resolved?.value ?? '';
  })();

  const record: any = {
    role: 'user',
    content: { type: 'text', text: message },
    meta: {
      sentFrom: 'cli',
      source: 'cli',
      permissionMode: permissionIntent,
      ...(modelId && modelId !== 'default' ? { model: modelId } : {}),
    },
  };

  const content =
    storedMode === 'plain'
      ? ({ t: 'plain', v: record } as const)
      : ({ t: 'encrypted', c: encryptSessionPayload({ ctx, payload: record }) } as const);

  await sendSessionMessageViaSocketCommitted({
    token: credentials.token,
    sessionId,
    content,
    localId,
    sentFrom: 'cli',
    permissionMode: permissionIntent,
  });

  let waited = false;
  if (wait) {
    const agentStateCiphertext =
      typeof (rawSession as any).agentState === 'string' ? String((rawSession as any).agentState).trim() : null;
    try {
      await waitForIdleViaSocket({
        token: credentials.token,
        sessionId,
        ctx,
        sessionEncryptionMode: storedMode,
        timeoutMs: timeoutSeconds * 1000,
        initialAgentStateCiphertextBase64: agentStateCiphertext && agentStateCiphertext.length > 0 ? agentStateCiphertext : null,
      });
      waited = true;
    } catch (error) {
      if (json) {
        printJsonEnvelope({ ok: false, kind: 'session_send', error: { code: 'timeout' } });
        return;
      }
      throw error;
    }
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_send', data: { sessionId, localId, waited } });
    return;
  }

  console.log(chalk.green('✓'), 'message sent');
  console.log(JSON.stringify({ sessionId, localId }, null, 2));
}

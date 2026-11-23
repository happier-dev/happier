import { readFile } from 'node:fs/promises';

import {
  approveTerminalAuthRequest,
  TerminalPairingContextRequiredError,
} from '@/auth/terminalAuthApproval';
import { writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { parseHomeTargetInput } from '@happier-dev/cli-common/homeTarget';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import { inspectHomeQrPairLink } from '@happier-dev/cli-common/homeEnrollment';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';

function fail(message: string, exitCode: 1 | 2): never {
  console.error(message);
  process.exit(exitCode);
}

function decodePublicKeyBytes(value: string): Uint8Array | null {
  try {
    const buf = Buffer.from(String(value ?? '').trim(), 'base64');
    if (buf.length === 32) return new Uint8Array(buf);
  } catch {
    // fall through to the mismatch/invalid handling
  }
  return null;
}

/**
 * The remote `auth request --json` envelope is the only genuine source of the
 * pairing context for this manual entry point. The approval owner validates
 * it; this reader only forwards `pairing`/`supportsTokenOnly` verbatim and
 * never fabricates pairing material.
 */
async function readRequestPairingEnvelope(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    fail(`Unable to read --request-json-file: ${path}`, 2);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    fail(
      `--request-json-file must contain the JSON envelope printed by \`happier auth request --json\`: ${path}`,
      2,
    );
  }
}

async function readRequestPairingEnvelopeFromStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > 64 * 1024) {
      fail('The request JSON on stdin exceeds the 65536-byte limit.', 2);
    }
    chunks.push(bytes);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    fail('The request JSON on stdin must be a JSON object.', 2);
  }
}

export async function handleAuthApprove(argsRaw: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const authorizeUnattendedTeamAccess = argsRaw.includes('--authorize-unattended-team-access');
  const homeTargetFromRequestJson = argsRaw.includes('--home-target-from-request-json');
  const args = homeTargetFromRequestJson ? argsRaw : await applyServerSelectionFromArgs(argsRaw);

  const json = args.includes('--json');
  const inviteLinks = homeTargetFromRequestJson ? [] : args.filter(isCliHomeQrApprovalLink);
  if (inviteLinks.length > 0) {
    const { approveCliDirectHomeQr, CliHomeQrApprovalError } = await import('@/auth/directHomeQr/runCliDirectHomeQr');
    const [link] = inviteLinks;
    if (inviteLinks.length !== 1 || !link || args.some((arg) => arg !== link && arg !== '--confirm' && arg !== '--json')) {
      throw new CliHomeQrApprovalError('HOME_QR_APPROVAL_INVALID_ARGUMENT', 'Pass one device code with optional --confirm and --json.');
    }
    const result = inspectHomeQrPairLink(link, (protocol) => protocol.startsWith('happier'));
    if (result?.kind !== 'valid' || result.invite.direction !== 'requester_displays') {
      throw new CliHomeQrApprovalError('HOME_QR_APPROVAL_INVALID_INVITE', 'Pass a fresh device code from the device you want to add.');
    }
    const confirmed = args.includes('--confirm');
    if (!confirmed && !isInteractiveTerminal('stderr')) {
      throw new CliHomeQrApprovalError('HOME_QR_APPROVAL_CONFIRMATION_REQUIRED', 'Use an interactive terminal or pass --confirm to approve the device code.');
    }
    await approveCliDirectHomeQr({
      invite: result.invite,
      signal,
      confirm: async ({ deviceLabel, homeUrl, accountLabel, accountId }) => {
        const show = (value: string) => JSON.stringify(value.replace(/[\p{Cc}\p{Cf}]/gu, ''));
        const account = accountLabel === accountId ? show(accountId) : `${show(accountLabel)} (${show(accountId)})`;
        const facts = `Device ${show(deviceLabel ?? 'Unknown device')}\nHome ${show(homeUrl)}\nAccount ${account}`;
        if (confirmed) {
          console.error(facts);
          return true;
        }
        return await promptConfirmYesNo(`${facts}\nApprove this device?`, {
          default: 'no',
          signal,
          promptInputFn: (message, options) => promptInput(message, { ...options, output: 'stderr' }),
        });
      },
    });
    if (json) await writeJsonStdout({ success: true });
    else console.log('Device approved.');
    return;
  }
  if (!json) {
    fail('Missing required flag: --json', 2);
  }

  const keyIndex = args.findIndex((a) => a === '--public-key');
  const publicKeyRaw = keyIndex >= 0 ? (args[keyIndex + 1] ?? '') : '';
  if (!publicKeyRaw || String(publicKeyRaw).startsWith('--')) {
    fail('Missing required flag: --public-key <base64>', 2);
  }

  const fileIndex = args.findIndex((a) => a === '--request-json-file');
  const requestJsonFileRaw = fileIndex >= 0 ? (args[fileIndex + 1] ?? '') : '';
  if (fileIndex >= 0 && (!requestJsonFileRaw || String(requestJsonFileRaw).startsWith('--'))) {
    fail('Missing value for --request-json-file <path>', 2);
  }
  const requestJsonFile = requestJsonFileRaw || null;
  const requestJsonStdin = args.includes('--request-json-stdin');
  if (requestJsonFile && requestJsonStdin) {
    fail('Use only one of --request-json-file or --request-json-stdin.', 2);
  }
  if (homeTargetFromRequestJson && (!requestJsonStdin || requestJsonFile || args.includes('--persist'))) {
    fail('SSH enrollment approval requires one non-persisted request envelope on stdin.', 2);
  }

  let pairing: unknown;
  let supportsTokenOnly = false;
  let target: ResolvedHomeTarget | undefined;
  if (requestJsonFile || requestJsonStdin) {
    const envelope = requestJsonStdin
      ? await readRequestPairingEnvelopeFromStdin()
      : await readRequestPairingEnvelope(String(requestJsonFile));
    if (homeTargetFromRequestJson) {
      const expectedKeys = new Set(['homeTarget', 'pairing', 'publicKey', 'supportsTokenOnly']);
      if (Object.keys(envelope).some((key) => !expectedKeys.has(key)) || envelope.homeTarget === undefined) {
        fail('The SSH enrollment request envelope has unexpected or missing fields.', 2);
      }
      try {
        target = await resolveCliHomeTarget(parseHomeTargetInput(envelope.homeTarget));
      } catch {
        fail('The SSH enrollment request envelope contains an invalid Home target.', 2);
      }
    }
    const envelopePublicKey = typeof envelope.publicKey === 'string' ? envelope.publicKey : '';
    if (envelopePublicKey) {
      const envelopeKey = decodePublicKeyBytes(envelopePublicKey);
      const requestedKey = decodePublicKeyBytes(String(publicKeyRaw));
      if (
        !envelopeKey
        || !requestedKey
        || Buffer.from(envelopeKey).toString('hex') !== Buffer.from(requestedKey).toString('hex')
      ) {
        fail(
          'The request envelope public key does not match --public-key; approve the matching request.',
          2,
        );
      }
    }
    if (envelope.pairing !== undefined && envelope.pairing !== null) {
      pairing = envelope.pairing;
    }
    supportsTokenOnly = envelope.supportsTokenOnly === true;
  }

  try {
    await approveTerminalAuthRequest({
      publicKey: String(publicKeyRaw),
      ...(pairing ? { pairing } : {}),
      ...(supportsTokenOnly ? { supportsTokenOnly: true } : {}),
      ...(target ? { target } : {}),
      ...(authorizeUnattendedTeamAccess ? { authorizeUnattendedTeamAccess: true } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof TerminalPairingContextRequiredError) {
      console.error(error.message);
      if (!requestJsonFile && !requestJsonStdin) {
        console.error(
          'Save the remote `happier auth request --json` output to a file and re-run with '
            + '--request-json-file <path>, or pair with `happier auth pair-remote --ssh <user@host>`.',
        );
      } else {
        console.error(
          'The request envelope did not include a pairing context. Upgrade the remote CLI, then run '
            + '`happier auth request --json` on the remote machine and approve the new request.',
        );
      }
      process.exit(1);
    }
    fail(error instanceof Error ? error.message : 'Failed to approve auth request.', 1);
  }

  await writeJsonStdout({ success: true });
}

export function isCliHomeQrApprovalLink(value: string): boolean {
  return /^happier[^:]*:/u.test(value);
}

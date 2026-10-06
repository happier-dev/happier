import { resolvePublicReleaseRingLabelForId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import type { OpenSshAuth as CanonicalOpenSshAuth } from '../../ssh/openSshTransport.js';
import { quoteRemotePathWithHomeExpansion, safeBashSingleQuote } from '../../ssh/shellQuote.js';
export type { OpenSshAuth } from '../../ssh/openSshTransport.js';
import { SystemTaskResultSchema } from '@happier-dev/protocol/system/tasks/spec';
import type { SystemTaskJsonObject } from '@happier-dev/protocol';

import type { SystemTaskSshConnectionConfig } from '../kinds/relayRuntimeKinds.js';
import { resolveRemoteInstalledFirstPartyBinaryPath } from '../kinds/remoteFirstPartyPayloadInstaller.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';

import type { HappierJsonExecutor, HappierTextResult, RunHappierOptions } from './happierJsonExecutor.js';

function isSystemTaskJsonObject(value: unknown): value is SystemTaskJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseStrictPersonalHomeTaskFinalResult(text: string): Readonly<{ ok: true; data: SystemTaskJsonObject }> {
  const lines = String(text ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const finalLine = lines.at(-1);
  let parsed: unknown;
  try { parsed = finalLine ? JSON.parse(finalLine) : null; } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home command did not end with a JSON result.');
  }
  const envelope = parsed as Record<string, unknown>;
  if (Object.keys(envelope).some((key) => !['kind', 'protocolVersion', 'result'].includes(key))
    || envelope.kind !== 'personal_home_task_result'
    || envelope.protocolVersion !== 1
    || !envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home command returned the wrong result contract.');
  }
  const result = SystemTaskResultSchema.safeParse(envelope.result);
  if (!result.success || result.data.ok !== true) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home command did not confirm a successful task result.');
  }
  if (!isSystemTaskJsonObject(result.data.data)) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home command did not confirm a successful task result.');
  }
  return { ok: true, data: result.data.data };
}

export type OpenSshRunRemoteText = (params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: CanonicalOpenSshAuth;
  knownHostsMode: 'app' | 'system';
  remoteCommand: string;
  label?: string;
  signal?: AbortSignal;
  timeoutMs?: number | null;
  onStdoutChunk?: (text: string) => void;
  includeStdoutInError?: boolean;
  input?: string;
}>) => Promise<HappierTextResult>;

function parseFirstJsonObject(text: string): unknown {
  const lines = String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

function isJsonFailureEnvelope(value: unknown): value is Readonly<{ ok: false }> {
  return Boolean(
    value
      && typeof value === 'object'
      && 'ok' in value
      && (value as { ok?: unknown }).ok === false,
  );
}

export function createOpenSshHappierJsonExecutor(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: CanonicalOpenSshAuth;
  knownHostsMode: 'app' | 'system';
  channel?: PublicReleaseRingId;
  happierCommand?: string;
  runRemoteText: OpenSshRunRemoteText;
}>): HappierJsonExecutor {
  const channel = params.channel ?? 'stable';
  const scopedLabel = channel === 'stable' ? '' : resolvePublicReleaseRingLabelForId(channel);
  const remoteHappier = String(params.happierCommand ?? '').trim() || resolveRemoteInstalledFirstPartyBinaryPath({
    componentId: 'happier-cli',
    channel,
  });

  return {
    async runHappierText(args, opts) {
      const argvCommand = [quoteRemotePathWithHomeExpansion(remoteHappier), ...args.map(safeBashSingleQuote)].join(' ');
      const remoteCommand = scopedLabel
        ? `HAPPIER_PUBLIC_RELEASE_CHANNEL=${safeBashSingleQuote(scopedLabel)} HAPPIER_RELEASE_RING=${safeBashSingleQuote(scopedLabel)} ${argvCommand}`
        : argvCommand;
      return await params.runRemoteText({
        ssh: params.ssh,
        auth: params.auth,
        knownHostsMode: params.knownHostsMode,
        remoteCommand,
        label: `happier ${args.slice(0, 2).join(' ') || '…'}`,
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs,
        onStdoutChunk: opts?.onStdoutChunk,
        includeStdoutInError: opts?.includeStdoutInError,
        input: opts?.input,
      });
    },

    async runHappierJson(args, opts) {
      const allowJsonFailure = opts?.allowJsonFailure;
      const result = await this.runHappierText(args, opts);
      const parsed = parseFirstJsonObject(result.stdout);

      if (result.status !== 0) {
        if (allowJsonFailure && parsed && typeof parsed === 'object') {
          return parsed;
        }
        throw new SystemTaskExecutionError(
          'cli_command_failed',
          result.stderr.trim() || result.stdout.trim() || 'Command failed.',
        );
      }

      if (!parsed || typeof parsed !== 'object') {
        throw new SystemTaskExecutionError(
          'invalid_cli_response',
          `Command did not return a JSON object: ${args.join(' ')}`,
        );
      }

      if (!allowJsonFailure && isJsonFailureEnvelope(parsed)) {
        const envelope = parsed as {
          error?: { code?: unknown; message?: unknown } | unknown;
          message?: unknown;
        };
        const message = typeof envelope.message === 'string' && envelope.message.trim()
          ? envelope.message.trim()
          : envelope.error && typeof envelope.error === 'object' && envelope.error !== null
              && typeof (envelope.error as { message?: unknown }).message === 'string'
            ? ((envelope.error as { message?: string }).message ?? '').trim()
            : `Command failed: ${args.join(' ')}`;
        throw new SystemTaskExecutionError('cli_command_failed', message);
      }

      return parsed;
    },
  };
}

export type OpenSshHappierJsonExecutor = HappierJsonExecutor;
export type OpenSshHappierTextResult = HappierTextResult;
export type OpenSshRunHappierOptions = RunHappierOptions;

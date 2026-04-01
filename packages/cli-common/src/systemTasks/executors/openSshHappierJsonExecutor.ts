import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { SystemTaskSshConnectionConfig } from '../kinds/relayRuntimeKinds.js';
import { resolveRemoteInstalledFirstPartyBinaryPath } from '../kinds/remoteFirstPartyPayloadInstaller.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';

import type { HappierJsonExecutor, HappierTextResult, RunHappierOptions } from './happierJsonExecutor.js';

export type OpenSshAuth =
  | Readonly<{ mode: 'agent' }>
  | Readonly<{ mode: 'keyFile'; privateKeyPath: string }>
  | Readonly<{ mode: 'password'; password: string }>;

export type OpenSshRunRemoteText = (params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: OpenSshAuth;
  knownHostsMode: 'app' | 'system';
  remoteCommand: string;
  label?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}>) => Promise<HappierTextResult>;

function safeBashSingleQuote(value: string): string {
  const raw = String(value ?? '');
  if (raw === '') return "''";
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

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

function buildRemoteCommandFromArgv(argv: readonly string[]): string {
  return argv.map((part) => safeBashSingleQuote(String(part))).join(' ');
}

export function createOpenSshHappierJsonExecutor(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: OpenSshAuth;
  knownHostsMode: 'app' | 'system';
  channel?: PublicReleaseRingId;
  runRemoteText: OpenSshRunRemoteText;
}>): HappierJsonExecutor {
  const channel = params.channel ?? 'stable';
  const remoteHappier = resolveRemoteInstalledFirstPartyBinaryPath({
    componentId: 'happier-cli',
    channel,
  });

  return {
    async runHappierText(args, opts) {
      const remoteCommand = buildRemoteCommandFromArgv([remoteHappier, ...args]);
      return await params.runRemoteText({
        ssh: params.ssh,
        auth: params.auth,
        knownHostsMode: params.knownHostsMode,
        remoteCommand,
        label: `happier ${args.slice(0, 2).join(' ') || '…'}`,
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs,
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

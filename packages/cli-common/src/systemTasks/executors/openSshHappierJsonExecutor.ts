import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import type { OpenSshAuth as CanonicalOpenSshAuth } from '../../ssh/openSshTransport.js';
import { buildDedicatedDaemonInvocationCommand, buildRemoteHappierInvocationCommand, DEDICATED_DAEMON_INSTALL_HOME } from '../ssh/remoteBootstrapCommandBuilder.js';
export type { OpenSshAuth } from '../../ssh/openSshTransport.js';
import { SystemTaskResultSchema } from '@happier-dev/protocol/system/tasks/spec';
import type { SystemTaskJsonObject } from '@happier-dev/protocol';
import type { ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import type { SystemTaskSshConnectionConfig } from '../kinds/relayRuntimeKinds.js';
import { resolveRemoteInstalledFirstPartyBinaryPath } from '../ssh/remoteFirstPartyInstallPath.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';

import { createHappierJsonExecutorFromTextRunner, type HappierJsonExecutor, type HappierTextResult, type RunHappierOptions } from './happierJsonExecutorFromTextRunner.js';

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

export function createOpenSshHappierJsonExecutor(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: CanonicalOpenSshAuth;
  knownHostsMode: 'app' | 'system';
  channel?: PublicReleaseRingId;
  enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
  happierCommand?: string;
  runRemoteText: OpenSshRunRemoteText;
}>): HappierJsonExecutor {
  const channel = params.channel ?? 'stable';
  const dedicated = params.enrollmentIdentity?.kind === 'dedicatedDaemonUser';
  const remoteHappier = dedicated ? resolveRemoteInstalledFirstPartyBinaryPath({
    componentId: 'happier-cli', channel, remoteHomeDir: DEDICATED_DAEMON_INSTALL_HOME,
  }) : String(params.happierCommand ?? '').trim() || resolveRemoteInstalledFirstPartyBinaryPath({
    componentId: 'happier-cli',
    channel,
  });

  return createHappierJsonExecutorFromTextRunner(async (args, opts) => {
      const remoteCommand = buildRemoteHappierInvocationCommand({ binaryPath: remoteHappier, args, channel });
      return await params.runRemoteText({
        ssh: params.ssh,
        auth: params.auth,
        knownHostsMode: params.knownHostsMode,
        remoteCommand: dedicated ? buildDedicatedDaemonInvocationCommand(remoteCommand) : remoteCommand,
        label: `happier ${args.slice(0, 2).join(' ') || '…'}`,
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs,
        onStdoutChunk: opts?.onStdoutChunk,
        includeStdoutInError: opts?.includeStdoutInError,
        input: opts?.input,
      });
  });
}

export type OpenSshHappierJsonExecutor = HappierJsonExecutor;
export type OpenSshHappierTextResult = HappierTextResult;
export type OpenSshRunHappierOptions = RunHappierOptions;

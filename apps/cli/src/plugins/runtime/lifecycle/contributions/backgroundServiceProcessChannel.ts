import { randomUUID } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk';
import { probeProcessGroupLiveness } from '@happier-dev/cli-common/process';

import { indexCensus, membersOfPgid, readProcessCensus, type ProcessStartIdentity } from '@/processes/census/processCensus';
import { PROCESS_OWNER_ENV_KEY, withProcessOwnerEnvironment } from '@/processes/ownerTag';
import { captureProcessTree, createProcessTreeStopper, terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { createManagedChildProcess } from '@/subprocess/supervision/managedChildProcess';
import {
  createProcessCustodyHandshakePath,
  createWindowsJobCustodyName,
  removeProcessCustodyHandshakeFile,
  resolveProcessCustodyRuntimeExecutable,
  terminateProcessCustodyByJob,
  waitForProcessCustodyHandshake,
  type ProcessCustodySpawnSpec,
} from '@/subprocess/supervision/processCustody';
import type { TerminationEvent } from '@/subprocess/supervision/types';
import { logger } from '@/ui/logger';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

export type BackgroundServiceProcessChannel = Readonly<{
  pid: number | null;
  send(frame: Buffer): void;
  onData(listener: (chunk: Buffer) => void): void;
  waitForTermination(): Promise<TerminationEvent>;
  close(): Promise<void>;
  terminate(): Promise<void>;
}>;

function custodyError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** Transport only: the background-service owner retains admission and runner lifecycle. */
export async function spawnBackgroundServiceProcessChannel(input: Readonly<{
  serviceId: string;
  pluginId?: string;
}>): Promise<BackgroundServiceProcessChannel> {
  let custody: ProcessCustodySpawnSpec | undefined;
  if (process.platform === 'win32') {
    const executablePath = resolveProcessCustodyRuntimeExecutable();
    if (!executablePath) throw custodyError('background_service_process_custody_unavailable');
    custody = {
      executablePath, jobName: createWindowsJobCustodyName(randomUUID()),
      handshakePath: createProcessCustodyHandshakePath(),
    };
  }

  const environment = withProcessOwnerEnvironment(process.env, {
    kind: 'service', serviceId: input.serviceId,
    ...(input.pluginId ? { pluginId: input.pluginId } : {}),
  });
  const launchOwnerTag = environment[PROCESS_OWNER_ENV_KEY];
  const child = spawnHappyCLI(['daemon', 'background-service-worker'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: environment,
  }, { processCustody: custody });
  const managed = createManagedChildProcess(child);
  let physicallyEnded = false;
  void managed.waitForTermination().then(() => { physicallyEnded = true; });

  const listeners = new Set<(chunk: Buffer) => void>();
  // The Windows assignment handshake can outlive the child's first frame.
  let pendingData: Buffer[] | null = [];
  child.stdout?.on('data', (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (pendingData) pendingData.push(data);
    for (const listener of listeners) listener(data);
  });
  // A crash may close stdin between send's availability check and write completion.
  // Physical termination remains the channel's failure signal.
  child.stdin?.on('error', () => {});

  const retainedTargets = new Map<number, { pid: number; start: ProcessStartIdentity }>();
  const captureBeforeEnd = async () => {
    if (custody || managed.pid === null || physicallyEnded) return;
    const captured = await captureProcessTree({ pid: managed.pid });
    if (captured.status === 'ok') for (const target of captured.capturedTargets) retainedTargets.set(target.pid, target);
  };
  const stopper = createProcessTreeStopper(async () => {
    if (custody) {
      const outcome = await terminateProcessCustodyByJob(custody);
      if (outcome !== 'absent') throw custodyError('background_service_process_termination_incomplete');
      return;
    }
    if (managed.pid === null) return;
    const targets = new Map(retainedTargets);
    // Finding uncaptured group members needs a census of every process on the
    // machine. ESRCH for the group proves it has no member now; a later group
    // with this number is a different group, so the scan is needed only when
    // the probe cannot prove the group empty.
    if (probeProcessGroupLiveness(managed.pid) !== 'absent') {
      // A numeric PGID can be reused once its last member leaves. Uncaptured
      // members require the launch's canonical owner tag as well as group membership.
      const census = await readProcessCensus({ freshness: 'fresh', scope: 'all', fields: [] });
      if (census.status !== 'ok') throw custodyError('background_service_process_termination_incomplete');
      const candidates = membersOfPgid(indexCensus(census.rows), managed.pid).filter(row => !targets.has(row.pid));
      if (candidates.length) {
        const ownership = await readProcessCensus({ freshness: 'fresh', pids: candidates.map(row => row.pid), fields: ['ownershipEnvironment'] });
        if (ownership.status !== 'ok') throw custodyError('background_service_process_termination_incomplete');
        for (const row of ownership.rows) {
          if (row.pgid === managed.pid && row.ownerTag && row.ownerTag === launchOwnerTag) {
            targets.set(row.pid, { pid: row.pid, start: row.start });
          }
        }
      }
    }
    const result = await terminateProcessTree({ targets: [...targets.values()], tree: true, rootKind: 'service' });
    if (result.status !== 'complete') throw custodyError('background_service_process_termination_incomplete');
  });
  const waitForTermination = async () => {
    const event = await managed.waitForTermination();
    await stopper.stop();
    return event;
  };
  // Unexpected exits also release descendants when no caller is currently waiting.
  void waitForTermination().catch(error => logger.infoFile('[backgroundServiceProcessChannel] Process cleanup remains unconfirmed', error));

  let pid = managed.pid;
  if (custody) {
    try {
      const established = await waitForProcessCustodyHandshake({
        ...custody, isAborted: () => physicallyEnded,
      });
      if (!established) {
        await stopper.stop();
        await managed.waitForTermination();
        throw custodyError('background_service_process_custody_failed');
      }
      pid = established.pid;
    } finally {
      await removeProcessCustodyHandshakeFile(custody.handshakePath);
    }
  }

  return {
    pid,
    send(frame) {
      if (physicallyEnded || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
        throw custodyError('background_service_worker_stdin_unavailable');
      }
      child.stdin.write(frame);
    },
    onData(listener) {
      listeners.add(listener);
      const buffered = pendingData;
      pendingData = null;
      if (buffered) for (const chunk of buffered) listener(chunk);
    },
    waitForTermination,
    async close() {
      await captureBeforeEnd();
      child.stdin?.end();
      const event = await waitForTermination();
      if (event.type !== 'exited' || event.code !== 0) {
        throw new PluginError({
          code: 'background_service_process_shutdown_failed',
          message: 'Background service process failed during graceful shutdown',
          details: { termination: event },
        });
      }
    },
    async terminate() {
      await captureBeforeEnd();
      await stopper.stop();
      await waitForTermination();
    },
  };
}

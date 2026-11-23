import { join } from 'node:path';

import type { CliUpdateFacts } from '@happier-dev/protocol';
import { SystemTaskExecutionError, type InteractiveSystemTaskKind } from '@happier-dev/cli-common/systemTasks';
import { spawnDetachedNode, type DetachedSpawnResult } from '@happier-dev/cli-common/update';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { readUpdaterAdmission, UPDATER_ADMISSION_FD_ENV } from '@/cli/runtime/update/updaterAdmission';

export const CLI_UPDATE_SYSTEM_TASK_KIND = 'cli.update.v1';

/** Start this program detached so it outlives the daemon, with its admission pipe (`spawnDetachedNode`). */
export type DetachedUpdaterSpawn = (params: Readonly<{
  script: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  admissionFdEnvName: string;
}>) => DetachedSpawnResult;

export type CliUpdateRemoteTaskResult = Readonly<{
  started: true;
  currentVersion: string;
  channel: CliUpdateFacts['channel'];
  logPath: string;
}>;

function selfUpdateChannelArgs(ring: PublicReleaseRingId): string[] {
  if (ring === 'preview') return ['--preview'];
  if (ring === 'publicdev') return ['--dev'];
  return [];
}

function readRequestedChannel(params: unknown): string | null {
  if (params === null || params === undefined) return null;
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'CLI update params must be an object.');
  }
  const channel = (params as { channel?: unknown }).channel;
  if (channel === undefined || channel === null) return null;
  if (typeof channel !== 'string') {
    throw new SystemTaskExecutionError('invalid_params', 'CLI update channel must be a string.');
  }
  return channel;
}

/**
 * `cli.update.v1` hosted by the daemon (plan R13 f): the same update transaction as
 * `happier self update`, started remotely through the daemon's `tool.systemTasks` capability
 * (same-account RPC; the app confirms before it asks).
 *
 * The daemon cannot run the update in-process — the transaction restarts the very service this
 * daemon runs under. It starts `self update` DETACHED from its own program (the version being
 * replaced, which the transaction keeps on disk until the new one is proven) and answers
 * "started" only after the updater reported its admission (it holds the install locks) on its
 * report pipe; a refused updater (`cli_update_in_progress`, …) fails this task instead. The updater survives the service restart because the service managers leave a
 * detached child alone (systemd `KillMode=process`, launchd `AbandonProcessGroup`). The outcome is
 * observed afterwards: the machine reconnects on the new version (or, rolled back, on the old one)
 * and publishes `lastUpdate` in its update facts.
 */
export function createCliUpdateRemoteTaskKind(deps: Readonly<{
  readFacts: () => CliUpdateFacts;
  publicReleaseRing: PublicReleaseRingId;
  /**
   * This daemon's own program (the installed version being replaced): the entry script under a
   * runtime, ignored when the daemon is the compiled binary itself (`spawnDetachedNode`).
   */
  script: string;
  cwd: string;
  logsDir: string;
  spawnDetached?: DetachedUpdaterSpawn;
  nowMs?: () => number;
}>): InteractiveSystemTaskKind<CliUpdateRemoteTaskResult> {
  return {
    async run(ctx) {
      const facts = deps.readFacts();
      const requestedChannel = readRequestedChannel(ctx.params);
      if (requestedChannel !== null && requestedChannel !== facts.channel) {
        throw new SystemTaskExecutionError(
          'invalid_params',
          `This machine runs the ${facts.channel} Happier CLI; it cannot update the ${requestedChannel} one.`,
        );
      }
      if (facts.installSource !== 'managed') {
        throw new SystemTaskExecutionError(
          'cli_not_managed',
          facts.updateCommand
            ? `The Happier CLI on this machine was not installed by Happier. Update it there with: ${facts.updateCommand}`
            : 'The Happier CLI on this machine was not installed by Happier. Update it where it came from.',
        );
      }
      if (!facts.canUpdateRemotely) {
        throw new SystemTaskExecutionError(
          'cli_remote_update_unsupported',
          `This machine cannot update its Happier CLI remotely yet. On that machine, run: ${facts.updateCommand ?? 'happier self update'}`,
        );
      }

      const logPath = join(deps.logsDir, `cli-update-${(deps.nowMs ?? Date.now)()}.log`);
      ctx.emit({ type: 'progress', stepId: 'cli.update.start', message: 'Starting the update on this machine' });
      const spawned = (deps.spawnDetached ?? spawnDetachedNode)({
        script: deps.script,
        args: ['self', 'update', ...selfUpdateChannelArgs(deps.publicReleaseRing)],
        cwd: deps.cwd,
        env: { ...process.env, HAPPIER_CLI_UPDATE_CHECK: '0' },
        logPath,
        admissionFdEnvName: UPDATER_ADMISSION_FD_ENV,
      });
      const fallback = facts.updateCommand ?? 'happier self update';
      if (!spawned.started || !spawned.admission) {
        throw new SystemTaskExecutionError('cli_update_start_failed', `The update could not be started on this machine. On that machine, run: ${fallback}`);
      }
      // Started is not admitted: answer only once the updater holds the install locks (or was
      // refused them — then another update owns the outcome, and this one never ran).
      const admission = await readUpdaterAdmission(spawned.admission);
      if (admission === null) {
        throw new SystemTaskExecutionError('cli_update_start_failed', `The update stopped before it began (details: ${logPath}). On that machine, run: ${fallback}`);
      }
      if (!admission.admitted) {
        throw new SystemTaskExecutionError(admission.code, admission.message || `The update did not start. Details: ${logPath}`);
      }
      return { started: true, currentVersion: facts.currentVersion, channel: facts.channel, logPath };
    },
  };
}

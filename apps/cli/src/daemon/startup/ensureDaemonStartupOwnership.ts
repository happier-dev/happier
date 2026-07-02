import type { DaemonState } from '@/api/types';
import { logger } from '@/ui/logger';
import { forceStopKnownDaemonPid, stopDaemon } from '@/daemon/controlClient';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { DaemonOwnershipConflictError } from '@/daemon/ownership/DaemonOwnershipConflictError';
import {
  evaluateDaemonStartupServiceConflict,
  renderDaemonInstalledServiceConflict,
} from '@/daemon/ownership/daemonServiceInventory';
import {
  buildDaemonTakeoverNotice,
  resolveDaemonTakeoverDecision,
} from '@/daemon/ownership/resolveDaemonTakeoverDecision';
import { resolveDaemonOwnershipConflictExitCode } from '@/daemon/ownership/resolveDaemonOwnershipConflictExitCode';

export async function ensureDaemonStartupOwnership(params: Readonly<{
  takeoverRequested: boolean;
  startupSource: DaemonState['startupSource'];
  runtimeId: string;
}>): Promise<Readonly<{ action: 'continue' }> | Readonly<{ action: 'exit' }>> {
  const startupSource = params.startupSource ?? 'unknown';
  const ownership = await evaluateCurrentDaemonOwner();
  const takeoverDecision = resolveDaemonTakeoverDecision({
    ownership,
    takeoverRequested: params.takeoverRequested,
    startupSource,
  });
  if (takeoverDecision.kind === 'conflict') {
    const error = new DaemonOwnershipConflictError({
      intent: 'daemon-start',
      owner: takeoverDecision.owner,
    });
    logger.warn('[DAEMON RUN] Relay ownership conflict prevented daemon startup', {
      title: error.title,
      lines: error.lines,
    });
    process.exit(resolveDaemonOwnershipConflictExitCode(startupSource));
    return { action: 'exit' };
  }

  const startupServiceConflict = await evaluateDaemonStartupServiceConflict({
    startupSource,
    runtime: resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env }),
  });
  if (startupServiceConflict.kind === 'installed-background-service-conflict') {
    const message = renderDaemonInstalledServiceConflict({
      action: 'daemon-start-sync',
      services: startupServiceConflict.services,
    });
    logger.warn('[DAEMON RUN] Installed background service prevented manual daemon startup', {
      title: message.title,
      lines: message.lines,
      services: startupServiceConflict.services,
    });
    process.stderr.write(`${message.title}\n`);
    process.stderr.write(`${message.lines.map((line) => `  ${line.trimStart()}`).join('\n')}\n`);
    process.exit(1);
    return { action: 'exit' };
  }

  if (takeoverDecision.kind === 'manual-owner-takeover' || takeoverDecision.kind === 'manual-owner-replace') {
    const takeoverNotice = buildDaemonTakeoverNotice({ action: 'start-sync' });
    logger.warn(
      takeoverDecision.kind === 'manual-owner-takeover'
        ? '[DAEMON RUN] Relay takeover requested; replacing the current manual relay runtime'
        : '[DAEMON RUN] Replacing the current stale manual relay runtime before startup',
      {
        runtimeId: params.runtimeId,
        ownerCliVersion: takeoverDecision.owner.state.startedWithCliVersion,
        ownerReleaseChannel: takeoverDecision.owner.state.startedWithPublicReleaseChannel,
        title: takeoverNotice.title,
        lines: takeoverNotice.lines,
      },
    );
    await stopDaemon();
    if (takeoverDecision.owner.source === 'process') {
      await forceStopKnownDaemonPid(takeoverDecision.owner.state.pid);
    }
  }

  return { action: 'continue' };
}

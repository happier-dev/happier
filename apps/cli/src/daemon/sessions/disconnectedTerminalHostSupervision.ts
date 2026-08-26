import type { TerminalHostAdapter, TerminalHostHandle } from '@happier-dev/agents';

import type { Metadata } from '@/api/types';
import { probeTerminalHostForRecovery } from '@/integrations/terminal/host/recoveryLiveness';
import {
  readTerminalHostAttachmentInfo as readDefaultTerminalHostAttachmentInfo,
  removeTerminalHostAttachmentInfo as removeDefaultTerminalHostAttachmentInfo,
  type BoundTerminalHostAttachmentInfo,
  type TerminalHostAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import { logger } from '@/ui/logger';
import type { TerminalMode } from '@/terminal/runtime/terminalConfig';

import { removeSessionMarker as removeDefaultSessionMarker } from '../sessionRegistry';
import type { SessionRunnerServiceabilityProbe } from './isSessionRunnerActive';
import {
  requireExactTerminalControlServiceabilityRetirement,
  type ExactTerminalControlServiceabilityRetirement,
} from './retireTerminalControlServiceability';

export type DisconnectedTerminalHostCandidate = Readonly<{
  sessionId: string;
  pid: number;
  happyHomeDir: string;
  attachmentId: NonNullable<TerminalHostHandle['attachmentId']>;
  handle: TerminalHostHandle & Readonly<{ attachmentId: NonNullable<TerminalHostHandle['attachmentId']> }>;
  terminalMode?: TerminalMode;
  controlDescriptorAvailable?: boolean;
}>;

export type DisconnectedTerminalHostSupervisionResult =
  | Readonly<{ state: 'servable' }>
  | Readonly<{ state: 'recoverable_unservable'; reason: string }>
  | Readonly<{ state: 'stopped' }>
  | Readonly<{ state: 'unknown'; reason: 'attachment_changed' | 'adapter_unavailable' | 'probe_inconclusive' | 'retirement_failed' }>;

export function resolveDisconnectedTerminalHostResumeGate(
  result: DisconnectedTerminalHostSupervisionResult,
): Readonly<{ action: 'resume' }> | Readonly<{ action: 'fence'; reason: string }> {
  return result.state === 'stopped' || result.state === 'servable'
    ? { action: 'resume' }
    : { action: 'fence', reason: result.reason };
}

type TerminalHostAdapters = Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>;

export function resolveDisconnectedTerminalMode(input: Readonly<{
  terminal: Metadata['terminal'] | undefined;
  hostKind: DisconnectedTerminalHostCandidate['handle']['kind'];
  attachmentId: string;
}>): TerminalMode | null {
  if (input.hostKind === 'tmux' || input.hostKind === 'zellij') return input.hostKind;
  const evidenceAttachmentId = input.terminal?.controlServiceabilityV1?.attachmentId;
  if (typeof evidenceAttachmentId === 'string' && evidenceAttachmentId !== input.attachmentId) {
    return null;
  }
  const mode = input.terminal?.mode;
  return mode === 'windows_terminal' || mode === 'windows_console' ? mode : null;
}

export async function superviseDisconnectedTerminalHostCandidate(input: Readonly<{
  candidate: DisconnectedTerminalHostCandidate;
  terminalHostAdapters: TerminalHostAdapters;
  readTerminalAttachmentInfo?: (input: Readonly<{ happyHomeDir: string; sessionId: string }>) => Promise<TerminalHostAttachmentInfo | null>;
  removeTerminalAttachmentInfo?: typeof removeDefaultTerminalHostAttachmentInfo;
  removeSessionMarker?: (pid: number) => Promise<void>;
  probeSessionServiceability?: (sessionId: string) => Promise<SessionRunnerServiceabilityProbe>;
  retireExactTerminalControlServiceability?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalHostAttachmentInfo;
    terminalMode: TerminalMode;
  }>) => Promise<ExactTerminalControlServiceabilityRetirement | void>;
}>): Promise<DisconnectedTerminalHostSupervisionResult> {
  const readAttachment = input.readTerminalAttachmentInfo ?? readDefaultTerminalHostAttachmentInfo;
  const current = await readAttachment({
    happyHomeDir: input.candidate.happyHomeDir,
    sessionId: input.candidate.sessionId,
  });
  if (
    current?.version !== 2
    || current.attachmentId !== input.candidate.attachmentId
    || current.handle.attachmentId !== input.candidate.attachmentId
  ) {
    return { state: 'unknown', reason: 'attachment_changed' };
  }

  const adapter = input.terminalHostAdapters[current.handle.kind];
  if (!adapter) return { state: 'unknown', reason: 'adapter_unavailable' };

  const probe = await probeTerminalHostForRecovery({ adapter, handle: current.handle });
  if (probe.status === 'alive') {
    if (input.candidate.controlDescriptorAvailable === false) {
      return { state: 'recoverable_unservable', reason: 'control_descriptor_missing' };
    }
    if (!input.probeSessionServiceability) return { state: 'unknown', reason: 'probe_inconclusive' };
    const serviceability = await input.probeSessionServiceability(input.candidate.sessionId);
    if (serviceability.state === 'runner_absent') {
      return { state: 'recoverable_unservable', reason: 'runner_absent' };
    }
    if (serviceability.state === 'runner_unknown') {
      return { state: 'unknown', reason: 'probe_inconclusive' };
    }
    if (serviceability.control.state === 'servable') return { state: 'servable' };
    if (serviceability.control.state === 'recoverable_unservable') {
      return { state: 'recoverable_unservable', reason: serviceability.control.reason };
    }
    return { state: 'unknown', reason: 'probe_inconclusive' };
  }
  if (probe.status === 'inconclusive') return { state: 'unknown', reason: 'probe_inconclusive' };

  const terminalMode = current.handle.kind === 'windows_console'
    ? input.candidate.terminalMode
    : current.handle.kind;
  if (!terminalMode) return { state: 'unknown', reason: 'retirement_failed' };

  const disposition = await executeTerminalHostDisposition({
    happyHomeDir: input.candidate.happyHomeDir,
    sessionId: input.candidate.sessionId,
    expectedAttachmentId: input.candidate.attachmentId,
    intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
    adapter,
    readAttachmentInfo: readAttachment,
    removeAttachmentInfo: input.removeTerminalAttachmentInfo ?? removeDefaultTerminalHostAttachmentInfo,
    beforeDescriptorRetirement: input.retireExactTerminalControlServiceability
      ? async ({ attachmentInfo }) => {
          try {
            const retirement = await input.retireExactTerminalControlServiceability!({
              happyHomeDir: input.candidate.happyHomeDir,
              sessionId: input.candidate.sessionId,
              attachmentInfo,
              terminalMode,
            });
            requireExactTerminalControlServiceabilityRetirement(retirement);
          } catch (error) {
            logger.debug('[DAEMON RUN] Confirmed-dead terminal host retained for serviceability retirement retry', {
              sessionId: input.candidate.sessionId,
              attachmentId: input.candidate.attachmentId,
              error,
            });
            throw error;
          }
        }
      : undefined,
  });
  if (disposition.status !== 'retired') return { state: 'unknown', reason: 'retirement_failed' };
  await (input.removeSessionMarker ?? removeDefaultSessionMarker)(input.candidate.pid);
  return { state: 'stopped' };
}

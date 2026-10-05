import type { TerminalHostAdapter, TerminalHostHandle } from '@happier-dev/agents';

import type { Metadata } from '@/api/types';
import { probeTerminalHostForRecovery } from '@/integrations/terminal/host/recoveryLiveness';
import {
  readTerminalHostAttachmentInfo as readDefaultTerminalHostAttachmentInfo,
  readTerminalHostAttachmentState,
  removeTerminalHostAttachmentInfo as removeDefaultTerminalHostAttachmentInfo,
  type ExactTerminalHostAttachmentInfo,
  type TerminalHostAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import { readTerminalClientProcessState } from '@/terminal/host/terminalClientCustody';
import { logger } from '@/ui/logger';
import type { TerminalMode } from '@/terminal/runtime/terminalConfig';

import { removeSessionMarker as removeDefaultSessionMarker } from '../sessionRegistry';
import type { SessionRunnerServiceabilityProbe } from './isSessionRunnerActive';
import type { ExactTerminalControlServiceabilityRetirement } from './retireTerminalControlServiceability';
import type { TrackedSession } from '../types';
import { resolveTrackedSessionTerminalPresentation } from './resolveTrackedSessionTerminalPresentation';

export type DisconnectedTerminalHostCandidate = Readonly<{
  sessionId: string;
  pid: number;
  happyHomeDir: string;
  attachmentId: NonNullable<TerminalHostHandle['attachmentId']>;
  handle: TerminalHostHandle & Readonly<{ attachmentId: NonNullable<TerminalHostHandle['attachmentId']> }>;
  terminalMode?: TerminalMode;
  controlDescriptorAvailable?: boolean;
  spawnOptions?: TrackedSession['spawnOptions'];
  metadata?: TrackedSession['happySessionMetadataFromLocalWebhook'];
}>;

export type DisconnectedTerminalHostSupervisionResult =
  | Readonly<{ state: 'servable' }>
  | Readonly<{ state: 'recoverable_unservable'; reason: string }>
  | Readonly<{ state: 'stopped' }>
  | Readonly<{ state: 'unknown'; reason: 'attachment_changed' | 'adapter_unavailable' | 'probe_inconclusive' | 'retirement_failed' }>;

export function resolveDisconnectedTerminalHostResumeGate(
  result: DisconnectedTerminalHostSupervisionResult,
  recovery?: Readonly<{
    controlDescriptorAvailable?: boolean;
    retainedTerminalRecovery?: NonNullable<Awaited<ReturnType<typeof resolveTrackedSessionTerminalPresentation>>>['retainedTerminalRecovery'];
  }>,
): Readonly<{ action: 'resume'; retainedTerminalRecovery?: 'adopt' }> | Readonly<{ action: 'fence'; reason: string }> {
  const admittedRecovery = result.state === 'recoverable_unservable'
    && result.reason === 'runner_absent'
    && recovery?.controlDescriptorAvailable === true
    && recovery.retainedTerminalRecovery === 'adopt';
  if (admittedRecovery) return { action: 'resume', retainedTerminalRecovery: 'adopt' };
  return result.state === 'stopped' || result.state === 'servable'
    ? { action: 'resume' }
    : { action: 'fence', reason: result.reason };
}

type TerminalHostAdapters = Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>;

/** Final-exit marker retention; unexpected daemon recovery remains caller-owned. */
export async function shouldRetainTrackedTerminalHostExitMarker(input: Readonly<{
  tracked: TrackedSession;
  happyHomeDir: string;
}>): Promise<boolean> {
  const tracked = input.tracked;
  const sessionId = tracked.happySessionId?.trim();
  if (sessionId) {
    const attachment = await readTerminalHostAttachmentState({ happyHomeDir: input.happyHomeDir, sessionId });
    const presentation = await resolveTrackedSessionTerminalPresentation(
      tracked, attachment.status === 'present' ? attachment.info.handle.kind : 'plain',
    );
    if (presentation?.kind === 'provider_attach') {
      if (attachment.status === 'unreadable') {
        logger.infoFile('[DAEMON RUN] Retaining runner-exit marker because terminal custody is unreadable', {
          sessionId, reason: attachment.reason,
        });
        return true;
      }
      return attachment.status === 'present' && attachment.info.version !== 3;
    }
  }
  if (tracked.publishedTerminalControlServiceabilityAttachmentLifecycle === 'borrowed') return false;
  const terminal = tracked.happySessionMetadataFromLocalWebhook?.terminal ?? tracked.hostedTerminal;
  return Boolean(tracked.publishedTerminalControlServiceabilityAttachmentId)
    || Boolean(terminal?.mode && terminal.mode !== 'plain');
}

/** Final-exit owned-host selection; borrowed-shell release has its own disposition. */
export async function resolveTrackedSessionTerminalHostExitCandidate(input: Readonly<{
  tracked: TrackedSession;
  pid: number;
  happyHomeDir: string;
  attachmentInfo: TerminalHostAttachmentInfo | null;
}>): Promise<DisconnectedTerminalHostCandidate | null> {
  const { tracked, attachmentInfo } = input;
  const sessionId = tracked.happySessionId?.trim();
  if (!sessionId) return null;
  const terminal = tracked.happySessionMetadataFromLocalWebhook?.terminal ?? tracked.hostedTerminal;
  if (attachmentInfo?.version !== 2) {
    const optionalPresentation = (await resolveTrackedSessionTerminalPresentation(
      tracked, attachmentInfo?.handle.kind ?? 'plain',
    ))?.kind === 'provider_attach';
    if (!optionalPresentation
      && (tracked.publishedTerminalControlServiceabilityAttachmentId || (terminal?.mode && terminal.mode !== 'plain'))) {
      throw new Error('terminal_host_attachment_unavailable_after_runner_exit');
    }
    return null;
  }
  const terminalMode = resolveDisconnectedTerminalMode({
    terminal, hostKind: attachmentInfo.handle.kind, attachmentId: attachmentInfo.attachmentId,
  });
  if (!terminalMode) throw new Error('terminal_host_mode_unresolved_after_runner_exit');
  return { sessionId, pid: input.pid, happyHomeDir: input.happyHomeDir,
    attachmentId: attachmentInfo.attachmentId, handle: attachmentInfo.handle, terminalMode,
    ...(tracked.spawnOptions ? { spawnOptions: tracked.spawnOptions } : {}),
    ...(tracked.happySessionMetadataFromLocalWebhook ? { metadata: tracked.happySessionMetadataFromLocalWebhook } : {}),
    ...(tracked.publishedTerminalControlServiceabilityAttachmentId === attachmentInfo.attachmentId
      ? { controlDescriptorAvailable: true } : {}),
  };
}

/** Observe the optional frontend using the existing heartbeat, not Session lifetime. */
export async function superviseTrackedOptionalTerminalPresentation(input: Readonly<{
  tracked: TrackedSession;
  isCurrent: () => boolean;
  happyHomeDir: string;
  loadTerminalHostAdapters: () => Promise<TerminalHostAdapters>;
  probeSessionServiceability: NonNullable<Parameters<typeof superviseDisconnectedTerminalHostCandidate>[0]['probeSessionServiceability']>;
  retireExactTerminalControlServiceability: NonNullable<Parameters<typeof superviseDisconnectedTerminalHostCandidate>[0]['retireExactTerminalControlServiceability']>;
}>): Promise<void> {
  const sessionId = input.tracked.happySessionId;
  if (!sessionId || !input.isCurrent()) return;
  const attachment = await readDefaultTerminalHostAttachmentInfo({ happyHomeDir: input.happyHomeDir, sessionId });
  if (!input.isCurrent()) return;
  if (attachment?.version === 3 && attachment.nativeClientProcess) {
    if (await readTerminalClientProcessState(attachment.nativeClientProcess) !== 'dead' || !input.isCurrent()) return;
    const terminalMode = resolveDisconnectedTerminalMode({
      terminal: input.tracked.happySessionMetadataFromLocalWebhook?.terminal ?? input.tracked.hostedTerminal,
      hostKind: attachment.handle.kind, attachmentId: attachment.attachmentId,
    });
    if (!terminalMode) return;
    const result = await executeTerminalHostDisposition({
      happyHomeDir: input.happyHomeDir, sessionId, expectedAttachmentId: attachment.attachmentId,
      intent: { kind: 'release_borrowed_host', reason: 'provider_exit' },
      beforeDescriptorRetirement: async (fact) => {
        if (!input.isCurrent()) throw new Error('Optional terminal presentation owner changed');
        await input.retireExactTerminalControlServiceability({ ...fact, terminalMode });
      },
    });
    if (result.status !== 'retired') logger.infoFile('[DAEMON RUN] Borrowed native presentation retirement is incomplete', {
      sessionId, attachmentId: attachment.attachmentId, status: result.status,
      ...(result.status === 'parked' ? { reason: result.reason } : {}),
    });
    return;
  }
  if (attachment?.version !== 2) return;
  if ((await resolveTrackedSessionTerminalPresentation(input.tracked, attachment.handle.kind))?.kind !== 'provider_attach'
    || !input.isCurrent()) return;
  const adapters = await input.loadTerminalHostAdapters();
  if (!input.isCurrent()) return;
  await superviseDisconnectedTerminalHostCandidate({
    candidate: { sessionId, pid: input.tracked.pid, happyHomeDir: input.happyHomeDir,
      attachmentId: attachment.attachmentId, handle: attachment.handle,
      ...(input.tracked.spawnOptions ? { spawnOptions: input.tracked.spawnOptions } : {}),
      ...(input.tracked.happySessionMetadataFromLocalWebhook
        ? { metadata: input.tracked.happySessionMetadataFromLocalWebhook } : {}),
    },
    terminalHostAdapters: adapters,
    isCurrent: input.isCurrent,
    removeSessionMarker: async () => {},
    probeSessionServiceability: input.probeSessionServiceability,
    retireExactTerminalControlServiceability: async (fact) => {
      if (!input.isCurrent()) throw new Error('Optional terminal presentation owner changed');
      return await input.retireExactTerminalControlServiceability(fact);
    },
  });
}

export function resolveDisconnectedTerminalMode(input: Readonly<{
  terminal: Metadata['terminal'] | undefined;
  hostKind: DisconnectedTerminalHostCandidate['handle']['kind'];
  attachmentId: string;
}>): TerminalMode | null {
  if (input.hostKind === 'tmux' || input.hostKind === 'zellij' || input.hostKind === 'herdr') return input.hostKind;
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
  isCurrent?: () => boolean;
  probeSessionServiceability?: (sessionId: string) => Promise<SessionRunnerServiceabilityProbe>;
  retireExactTerminalControlServiceability?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: ExactTerminalHostAttachmentInfo;
    terminalMode: TerminalMode;
  }>) => Promise<ExactTerminalControlServiceabilityRetirement | void>;
}>): Promise<DisconnectedTerminalHostSupervisionResult> {
  const readAttachment = input.readTerminalAttachmentInfo ?? readDefaultTerminalHostAttachmentInfo;
  const current = await readAttachment({
    happyHomeDir: input.candidate.happyHomeDir,
    sessionId: input.candidate.sessionId,
  });
  if (input.isCurrent?.() === false || (
    current?.version !== 2
    || current.attachmentId !== input.candidate.attachmentId
    || current.handle.attachmentId !== input.candidate.attachmentId
  )) {
    return { state: 'unknown', reason: 'attachment_changed' };
  }

  const adapter = input.terminalHostAdapters[current.handle.kind];
  if (!adapter) return { state: 'unknown', reason: 'adapter_unavailable' };

  const probe = await probeTerminalHostForRecovery({ adapter, handle: current.handle });
  if (input.isCurrent?.() === false) return { state: 'unknown', reason: 'attachment_changed' };
  let destroyOptionalClient = false;
  if (probe.status === 'alive') {
    const optionalPresentation = (await resolveTrackedSessionTerminalPresentation({
      pid: input.candidate.pid, startedBy: 'daemon', happySessionId: input.candidate.sessionId,
      spawnOptions: input.candidate.spawnOptions,
      happySessionMetadataFromLocalWebhook: input.candidate.metadata,
    }, current.handle.kind))?.kind === 'provider_attach';
    if (!optionalPresentation && input.candidate.controlDescriptorAvailable === false) {
      return { state: 'recoverable_unservable', reason: 'control_descriptor_missing' };
    }
    if (!input.probeSessionServiceability) return { state: 'unknown', reason: 'probe_inconclusive' };
    const serviceability = await input.probeSessionServiceability(input.candidate.sessionId);
    if (input.isCurrent?.() === false) return { state: 'unknown', reason: 'attachment_changed' };
    if (serviceability.state === 'runner_absent') {
      if (!optionalPresentation) return { state: 'recoverable_unservable', reason: 'runner_absent' };
      destroyOptionalClient = true;
    } else if (serviceability.state === 'runner_unknown') {
      return { state: 'unknown', reason: 'probe_inconclusive' };
    } else if (serviceability.control.state === 'servable') return { state: 'servable' };
    else if (serviceability.control.state === 'recoverable_unservable') {
      return { state: 'recoverable_unservable', reason: serviceability.control.reason };
    } else return { state: 'unknown', reason: 'probe_inconclusive' };
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
    intent: destroyOptionalClient
      ? { kind: 'destroy_owned_host', reason: 'unrecoverable_control_recovery' }
      : { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
    adapter,
    readAttachmentInfo: readAttachment,
    removeAttachmentInfo: input.removeTerminalAttachmentInfo ?? removeDefaultTerminalHostAttachmentInfo,
    beforeDescriptorRetirement: input.retireExactTerminalControlServiceability
      ? async ({ attachmentInfo }) => {
          if (attachmentInfo.version !== 2) {
            throw new Error('disconnected supervision cannot retire a borrowed terminal');
          }
          try {
            await input.retireExactTerminalControlServiceability!({
              happyHomeDir: input.candidate.happyHomeDir,
              sessionId: input.candidate.sessionId,
              attachmentInfo,
              terminalMode,
            });
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
  if (disposition.status !== 'retired' && (disposition.status !== 'destroyed' || disposition.descriptorRetained)) {
    return { state: 'unknown', reason: 'retirement_failed' };
  }
  await (input.removeSessionMarker ?? removeDefaultSessionMarker)(input.candidate.pid);
  return { state: 'stopped' };
}

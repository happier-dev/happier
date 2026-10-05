import type { EventEmitter } from 'node:events';
import { resolveManagedCliToolNameForRing } from '@happier-dev/cli-common/firstPartyRuntime';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { Metadata } from '@/api/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { deriveActivitySummaryFromAgentState } from '@/api/session/deriveActivitySummaryFromAgentState';
import { configuration } from '@/configuration';
import { createRuntimeContextPrefixArgs } from '@/utils/env/runtimeContextArgv';
import { resolveHappierRuntimeContextEnvFromConfiguration } from '@/utils/env/resolveHappierRuntimeContextEnvFromConfiguration';
import { logger } from '@/ui/logger';
import { readTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import { createHerdrClient, type HerdrClient } from './client';
import { HERDR_ACTION_TIMEOUT_MS, HERDR_STARTUP_TIMEOUT_MS, resolveHerdrRuntimeBinary } from './runtimeBinary';

type ManagedHerdrBinding = Readonly<{
  schedule(): void;
  preserveHostOnClose(): void;
  closing: Promise<boolean> | null;
}>;

type ManagedHerdrSession = EventEmitter & Pick<ApiSessionClient, 'getAgentStateSnapshot'>
  & Partial<Pick<ApiSessionClient, 'getMetadataSnapshot'>>;

const managedHerdrBindings = new WeakMap<EventEmitter, Map<string, ManagedHerdrBinding>>();

function isCurrentManagedTerminal(session: ManagedHerdrSession, terminalId: string): boolean {
  const metadata = session.getMetadataSnapshot?.();
  if (!metadata) return true;
  const terminal = metadata.terminal;
  if (!terminal) return true;
  return terminal.mode === 'herdr' && terminal.herdr?.terminalId === terminalId
    && terminal.controlServiceabilityV1?.retired !== true;
}

export function createHerdrResumeArgv(sessionId: string, releaseRing: PublicReleaseRingId): string[] {
  return [
    resolveManagedCliToolNameForRing(releaseRing),
    ...createRuntimeContextPrefixArgs(resolveHappierRuntimeContextEnvFromConfiguration()),
    'resume', sessionId,
  ];
}

export async function bindHerdrAgentIfNeeded(params: Readonly<{
  session: ManagedHerdrSession;
  sessionId: string;
  agent: string;
  terminal: Metadata['terminal'] | undefined;
  preserveHostOnClose?: boolean;
  client?: Pick<HerdrClient, 'findPane' | 'request'>;
  readTerminalAttachmentInfoFn?: typeof readTerminalAttachmentInfo;
}>): Promise<void> {
  let terminal = params.terminal;
  if (
    terminal?.mode === 'herdr'
    && (!terminal.herdr?.sessionName || !terminal.herdr.socketPath || !terminal.herdr.terminalId)
  ) {
    const attachment = await (params.readTerminalAttachmentInfoFn ?? readTerminalAttachmentInfo)({
      happyHomeDir: configuration.happyHomeDir,
      sessionId: params.sessionId,
    });
    if (attachment?.terminal.mode === 'herdr') terminal = attachment.terminal;
  }
  const herdr = terminal?.mode === 'herdr' ? terminal.herdr : undefined;
  if (!herdr?.sessionName || !herdr.socketPath || !herdr.terminalId) return;
  let client = params.client;
  if (!client) {
    const binary = await resolveHerdrRuntimeBinary({ actionTimeoutMs: HERDR_ACTION_TIMEOUT_MS });
    if (!binary) {
      logger.infoFile('[WARN] [herdr] Cannot report agent state: a supported Herdr executable is unavailable');
      return;
    }
    client = createHerdrClient({
      binary,
      sessionName: herdr.sessionName,
      socketPath: herdr.socketPath,
      actionTimeoutMs: HERDR_ACTION_TIMEOUT_MS,
      startupTimeoutMs: HERDR_STARTUP_TIMEOUT_MS,
    });
  }
  bindManagedHerdrSession({
    session: params.session,
    client,
    terminalId: herdr.terminalId,
    agent: params.agent,
    sessionId: params.sessionId,
    ...(params.preserveHostOnClose ? { preserveHostOnClose: true } : {}),
  });
}

export function bindManagedHerdrSession(params: Readonly<{
  session: ManagedHerdrSession;
  client: Pick<HerdrClient, 'findPane' | 'request'>;
  terminalId: string;
  agent: string;
  sessionId: string;
  preserveHostOnClose?: boolean;
}>): void {
  const bindingKey = `${params.terminalId}\u0000${params.agent}\u0000${params.sessionId}`;
  let sessionBindings = managedHerdrBindings.get(params.session);
  const existing = sessionBindings?.get(bindingKey);
  if (existing) {
    if (existing.closing) {
      // Keep one write lifetime per terminal: a predecessor's delayed release
      // must complete before the replacement reports its agent/resume state.
      void existing.closing.then((sessionOpen) => {
        if (sessionOpen && isCurrentManagedTerminal(params.session, params.terminalId)) bindManagedHerdrSession(params);
      });
      return;
    }
    if (params.preserveHostOnClose) existing.preserveHostOnClose();
    existing.schedule();
    return;
  }
  sessionBindings ??= new Map();
  managedHerdrBindings.set(params.session, sessionBindings);

  const resolveState = (thinking: boolean): 'idle' | 'working' | 'blocked' => {
    const activity = deriveActivitySummaryFromAgentState(params.session.getAgentStateSnapshot());
    if (activity.pendingPermissionRequestCount > 0 || activity.pendingUserActionRequestCount > 0) return 'blocked';
    return thinking ? 'working' : 'idle';
  };
  let desiredState = resolveState(false);
  let reportedState: 'idle' | 'working' | 'blocked' | null = null;
  let closed = false;
  let sessionClosed = false;
  let preserveHostOnClose = params.preserveHostOnClose === true;
  let reporting: Promise<void> | null = null;
  let closing: Promise<boolean> | null = null;

  const report = async (state: 'idle' | 'working' | 'blocked') => {
    const pane = await params.client.findPane(params.terminalId);
    if (!pane) {
      reportedState = state;
      logger.infoFile('[WARN] [herdr] Managed agent terminal is no longer available');
      return;
    }
    await params.client.request('pane.report_agent', {
      pane_id: pane.paneId,
      source: 'happier',
      agent: params.agent,
      state,
      resume_argv: createHerdrResumeArgv(params.sessionId, configuration.publicReleaseRing),
    });
    reportedState = state;
  };

  const release = async () => {
    const pane = await params.client.findPane(params.terminalId);
    if (!pane) return;
    await params.client.request('pane.release_agent', {
      pane_id: pane.paneId,
      source: 'happier',
      agent: params.agent,
    });
  };

  const schedule = () => {
    if (reporting) return;
    reporting = (async () => {
      while (!closed && reportedState !== desiredState) {
        try {
          await report(desiredState);
        } catch {
          // OS/API errors can contain launch inputs; keep the event observable without serializing them.
          logger.infoFile('[WARN] [herdr] Failed to report managed agent state');
          return;
        }
      }
    })().finally(() => { reporting = null; });
  };

  const onPresence = (presence: { thinking: boolean }) => {
    desiredState = resolveState(presence.thinking);
    schedule();
  };
  const onClosed = () => {
    if (closed) return;
    closed = true;
    params.session.off('local-presence', onPresence);
    params.session.off('metadata-updated', onMetadataUpdated);
    closing = (reporting ?? Promise.resolve()).then(async () => {
      if (!preserveHostOnClose) await release();
    }).catch(() => {
      logger.infoFile('[WARN] [herdr] Failed to release managed agent state');
    }).then(() => {
      params.session.off('local-closed', onSessionClosed);
      if (sessionBindings?.get(bindingKey) === binding) sessionBindings.delete(bindingKey);
      return !sessionClosed;
    });
  };
  const onSessionClosed = () => {
    sessionClosed = true;
    onClosed();
  };
  const onMetadataUpdated = () => {
    // A live headless session can release or replace only its optional presenter.
    // Retire that terminal's existing subscription rather than accumulating reporters.
    if (!isCurrentManagedTerminal(params.session, params.terminalId)) onClosed();
  };
  const binding: ManagedHerdrBinding = {
    schedule,
    preserveHostOnClose: () => { preserveHostOnClose = true; },
    get closing() { return closing; },
  };
  sessionBindings.set(bindingKey, binding);
  params.session.on('local-presence', onPresence);
  params.session.on('local-closed', onSessionClosed);
  params.session.on('metadata-updated', onMetadataUpdated);
  schedule();
}

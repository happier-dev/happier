import { randomUUID } from 'node:crypto';

import type { TerminalControlPort, TerminalSpecialKey } from '@happier-dev/agents';

import { buildTerminalControlCapture } from '@/integrations/terminalHost/controlCapture';
import {
  resolveTerminalPromptSubmissionFailureReason,
  runTerminalPromptSubmission,
  type TerminalPromptSubmitVerificationPolicy,
} from '@/integrations/terminalHost/promptSubmitVerification';
import type {
  TerminalAttachmentId,
  TerminalHostAdapter,
  TerminalHostHandle,
  TerminalInputInjectionResult,
  TerminalInputState,
} from '@/integrations/terminalHost/_types';
import { resolveTerminalPromptWriteTimeoutMs } from '@/agent/runtime/terminal/injection/promptWriteTimeout';
import { createTerminalHostDeadline, remainingTerminalHostDeadlineMs } from '@/integrations/terminalHost/deadline';
import { logger } from '@/ui/logger';
import { TerminalHostCreationError, TerminalHostStartupError, resolveTerminalHostLaunchFailure } from '@/integrations/terminalHost/errors';

import { createHerdrClient, HerdrApiError, HerdrPaneCreationError, type HerdrClient } from './client';
import { createHerdrLaunchSpec } from './launchSpec';

const SPECIAL_KEYS: Readonly<Record<TerminalSpecialKey, string>> = {
  Enter: 'enter',
  Escape: 'esc',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Tab: 'tab',
  ShiftTab: 'shift+tab',
  CtrlC: 'ctrl+c',
  Backspace: 'backspace',
};

function paneFailure(error: unknown): boolean {
  return error instanceof HerdrApiError && error.code === 'pane_not_found';
}

/** Admit the endpoint before preparing a command; no managed process exists yet. */
export async function admitHerdrServer(client: HerdrClient): Promise<string> {
  try {
    return await client.ensureServer();
  } catch (error) {
    if (error instanceof HerdrApiError && error.code === 'unsupported_server_version') {
      throw new TerminalHostStartupError({
        hostKind: 'herdr', reason: 'server_version_unsupported',
        message: 'The running Herdr server is older than the supported version.', cause: error,
        launchFailure: { launchDisposition: 'not_started', cleanupIncomplete: false },
      });
    }
    throw new TerminalHostCreationError([error], {
      launchDisposition: 'not_started', cleanupIncomplete: false,
    }, 'Herdr server admission failed before the managed command was submitted');
  }
}

function failedInjection(
  reason: Extract<TerminalInputInjectionResult, { status: 'failed' }>['reason'],
  phase: Extract<TerminalInputInjectionResult, { status: 'failed' }>['phase'],
  duplicateRisk: Extract<TerminalInputInjectionResult, { status: 'failed' }>['duplicateRisk'],
): TerminalInputInjectionResult {
  return { status: 'failed', reason, phase, duplicateRisk, recoverable: reason !== 'pane_dead' };
}

export function createHerdrTerminalHostAdapter(params: Readonly<{
  binary: string;
  actionTimeoutMs: number;
  startupTimeoutMs: number;
  sessionName?: string;
  socketPath?: string;
  client?: HerdrClient;
  promptSubmitVerification?: TerminalPromptSubmitVerificationPolicy;
}>): TerminalHostAdapter {
  const sessionName = params.sessionName ?? 'default';
  const client = params.client ?? createHerdrClient({
    binary: params.binary,
    sessionName,
    socketPath: params.socketPath,
    actionTimeoutMs: params.actionTimeoutMs,
    startupTimeoutMs: params.startupTimeoutMs,
  });
  const clientFor = (handle: TerminalHostHandle): HerdrClient => (
    handle.socketPath === client.socketPath
      ? client
      : createHerdrClient({
        binary: params.binary,
        sessionName: handle.sessionName,
        ...(handle.socketPath ? { socketPath: handle.socketPath } : {}),
        actionTimeoutMs: params.actionTimeoutMs,
        startupTimeoutMs: params.startupTimeoutMs,
      })
  );

  async function resolvePane(handle: TerminalHostHandle): Promise<Readonly<{ paneId: string }> | null> {
    if (!handle.terminalId?.trim()) return null;
    return await clientFor(handle).findPane(handle.terminalId);
  }

  async function captureInputState(handle: TerminalHostHandle): Promise<TerminalInputState> {
    const pane = await resolvePane(handle);
    if (!pane) return { stable: false, currentInput: '', observedAt: Date.now() };
    try {
      const first = await clientFor(handle).readPane(pane.paneId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const currentInput = await clientFor(handle).readPane(pane.paneId);
      return { stable: first === currentInput, currentInput, observedAt: Date.now() };
    } catch {
      return { stable: false, currentInput: '', observedAt: Date.now() };
    }
  }

  function createControlPort(handle: TerminalHostHandle): TerminalControlPort {
    const send = async (effect: (paneId: string) => Promise<void>) => {
      try {
        const pane = await resolvePane(handle);
        if (!pane) return { status: 'host_dead' as const, recoverable: false };
        await effect(pane.paneId);
        return { status: 'sent' as const, at: Date.now() };
      } catch (error) {
        if (paneFailure(error)) return { status: 'host_dead' as const, recoverable: false };
        return { status: 'failed' as const, reason: error instanceof HerdrApiError && error.code === 'timeout' ? 'timeout' as const : 'host_unreachable' as const };
      }
    };
    return {
      hostKind: 'herdr',
      sendLiteralText: (text) => send((paneId) => clientFor(handle).sendText(paneId, text)),
      sendRawSequence: (sequence) => send((paneId) => clientFor(handle).sendRaw(paneId, sequence)),
      sendSpecialKey: (key) => send((paneId) => clientFor(handle).sendKeys(paneId, [SPECIAL_KEYS[key]])),
      async captureScreen() {
        try {
          const pane = await resolvePane(handle);
          if (!pane) return { status: 'host_dead' as const, recoverable: false };
          const rawText = await clientFor(handle).readPane(pane.paneId);
          return {
            status: 'captured' as const,
            capture: buildTerminalControlCapture({ rawText, hostKind: 'herdr', capturedAtMs: Date.now() }),
          };
        } catch (error) {
          if (paneFailure(error)) return { status: 'host_dead' as const, recoverable: false };
          return { status: 'failed' as const, reason: error instanceof HerdrApiError && error.code === 'timeout' ? 'timeout' as const : 'host_unreachable' as const };
        }
      },
    };
  }

  return {
    kind: 'herdr',
    async createOrAttachHost(opts) {
      const launchClient = params.client || params.socketPath || opts.sessionName === sessionName
        ? client
        : createHerdrClient({
            binary: params.binary,
            sessionName: opts.sessionName,
            actionTimeoutMs: params.actionTimeoutMs,
            startupTimeoutMs: params.startupTimeoutMs,
          });
      await admitHerdrServer(launchClient);
      let launch;
      try {
        launch = opts.preparedLaunch
          ? { argv: opts.preparedLaunch.spawnArgv, specPath: opts.preparedLaunch.launchSpecPath,
              discard: opts.preparedLaunch.cleanupUnreadArtifacts }
          : await createHerdrLaunchSpec(opts);
      } catch (error) {
        if (resolveTerminalHostLaunchFailure(error)) throw error;
        throw new TerminalHostCreationError([error], {
          launchDisposition: 'not_started', cleanupIncomplete: false,
        }, 'Herdr launch preparation failed before the managed command was submitted');
      }
      let pane;
      try {
        pane = await launchClient.createPane({
          label: opts.label ?? opts.sessionName,
          cwd: opts.workingDirectory,
          argv: launch.argv,
          env: opts.preparedLaunch ? opts.spawnEnv : {},
        });
      } catch (error) {
        let failure = error;
        if (error instanceof HerdrPaneCreationError && error.launchDisposition !== 'unconfirmed') {
          try {
            await launch.discard();
          } catch (cleanupError) {
            failure = new HerdrPaneCreationError([...error.errors, cleanupError], error.launchDisposition, true);
          }
        }
        // Do not serialize the error's causes: OS/API errors can contain launch inputs.
        logger.infoFile('[WARN] [herdr] Pane creation failed', {
          launchDisposition: failure instanceof HerdrPaneCreationError ? failure.launchDisposition : 'unconfirmed',
          cleanupIncomplete: failure instanceof HerdrPaneCreationError ? failure.cleanupIncomplete : true,
        });
        throw failure;
      }
      const socketPath = launchClient.socketPath;
      if (!socketPath) throw new HerdrApiError('server_not_ready');
      return {
        attachmentId: randomUUID() as TerminalAttachmentId,
        kind: 'herdr',
        sessionName: opts.sessionName,
        paneId: pane.paneId,
        terminalId: pane.terminalId,
        socketPath,
        expectedCommandFragments: opts.spawnArgv.length > 0 ? [opts.spawnArgv[0] ?? ''] : [],
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          maxClients: null,
          requiresLocalAttachmentInfo: true,
          liveProbe: 'required',
        },
      };
    },
    async adoptExistingHost(handle) {
      await clientFor(handle).assertServerVersion();
      const pane = await resolvePane(handle);
      if (!pane) throw new HerdrApiError('pane_not_found');
      return { ...handle, paneId: pane.paneId };
    },
    async evaluateLiveness(handle) {
      const observedAt = Date.now();
      try {
        const pane = await resolvePane(handle);
        if (!pane) return { paneAlive: false, paneDead: true, observedAt };
        const process = await clientFor(handle).processInfo(pane.paneId);
        return {
          paneAlive: true,
          panePid: process.shellPid ?? undefined,
          paneCurrentCommand: process.foregroundProcesses.map((item) => item.argv.join(' ')).join(' | '),
          paneForegroundProcesses: process.foregroundProcesses,
          observedAt,
        };
      } catch (error) {
        if (paneFailure(error)) return { paneAlive: false, paneDead: true, observedAt };
        return { paneAlive: false, probeInconclusive: true, observedAt };
      }
    },
    captureInputState,
    createControlPort,
    async injectUserPrompt(handle, input, writeBoundary) {
      if (input.scheduling.deferReason) {
        return {
          status: 'deferred',
          reason: input.scheduling.deferReason,
          ...(input.scheduling.retryAfterMs !== undefined ? { retryAfterMs: input.scheduling.retryAfterMs } : {}),
        };
      }
      let pane: Awaited<ReturnType<typeof resolvePane>>;
      try {
        pane = await resolvePane(handle);
      } catch (error) {
        return failedInjection(
          error instanceof HerdrApiError && error.code === 'timeout' ? 'timeout' : 'host_unreachable',
          'liveness',
          'none',
        );
      }
      if (!pane) return failedInjection('pane_dead', 'liveness', 'none');
      if (input.scheduling.deferredUntilQuietMs && !(await captureInputState(handle)).stable) {
        return { status: 'deferred', reason: 'user_typing', retryAfterMs: input.scheduling.deferredUntilQuietMs };
      }
      if (writeBoundary && !await writeBoundary.authorizeBeforeWrite()) {
        return failedInjection('no_target', 'before_write', 'none');
      }
      try {
        await clientFor(handle).sendText(pane.paneId, input.text);
      } catch (error) {
        return failedInjection(
          error instanceof HerdrApiError && error.code === 'timeout' ? 'timeout' : 'host_unreachable',
          'during_write',
          'possible',
        );
      }
      const policy = params.promptSubmitVerification;
      const submissionDeadline = createTerminalHostDeadline(
        input.scheduling.timeoutMs ?? resolveTerminalPromptWriteTimeoutMs(input.text),
      );
      const submitted = await runTerminalPromptSubmission({
        promptText: input.text,
        signal: input.signal,
        resolveDeliveryState: input.resolveDeliveryState,
        remainingTimeoutMs: () => remainingTerminalHostDeadlineMs(submissionDeadline),
        ...(policy?.shouldVerifyAfterSubmit(input.text)
          ? {
            verifyStagedBeforeSubmit: async ({ promptText }) => policy.isPromptStagedBeforeSubmit({
              promptText,
              screenText: await clientFor(handle).readPane(pane.paneId),
            }),
            verifyAfterSubmit: async ({ promptText }) => policy.isPromptStillPendingAfterSubmit({
              promptText,
              screenText: await clientFor(handle).readPane(pane.paneId),
            }),
          }
          : {}),
        submitEnter: async () => {
          try {
            await clientFor(handle).sendKeys(pane.paneId, ['enter']);
            return 'success';
          } catch (error) {
            return error instanceof HerdrApiError && error.code === 'timeout' ? 'timeout' : 'failed';
          }
        },
      });
      if (!submitted.success) {
        return failedInjection(
          resolveTerminalPromptSubmissionFailureReason(submitted.reason),
          submitted.phase,
          submitted.duplicateRisk,
        );
      }
      return { status: 'injected', at: Date.now(), bytesWritten: Buffer.byteLength(input.text) };
    },
    async interruptTurn(handle) {
      const pane = await resolvePane(handle);
      if (!pane) throw new HerdrApiError('pane_not_found');
      await clientFor(handle).sendKeys(pane.paneId, ['esc']);
    },
    async dispose(handle) {
      const pane = await resolvePane(handle);
      if (!pane) return;
      await clientFor(handle).closePane(pane.paneId);
    },
  };
}

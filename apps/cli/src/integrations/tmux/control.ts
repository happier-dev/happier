import {
  TERMINAL_SHIFT_TAB_SEQUENCE,
  type TerminalControlCaptureResult,
  type TerminalControlPort,
  type TerminalControlSendResult,
  type TerminalSpecialKey,
} from '@happier-dev/agents';

import { splitStringByCodePoints } from '../terminalHost/chunks';
import { buildTerminalControlCapture } from '../terminalHost/controlCapture';
import { parseTmuxCursorPosition } from './cursorPosition';
import { resolveTmuxSendKeysChunkSize } from './env';
import type { TmuxCommandResult } from './types';

export type TmuxControlCommandExecutor = (
  args: readonly string[],
  options?: Readonly<{ timeoutMs?: number }>,
) => Promise<TmuxCommandResult | null>;

/**
 * tmux named keys that the host delivers natively. ShiftTab is intentionally absent: tmux's named
 * `S-Tab` key is a proven no-op, so ShiftTab is routed through the raw {@link TERMINAL_SHIFT_TAB_SEQUENCE}.
 */
const TMUX_NAMED_SPECIAL_KEYS: Readonly<Partial<Record<TerminalSpecialKey, string>>> = Object.freeze({
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  CtrlC: 'C-c',
  Backspace: 'BSpace',
});

type TmuxExecOutcome =
  | Readonly<{ kind: 'ok'; result: TmuxCommandResult }>
  | Readonly<{ kind: 'failed'; reason: 'host_unreachable' | 'timeout'; detail?: string }>
  | Readonly<{ kind: 'host_dead' }>;

function isTmuxMissingTargetStderr(stderr: string): boolean {
  return /can't find (?:pane|window|session)|no server running|no current (?:session|client)|(?:session|window|pane) not found/i.test(stderr);
}

function sanitizeStderr(stderr: string): string {
  return stderr.replace(/\s+/g, ' ').trim().slice(0, 240);
}

export function createTmuxTerminalControlPort(params: Readonly<{
  executor: TmuxControlCommandExecutor;
  target: string;
  chunkSize?: number;
  timeoutMs?: number;
  nowMs?: () => number;
}>): TerminalControlPort {
  const { executor, target } = params;
  const chunkSize = Math.max(1, Math.trunc(params.chunkSize ?? resolveTmuxSendKeysChunkSize()));
  const nowMs = params.nowMs ?? Date.now;

  async function exec(args: readonly string[]): Promise<TmuxExecOutcome> {
    const result = await executor(args, params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : undefined);
    if (result === null) return { kind: 'failed', reason: 'host_unreachable' };
    if (result.timedOut) return { kind: 'failed', reason: 'timeout' };
    if (result.returncode !== 0) {
      if (isTmuxMissingTargetStderr(result.stderr)) return { kind: 'host_dead' };
      const detail = sanitizeStderr(result.stderr);
      return detail.length > 0
        ? { kind: 'failed', reason: 'host_unreachable', detail }
        : { kind: 'failed', reason: 'host_unreachable' };
    }
    return { kind: 'ok', result };
  }

  function outcomeToSendResult(outcome: TmuxExecOutcome): TerminalControlSendResult {
    if (outcome.kind === 'ok') return { status: 'sent', at: nowMs() };
    if (outcome.kind === 'host_dead') return { status: 'host_dead', recoverable: false };
    return outcome.detail !== undefined
      ? { status: 'failed', reason: outcome.reason, detail: outcome.detail }
      : { status: 'failed', reason: outcome.reason };
  }

  async function sendLiteralChunks(text: string): Promise<TerminalControlSendResult> {
    if (text.length === 0) return { status: 'sent', at: nowMs() };
    for (const chunk of splitStringByCodePoints(text, chunkSize)) {
      const outcome = await exec(['send-keys', '-t', target, '-l', '--', chunk]);
      if (outcome.kind !== 'ok') return outcomeToSendResult(outcome);
    }
    return { status: 'sent', at: nowMs() };
  }

  return {
    hostKind: 'tmux',
    sendLiteralText(text) {
      return sendLiteralChunks(text);
    },
    sendRawSequence(sequence) {
      return sendLiteralChunks(sequence);
    },
    async sendSpecialKey(key) {
      if (key === 'ShiftTab') {
        return sendLiteralChunks(TERMINAL_SHIFT_TAB_SEQUENCE);
      }
      const named = TMUX_NAMED_SPECIAL_KEYS[key];
      if (named === undefined) {
        return { status: 'unsupported', reason: 'special_key_unsupported' };
      }
      return outcomeToSendResult(await exec(['send-keys', '-t', target, named]));
    },
    async captureScreen(): Promise<TerminalControlCaptureResult> {
      // `-e` preserves SGR styling: dim (SGR 2) text is the only honest discriminator between a
      // Claude Code empty-composer suggestion placeholder and a real typed draft (ported S-8).
      const outcome = await exec(['capture-pane', '-p', '-e', '-t', target]);
      if (outcome.kind === 'host_dead') return { status: 'host_dead', recoverable: false };
      if (outcome.kind === 'failed') {
        return outcome.detail !== undefined
          ? { status: 'failed', reason: outcome.reason, detail: outcome.detail }
          : { status: 'failed', reason: outcome.reason };
      }
      const cursorOutcome = await exec(['display-message', '-p', '-t', target, '#{cursor_x}\t#{cursor_y}']);
      const cursor = cursorOutcome.kind === 'ok'
        ? parseTmuxCursorPosition(cursorOutcome.result.stdout)
        : null;
      return {
        status: 'captured',
        capture: buildTerminalControlCapture({
          rawText: outcome.result.stdout,
          hostKind: 'tmux',
          ...(cursor !== null ? { cursor } : {}),
          capturedAtMs: nowMs(),
        }),
      };
    },
  };
}
